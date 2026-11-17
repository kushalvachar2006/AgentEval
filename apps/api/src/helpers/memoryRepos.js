import { AppError } from '../../src/middleware/errors.js';

let counter = 0;
const newId = () => (++counter).toString(16).padStart(24, '0');
const clone = (x) => structuredClone(x);

export function createMemoryRepos() {
  const db = { users: [], orgs: [], agents: [], versions: [], keys: [], traces: [], audit: [] };
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
    },
    orgs: {
      async create(doc) { const o = stamp(doc); db.orgs.push(o); return clone(o); },
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
      async insertIfAbsent(orgId, doc) {
        if (inOrg(db.traces, orgId).some((t) => t.traceId === doc.traceId)) return { inserted: false };
        db.traces.push({ ...clone(doc), id: newId(), organizationId: orgId }); return { inserted: true };
      },
      get: async (orgId, traceId) => clone(inOrg(db.traces, orgId).find((t) => t.traceId === traceId) ?? null),
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
    audit: { append: async (e) => { db.audit.push(clone(e)); } },
  };
  return repos;
}
