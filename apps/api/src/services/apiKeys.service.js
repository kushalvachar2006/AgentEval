import { AppError } from '../middleware/errors.js';
import { check } from '../lib/validate.js';
import { isId } from '../lib/ids.js';
import { requirePermission, KEY_SCOPES } from '../lib/rbac.js';
import { generateApiKey, sha256Hex, API_KEY_RE } from '../lib/crypto.js';

const publicKey = (k) => ({ id: k.id, name: k.name, keyPrefix: k.keyPrefix, scopes: k.scopes, agentId: k.agentId ?? null, createdAt: k.createdAt, expiresAt: k.expiresAt ?? null, lastUsedAt: k.lastUsedAt ?? null, revokedAt: k.revokedAt ?? null });

export function createApiKeyService({ repos, audit, now = () => new Date() }) {
  return {
    async create(principal, body) {
      requirePermission(principal, 'keys:manage');
      const c = check();
      const name = c.str(body?.name, 'name', { max: 64 });
      const scopes = body?.scopes ?? ['traces:write'];
      if (!Array.isArray(scopes) || !scopes.length || !scopes.every((s) => KEY_SCOPES.includes(s))) c.fail('scopes', `must be a non-empty subset of: ${KEY_SCOPES.join(', ')}`);
      let days;
      if (body?.expiresInDays !== undefined) { days = body.expiresInDays; if (!Number.isInteger(days) || days < 1 || days > 365) c.fail('expiresInDays', 'must be an integer from 1 to 365'); }
      c.done();

      let agentId = null;
      if (body?.agentId !== undefined && body.agentId !== null) {
        const agent = isId(body.agentId) ? await repos.agents.get(principal.organizationId, body.agentId) : null;
        if (!agent) throw new AppError(404, 'AGENT_NOT_FOUND', 'Agent not found');
        agentId = agent.id;
      }
      const { key, keyHash, keyPrefix } = generateApiKey();
      const rec = await repos.apiKeys.create(principal.organizationId, {
        name, keyHash, keyPrefix, scopes, agentId, createdBy: principal.userId, createdAt: now(),
        expiresAt: days ? new Date(now().getTime() + days * 86_400_000) : null, revokedAt: null, lastUsedAt: null,
      });
      await audit.log({ organizationId: principal.organizationId, actorId: principal.userId, action: 'apikey.create', target: rec.id });
      return { ...publicKey(rec), key }; // the only time the plaintext key is ever returned
    },

    async list(principal) {
      requirePermission(principal, 'keys:manage');
      return { items: (await repos.apiKeys.list(principal.organizationId)).map(publicKey) };
    },

    async revoke(principal, id) {
      requirePermission(principal, 'keys:manage');
      const rec = isId(id) ? await repos.apiKeys.revoke(principal.organizationId, id, now()) : null;
      if (!rec) throw new AppError(404, 'NOT_FOUND', 'API key not found');
      await audit.log({ organizationId: principal.organizationId, actorId: principal.userId, action: 'apikey.revoke', target: id });
    },

    async authenticate(raw) {
      const invalid = () => new AppError(401, 'INVALID_API_KEY', 'API key is invalid, revoked or expired');
      if (!API_KEY_RE.test(raw)) throw invalid();
      const rec = await repos.apiKeys.findByHash(sha256Hex(raw));
      const t = now();
      if (!rec || rec.revokedAt || (rec.expiresAt && new Date(rec.expiresAt) <= t)) throw invalid();
      if (!rec.lastUsedAt || t - new Date(rec.lastUsedAt) > 60_000) await repos.apiKeys.touch(rec.id, t); // throttled write
      return { type: 'apiKey', keyId: rec.id, organizationId: rec.organizationId, agentId: rec.agentId ?? null, scopes: rec.scopes };
    },
  };
}
