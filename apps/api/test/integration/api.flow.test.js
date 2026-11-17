// End-to-end over real HTTP using Express + in-memory repositories (no MongoDB needed).
// Needs `npm install`. Run: npm --prefix apps/api run test:integration
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.js';
import { buildServices } from '../../src/composition.js';
import { loadConfig } from '../../src/config/env.js';
import { createMemoryRepos } from '../helpers/memoryRepos.js';
import { testEnv, validTrace } from '../helpers/world.js';
import crypto from 'node:crypto';

async function boot(env = {}) {
  const config = loadConfig({ ...testEnv(), ...env });
  const services = buildServices({ repos: createMemoryRepos(), config, deps: { assertSafeUrl: async (u) => ({ url: u }) } });
  const server = createApp({ config, services, checks: {} }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { token, body, headers = {} } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }), ...headers }, body: body && JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return { call, close: () => server.close() };
}
const newTrace = (agentId) => ({ ...structuredClone(validTrace), agentId, traceId: crypto.randomBytes(16).toString('hex') });

test('full novice flow: register -> agent -> key -> ingest -> read; plus isolation and abuse cases', async () => {
  const { call, close } = await boot();
  try {
    const reg = await call('POST', '/auth/register', { body: { email: 'a@example.com', password: 'correct-horse-1', name: 'A', organizationName: 'Acme' } });
    assert.equal(reg.status, 201);
    const jwt = reg.body.token;
    assert.equal((await call('GET', '/auth/me', { token: jwt })).body.user.email, 'a@example.com');
    assert.equal((await call('GET', '/agents')).status, 401);

    const ag = await call('POST', '/agents', { token: jwt, body: { name: 'laptop-agent', framework: 'langchain' } });
    assert.equal(ag.status, 201);
    const key = await call('POST', '/api-keys', { token: jwt, body: { name: 'sdk' } });
    assert.equal(key.status, 201);
    assert.match(key.body.key, /^ae_live_/);

    const t = newTrace(ag.body.id);
    const first = await call('POST', '/traces', { token: key.body.key, body: t });
    assert.equal(first.status, 202);
    assert.equal((await call('POST', '/traces', { token: key.body.key, body: t })).status, 200); // duplicate = idempotent
    assert.equal((await call('POST', '/traces', { headers: { 'x-api-key': key.body.key }, body: newTrace(ag.body.id) })).status, 202); // X-API-Key header works

    const list = await call('GET', `/agents/${ag.body.id}/traces?limit=10`, { token: jwt });
    assert.equal(list.body.items.length, 2);
    assert.equal(list.body.items[0].spans, undefined);
    const one = await call('GET', `/traces/${t.traceId}`, { token: jwt });
    assert.equal(one.body.spans.length, 5);
    assert.equal((await call('GET', `/agents/${ag.body.id}`, { token: jwt })).body.status, 'connected');

    // api key can't read traces or manage keys
    assert.equal((await call('GET', `/traces/${t.traceId}`, { token: key.body.key })).status, 403);
    assert.equal((await call('GET', '/api-keys', { token: key.body.key })).status, 403);

    // second tenant sees nothing
    const regB = await call('POST', '/auth/register', { body: { email: 'b@example.com', password: 'correct-horse-1', name: 'B', organizationName: 'Beta' } });
    assert.equal((await call('GET', `/traces/${t.traceId}`, { token: regB.body.token })).status, 404);
    assert.equal((await call('GET', `/agents/${ag.body.id}`, { token: regB.body.token })).status, 404);
    assert.equal((await call('GET', '/agents', { token: regB.body.token })).body.items.length, 0);
    assert.equal((await call('GET', '/agents', { token: jwt, headers: { 'x-organization-id': regB.body.organizations[0].id } })).status, 403);

    // abuse: bad json, operator-injection in query, bad key, revoked key
    assert.equal((await call('POST', '/agents', { token: jwt, body: { name: '' } })).status, 422);
    assert.equal((await call('GET', `/agents/${ag.body.id}/traces?status[$ne]=x`, { token: jwt })).status, 400);
    assert.equal((await call('POST', '/traces', { token: `ae_live_${'A'.repeat(43)}`, body: t })).status, 401);
    assert.equal((await call('DELETE', `/api-keys/${key.body.id}`, { token: jwt })).status, 204);
    assert.equal((await call('POST', '/traces', { token: key.body.key, body: newTrace(ag.body.id) })).status, 401);

    // consistent error envelope + request id
    const nf = await call('GET', '/nope', { token: jwt });
    assert.equal(nf.body.error.code, 'NOT_FOUND');
    assert.ok(nf.headers.get('x-request-id'));
  } finally { close(); }
});

test('login rate limit counts failures only and returns the standard envelope', async () => {
  const { call, close } = await boot({ AUTH_RATE_LIMIT_MAX: '3' });
  try {
    await call('POST', '/auth/register', { body: { email: 'c@example.com', password: 'correct-horse-1', name: 'C', organizationName: 'C' } });
    for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/auth/login', { body: { email: 'c@example.com', password: 'wrong-wrong-1' } })).status, 401);
    const blocked = await call('POST', '/auth/login', { body: { email: 'c@example.com', password: 'correct-horse-1' } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'RATE_LIMITED');
  } finally { close(); }
});

test('oversized ingest body is refused before processing', async () => {
  const { call, close } = await boot({ INGEST_BODY_LIMIT_KB: '1' });
  try {
    const reg = await call('POST', '/auth/register', { body: { email: 'd@example.com', password: 'correct-horse-1', name: 'D', organizationName: 'D' } });
    const ag = await call('POST', '/agents', { token: reg.body.token, body: { name: 'x', framework: 'custom' } });
    const t = newTrace(ag.body.id); t.output = 'z'.repeat(5000);
    assert.equal((await call('POST', '/traces', { token: reg.body.token, body: t })).status, 413);
  } finally { close(); }
});
