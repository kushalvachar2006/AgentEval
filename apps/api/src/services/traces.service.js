import { AppError } from '../middleware/errors.js';
import { validateTrace } from '../modules/traces/traceSchema.js';
import { buildTraceDoc } from '../modules/traces/traceDocument.js';
import { isId } from '../lib/ids.js';
import { requirePermission } from '../lib/rbac.js';
import { parseLimit, queryString, encodeCursor, decodeCursor } from '../lib/validate.js';

const MAX_BATCH = 100;
const TRACE_STATUSES = ['success', 'error', 'cancelled', 'timeout'];
const strip = ({ organizationId, expiresAt, ...rest }) => rest; // eslint-disable-line no-unused-vars

export function createTraceService({ repos, config, evaluations, monitoring, now = () => new Date() }) {
  // Per-organization retention (Organization Settings). Cached for 30 s so a batch of traces costs one lookup, not one per trace.
  const retentionCache = new Map();
  async function retentionDaysFor(org) {
    const hit = retentionCache.get(org);
    if (hit && hit.until > now().getTime()) return hit.days;
    const o = await repos.orgs.get(org);
    const days = o?.settings?.traceRetentionDays ?? config.traceRetentionDays;
    if (retentionCache.size > 1000) retentionCache.clear();
    retentionCache.set(org, { days, until: now().getTime() + 30_000 });
    return days;
  }
  async function ingestOne(principal, raw) {
    requirePermission(principal, 'traces:write');
    const v = validateTrace(raw);
    if (!v.valid) throw new AppError(422, 'INVALID_TRACE', 'Trace failed validation', v.errors.slice(0, 20));
    if (principal.agentId && principal.agentId !== raw.agentId) throw new AppError(403, 'FORBIDDEN', 'This API key is restricted to a different agent');

    const org = principal.organizationId;
    const agent = isId(raw.agentId) ? await repos.agents.get(org, raw.agentId) : null;
    if (!agent) throw new AppError(404, 'AGENT_NOT_FOUND', 'Agent not found. Register it first and use its id as agentId');

    const doc = buildTraceDoc(raw, { organizationId: org, retentionDays: await retentionDaysFor(org), maxBytes: config.maxTraceBytes, now: now() });
    const { inserted } = await repos.traces.insertIfAbsent(org, doc);
    if (inserted) {
      await repos.agents.markConnected(org, agent.id, doc.startedAt);
      if (doc.agentVersion) await repos.versions.ensure(org, agent.id, doc.agentVersion, 'trace');
      if (monitoring) await monitoring.onTraceIngested(org, agent, doc);   // rollups + sampled production evaluation; never throws
    }
    // SDK-driven evaluation: a trace tagged with metadata.evaluation joins that run (idempotent; never blocks ingestion).
    const link = raw.metadata?.evaluation;
    let linked;
    if (evaluations && link && typeof link === 'object') {
      linked = await evaluations.onTraceIngested(principal, { runId: link.runId, testCaseId: link.testCaseId, traceId: raw.traceId, agentId: raw.agentId }).catch(() => false);
    }
    return { traceId: raw.traceId, status: inserted ? 'accepted' : 'duplicate', ...(linked !== undefined && { linked }) }; // idempotent by (organization, traceId)
  }

  return {
    ingestOne,

    async ingestBatch(principal, body) {
      requirePermission(principal, 'traces:write');
      const traces = body?.traces;
      if (!Array.isArray(traces) || traces.length < 1 || traces.length > MAX_BATCH) throw new AppError(422, 'VALIDATION_ERROR', `"traces" must be an array of 1-${MAX_BATCH} traces`);
      const results = [];
      for (const [index, raw] of traces.entries()) {
        try {
          results.push({ index, ...(await ingestOne(principal, raw)) });
        } catch (e) {
          if (!(e instanceof AppError)) throw e; // infrastructure failure: fail the whole request so the client retries
          results.push({ index, traceId: typeof raw?.traceId === 'string' ? raw.traceId : null, status: 'rejected', error: { code: e.code, message: e.message, details: e.details } });
        }
      }
      const count = (s) => results.filter((r) => r.status === s).length;
      return { accepted: count('accepted'), duplicates: count('duplicate'), rejected: count('rejected'), results };
    },

    async get(principal, traceId) {
      requirePermission(principal, 'traces:read');
      const doc = /^[0-9a-f]{32}$/.test(traceId) ? await repos.traces.get(principal.organizationId, traceId) : null;
      if (!doc) throw new AppError(404, 'TRACE_NOT_FOUND', 'Trace not found');
      return strip(doc);
    },

    // Trace explorer: filter across ALL agents of the organization.
    async explore(principal, query = {}) {
      requirePermission(principal, 'traces:read');
      const org = principal.organizationId;
      const f = {};
      const agentId = queryString(query, 'agentId');
      if (agentId) { if (!isId(agentId)) throw new AppError(400, 'INVALID_QUERY', 'agentId must be a valid id'); f.agentId = agentId; }
      const status = queryString(query, 'status');
      if (status) { if (!TRACE_STATUSES.includes(status)) throw new AppError(400, 'INVALID_QUERY', 'unknown status'); f.status = status; }
      const environment = queryString(query, 'environment');
      if (environment) { if (!['production', 'test', 'evaluation'].includes(environment)) throw new AppError(400, 'INVALID_QUERY', 'unknown environment'); f.environment = environment; }
      const version = queryString(query, 'version'); if (version) f.version = version.slice(0, 64);
      for (const name of ['from', 'to']) { const s = queryString(query, name); if (s !== undefined) { const d = new Date(s); if (Number.isNaN(d.getTime())) throw new AppError(400, 'INVALID_QUERY', `${name} must be an ISO date`); f[name] = d; } }
      const q = queryString(query, 'q');
      if (q) { if (q.length > 100) throw new AppError(400, 'INVALID_QUERY', 'q must be at most 100 characters'); f.q = q; if (!f.from) f.from = new Date(now().getTime() - 30 * 86_400_000); }   // text search is always time-bounded
      const minD = queryString(query, 'minDurationMs');
      if (minD !== undefined) { const n = Number(minD); if (!Number.isInteger(n) || n < 0) throw new AppError(400, 'INVALID_QUERY', 'minDurationMs must be a non-negative integer'); f.minDurationMs = n; }
      const demo = queryString(query, 'demo');
      if (demo) { if (!['true', 'false'].includes(demo)) throw new AppError(400, 'INVALID_QUERY', 'demo must be true or false'); f.isDemo = demo === 'true'; }
      f.limit = parseLimit(query.limit);
      const cursor = decodeCursor(queryString(query, 'cursor'));
      if (cursor && (typeof cursor.t !== 'string' || Number.isNaN(Date.parse(cursor.t)) || !isId(cursor.id))) throw new AppError(400, 'INVALID_CURSOR', 'cursor is not valid');
      f.cursor = cursor;
      const { items, hasMore } = await repos.traces.listFiltered(org, f);
      const last = items.at(-1);
      return { items, nextCursor: hasMore ? encodeCursor({ t: new Date(last.startedAt).toISOString(), id: last.id }) : null };
    },

    async listForAgent(principal, agentId, query = {}) {
      requirePermission(principal, 'traces:read');
      const org = principal.organizationId;
      if (!isId(agentId) || !(await repos.agents.get(org, agentId))) throw new AppError(404, 'AGENT_NOT_FOUND', 'Agent not found');
      const status = queryString(query, 'status');
      if (status && !TRACE_STATUSES.includes(status)) throw new AppError(400, 'INVALID_QUERY', 'unknown status');
      const date = (name) => { const s = queryString(query, name); if (s === undefined) return undefined; const d = new Date(s); if (Number.isNaN(d.getTime())) throw new AppError(400, 'INVALID_QUERY', `${name} must be an ISO date`); return d; };
      const limit = parseLimit(query.limit);
      const cursor = decodeCursor(queryString(query, 'cursor'));
      if (cursor && (typeof cursor.t !== 'string' || Number.isNaN(Date.parse(cursor.t)) || !isId(cursor.id))) throw new AppError(400, 'INVALID_CURSOR', 'cursor is not valid');
      const { items, hasMore } = await repos.traces.list(org, agentId, { status, from: date('from'), to: date('to'), limit, cursor });
      const last = items.at(-1);
      return { items, nextCursor: hasMore ? encodeCursor({ t: new Date(last.startedAt).toISOString(), id: last.id }) : null };
    },
  };
}
