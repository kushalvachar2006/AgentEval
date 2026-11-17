import { AppError } from '../../src/middleware/errors.js';

let counter = 0;
const newId = () => (++counter).toString(16).padStart(24, '0');
const clone = (x) => structuredClone(x);

const within = (d, from, to) => (!from || d >= from) && (!to || d <= to);
const avg = (xs) => { const v = xs.filter((x) => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const traceFilter = (t, f) => within(t.startedAt, f.from, f.to) && (!f.agentId || t.agentId === f.agentId) && (!f.version || t.agentVersion === f.version) && (!f.environment || t.environment === f.environment)
  && (!f.status || t.status === f.status) && (!f.failedOnly || t.status !== 'success') && (typeof f.isDemo !== 'boolean' || Boolean(t.isDemo) === f.isDemo) && (!f.minDurationMs || t.durationMs >= f.minDurationMs)
  && (!f.q || `${t.inputPreview} ${t.outputPreview}`.toLowerCase().includes(String(f.q).slice(0, 100).toLowerCase()));
const resultFilter = (r, f) => within(r.evaluatedAt, f.from, f.to) && (!f.agentId || r.agentId === f.agentId) && (!f.version || r.agentVersion === f.version) && (!f.runId || r.runId === f.runId);


function metricStatsOf(rows, f) {
  const g = new Map();
  for (const r of rows) for (const m of r.metrics ?? []) { if (f.metric && m.metric !== f.metric) continue; (g.get(m.metric) ?? g.set(m.metric, []).get(m.metric)).push(m); }
  const sum = (ms, k) => ms.reduce((n, m) => n + (m.meta?.counts?.[k] ?? 0), 0);
  return [...g].sort(([a], [b]) => (a < b ? -1 : 1)).map(([metric, ms]) => ({ metric, n: ms.length, pass: ms.filter((m) => m.status === 'pass').length, fail: ms.filter((m) => m.status === 'fail').length, inconclusive: ms.filter((m) => m.status === 'inconclusive').length,
    avgScore: avg(ms.map((m) => m.score)), contradicted: sum(ms, 'contradicted'), unsupported: sum(ms, 'unsupported'), supported: sum(ms, 'supported') }));
}
const binStart = (d, binMinutes) => { const ms = binMinutes * 60_000; return new Date(Math.floor(d.getTime() / ms) * ms); };

export function createMemoryRepos() {
  const db = { users: [], orgs: [], agents: [], versions: [], keys: [], traces: [], audit: [], suites: [], cases: [], evalConfigs: [], runs: [], results: [], jobs: [], rollups: [], usage: [], prodEvals: [], alertRules: [], alerts: [], sessions: [], tokens: [], throttle: [] };
  const inOrg = (rows, orgId) => rows.filter((r) => r.organizationId === orgId);
  const stamp = (d) => ({ ...clone(d), id: newId(), createdAt: new Date(), updatedAt: new Date() });

  const repos = {
    _db: db,
    users: {
      findByEmail: async (email) => clone(db.users.find((u) => u.email === email) ?? null),
      findById: async (id) => clone(db.users.find((u) => u.id === id) ?? null),
      async create(doc) {
        if (db.users.some((u) => u.email === doc.email)) throw new AppError(409, 'EMAIL_IN_USE', 'An account with this email already exists');
        const u = stamp(doc); db.users.push(u); return clone(u);
      },
      count: async () => db.users.length,
      async update(id, patch) { const u = db.users.find((x) => x.id === id); if (!u) return null; Object.assign(u, clone(patch), { updatedAt: new Date() }); return clone(u); },
      findByIds: async (ids) => clone(db.users.filter((u) => ids.includes(u.id)).map(({ id, email, name, disabled }) => ({ id, email, name, disabled }))),
    },
    orgs: {
      async create(doc) { const o = stamp(doc); db.orgs.push(o); return clone(o); },
      get: async (id) => clone(db.orgs.find((o) => o.id === id) ?? null),
      async update(id, patch) { const o = db.orgs.find((x) => x.id === id); if (!o) return null; for (const [k, v] of Object.entries(clone(patch))) { if (k === 'settings') o.settings = { ...o.settings, ...v }; else o[k] = v; } o.updatedAt = new Date(); return clone(o); },
      async addMember(orgId, userId, role) { const o = db.orgs.find((x) => x.id === orgId); if (!o || o.members.some((m) => m.userId === userId)) return false; o.members.push({ userId, role }); return true; },
      async setMemberRole(orgId, userId, role) { const m = db.orgs.find((x) => x.id === orgId)?.members.find((x) => x.userId === userId); if (!m) return false; m.role = role; return true; },
      async removeMember(orgId, userId) { const o = db.orgs.find((x) => x.id === orgId); const n = o?.members.length; if (!o) return false; o.members = o.members.filter((m) => m.userId !== userId); return o.members.length < n; },
      listForUser: async (userId) => clone(db.orgs.filter((o) => o.members.some((m) => m.userId === userId))),
    },
    agents: {
      async create(orgId, doc) {
        if (inOrg(db.agents, orgId).some((a) => !a.isArchived && a.name === doc.name)) throw new AppError(409, 'AGENT_NAME_EXISTS', 'An agent with this name already exists');
        const a = { ...stamp(doc), organizationId: orgId, isArchived: false }; db.agents.push(a); return clone(a);
      },
      async list(orgId, { limit, cursorId, name, framework, onlyId }) {
        let rows = inOrg(db.agents, orgId).filter((a) => !a.isArchived);
        if (name) rows = rows.filter((a) => a.name === name);
        if (framework) rows = rows.filter((a) => a.framework === framework);
        if (onlyId) rows = rows.filter((a) => a.id === onlyId);
        else if (cursorId) rows = rows.filter((a) => a.id < cursorId);
        rows = rows.sort((a, b) => (a.id < b.id ? 1 : -1));
        return { items: clone(rows.slice(0, limit)), hasMore: rows.length > limit };
      },
      get: async (orgId, id) => clone(inOrg(db.agents, orgId).find((a) => a.id === id && !a.isArchived) ?? null),
      count: async (orgId) => inOrg(db.agents, orgId).filter((a) => !a.isArchived).length,
      async update(orgId, id, patch) {
        const a = inOrg(db.agents, orgId).find((x) => x.id === id && !x.isArchived);
        if (!a) return null;
        if (patch.name && inOrg(db.agents, orgId).some((x) => x.id !== id && !x.isArchived && x.name === patch.name)) throw new AppError(409, 'AGENT_NAME_EXISTS', 'An agent with this name already exists');
        Object.assign(a, patch, { updatedAt: new Date() }); return clone(a);
      },
      async archive(orgId, id) { const a = inOrg(db.agents, orgId).find((x) => x.id === id); if (a) Object.assign(a, { isArchived: true, status: 'archived' }); return clone(a ?? null); },
      async markConnected(orgId, id, at) { const a = inOrg(db.agents, orgId).find((x) => x.id === id && !x.isArchived); if (a) Object.assign(a, { status: 'connected', lastTraceAt: at }); },
    },
    versions: {
      async create(orgId, doc) {
        if (inOrg(db.versions, orgId).some((v) => v.agentId === doc.agentId && v.version === doc.version)) throw new AppError(409, 'VERSION_EXISTS', 'This version already exists for the agent');
        const v = { ...stamp(doc), organizationId: orgId }; db.versions.push(v); return clone(v);
      },
      async ensure(orgId, agentId, version, source) {
        if (!inOrg(db.versions, orgId).some((v) => v.agentId === agentId && v.version === version)) db.versions.push({ ...stamp({ agentId, version, source }), organizationId: orgId });
      },
      list: async (orgId, agentId) => clone(inOrg(db.versions, orgId).filter((v) => v.agentId === agentId).reverse()),
    },
    apiKeys: {
      async create(orgId, doc) { const k = { ...stamp(doc), organizationId: orgId }; db.keys.push(k); return clone(k); },
      list: async (orgId) => clone(inOrg(db.keys, orgId).map(({ keyHash, ...rest }) => rest)), // eslint-disable-line no-unused-vars
      findByHash: async (hash) => clone(db.keys.find((k) => k.keyHash === hash) ?? null),
      async revoke(orgId, id, at) { const k = inOrg(db.keys, orgId).find((x) => x.id === id && !x.revokedAt); if (k) k.revokedAt = at; return clone(k ?? null); },
      async touch(id, at) { const k = db.keys.find((x) => x.id === id); if (k) k.lastUsedAt = at; },
      async revokeForAgent(orgId, agentId, at) { for (const k of inOrg(db.keys, orgId)) if (k.agentId === agentId && !k.revokedAt) k.revokedAt = at; },
    },
    traces: {
      async deleteDemo(orgId) { const n = db.traces.length; db.traces = db.traces.filter((t) => !(t.organizationId === orgId && t.isDemo)); return n - db.traces.length; },
      async insertIfAbsent(orgId, doc) {
        if (inOrg(db.traces, orgId).some((t) => t.traceId === doc.traceId)) return { inserted: false };
        db.traces.push({ ...clone(doc), id: newId(), organizationId: orgId }); return { inserted: true };
      },
      get: async (orgId, traceId) => clone(inOrg(db.traces, orgId).find((t) => t.traceId === traceId) ?? null),
      async listFiltered(orgId, f) {
        let rows = inOrg(db.traces, orgId).filter((t) => traceFilter(t, f)).sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
        if (f.cursor) { const t = new Date(f.cursor.t); rows = rows.filter((r) => r.startedAt < t || (r.startedAt.getTime() === t.getTime() && r.id < f.cursor.id)); }
        const items = rows.slice(0, f.limit).map(({ spans, metadata, input, output, error, ...summary }) => clone(summary)); // eslint-disable-line no-unused-vars
        return { items, hasMore: rows.length > f.limit };
      },
      async durations(orgId, f, limit) {
        return inOrg(db.traces, orgId).filter((t) => traceFilter(t, f)).sort((a, b) => b.startedAt - a.startedAt).slice(0, limit).map((t) => t.durationMs).filter((d) => typeof d === 'number');
      },
      async buckets(orgId, f, binMinutes) {
        const g = new Map();
        for (const t of inOrg(db.traces, orgId).filter((x) => traceFilter(x, f))) { const k = binStart(t.startedAt, binMinutes).getTime(); (g.get(k) ?? g.set(k, []).get(k)).push(t); }
        return [...g].sort(([a], [b]) => a - b).map(([k, ts]) => ({ at: new Date(k), count: ts.length, errors: ts.filter((t) => t.status === 'error').length, avgLatencyMs: avg(ts.map((t) => t.durationMs)), tokens: ts.reduce((n, t) => n + (t.usage?.totalTokens ?? 0), 0), costUsd: ts.reduce((n, t) => n + (typeof t.usage?.estimatedCostUsd === 'number' ? t.usage.estimatedCostUsd : 0), 0) }));
      },
      async stats(orgId, f) {
        const rows = inOrg(db.traces, orgId).filter((t) => traceFilter(t, f));
        const costs = rows.map((t) => t.usage?.estimatedCostUsd).filter((c) => typeof c === 'number');
        return { count: rows.length, errors: rows.filter((t) => t.status === 'error').length, failed: rows.filter((t) => t.status !== 'success').length, avgLatencyMs: avg(rows.map((t) => t.durationMs)),
          totalTokens: rows.reduce((n, t) => n + (t.usage?.totalTokens ?? 0), 0), costUsd: costs.reduce((a, b) => a + b, 0), costN: costs.length };
      },
      async daily(orgId, f) {
        const days = new Map();
        for (const t of inOrg(db.traces, orgId).filter((x) => traceFilter(x, f))) { const d = t.startedAt.toISOString().slice(0, 10); (days.get(d) ?? days.set(d, []).get(d)).push(t); }
        return [...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, ts]) => ({ date, count: ts.length, errors: ts.filter((t) => t.status === 'error').length, avgLatencyMs: avg(ts.map((t) => t.durationMs)) }));
      },
      async byVersion(orgId, f) {
        const g = new Map();
        for (const t of inOrg(db.traces, orgId).filter((x) => traceFilter(x, f))) { const v = t.agentVersion ?? 'unversioned'; (g.get(v) ?? g.set(v, []).get(v)).push(t); }
        return [...g].map(([version, ts]) => ({ version, count: ts.length, errors: ts.filter((t) => t.status === 'error').length, avgLatencyMs: avg(ts.map((t) => t.durationMs)), totalTokens: ts.reduce((n, t) => n + (t.usage?.totalTokens ?? 0), 0) })).sort((a, b) => b.count - a.count);
      },
      async list(orgId, agentId, { status, from, to, limit, cursor }) {
        let rows = inOrg(db.traces, orgId).filter((t) => t.agentId === agentId);
        if (status) rows = rows.filter((t) => t.status === status);
        if (from) rows = rows.filter((t) => t.startedAt >= from);
        if (to) rows = rows.filter((t) => t.startedAt <= to);
        rows = rows.sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
        if (cursor) { const t = new Date(cursor.t); rows = rows.filter((r) => r.startedAt < t || (r.startedAt.getTime() === t.getTime() && r.id < cursor.id)); }
        const items = rows.slice(0, limit).map(({ spans, metadata, input, output, error, ...summary }) => clone(summary)); // eslint-disable-line no-unused-vars
        return { items, hasMore: rows.length > limit };
      },
    },
    suites: {
      async create(orgId, doc) {
        if (inOrg(db.suites, orgId).some((s) => s.name === doc.name)) throw new AppError(409, 'SUITE_NAME_EXISTS', 'A test suite with this name already exists');
        const s = { ...stamp(doc), organizationId: orgId, caseCount: 0 }; db.suites.push(s); return clone(s);
      },
      async list(orgId, { limit, cursorId }) {
        let rows = inOrg(db.suites, orgId).sort((a, b) => (a.id < b.id ? 1 : -1));
        if (cursorId) rows = rows.filter((s) => s.id < cursorId);
        return { items: clone(rows.slice(0, limit)), hasMore: rows.length > limit };
      },
      get: async (orgId, id) => clone(inOrg(db.suites, orgId).find((s) => s.id === id) ?? null),
      async incCases(orgId, id, n) { const s = inOrg(db.suites, orgId).find((x) => x.id === id); if (s) s.caseCount += n; },
    },
    cases: {
      async insertMany(orgId, suiteId, docs, { startPosition = 0, createdBy } = {}) {
        const out = docs.map((d, i) => ({ ...stamp(d), organizationId: orgId, suiteId, position: startPosition + i, isDeleted: false, createdBy }));
        db.cases.push(...out); return clone(out);
      },
      async list(orgId, suiteId, { limit, cursorId }) {
        let rows = inOrg(db.cases, orgId).filter((c) => c.suiteId === suiteId && !c.isDeleted).sort((a, b) => (a.id < b.id ? -1 : 1));
        if (cursorId) rows = rows.filter((c) => c.id > cursorId);
        return { items: clone(rows.slice(0, limit)), hasMore: rows.length > limit };
      },
      get: async (orgId, id) => clone(inOrg(db.cases, orgId).find((c) => c.id === id) ?? null),
      getMany: async (orgId, ids) => clone(inOrg(db.cases, orgId).filter((c) => ids.includes(c.id))),
      async softDelete(orgId, suiteId, id) { const c = inOrg(db.cases, orgId).find((x) => x.id === id && x.suiteId === suiteId && !x.isDeleted); if (c) c.isDeleted = true; return Boolean(c); },
      async summary(orgId, suiteId, max) {
        const rows = inOrg(db.cases, orgId).filter((c) => c.suiteId === suiteId && !c.isDeleted).sort((a, b) => a.position - b.position);
        const has = (f) => rows.some((c) => c[f] !== undefined && c[f] !== null && !(Array.isArray(c[f]) && !c[f].length));
        return { ids: rows.slice(0, max + 1).map((c) => c.id), flags: { reference: has('referenceAnswer'), evidence: has('referenceEvidence'), required: has('requiredElements'), tools: has('expectedToolCalls'), constraints: has('constraints') } };
      },
    },
    evaluatorConfigs: {
      get: async (orgId) => clone(inOrg(db.evalConfigs, orgId)[0] ?? null),
      async upsert(orgId, doc) {
        let c = inOrg(db.evalConfigs, orgId)[0];
        if (!c) { c = { id: newId(), organizationId: orgId }; db.evalConfigs.push(c); }
        Object.assign(c, clone(doc)); return clone(c);
      },
    },
    runs: {
      async create(orgId, doc) {
        const r = { ...stamp(doc), organizationId: orgId, progress: { completed: 0, passed: 0, failed: 0, inconclusive: 0, error: 0, ...doc.progress }, counters: { judgeCalls: 0 } };
        db.runs.push(r); return clone(r);
      },
      get: async (orgId, id) => clone(inOrg(db.runs, orgId).find((r) => r.id === id) ?? null),
      count: async (orgId, { agentId, from, to } = {}) => inOrg(db.runs, orgId).filter((r) => (!agentId || r.agentId === agentId) && within(r.createdAt, from, to)).length,
      async list(orgId, { agentId, limit, cursorId }) {
        let rows = inOrg(db.runs, orgId).filter((r) => !agentId || r.agentId === agentId).sort((a, b) => (a.id < b.id ? 1 : -1));
        if (cursorId) rows = rows.filter((r) => r.id < cursorId);
        return { items: clone(rows.slice(0, limit).map(({ caseIds, ...rest }) => rest)), hasMore: rows.length > limit }; // eslint-disable-line no-unused-vars
      },
      async update(orgId, id, patch, { ifStatusIn } = {}) {
        const r = inOrg(db.runs, orgId).find((x) => x.id === id);
        if (!r || (ifStatusIn && !ifStatusIn.includes(r.status))) return null;
        Object.assign(r, patch, { updatedAt: new Date() }); return clone(r);
      },
      async incProgress(orgId, id, inc, judgeCalls = 0) {
        const r = inOrg(db.runs, orgId).find((x) => x.id === id);
        for (const [k, v] of Object.entries(inc)) r.progress[k] = (r.progress[k] ?? 0) + v;
        r.counters.judgeCalls += judgeCalls; return clone(r);
      },
      async reserveJudgeCalls(orgId, id, wanted, max) {
        const r = inOrg(db.runs, orgId).find((x) => x.id === id);
        for (const want of [...new Set([wanted, Math.ceil(wanted / 2), 1])].filter((n) => n > 0)) {
          if (r && r.counters.judgeCalls <= max - want) { r.counters.judgeCalls += want; return want; }
        }
        return 0;
      },
      listExpiredAwaiting: async (now) => clone(db.runs.filter((r) => r.mode === 'sdk' && ['awaiting_traces', 'running'].includes(r.status) && r.awaitDeadline && r.awaitDeadline <= now)),
    },
    results: {
      async insertIfAbsent(orgId, doc) {
        if (inOrg(db.results, orgId).some((r) => r.runId === doc.runId && r.testCaseId === doc.testCaseId)) return { created: false };
        db.results.push({ ...clone(doc), id: newId(), organizationId: orgId }); return { created: true };
      },
      get: async (orgId, runId, testCaseId) => clone(inOrg(db.results, orgId).find((r) => r.runId === runId && r.testCaseId === testCaseId) ?? null),
      async list(orgId, runId, { status, limit, cursorId }) {
        let rows = inOrg(db.results, orgId).filter((r) => r.runId === runId && (!status || r.status === status)).sort((a, b) => (a.id < b.id ? -1 : 1));
        if (cursorId) rows = rows.filter((r) => r.id > cursorId);
        return { items: clone(rows.slice(0, limit)), hasMore: rows.length > limit };
      },
      listAll: async (orgId, runId) => clone(inOrg(db.results, orgId).filter((r) => r.runId === runId)),
      byTraceId: async (orgId, traceId) => clone(inOrg(db.results, orgId).filter((r) => r.traceId === traceId).slice(-20).reverse()),
      async metricStats(orgId, f) { return metricStatsOf(inOrg(db.results, orgId).filter((x) => resultFilter(x, f)), f); },
      async caseStats(orgId, f) { const out = { total: 0, passed: 0, failed: 0, inconclusive: 0, error: 0 }; for (const r of inOrg(db.results, orgId).filter((x) => resultFilter(x, f))) { out[r.status] += 1; out.total += 1; } return out; },
      async runTrend(orgId, f) {
        const g = new Map();
        for (const r of inOrg(db.results, orgId).filter((x) => resultFilter(x, f))) for (const m of r.metrics ?? []) { if (f.metric && m.metric !== f.metric) continue; const k = `${r.runId}|${m.metric}`; (g.get(k) ?? g.set(k, { runId: r.runId, metric: m.metric, scores: [], at: r.evaluatedAt }).get(k)).scores.push(m.score); const e = g.get(k); if (r.evaluatedAt > e.at) e.at = r.evaluatedAt; }
        return [...g.values()].map((e) => ({ runId: e.runId, metric: e.metric, avgScore: avg(e.scores), at: e.at })).sort((a, b) => b.at - a.at);
      },
      async versionQuality(orgId, f) {
        const g = new Map();
        for (const r of inOrg(db.results, orgId).filter((x) => resultFilter(x, f))) for (const m of r.metrics ?? []) { if (f.metric && m.metric !== f.metric) continue; const k = `${r.agentVersion ?? 'unversioned'}|${m.metric}`; (g.get(k) ?? g.set(k, { version: r.agentVersion ?? 'unversioned', metric: m.metric, scores: [] }).get(k)).scores.push(m.score); }
        return [...g.values()].map((e) => ({ version: e.version, metric: e.metric, avgScore: avg(e.scores), n: e.scores.length }));
      },
      async failedCases(orgId, f, limit) {
        return clone(inOrg(db.results, orgId).filter((r) => resultFilter(r, f) && ['failed', 'error'].includes(r.status)).sort((a, b) => b.evaluatedAt - a.evaluatedAt).slice(0, limit)
          .map((r) => ({ runId: r.runId, testCaseId: r.testCaseId, traceId: r.traceId, inputPreview: r.inputPreview, status: r.status, error: r.error, evaluatedAt: r.evaluatedAt, failedMetrics: (r.metrics ?? []).filter((m) => m.status === 'fail').map((m) => m.metric) })));
      },
    },
    jobs: {
      async enqueue(orgId, job) {
        if (inOrg(db.jobs, orgId).some((j) => j.idempotencyKey === job.idempotencyKey)) return { created: false };
        const j = { ...stamp(job), organizationId: orgId, status: 'queued', attempts: 0, maxAttempts: job.maxAttempts ?? 3, runAt: job.runAt ?? new Date(0), lockedUntil: null };
        db.jobs.push(j); return { created: true, job: clone(j) };
      },
      async claim({ workerId, now, leaseMs }) {
        const due = db.jobs.filter((j) => (j.status === 'queued' && j.runAt <= now) || (j.status === 'running' && j.lockedUntil && j.lockedUntil < now)).sort((a, b) => a.runAt - b.runAt)[0];
        if (!due) return null;
        Object.assign(due, { status: 'running', lockedBy: workerId, lockedUntil: new Date(now.getTime() + leaseMs) }); due.attempts += 1; return clone(due);
      },
      async complete(id) { const j = db.jobs.find((x) => x.id === id); if (j) Object.assign(j, { status: 'succeeded', lockedUntil: null }); },
      async fail(id, { error, now, backoffMs, retry }) {
        const j = db.jobs.find((x) => x.id === id); if (!j) return { state: 'missing' };
        const again = retry && j.attempts < j.maxAttempts;
        Object.assign(j, again ? { status: 'queued', runAt: new Date(now.getTime() + backoffMs * 2 ** (j.attempts - 1)), lockedUntil: null, lastError: String(error) } : { status: 'failed', lockedUntil: null, lastError: String(error) });
        return { state: again ? 'queued' : 'failed' };
      },
      async cancelForRun(orgId, runId) { let n = 0; for (const j of inOrg(db.jobs, orgId)) if (j.runId === runId && ['queued', 'running'].includes(j.status)) { j.status = 'cancelled'; n++; } return n; },
      caseIdsForRun: async (orgId, runId) => inOrg(db.jobs, orgId).filter((j) => j.runId === runId && j.status !== 'cancelled').map((j) => j.testCaseId),
    },
    // ---- Milestone 5 (mirrors repos/mongo.js) ----
    rollups: {
      async deleteDemo(orgId) { const n = db.rollups.length; db.rollups = db.rollups.filter((r) => !(r.organizationId === orgId && r.isDemo)); return n - db.rollups.length; },
      async record(orgId, r) {
        const key = [r.agentId, r.agentVersion ?? '', r.environment, Boolean(r.isDemo), r.hour.getTime()].join('|');
        let d = inOrg(db.rollups, orgId).find((x) => x._key === key);
        if (!d) { d = { _key: key, id: newId(), organizationId: orgId, agentId: r.agentId, agentVersion: r.agentVersion ?? '', environment: r.environment, isDemo: Boolean(r.isDemo), hour: r.hour, count: 0, errors: 0, failed: 0, sumDurationMs: 0, maxDurationMs: 0, durationN: 0, tokens: 0, costUsd: 0, costN: 0, lat: {}, expiresAt: r.expiresAt }; db.rollups.push(d); }
        d.count += 1; d.errors += r.status === 'error' ? 1 : 0; d.failed += r.status !== 'success' ? 1 : 0; d.tokens += r.tokens ?? 0;
        if (typeof r.durationMs === 'number') { d.sumDurationMs += r.durationMs; d.durationN += 1; if (r.bucket !== null && r.bucket !== undefined) d.lat[r.bucket] = (d.lat[r.bucket] ?? 0) + 1; }
        d.maxDurationMs = Math.max(d.maxDurationMs, r.durationMs ?? 0);
        if (typeof r.costUsd === 'number') { d.costUsd += r.costUsd; d.costN += 1; }
      },
      async range(orgId, f) {
        return clone(inOrg(db.rollups, orgId).filter((d) => (!f.from || d.hour >= f.from) && (!f.to || d.hour < f.to) && (!f.agentId || d.agentId === f.agentId) && (f.version === undefined || d.agentVersion === f.version)
          && (!f.environment || d.environment === f.environment) && (typeof f.isDemo !== 'boolean' || d.isDemo === f.isDemo)).sort((a, b) => a.hour - b.hour).map(({ _key, ...rest }) => rest)); // eslint-disable-line no-unused-vars
      },
    },
    usage: {
      // No await between the check and the increment, so concurrent callers are serialised exactly like Mongo's conditional update.
      async reserve(orgId, agentId, day, field, wanted, max, { expiresAt } = {}) {
        let u = inOrg(db.usage, orgId).find((x) => x.agentId === agentId && x.day === day);
        if (!u) { u = { id: newId(), organizationId: orgId, agentId, day, queued: 0, skippedBudget: 0, judgeCalls: 0, expiresAt }; db.usage.push(u); }
        if (max === null || max === undefined) { u[field] += wanted; return wanted; }
        for (const want of [...new Set([wanted, Math.ceil(wanted / 2), 1])].filter((n) => n > 0)) {
          if (u[field] <= max - want) { u[field] += want; return want; }
        }
        return 0;
      },
      async add(orgId, agentId, day, inc, { expiresAt } = {}) {
        let u = inOrg(db.usage, orgId).find((x) => x.agentId === agentId && x.day === day);
        if (!u) { u = { id: newId(), organizationId: orgId, agentId, day, queued: 0, skippedBudget: 0, judgeCalls: 0, expiresAt }; db.usage.push(u); }
        for (const [k, v] of Object.entries(inc)) u[k] = (u[k] ?? 0) + v;
      },
      get: async (orgId, agentId, day) => clone(inOrg(db.usage, orgId).find((x) => x.agentId === agentId && x.day === day) ?? null),
    },
    prodEvals: {
      async insertIfAbsent(orgId, doc) {
        if (inOrg(db.prodEvals, orgId).some((r) => r.traceId === doc.traceId)) return { created: false };
        db.prodEvals.push({ ...clone(doc), id: newId(), organizationId: orgId }); return { created: true };
      },
      byTraceId: async (orgId, traceId) => clone(inOrg(db.prodEvals, orgId).find((r) => r.traceId === traceId) ?? null),
      async recent(orgId, { agentId, limit }) {
        return clone(inOrg(db.prodEvals, orgId).filter((r) => !agentId || r.agentId === agentId).sort((a, b) => b.evaluatedAt - a.evaluatedAt || (a.id < b.id ? 1 : -1)).slice(0, limit)
          .map(({ agentId: a, agentVersion, traceId, status, reason, evaluatedAt, inputPreview, metrics }) => ({ agentId: a, agentVersion, traceId, status, reason, evaluatedAt, inputPreview, metrics: (metrics ?? []).map(({ metric, status: st, score }) => ({ metric, status: st, score })) })));
      },
      async metricStats(orgId, f) { return metricStatsOf(inOrg(db.prodEvals, orgId).filter((x) => resultFilter(x, f)), f).map(({ metric, n, pass, fail, inconclusive, avgScore }) => ({ metric, n, pass, fail, inconclusive, avgScore })); },
      async statusCounts(orgId, f) { const out = { total: 0, passed: 0, failed: 0, inconclusive: 0 }; for (const r of inOrg(db.prodEvals, orgId).filter((x) => resultFilter(x, f))) { out[r.status] += 1; out.total += 1; } return out; },
    },
    alertRules: {
      async create(orgId, doc) { const r = { ...stamp(doc), organizationId: orgId, nextEvalAt: doc.nextEvalAt ?? new Date(0) }; db.alertRules.push(r); return clone(r); },
      get: async (orgId, id) => clone(inOrg(db.alertRules, orgId).find((r) => r.id === id) ?? null),
      count: async (orgId) => inOrg(db.alertRules, orgId).length,
      async list(orgId, { limit, cursorId, agentId }) {
        let rows = inOrg(db.alertRules, orgId).filter((r) => !agentId || r.agentId === agentId).sort((a, b) => (a.id < b.id ? 1 : -1));
        if (cursorId) rows = rows.filter((r) => r.id < cursorId);
        return { items: clone(rows.slice(0, limit)), hasMore: rows.length > limit };
      },
      async update(orgId, id, patch) { const r = inOrg(db.alertRules, orgId).find((x) => x.id === id); if (!r) return null; Object.assign(r, clone(patch), { updatedAt: new Date() }); return clone(r); },
      async remove(orgId, id) { const i = db.alertRules.findIndex((r) => r.organizationId === orgId && r.id === id); if (i < 0) return false; db.alertRules.splice(i, 1); return true; },
      async claimDue({ now, leaseMs }) {
        const r = db.alertRules.filter((x) => x.enabled && x.nextEvalAt <= now).sort((a, b) => a.nextEvalAt - b.nextEvalAt)[0];
        if (!r) return null;
        r.nextEvalAt = new Date(now.getTime() + leaseMs); return clone(r);
      },
    },
    alerts: {
      findOpenForRule: async (orgId, ruleId) => clone(inOrg(db.alerts, orgId).find((a) => a.ruleId === ruleId && ['open', 'acknowledged'].includes(a.status)) ?? null),
      async create(orgId, doc) {
        if (inOrg(db.alerts, orgId).some((a) => a.ruleId === doc.ruleId && ['open', 'acknowledged'].includes(a.status))) return { created: false };
        const a = { ...stamp(doc), organizationId: orgId, evaluations: doc.evaluations ?? 1, notifications: [] }; db.alerts.push(a); return { created: true, alert: clone(a) };
      },
      get: async (orgId, id) => clone(inOrg(db.alerts, orgId).find((a) => a.id === id) ?? null),
      async update(orgId, id, patch, { ifStatusIn } = {}) { const a = inOrg(db.alerts, orgId).find((x) => x.id === id); if (!a || (ifStatusIn && !ifStatusIn.includes(a.status))) return null; Object.assign(a, clone(patch), { updatedAt: new Date() }); return clone(a); },
      async incEvaluations(orgId, id, patch) { const a = inOrg(db.alerts, orgId).find((x) => x.id === id && ['open', 'acknowledged'].includes(x.status)); if (!a) return null; Object.assign(a, clone(patch)); a.evaluations += 1; return clone(a); },
      async pushNotification(orgId, id, entry) { const a = inOrg(db.alerts, orgId).find((x) => x.id === id); if (a) a.notifications = [...a.notifications, clone(entry)].slice(-20); },
      async list(orgId, { status, agentId, ruleId, limit, cursorId }) {
        let rows = inOrg(db.alerts, orgId).filter((a) => (!status || (Array.isArray(status) ? status.includes(a.status) : a.status === status)) && (!agentId || a.agentId === agentId) && (!ruleId || a.ruleId === ruleId)).sort((a, b) => (a.id < b.id ? 1 : -1));
        if (cursorId) rows = rows.filter((a) => a.id < cursorId);
        return { items: clone(rows.slice(0, limit)), hasMore: rows.length > limit };
      },
      async openCounts(orgId) {
        const g = new Map();
        for (const a of inOrg(db.alerts, orgId).filter((x) => ['open', 'acknowledged'].includes(x.status))) { const k = `${a.agentId ?? ''}|${a.severity}`; g.set(k, { agentId: a.agentId ?? null, severity: a.severity, n: (g.get(k)?.n ?? 0) + 1 }); }
        return [...g.values()];
      },
    },
    // ---- Milestone 6 (mirrors repos/mongo.js) ----
    sessions: {
      async create(doc) { const x = stamp(doc); db.sessions.push(x); return clone(x); },
      get: async (id) => clone(db.sessions.find((x) => x.id === id) ?? null),
      findByRefreshHash: async (h) => clone(db.sessions.find((x) => x.refreshHash === h || (x.previousHashes ?? []).includes(h)) ?? null),
      async rotate(id, oldHash, newHash, at, expiresAt) { const x = db.sessions.find((s) => s.id === id && s.refreshHash === oldHash && !s.revokedAt); if (!x) return null; x.previousHashes = [...(x.previousHashes ?? []), oldHash].slice(-5); Object.assign(x, { refreshHash: newHash, lastUsedAt: at, expiresAt }); return clone(x); },
      async revoke(id, at) { const x = db.sessions.find((s) => s.id === id && !s.revokedAt); if (x) x.revokedAt = at; },
      async revokeAllForUser(userId, at) { for (const x of db.sessions) if (x.userId === userId && !x.revokedAt) x.revokedAt = at; },
    },
    tokens: {
      async create(orgId, doc) { const x = { ...stamp(doc), organizationId: orgId }; db.tokens.push(x); return clone(x); },
      findByHash: async (h) => clone(db.tokens.find((x) => x.tokenHash === h) ?? null),
      async consume(h, now) { const x = db.tokens.find((t) => t.tokenHash === h && !t.usedAt && !t.revokedAt && t.expiresAt > now); if (!x) return null; x.usedAt = now; return clone(x); },
      async listPending(orgId, purpose, now) { return clone(inOrg(db.tokens, orgId).filter((t) => t.purpose === purpose && !t.usedAt && !t.revokedAt && t.expiresAt > now).sort((a, b) => (a.id < b.id ? 1 : -1)).map(({ tokenHash, ...rest }) => rest)); }, // eslint-disable-line no-unused-vars
      async revoke(orgId, id, at) { const x = inOrg(db.tokens, orgId).find((t) => t.id === id && !t.usedAt && !t.revokedAt); if (!x) return null; x.revokedAt = at; return clone(x); },
    },
    throttle: {
      get: async (key) => clone(db.throttle.find((x) => x.key === key) ?? null),
      async fail(key, now, { max, windowMs, lockMs }) {
        db.throttle = db.throttle.filter((x) => !(x.key === key && x.expiresAt <= now));
        let d = db.throttle.find((x) => x.key === key);
        if (!d) { d = { key, count: 0, windowStart: now, expiresAt: new Date(now.getTime() + windowMs) }; db.throttle.push(d); }
        d.count += 1;
        if (d.count >= max) { d.lockedUntil = new Date(now.getTime() + lockMs); d.expiresAt = new Date(Math.max(d.lockedUntil.getTime(), d.expiresAt.getTime())); }
        return clone(d);
      },
      async clear(key) { db.throttle = db.throttle.filter((x) => x.key !== key); },
    },
    audit: {
      append: async (e) => { db.audit.push({ id: newId(), ...clone(e) }); },
      async list(orgId, { action, limit, cursorId }) {
        let rows = db.audit.filter((e) => e.organizationId === orgId && (!action || e.action === action)).sort((a, b) => (a.id < b.id ? 1 : -1));
        if (cursorId) rows = rows.filter((e) => e.id < cursorId);
        return { items: clone(rows.slice(0, limit)), hasMore: rows.length > limit };
      },
    },
  };
  return repos;
}
