import { AppError } from '../middleware/errors.js';
import { check, parseLimit, queryString, encodeCursor, decodeCursor } from '../lib/validate.js';
import { isId } from '../lib/ids.js';
import { can, requirePermission } from '../lib/rbac.js';
import { CATALOG } from '../config/catalog.js';
import { sanitize } from '../lib/redact.js';

const MODES = ['sdk', 'endpoint'];
const ACTIVE = ['queued', 'awaiting_traces', 'running'];
const RESULT_STATUSES = ['passed', 'failed', 'inconclusive', 'error'];
const publicRun = ({ organizationId, caseIds, createdBy, updatedAt, ...r }) => r; // eslint-disable-line no-unused-vars

export function createEvaluationService({ repos, config, audit, evaluatorConfig, now = () => new Date() }) {
  const orgOf = (p) => p.organizationId;
  const getRunOr404 = async (principal, id) => {
    const r = isId(id) ? await repos.runs.get(orgOf(principal), id) : null;
    if (!r) throw new AppError(404, 'RUN_NOT_FOUND', 'Evaluation run not found');
    return r;
  };

  function defaultMetrics(flags) {
    const m = ['relevance'];
    if (flags.reference) m.push('accuracy');
    if (flags.reference || flags.evidence) m.push('hallucination');
    if (flags.evidence) m.push('groundedness');
    if (flags.required) m.push('completeness');
    if (flags.tools) m.push('tool_usage');
    if (flags.constraints) m.push('instruction_adherence');
    return m.map((metric) => ({ metric }));
  }

  return {
    async create(principal, body) {
      requirePermission(principal, 'evaluations:write');
      if (principal.type !== 'user') throw new AppError(403, 'FORBIDDEN', 'Only signed-in users can start evaluation runs');
      const c = check();
      const name = c.str(body?.name, 'name', { max: 100, optional: true });
      const mode = c.oneOf(body?.mode, 'mode', MODES);
      if (!isId(body?.agentId)) c.fail('agentId', 'must be a valid id');
      if (!isId(body?.suiteId)) c.fail('suiteId', 'must be a valid id');
      const lim = body?.limits ?? {};
      let maxJudgeCalls = config.defaultMaxJudgeCalls;
      if (lim.maxJudgeCalls !== undefined) { if (!Number.isInteger(lim.maxJudgeCalls) || lim.maxJudgeCalls < 0 || lim.maxJudgeCalls > 5000) c.fail('limits.maxJudgeCalls', 'must be an integer from 0 to 5000'); else maxJudgeCalls = lim.maxJudgeCalls; }
      if (body?.metrics !== undefined && (!Array.isArray(body.metrics) || !body.metrics.length || body.metrics.length > 12)) c.fail('metrics', 'must be a list of 1-12 metrics');
      if (body?.useJudge !== undefined && typeof body.useJudge !== 'boolean') c.fail('useJudge', 'must be true or false');
      c.done();

      const org = orgOf(principal);
      const agent = await repos.agents.get(org, body.agentId);
      if (!agent) throw new AppError(404, 'AGENT_NOT_FOUND', 'Agent not found');
      if (mode === 'endpoint' && (agent.integrationType !== 'api' || !agent.endpointUrl)) {
        throw new AppError(422, 'AGENT_NOT_CALLABLE', 'Endpoint mode needs an agent with integrationType "api" and an endpointUrl. For SDK agents use mode "sdk".');
      }
      const suite = await repos.suites.get(org, body.suiteId);
      if (!suite) throw new AppError(404, 'SUITE_NOT_FOUND', 'Test suite not found');
      const { ids, flags } = await repos.cases.summary(org, suite.id, config.maxCasesPerRun);
      if (!ids.length) throw new AppError(422, 'SUITE_EMPTY', 'This test suite has no test cases');
      if (ids.length > config.maxCasesPerRun) throw new AppError(422, 'SUITE_TOO_LARGE', `A run can evaluate at most ${config.maxCasesPerRun} test cases`);

      const specs = body.metrics ?? defaultMetrics(flags);
      const evaluators = specs.map((s, i) => {
        const entry = CATALOG[s?.metric];
        if (!entry) { c.fail(`metrics[${i}].metric`, `must be one of: ${Object.keys(CATALOG).join(', ')}`); return null; }
        if (s.version !== undefined && s.version !== entry.version) { c.fail(`metrics[${i}].version`, `only version ${entry.version} is available for ${s.metric}`); return null; }
        const cfg = s.config === undefined ? {} : s.config;
        if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg) || JSON.stringify(cfg).length > 4096) { c.fail(`metrics[${i}].config`, 'must be an object under 4 KB'); return null; }
        return { metric: s.metric, version: entry.version, config: sanitize(cfg).value }; // version is pinned NOW so the run stays reproducible
      });
      c.done();

      const judgeReady = Boolean(await evaluatorConfig.judgeFor(org));
      const useJudge = body.useJudge ?? judgeReady;
      if (useJudge && !judgeReady) throw new AppError(422, 'JUDGE_NOT_CONFIGURED', 'useJudge is true but no judge is configured. Add one under Settings, or send useJudge: false.');

      const t = now();
      const run = await repos.runs.create(org, {
        name: name ?? `${suite.name} on ${agent.name}`, agentId: agent.id, suiteId: suite.id, mode, evaluators, useJudge, limits: { maxJudgeCalls },
        caseIds: ids, status: mode === 'sdk' ? 'awaiting_traces' : 'queued',
        progress: { total: ids.length }, awaitDeadline: mode === 'sdk' ? new Date(t.getTime() + config.sdkRunWaitMinutes * 60_000) : undefined, createdBy: principal.userId,
      });
      if (mode === 'endpoint') {
        for (const caseId of ids) await repos.jobs.enqueue(org, { type: 'evaluate_case', runId: run.id, testCaseId: caseId, idempotencyKey: `eval:${run.id}:${caseId}`, payload: {} });
      }
      await audit.log({ organizationId: org, actorId: principal.userId, action: 'evaluation.create', target: run.id, meta: { mode, cases: ids.length, useJudge } });
      return publicRun(run);
    },

    async get(principal, id) {
      requirePermission(principal, 'evaluations:read');
      return publicRun(await getRunOr404(principal, id));
    },

    async list(principal, query = {}) {
      requirePermission(principal, 'evaluations:read');
      const limit = parseLimit(query.limit);
      const cur = decodeCursor(queryString(query, 'cursor'));
      if (cur && !isId(cur.id)) throw new AppError(400, 'INVALID_CURSOR', 'cursor is not valid');
      const agentId = queryString(query, 'agentId');
      if (agentId && !isId(agentId)) throw new AppError(400, 'INVALID_QUERY', 'agentId must be a valid id');
      const { items, hasMore } = await repos.runs.list(orgOf(principal), { agentId, limit, cursorId: cur?.id });
      return { items: items.map(publicRun), nextCursor: hasMore ? encodeCursor({ id: items.at(-1).id }) : null };
    },

    async results(principal, id, query = {}) {
      requirePermission(principal, 'evaluations:read');
      await getRunOr404(principal, id);
      const status = queryString(query, 'status');
      if (status && !RESULT_STATUSES.includes(status)) throw new AppError(400, 'INVALID_QUERY', `status must be one of: ${RESULT_STATUSES.join(', ')}`);
      const limit = parseLimit(query.limit, { def: 50, max: 200 });
      const cur = decodeCursor(queryString(query, 'cursor'));
      if (cur && !isId(cur.id)) throw new AppError(400, 'INVALID_CURSOR', 'cursor is not valid');
      const { items, hasMore } = await repos.results.list(orgOf(principal), id, { status, limit, cursorId: cur?.id });
      const clean = items.map(({ organizationId, ...r }) => r); // eslint-disable-line no-unused-vars
      return { items: clean, nextCursor: hasMore ? encodeCursor({ id: items.at(-1).id }) : null };
    },

    async cancel(principal, id) {
      requirePermission(principal, 'evaluations:write');
      const run = await getRunOr404(principal, id);
      const updated = await repos.runs.update(orgOf(principal), run.id, { status: 'cancelled', cancelledAt: now(), completedAt: now() }, { ifStatusIn: ACTIVE });
      if (!updated) throw new AppError(409, 'RUN_FINISHED', `This run is already ${run.status}`);
      await repos.jobs.cancelForRun(orgOf(principal), run.id);
      await audit.log({ organizationId: orgOf(principal), actorId: principal.userId, action: 'evaluation.cancel', target: run.id });
      return publicRun(updated);
    },

    // SDK mode: which test cases still need to be run by the developer's own code.
    async work(principal, id) {
      if (!(can(principal, 'evaluations:run') || can(principal, 'evaluations:write'))) throw new AppError(403, 'FORBIDDEN', 'You do not have permission to do this');
      const run = await getRunOr404(principal, id);
      if (principal.agentId && principal.agentId !== run.agentId) throw new AppError(404, 'RUN_NOT_FOUND', 'Evaluation run not found');
      if (run.mode !== 'sdk') throw new AppError(409, 'RUN_NOT_SDK', 'This run is executed by the server, not by the SDK');
      if (!['awaiting_traces', 'running'].includes(run.status) || (run.awaitDeadline && new Date(run.awaitDeadline) <= now())) throw new AppError(409, 'RUN_NOT_ACCEPTING', `This run is ${run.status} and no longer accepts traces`);
      const org = orgOf(principal);
      const [done, queued] = await Promise.all([repos.results.listAll(org, run.id), repos.jobs.caseIdsForRun(org, run.id)]);
      const taken = new Set([...done.map((r) => r.testCaseId), ...queued]);
      const pending = run.caseIds.filter((cid) => !taken.has(cid));
      const cases = await repos.cases.getMany(org, pending);
      const order = new Map(pending.map((cid, i) => [cid, i]));
      return { runId: run.id, agentId: run.agentId, deadline: run.awaitDeadline ?? null, cases: cases.sort((a, b) => order.get(a.id) - order.get(b.id)).map((c) => ({ testCaseId: c.id, input: c.input })) };
    },

    // Called by trace ingestion when a trace carries metadata.evaluation = {runId, testCaseId}.
    async onTraceIngested(principal, { runId, testCaseId, traceId, agentId }) {
      if (!isId(runId) || !isId(testCaseId)) return false;
      const org = orgOf(principal);
      const run = await repos.runs.get(org, runId);
      if (!run || run.mode !== 'sdk' || !['awaiting_traces', 'running'].includes(run.status) || run.agentId !== agentId || !run.caseIds.includes(testCaseId)) return false;
      if (run.awaitDeadline && new Date(run.awaitDeadline) <= now()) return false;
      await repos.jobs.enqueue(org, { type: 'evaluate_case', runId, testCaseId, idempotencyKey: `eval:${runId}:${testCaseId}`, payload: { traceId } });
      return true;
    },
  };
}
