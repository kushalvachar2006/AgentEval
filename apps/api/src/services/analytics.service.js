import { AppError } from '../middleware/errors.js';
import { queryString } from '../lib/validate.js';
import { isId } from '../lib/ids.js';
import { requirePermission } from '../lib/rbac.js';
import { CATALOG } from '../config/catalog.js';

const DAY = 86_400_000;
const ENVIRONMENTS = ['production', 'test', 'evaluation'];
const TRACE_STATUSES = ['success', 'error', 'cancelled', 'timeout'];
const round = (n, d = 4) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);
const rate = (a, b) => (b ? round(a / b) : null);

export function parseDate(raw, name) {
  if (raw === undefined) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new AppError(400, 'INVALID_QUERY', `${name} must be an ISO date, e.g. 2026-11-01 or 2026-11-01T00:00:00Z`);
  return d;
}

export function createAnalyticsService({ repos, now = () => new Date() }) {
  function filters(query) {
    const to = parseDate(queryString(query, 'to'), 'to') ?? now();
    const from = parseDate(queryString(query, 'from'), 'from') ?? new Date(to.getTime() - 30 * DAY);
    if (from > to) throw new AppError(400, 'INVALID_QUERY', '"from" must not be after "to"');
    if (to - from > 366 * DAY) throw new AppError(400, 'INVALID_QUERY', 'The date range may be at most 366 days');
    const f = { from, to };
    const agentId = queryString(query, 'agentId'); if (agentId) { if (!isId(agentId)) throw new AppError(400, 'INVALID_QUERY', 'agentId must be a valid id'); f.agentId = agentId; }
    const version = queryString(query, 'version'); if (version) { if (version.length > 64) throw new AppError(400, 'INVALID_QUERY', 'version is too long'); f.version = version; }
    const environment = queryString(query, 'environment'); if (environment) { if (!ENVIRONMENTS.includes(environment)) throw new AppError(400, 'INVALID_QUERY', `environment must be one of: ${ENVIRONMENTS.join(', ')}`); f.environment = environment; }
    const status = queryString(query, 'status'); if (status) { if (!TRACE_STATUSES.includes(status)) throw new AppError(400, 'INVALID_QUERY', `status must be one of: ${TRACE_STATUSES.join(', ')}`); f.status = status; }
    const metric = queryString(query, 'metric'); if (metric) { if (!CATALOG[metric]) throw new AppError(400, 'INVALID_QUERY', `metric must be one of: ${Object.keys(CATALOG).join(', ')}`); f.metric = metric; }
    const demo = queryString(query, 'demo'); if (demo) { if (!['true', 'false'].includes(demo)) throw new AppError(400, 'INVALID_QUERY', 'demo must be true or false'); f.isDemo = demo === 'true'; }
    return f;
  }

  async function ensureAgent(org, f) {
    if (f.agentId && !(await repos.agents.get(org, f.agentId))) throw new AppError(404, 'AGENT_NOT_FOUND', 'Agent not found');
  }

  async function build(org, f) {
    const evalF = { from: f.from, to: f.to, agentId: f.agentId, version: f.version, metric: f.metric };   // execution-only filters (status, environment, demo) do not apply to evaluation results
    const [agents, runs, stats, daily, metricRows, cases, trendRows, failed] = await Promise.all([
      repos.agents.count(org), repos.runs.count(org, { agentId: f.agentId, from: f.from, to: f.to }),
      repos.traces.stats(org, f), repos.traces.daily(org, f),
      repos.results.metricStats(org, evalF), repos.results.caseStats(org, evalF), repos.results.runTrend(org, evalF), repos.results.failedCases(org, evalF, 10),
    ]);
    const metrics = Object.fromEntries(metricRows.map((m) => [m.metric, { avgScore: round(m.avgScore), n: m.n, pass: m.pass, fail: m.fail, inconclusive: m.inconclusive }]));
    const h = metricRows.find((m) => m.metric === 'hallucination');
    const claims = h ? h.contradicted + h.unsupported + h.supported : 0;
    const byRun = new Map();
    for (const r of trendRows) { const e = byRun.get(r.runId) ?? byRun.set(r.runId, { runId: r.runId, at: r.at, scores: {} }).get(r.runId); e.scores[r.metric] = round(r.avgScore); if (r.at > e.at) e.at = r.at; }
    const runs20 = [...byRun.values()].sort((a, b) => a.at - b.at).slice(-20);
    return {
      filters: { from: f.from.toISOString(), to: f.to.toISOString(), agentId: f.agentId ?? null, version: f.version ?? null, environment: f.environment ?? null, status: f.status ?? null, metric: f.metric ?? null },
      totals: { agents, executions: stats.count, evaluationRuns: runs, failedExecutions: stats.failed },
      execution: {
        avgLatencyMs: stats.avgLatencyMs === null ? null : Math.round(stats.avgLatencyMs), errorRate: rate(stats.errors, stats.count),
        taskCompletionRate: rate(stats.count - stats.failed, stats.count),   // share of executions that finished successfully
        totalTokens: stats.totalTokens, estimatedCostUsd: stats.costN ? round(stats.costUsd, 6) : null, costCoverage: rate(stats.costN, stats.count),
      },
      quality: {
        metrics,
        accuracy: metrics.accuracy?.avgScore ?? null, groundedness: metrics.groundedness?.avgScore ?? null,
        unsupportedClaimRate: claims ? round((h.contradicted + h.unsupported) / claims) : null, contradictedClaimRate: claims ? round(h.contradicted / claims) : null,
        evaluatedCases: cases.total, passRate: rate(cases.passed, cases.total), failedTestCases: cases.failed + cases.error,
      },
      trends: { daily, runs: runs20 },
      recentFailures: failed,
    };
  }

  return {
    async overview(principal, query = {}) {
      requirePermission(principal, 'traces:read');
      const f = filters(query);
      await ensureAgent(principal.organizationId, f);
      return build(principal.organizationId, f);
    },

    async agentMetrics(principal, agentId, query = {}) {
      requirePermission(principal, 'traces:read');
      const org = principal.organizationId;
      if (!isId(agentId)) throw new AppError(404, 'AGENT_NOT_FOUND', 'Agent not found');
      const f = { ...filters(query), agentId };
      await ensureAgent(org, f);
      const vf = { ...f, version: undefined };   // the comparison always shows every version
      const [overview, tv, qv] = await Promise.all([build(org, f), repos.traces.byVersion(org, vf), repos.results.versionQuality(org, { from: f.from, to: f.to, agentId, metric: f.metric })]);
      const versions = new Map(tv.map((v) => [v.version, { version: v.version, executions: v.count, errorRate: rate(v.errors, v.count), avgLatencyMs: v.avgLatencyMs === null ? null : Math.round(v.avgLatencyMs), avgTokens: v.count ? Math.round(v.totalTokens / v.count) : null, quality: {} }]));
      for (const q of qv) { const e = versions.get(q.version) ?? versions.set(q.version, { version: q.version, executions: 0, errorRate: null, avgLatencyMs: null, avgTokens: null, quality: {} }).get(q.version); e.quality[q.metric] = round(q.avgScore); }
      return { ...overview, versions: [...versions.values()].sort((a, b) => b.executions - a.executions) };
    },
  };
}
