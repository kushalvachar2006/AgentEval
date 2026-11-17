import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../../src/config/env.js';
import { buildServices } from '../../src/composition.js';
import { AppError } from '../../src/middleware/errors.js';
import { createMemoryRepos } from './memoryRepos.js';

export const validTrace = JSON.parse(readFileSync(new URL('../../../../packages/trace-schema/fixtures/valid-trace.json', import.meta.url), 'utf8'));

export const testEnv = () => ({
  MONGODB_URI: 'mongodb://localhost/x', JWT_SECRET: 'j'.repeat(40), ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), CORS_ORIGINS: 'http://localhost:5173',
});

// Stub for the SSRF guard so service tests never touch DNS (the guard itself has its own tests).
const fakeSsrf = async (url) => { if (/localhost|169\.254/.test(url)) throw new AppError(422, 'UNSAFE_ENDPOINT', 'blocked'); return { url }; };

export function makeWorld(envOverrides = {}) {
  const config = loadConfig({ ...testEnv(), ...envOverrides });
  const repos = createMemoryRepos();
  const services = buildServices({ repos, config, deps: { assertSafeUrl: fakeSsrf } });
  let n = 0;
  async function signup(label = `user${++n}`) {
    const email = `${label}@example.com`;
    const r = await services.auth.register({ email, password: 'correct-horse-1', name: label, organizationName: `${label} org` });
    const principal = await services.auth.authenticateUser(r.token);
    return { ...r, email, principal };
  }
  const newAgent = (principal, name = 'agent-1', extra = {}) => services.agents.create(principal, { name, framework: 'langchain', ...extra });
  const traceFor = (agentId, patch = {}) => ({ ...structuredClone(validTrace), agentId, traceId: crypto.randomBytes(16).toString('hex'), ...patch });
  return { config, repos, services, signup, newAgent, traceFor };
}
