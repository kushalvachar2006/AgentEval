import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../../src/config/env.js';
import { buildServices, buildWorker } from '../../src/composition.js';
import { AppError } from '../../src/middleware/errors.js';
import { createMemoryRepos } from './memoryRepos.js';

export const validTrace = JSON.parse(readFileSync(new URL('../../../../packages/trace-schema/fixtures/valid-trace.json', import.meta.url), 'utf8'));

export const testEnv = () => ({
  MONGODB_URI: 'mongodb://localhost/x', JWT_SECRET: 'j'.repeat(40), ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), CORS_ORIGINS: 'http://localhost:5173',
});

// Stub for the SSRF guard so service tests never touch DNS (the guard itself has its own tests).
const fakeSsrf = async (url) => { if (/localhost|169\.254/.test(url)) throw new AppError(422, 'UNSAFE_ENDPOINT', 'blocked'); return { url }; };

export function makeWorld(envOverrides = {}, extraDeps = {}) {
  const config = loadConfig({ ...testEnv(), ...envOverrides });
  const repos = createMemoryRepos();
  const deps = { assertSafeUrl: fakeSsrf, ...extraDeps };
  const services = buildServices({ repos, config, deps });
  const worker = buildWorker({ repos, config, services, deps });
  let n = 0;
  async function signup(label = `user${++n}`) {
    const email = `${label}@example.com`;
    const r = await services.auth.register({ email, password: 'correct-horse-1', name: label, organizationName: `${label} org` });
    const principal = await services.auth.authenticateUser(r.token);
    return { ...r, email, principal };
  }
  const newAgent = (principal, name = 'agent-1', extra = {}) => services.agents.create(principal, { name, framework: 'langchain', ...extra });
  const traceFor = (agentId, patch = {}) => ({ ...structuredClone(validTrace), agentId, traceId: crypto.randomBytes(16).toString('hex'), ...patch });
  return { config, repos, services, worker, signup, newAgent, traceFor };
}

// ---------- helpers for evaluation tests ----------
import http from 'node:http';
import { spawnSync } from 'node:child_process';

export function findPython() {
  for (const c of ['python3', 'python', 'py']) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 && /Python 3\.\d+/.test(`${r.stdout}${r.stderr}`)) return c;
  }
  return null;
}

export const CASES = [
  { input: 'Find the cheapest laptop below ₹50,000.', referenceAnswer: 'Acme Book 14 at ₹47,999', requiredElements: ['Acme Book 14', '₹47,999'], expectedToolCalls: [{ name: 'search_products', args: { maxPrice: 50000 } }] },
  { input: 'What is the refund window?', referenceAnswer: 'Refunds are available within 30 days of purchase.', referenceEvidence: ['The refund window is 30 days from the date of purchase.'] },
  { input: 'Say hello in one line.', constraints: { maxChars: 40, format: 'single_line' } },
];

export async function seedSuite(w, principal, name = 'suite-1', cases = CASES) {
  const suite = await w.services.suites.create(principal, { name });
  await w.services.suites.importCases(principal, suite.id, { format: 'json', content: JSON.stringify(cases) });
  return suite;
}

export function listen(handler) {
  return new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res({ s, port: s.address().port, close: () => s.close() })); });
}

// A fake evaluation engine: records calls, returns whatever `respond(payload)` says.
export function fakeEngine(respond) {
  const calls = [];
  return { calls, async evaluate(payload) { calls.push(payload); return respond ? respond(payload, calls.length) : { results: payload.evaluators.map((e) => ({ metric: e.metric, status: 'pass', score: 1, confidence: 0.9, evaluatorVersion: e.version, explanation: 'ok', findings: [], meta: {} })), judgeCalls: 0 }; } };
}
