// Production monitoring: server-side sampling policy, ingest hook (rollups + sampled evaluation jobs), live views, rollup queries.
import { AppError } from '../middleware/errors.js';
import { isId } from '../lib/ids.js';
import { requirePermission } from '../lib/rbac.js';
import { queryString } from '../lib/validate.js';
import { validatePolicy, effectivePolicy, dayKey } from '../modules/monitoring/policy.js';
import { decideSampling } from '../modules/monitoring/sampling.js';
import { bucketIndex, bucketKey, percentileFromBuckets, mergeBuckets } from '../modules/monitoring/histogram.js';
import { computeHealth } from '../modules/monitoring/health.js';
import { gatherWindow } from '../modules/monitoring/windowStats.js';
import { parseDate } from './analytics.service.js';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const hourOf = (d) => new Date(Math.floor(d.getTime() / HOUR) * HOUR);
const round = (n, d = 4) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);
const publicPolicy = (p) => ({ enabled: p.enabled, sampleRate: p.sampleRate, alwaysEvaluateErrors: p.alwaysEvaluateErrors, dailyTraceBudget: p.dailyTraceBudget, dailyJudgeBudget: p.dailyJudgeBudget, useJudge: p.useJudge, evaluators: p.evaluators, constraints: p.constraints });

export function createMonitoringService({ repos, config, audit, now = () => new Date(), logger = console }) {
  async function agentOr404(principal, id) {
    const agent = isId(id) ? await repos.agents.get(principal.organizationId, id) : null;
    if (!agent || (principal.agentId && principal.agentId !== agent.id)) throw new AppError(404, 'AGENT_NOT_FOUND', 'Agent not found');
    return agent;
  }
  function windowMinutes(query) {
    const raw = queryString(query, 'windowMinutes');
    if (raw === undefined) return 15;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 5 || n > 1440) throw new AppError(400, 'INVALID_QUERY', 'windowMinutes must be a whole number from 5 to 1440');
    return n;
  }
  const includeDemo = (query) => { const v = queryString(query, 'demo'); if (v !== undefined && !['true', 'false'].includes(v)) throw new AppError(400, 'INVALID_QUERY', 'demo must be true or false'); return v === 'true'; };

  async function usageOf(org, agentId, policy, at) {
    const day = dayKey(at);
    const u = (await repos.usage.get(org, agentId, day)) ?? {};
    return { day, evaluationsQueued: u.queued ?? 0, skippedBudget: u.skippedBudget ?? 0, judgeCalls: u.judgeCalls ?? 0, dailyTraceBudget: policy.dailyTraceBudget, dailyJudgeBudget: policy.dailyJudgeBudget };
  }

  async function healthFor(org, agent, current, previous, at) {
    const [counts, evalCounts] = await Promise.all([
      repos.alerts.openCounts(org),
      repos.prodEvals.statusCounts(org, { agentId: agent.id, from: new Date(at.getTime() - 60 * MIN), to: at }),
    ]);
    const mine = counts.filter((c) => c.agentId === agent.id || c.agentId === null);
    const sev = (s) => mine.filter((c) => c.severity === s).reduce((n, c) => n + c.n, 0);
    const minutesSince = agent.lastTraceAt ? (at - new Date(agent.lastTraceAt)) / MIN : null;
    return { ...computeHealth({ current, previous, quality: { n: evalCounts.passed + evalCounts.failed, failed: evalCounts.failed }, alerts: { critical: sev('critical'), warning: sev('warning') }, silence: { everConnected: Boolean(agent.lastTraceAt), minutesSinceLastTrace: minutesSince } }), openAlerts: { critical: sev('critical'), warning: sev('warning') } };
  }

  return {
    // ---------- policy ----------
    async getPolicy(principal, agentId) {
      requirePermission(principal, 'agents:read');
      const agent = await agentOr404(principal, agentId);
      const policy = effectivePolicy(agent.monitoring);
      return { policy: publicPolicy(policy), usage: await usageOf(principal.organizationId, agent.id, policy, now()) };
    },
    async putPolicy(principal, agentId, body) {
      requirePermission(principal, 'settings:manage');
      const agent = await agentOr404(principal, agentId);
      const policy = validatePolicy(body);
      await repos.agents.update(principal.organizationId, agent.id, { monitoring: policy });
      await audit.log({ organizationId: principal.organizationId, actorId: principal.userId, action: 'monitoring-policy.update', target: agent.id, meta: { enabled: policy.enabled, sampleRate: policy.sampleRate, dailyTraceBudget: policy.dailyTraceBudget, dailyJudgeBudget: policy.dailyJudgeBudget, useJudge: policy.useJudge } });
      return { policy: publicPolicy(policy), usage: await usageOf(principal.organizationId, agent.id, policy, now()) };
    },

    // ---------- ingest hook: NEVER throws (ingestion must not fail because monitoring did) ----------
    async onTraceIngested(org, agent, doc) {
      const out = { rollup: false, sampled: false, reason: 'unknown' };
      try {
        const at = now();
        await repos.rollups.record(org, {
          agentId: doc.agentId, agentVersion: doc.agentVersion ?? '', environment: doc.environment ?? 'production', isDemo: doc.isDemo, hour: hourOf(doc.startedAt),
          status: doc.status, durationMs: doc.durationMs, bucket: typeof doc.durationMs === 'number' ? bucketKey(bucketIndex(doc.durationMs)) : null,
          tokens: doc.usage?.totalTokens, costUsd: doc.usage?.estimatedCostUsd, expiresAt: new Date(at.getTime() + config.rollupRetentionDays * DAY),
        });
        out.rollup = true;
      } catch (e) { logger.error(JSON.stringify({ level: 'error', msg: 'rollup write failed', agentId: agent?.id, error: e.message })); }
      try {
        const policy = effectivePolicy(agent.monitoring);
        const decision = decideSampling(policy, doc);
        out.reason = decision.reason;
        if (!decision.evaluate) return out;
        const at = now();
        const day = dayKey(at);
        const expiresAt = new Date(at.getTime() + 35 * DAY);
        const granted = await repos.usage.reserve(org, agent.id, day, 'queued', 1, policy.dailyTraceBudget, { expiresAt });
        if (!granted) { await repos.usage.add(org, agent.id, day, { skippedBudget: 1 }, { expiresAt }); out.reason = 'budget_exhausted'; return out; }
        await repos.jobs.enqueue(org, { type: 'evaluate_trace', idempotencyKey: `prod:${doc.traceId}`, payload: { traceId: doc.traceId, agentId: agent.id, reason: decision.reason } });
        out.sampled = true;
      } catch (e) { logger.error(JSON.stringify({ level: 'error', msg: 'sampling failed', agentId: agent?.id, error: e.message })); }
      return out;
    },

    // ---------- live views ----------
    async overview(principal, query = {}) {
      requirePermission(principal, 'traces:read');
      const org = principal.organizationId, minutes = windowMinutes(query), demo = includeDemo(query), at = now();
      const to = at, from = new Date(at - minutes * MIN), prevFrom = new Date(from - minutes * MIN);
      const { items, hasMore } = await repos.agents.list(org, { limit: 50 });
      const agents = await Promise.all(items.map(async (a) => {
        const [current, previous] = await Promise.all([gatherWindow(repos, org, { agentId: a.id, from, to, includeDemo: demo, withP95: false }), gatherWindow(repos, org, { agentId: a.id, from: prevFrom, to: from, includeDemo: demo, withP95: false })]);
        const policy = effectivePolicy(a.monitoring);
        return { id: a.id, name: a.name, currentVersion: a.currentVersion, lastTraceAt: a.lastTraceAt ?? null, current, health: await healthFor(org, a, current, previous, at), monitoring: { enabled: policy.enabled, sampleRate: policy.sampleRate } };
      }));
      const order = { failing: 0, degraded: 1, healthy: 2, no_data: 3 };
      agents.sort((a, b) => order[a.health.status] - order[b.health.status] || a.name.localeCompare(b.name));
      return { generatedAt: at.toISOString(), window: { minutes, from: from.toISOString(), to: to.toISOString() }, agents, truncated: hasMore };
    },

    async live(principal, agentId, query = {}) {
      requirePermission(principal, 'traces:read');
      const org = principal.organizationId, agent = await agentOr404(principal, agentId), minutes = windowMinutes(query), demo = includeDemo(query), at = now();
      const to = at, from = new Date(at - minutes * MIN), prevFrom = new Date(from - minutes * MIN);
      const binMinutes = Math.max(1, Math.ceil(minutes / 30));
      const f = { agentId: agent.id, environment: 'production', ...(!demo && { isDemo: false }) };
      const qFrom = new Date(at - Math.max(minutes, 1440) * MIN);
      const [current, previous, series, failures, recent, evalStats, evalCounts, evalRecent, alerts] = await Promise.all([
        gatherWindow(repos, org, { agentId: agent.id, from, to, includeDemo: demo }),
        gatherWindow(repos, org, { agentId: agent.id, from: prevFrom, to: from, includeDemo: demo, withP95: false }),
        repos.traces.buckets(org, { ...f, from, to }, binMinutes),
        repos.traces.listFiltered(org, { ...f, failedOnly: true, from: qFrom, limit: 10 }),
        repos.traces.listFiltered(org, { ...f, from, limit: 15 }),
        repos.prodEvals.metricStats(org, { agentId: agent.id, from: qFrom, to }),
        repos.prodEvals.statusCounts(org, { agentId: agent.id, from: qFrom, to }),
        repos.prodEvals.recent(org, { agentId: agent.id, limit: 10 }),
        repos.alerts.list(org, { agentId: agent.id, status: ['open', 'acknowledged'], limit: 5 }),
      ]);
      const policy = effectivePolicy(agent.monitoring);
      return {
        generatedAt: at.toISOString(),
        agent: { id: agent.id, name: agent.name, currentVersion: agent.currentVersion, lastTraceAt: agent.lastTraceAt ?? null },
        window: { minutes, from: from.toISOString(), to: to.toISOString(), binMinutes },
        current, previous,
        series: series.map((b) => ({ at: b.at, count: b.count, errors: b.errors, avgLatencyMs: b.avgLatencyMs === null ? null : Math.round(b.avgLatencyMs), tokens: b.tokens, costUsd: round(b.costUsd, 6) })),
        health: await healthFor(org, agent, current, previous, at),
        recentTraces: recent.items, failedExecutions: failures.items,
        quality: { windowHours: Math.round((to - qFrom) / HOUR), evaluated: evalCounts.total, passed: evalCounts.passed, failed: evalCounts.failed, inconclusive: evalCounts.inconclusive, passRate: evalCounts.passed + evalCounts.failed ? round(evalCounts.passed / (evalCounts.passed + evalCounts.failed)) : null,
          metrics: Object.fromEntries(evalStats.map((m) => [m.metric, { avgScore: round(m.avgScore), n: m.n, pass: m.pass, fail: m.fail, inconclusive: m.inconclusive }])), recent: evalRecent },
        openAlerts: alerts.items.map(({ id, ruleName, ruleType, severity, status, openedAt, explanation }) => ({ id, ruleName, ruleType, severity, status, openedAt, explanation })),
        policy: publicPolicy(policy), usage: await usageOf(org, agent.id, policy, at),
      };
    },

    // ---------- rollups ----------
    async rollups(principal, agentId, query = {}) {
      requirePermission(principal, 'traces:read');
      const org = principal.organizationId, agent = await agentOr404(principal, agentId), at = now();
      const to = parseDate(queryString(query, 'to'), 'to') ?? new Date(hourOf(at).getTime() + HOUR);   // default: through the end of the current hour
      const from = parseDate(queryString(query, 'from'), 'from') ?? new Date(to - 7 * DAY);
      if (from >= to) throw new AppError(400, 'INVALID_QUERY', '"from" must be before "to"');
      if (to - from > 90 * DAY) throw new AppError(400, 'INVALID_QUERY', 'The rollup range may be at most 90 days');
      const environment = queryString(query, 'environment') ?? 'production';
      if (!['production', 'test', 'evaluation'].includes(environment)) throw new AppError(400, 'INVALID_QUERY', 'unknown environment');
      const version = queryString(query, 'version');
      const f = { agentId: agent.id, from, to, environment, isDemo: includeDemo(query), ...(version !== undefined && { version: version.slice(0, 64) }) };
      const rows = await repos.rollups.range(org, f);
      const summarize = (rs) => {
        const count = rs.reduce((n, r) => n + r.count, 0), dN = rs.reduce((n, r) => n + r.durationN, 0), costN = rs.reduce((n, r) => n + r.costN, 0);
        const p95 = percentileFromBuckets(mergeBuckets(rs.map((r) => r.lat)), 0.95);
        return { count, errors: rs.reduce((n, r) => n + r.errors, 0), failed: rs.reduce((n, r) => n + r.failed, 0), errorRate: count ? round(rs.reduce((n, r) => n + r.errors, 0) / count) : null,
          avgLatencyMs: dN ? Math.round(rs.reduce((n, r) => n + r.sumDurationMs, 0) / dN) : null, maxLatencyMs: rs.length ? Math.max(...rs.map((r) => r.maxDurationMs)) : null,
          p95LatencyMs: p95?.valueMs ?? null, p95Note: p95 ? (p95.overflow ? 'above the largest bucket (60 s)' : 'upper bound of the latency bucket containing the 95th percentile') : null,
          totalTokens: rs.reduce((n, r) => n + r.tokens, 0), costUsd: costN ? round(rs.reduce((n, r) => n + r.costUsd, 0), 6) : null, costN };
      };
      const byHour = new Map();
      for (const r of rows) (byHour.get(r.hour.getTime()) ?? byHour.set(r.hour.getTime(), []).get(r.hour.getTime())).push(r);
      return { filters: { agentId: agent.id, from: from.toISOString(), to: to.toISOString(), environment, version: version ?? null }, totals: summarize(rows), hourly: [...byHour].sort(([a], [b]) => a - b).map(([t, rs]) => ({ hour: new Date(t).toISOString(), ...summarize(rs) })) };
    },
  };
}
