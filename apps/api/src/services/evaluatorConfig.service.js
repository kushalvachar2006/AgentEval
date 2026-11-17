import { AppError } from '../middleware/errors.js';
import { check } from '../lib/validate.js';
import { requirePermission } from '../lib/rbac.js';
import { assertSafeUrl } from '../lib/ssrf.js';

const PROVIDERS = ['openai_compatible', 'anthropic'];
const publicJudge = (j) => ({ enabled: Boolean(j?.enabled), provider: j?.provider ?? null, model: j?.model ?? '', baseUrl: j?.baseUrl ?? '', hasApiKey: Boolean(j?.apiKeyEnc), temperature: j?.temperature ?? null, maxTokens: j?.maxTokens ?? null });

export function createEvaluatorConfigService({ repos, config, audit, secrets, deps = {} }) {
  const safeUrl = deps.assertSafeUrl ?? assertSafeUrl;
  return {
    async get(principal) {
      requirePermission(principal, 'evaluations:read');
      return { judge: publicJudge((await repos.evaluatorConfigs.get(principal.organizationId))?.judge) };
    },

    async put(principal, body) {
      requirePermission(principal, 'settings:manage');
      const prev = (await repos.evaluatorConfigs.get(principal.organizationId))?.judge ?? {};
      const j = body?.judge;
      const c = check();
      if (j === null || typeof j !== 'object' || Array.isArray(j)) { c.fail('judge', 'is required'); c.done(); }
      const enabled = typeof j.enabled === 'boolean' ? j.enabled : (c.fail('judge.enabled', 'must be true or false'), false);
      const provider = c.oneOf(j.provider, 'judge.provider', PROVIDERS, { optional: !enabled });
      const model = c.str(j.model, 'judge.model', { max: 200, optional: !enabled });
      let baseUrl = c.str(j.baseUrl, 'judge.baseUrl', { max: 500, optional: true });
      let temperature = j.temperature, maxTokens = j.maxTokens;
      if (temperature !== undefined && temperature !== null && !(typeof temperature === 'number' && temperature >= 0 && temperature <= 2)) c.fail('judge.temperature', 'must be a number from 0 to 2');
      if (maxTokens !== undefined && maxTokens !== null && !(Number.isInteger(maxTokens) && maxTokens >= 1 && maxTokens <= 8000)) c.fail('judge.maxTokens', 'must be an integer from 1 to 8000');
      let apiKeyEnc = prev.apiKeyEnc;
      if (j.apiKey !== undefined) {
        if (typeof j.apiKey !== 'string' || j.apiKey.length < 8 || j.apiKey.length > 500) c.fail('judge.apiKey', 'must be a string of 8-500 characters');
        else apiKeyEnc = secrets.encrypt(j.apiKey);
      }
      if (j.clearApiKey === true) apiKeyEnc = undefined;
      c.done();
      if (enabled && provider === 'anthropic' && !apiKeyEnc) throw new AppError(422, 'VALIDATION_ERROR', 'Request validation failed', [{ path: 'judge.apiKey', message: 'is required for the anthropic provider' }]);
      if (baseUrl) baseUrl = (await safeUrl(baseUrl, { allowPrivate: config.allowPrivateEndpoints })).url.replace(/\/$/, '');
      const judge = { enabled, provider, model, baseUrl, apiKeyEnc, temperature: temperature ?? undefined, maxTokens: maxTokens ?? undefined };
      await repos.evaluatorConfigs.upsert(principal.organizationId, { judge, updatedBy: principal.userId });
      await audit.log({ organizationId: principal.organizationId, actorId: principal.userId, action: 'evaluator-config.update', meta: { enabled, provider, keyChanged: j.apiKey !== undefined || j.clearApiKey === true } });
      return { judge: publicJudge(judge) };
    },

    // Worker-side only: decrypted credentials, never returned by the API.
    async judgeFor(organizationId) {
      const j = (await repos.evaluatorConfigs.get(organizationId))?.judge;
      if (!j?.enabled || !j.provider || !j.model) return null;
      return { provider: j.provider, model: j.model, baseUrl: j.baseUrl || undefined, apiKey: j.apiKeyEnc ? secrets.decrypt(j.apiKeyEnc) : '', temperature: j.temperature ?? undefined, maxTokens: j.maxTokens ?? undefined };
    },
  };
}
