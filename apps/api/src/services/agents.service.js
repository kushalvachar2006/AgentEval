import { AppError } from '../middleware/errors.js';
import { check, parseLimit, queryString, encodeCursor, decodeCursor } from '../lib/validate.js';
import { isId } from '../lib/ids.js';
import { requirePermission } from '../lib/rbac.js';
import { sanitize } from '../lib/redact.js';
import { assertSafeUrl } from '../lib/ssrf.js';

const FRAMEWORKS = ['langchain', 'langgraph', 'custom'];
const INTEGRATIONS = ['sdk', 'api'];
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/;
const publicAgent = (a) => ({ id: a.id, name: a.name, description: a.description ?? '', framework: a.framework, integrationType: a.integrationType, endpointUrl: a.endpointUrl ?? null, hasEndpointToken: Boolean(a.endpointTokenEnc), currentVersion: a.currentVersion, status: a.status, config: a.config ?? {}, lastTraceAt: a.lastTraceAt ?? null, createdAt: a.createdAt, updatedAt: a.updatedAt });
const publicVersion = (v) => ({ id: v.id, agentId: v.agentId, version: v.version, notes: v.notes ?? '', source: v.source, createdAt: v.createdAt });

export function createAgentService({ repos, config, audit, secrets, deps = {} }) {
  const safeUrl = deps.assertSafeUrl ?? assertSafeUrl;
  const orgOf = (p) => p.organizationId;

  async function getOr404(principal, id) {
    const agent = isId(id) ? await repos.agents.get(orgOf(principal), id) : null;
    if (!agent || (principal.agentId && principal.agentId !== agent.id)) throw new AppError(404, 'AGENT_NOT_FOUND', 'Agent not found');
    return agent;
  }
  const cleanConfig = (c) => (c ? sanitize(c).value : undefined);

  return {
    async create(principal, body) {
      requirePermission(principal, 'agents:write');
      if (principal.agentId) throw new AppError(403, 'FORBIDDEN', 'This API key is restricted to a single agent');
      const c = check();
      const name = c.str(body?.name, 'name', { max: 100 });
      const description = c.str(body?.description, 'description', { min: 0, max: 1000, optional: true });
      const framework = c.oneOf(body?.framework, 'framework', FRAMEWORKS);
      const integrationType = c.oneOf(body?.integrationType, 'integrationType', INTEGRATIONS, { optional: true, fallback: 'sdk' });
      const version = c.str(body?.version ?? '1.0.0', 'version', { max: 32 });
      if (version && !VERSION_RE.test(version)) c.fail('version', 'may contain letters, digits and . + _ - only');
      const cfg = c.obj(body?.config, 'config');
      let endpointUrl;
      if (integrationType === 'api') {
        endpointUrl = c.str(body?.endpointUrl, 'endpointUrl', { max: 500 });
      } else if (body?.endpointUrl) c.fail('endpointUrl', 'is only allowed for integrationType "api"');
      const token = body?.endpointToken;
      if (token !== undefined && (integrationType !== 'api' || typeof token !== 'string' || token.length < 8 || token.length > 500)) c.fail('endpointToken', integrationType !== 'api' ? 'is only allowed for integrationType "api"' : 'must be a string of 8-500 characters');
      c.done();
      if (endpointUrl) endpointUrl = (await safeUrl(endpointUrl, { allowPrivate: config.allowPrivateEndpoints })).url;

      const agent = await repos.agents.create(orgOf(principal), { name, description: description ?? '', framework, integrationType, endpointUrl, currentVersion: version, status: 'pending', config: cleanConfig(cfg), endpointTokenEnc: token ? secrets.encrypt(token) : undefined, createdBy: principal.userId ?? null });
      await repos.versions.create(orgOf(principal), { agentId: agent.id, version, source: 'manual', config: cleanConfig(cfg) });
      await audit.log({ organizationId: orgOf(principal), actorId: principal.userId, action: 'agent.create', target: agent.id });
      return publicAgent(agent);
    },

    async list(principal, query = {}) {
      requirePermission(principal, 'agents:read');
      const limit = parseLimit(query.limit);
      const cur = decodeCursor(queryString(query, 'cursor'));
      if (cur && !isId(cur.id)) throw new AppError(400, 'INVALID_CURSOR', 'cursor is not valid');
      const framework = queryString(query, 'framework');
      if (framework && !FRAMEWORKS.includes(framework)) throw new AppError(400, 'INVALID_QUERY', 'unknown framework');
      const { items, hasMore } = await repos.agents.list(orgOf(principal), { limit, cursorId: cur?.id, name: queryString(query, 'name'), framework, onlyId: principal.agentId ?? undefined });
      return { items: items.map(publicAgent), nextCursor: hasMore ? encodeCursor({ id: items.at(-1).id }) : null };
    },

    async get(principal, id) {
      requirePermission(principal, 'agents:read');
      return publicAgent(await getOr404(principal, id));
    },

    async update(principal, id, body) {
      requirePermission(principal, 'agents:write');
      const existing = await getOr404(principal, id);
      const c = check();
      const patch = {};
      if (body?.name !== undefined) patch.name = c.str(body.name, 'name', { max: 100 });
      if (body?.description !== undefined) patch.description = c.str(body.description, 'description', { min: 0, max: 1000 });
      if (body?.config !== undefined) patch.config = c.obj(body.config, 'config');
      if (body?.endpointUrl !== undefined) patch.endpointUrl = c.str(body.endpointUrl, 'endpointUrl', { max: 500 });
      if (body?.endpointToken !== undefined || body?.clearEndpointToken !== undefined) {
        if (existing.integrationType !== 'api') c.fail('endpointToken', 'is only allowed for agents with integrationType "api"');
        else if (body.clearEndpointToken === true) patch.endpointTokenEnc = null;
        else if (typeof body.endpointToken !== 'string' || body.endpointToken.length < 8 || body.endpointToken.length > 500) c.fail('endpointToken', 'must be a string of 8-500 characters');
        else patch.endpointTokenEnc = secrets.encrypt(body.endpointToken);
      }
      const allowed = ['name', 'description', 'config', 'endpointUrl', 'endpointToken', 'clearEndpointToken'];
      for (const k of Object.keys(body ?? {})) if (!allowed.includes(k)) c.fail(k, 'cannot be changed here');
      if (!Object.keys(body ?? {}).length) c.fail('body', 'nothing to update');
      c.done();
      if (patch.endpointTokenEnc !== undefined) await audit.log({ organizationId: orgOf(principal), actorId: principal.userId, action: 'agent.endpoint-token', target: id });
      if (patch.endpointUrl) patch.endpointUrl = (await safeUrl(patch.endpointUrl, { allowPrivate: config.allowPrivateEndpoints })).url;
      if (patch.config) patch.config = cleanConfig(patch.config);
      const updated = await repos.agents.update(orgOf(principal), id, patch);
      await audit.log({ organizationId: orgOf(principal), actorId: principal.userId, action: 'agent.update', target: id, meta: { fields: Object.keys(patch).filter((k) => k !== 'endpointTokenEnc') } });
      return publicAgent(updated);
    },

    async archive(principal, id) {
      requirePermission(principal, 'agents:delete');
      await getOr404(principal, id);
      await repos.agents.archive(orgOf(principal), id);
      await repos.apiKeys.revokeForAgent(orgOf(principal), id, new Date());
      await audit.log({ organizationId: orgOf(principal), actorId: principal.userId, action: 'agent.archive', target: id });
    },

    async listVersions(principal, id) {
      requirePermission(principal, 'agents:read');
      await getOr404(principal, id);
      return { items: (await repos.versions.list(orgOf(principal), id)).map(publicVersion) };
    },

    async addVersion(principal, id, body) {
      requirePermission(principal, 'agents:write');
      await getOr404(principal, id);
      const c = check();
      const version = c.str(body?.version, 'version', { max: 32 });
      if (version && !VERSION_RE.test(version)) c.fail('version', 'may contain letters, digits and . + _ - only');
      const notes = c.str(body?.notes, 'notes', { min: 0, max: 1000, optional: true });
      const cfg = c.obj(body?.config, 'config');
      c.done();
      const v = await repos.versions.create(orgOf(principal), { agentId: id, version, notes, source: 'manual', config: cleanConfig(cfg) });
      if (body?.setCurrent !== false) await repos.agents.update(orgOf(principal), id, { currentVersion: version });
      await audit.log({ organizationId: orgOf(principal), actorId: principal.userId, action: 'agent.version', target: id, meta: { version } });
      return publicVersion(v);
    },
  };
}
