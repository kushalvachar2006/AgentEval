// Executes ONE queued test case: obtain the trace (call the agent, or use the SDK-submitted one), ask the Python engine to
// evaluate it, store the result, update progress and finalise the run. Safe to run twice for the same job (idempotent results).
import crypto from 'node:crypto';
import { UpstreamError } from '../lib/upstream.js';
import { safeRequest } from '../lib/safeHttp.js';
import { validateTrace } from '../modules/traces/traceSchema.js';
import { buildTraceDoc } from '../modules/traces/traceDocument.js';
import { aggregateRun, caseStatusOf } from '../modules/evaluations/aggregate.js';

const TERMINAL = ['completed', 'cancelled', 'failed'];
const preview = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? '')).slice(0, 300);
const hex = (n) => crypto.randomBytes(n).toString('hex');
const iso = (d) => d.toISOString();

export function createEvaluationExecutor({ repos, config, engine, evaluatorConfig, secrets, now = () => new Date(), http = safeRequest }) {
  async function finalizeIfComplete(org, run) {
    if (run.progress.completed < run.progress.total) return;
    const results = await repos.results.listAll(org, run.id);
    await repos.runs.update(org, run.id, { status: 'completed', completedAt: now(), summary: aggregateRun(results, run) }, { ifStatusIn: ['queued', 'running', 'awaiting_traces'] });
  }

  async function saveResult(org, run, doc) {
    const { created } = await repos.results.insertIfAbsent(org, { ...doc, runId: run.id, evaluatedAt: now() });
    if (!created) return;
    const updated = await repos.runs.incProgress(org, run.id, { completed: 1, [doc.status === 'error' ? 'error' : doc.status]: 1 }); // judge calls are accounted via reserve/refund
    await finalizeIfComplete(org, updated);
  }

  const inputPreviewOf = async (org, caseId) => { const c = await repos.cases.get(org, caseId).catch(() => null); return c ? preview(c.input) : undefined; };

  async function recordFailure(job, message) {
    const run = await repos.runs.get(job.organizationId, job.runId);
    if (!run || TERMINAL.includes(run.status)) return;
    await saveResult(job.organizationId, run, { testCaseId: job.testCaseId, agentId: run.agentId, status: 'error', metrics: [], error: String(message).slice(0, 500), inputPreview: await inputPreviewOf(job.organizationId, job.testCaseId), judgeCalls: 0 });
  }

  // ---- obtain a trace by calling the agent's HTTP endpoint (contract: POST {input, sessionId, traceId, metadata} -> {output, trace?}) ----
  async function callAgent(org, run, agent, tcase) {
    const traceId = hex(16);
    const headers = { 'content-type': 'application/json', accept: 'application/json', 'x-agenteval-run': run.id };
    if (agent.endpointTokenEnc) headers.authorization = `Bearer ${secrets.decrypt(agent.endpointTokenEnc)}`;
    const started = now();
    const res = await http(agent.endpointUrl, {
      headers, timeoutMs: config.agentCallTimeoutMs, allowPrivate: config.allowPrivateEndpoints,
      body: { input: tcase.input, sessionId: `eval-${run.id}-${tcase.id}`, traceId, metadata: { evaluation: { runId: run.id, testCaseId: tcase.id } } },
    });
    const ended = now();
    if (res.status === 408 || res.status === 429 || res.status >= 500) throw new UpstreamError(`Agent endpoint returned HTTP ${res.status}`, { retryable: true });
    if (res.status < 200 || res.status >= 300) throw new UpstreamError(`Agent endpoint returned HTTP ${res.status}`, { retryable: false });
    let json;
    try { json = JSON.parse(res.text); } catch { throw new UpstreamError('Agent endpoint did not return JSON', { retryable: false }); }
    if (json === null || typeof json !== 'object') throw new UpstreamError('Agent endpoint response must be a JSON object', { retryable: false });
    const output = json.output ?? json.answer ?? json.response;
    if (output === undefined) throw new UpstreamError('Agent response has no "output" field', { retryable: false });

    let trace;
    if (json.trace && validateTrace(json.trace).valid) {
      trace = { ...json.trace, agentId: agent.id, environment: 'evaluation', metadata: { ...json.trace.metadata, evaluation: { runId: run.id, testCaseId: tcase.id } } };
    } else {
      const sid = hex(8), dur = ended - started;
      trace = {
        schemaVersion: '1.0', traceId, agentId: agent.id, environment: 'evaluation', framework: { name: 'custom' }, status: 'success',
        input: tcase.input, output, startedAt: iso(started), endedAt: iso(ended), durationMs: dur,
        spans: [{ spanId: sid, parentSpanId: null, type: 'agent', name: agent.name, status: 'success', startedAt: iso(started), endedAt: iso(ended), durationMs: dur, input: tcase.input, output }],
        metadata: { evaluation: { runId: run.id, testCaseId: tcase.id }, synthesized: true },
      };
    }
    const doc = buildTraceDoc(trace, { organizationId: org, retentionDays: config.traceRetentionDays, maxBytes: config.maxTraceBytes, now: now() });
    await repos.traces.insertIfAbsent(org, doc);
    return doc;
  }

  async function process(job) {
    const org = job.organizationId;
    const run = await repos.runs.get(org, job.runId);
    if (!run || TERMINAL.includes(run.status)) return { done: true, skipped: 'run is not active' };
    if (job.attempts > job.maxAttempts) { await recordFailure(job, 'The evaluation worker stopped repeatedly while processing this case'); return { done: true }; }
    if (await repos.results.get(org, run.id, job.testCaseId)) return { done: true, skipped: 'already evaluated' };
    await repos.runs.update(org, run.id, { status: 'running', startedAt: now() }, { ifStatusIn: ['queued', 'awaiting_traces'] });

    const tcase = await repos.cases.get(org, job.testCaseId);
    const agent = await repos.agents.get(org, run.agentId);
    if (!tcase) throw new UpstreamError('Test case no longer exists', { retryable: false });
    if (!agent) throw new UpstreamError('Agent no longer exists (archived or deleted)', { retryable: false });

    let trace;
    if (run.mode === 'sdk') {
      trace = await repos.traces.get(org, job.payload?.traceId);
      if (!trace) throw new UpstreamError('The submitted trace is no longer available', { retryable: false });
    } else trace = await callAgent(org, run, agent, tcase);

    // Judge budget: reserve atomically BEFORE the call (parallel workers cannot overspend), refund what was not used.
    const maxJudge = run.limits?.maxJudgeCalls ?? 0;
    const remaining = Math.max(0, maxJudge - (run.counters?.judgeCalls ?? 0));
    const judgeCfg = run.useJudge && remaining > 0 ? await evaluatorConfig.judgeFor(org) : null;
    const granted = judgeCfg ? await repos.runs.reserveJudgeCalls(org, run.id, Math.min(8, remaining), maxJudge) : 0;
    const judge = granted > 0 ? judgeCfg : null;
    let out, used = 0;
    try {
      out = await engine.evaluate({
      trace: { status: trace.status, input: trace.input, output: trace.output, error: trace.error, durationMs: trace.durationMs, usage: trace.usage, spans: trace.spans, metadata: trace.metadata },
      testCase: Object.fromEntries(['input', 'referenceAnswer', 'referenceEvidence', 'expectedBehavior', 'evaluationCriteria', 'requiredElements', 'expectedToolCalls', 'constraints'].filter((k) => tcase[k] !== undefined).map((k) => [k, tcase[k]])),
      evaluators: run.evaluators.map(({ metric, version, config: cfg }) => ({ metric, version, config: cfg })),
      judge, limits: { maxJudgeCalls: granted },
      });
      used = Math.min(out?.judgeCalls ?? 0, granted);
    } finally {
      if (granted - used !== 0) await repos.runs.incProgress(org, run.id, {}, used - granted).catch(() => {});
    }
    if (!Array.isArray(out?.results)) throw new UpstreamError('Evaluation engine returned an unexpected response', { retryable: true });

    const fresh = await repos.runs.get(org, run.id);
    if (!fresh || TERMINAL.includes(fresh.status)) return { done: true, skipped: 'run ended while evaluating' };
    const operational = out.results.find((r) => r.metric === 'operational')?.meta?.measurements;
    await saveResult(org, run, {
      testCaseId: tcase.id, agentId: agent.id, agentVersion: trace.agentVersion, traceId: trace.traceId, status: caseStatusOf(out.results), metrics: out.results,
      inputPreview: preview(tcase.input ?? trace.input), outputPreview: preview(trace.output), latencyMs: trace.durationMs,
      tokens: trace.usage?.totalTokens, costUsd: operational?.costUsd ?? trace.usage?.estimatedCostUsd, judgeCalls: used,
    });
    return { done: true };
  }

  return {
    // Returns {done:true} or {retry:true,error}. Never throws.
    async handle(job) {
      try { return await process(job); }
      catch (e) {
        const retryable = e instanceof UpstreamError ? e.retryable : true; // unknown failures get another chance
        if (retryable && job.attempts < job.maxAttempts) return { retry: true, error: e.message };
        await recordFailure(job, e instanceof UpstreamError ? e.message : 'Internal error while evaluating this case').catch(() => {});
        return { done: true };
      }
    },

    // SDK runs: cases whose trace never arrived before the deadline become "error" results so the run can finish.
    async sweepExpired() {
      let swept = 0;
      for (const run of await repos.runs.listExpiredAwaiting(now())) {
        const org = run.organizationId;
        const [done, queued] = await Promise.all([repos.results.listAll(org, run.id), repos.jobs.caseIdsForRun(org, run.id)]);
        const taken = new Set([...done.map((r) => r.testCaseId), ...queued]);
        for (const testCaseId of run.caseIds.filter((c) => !taken.has(c))) {
          await saveResult(org, run, { testCaseId, agentId: run.agentId, status: 'error', metrics: [], error: 'No trace was received before the deadline', inputPreview: await inputPreviewOf(org, testCaseId), judgeCalls: 0 });
          swept++;
        }
        await repos.runs.update(org, run.id, { awaitDeadline: null });
      }
      return swept;
    },
  };
}
