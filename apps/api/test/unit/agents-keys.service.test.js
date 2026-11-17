import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from '../helpers/world.js';

test('agent CRUD, initial version, and config secrets are redacted', async () => {
  const w = makeWorld();
  const { principal } = await w.signup();
  const a = await w.newAgent(principal, 'support-bot', { description: 'd', config: { temperature: 0, openai_api_key: 'sk-abcdefghijklmnopqrstuvwxyz' } });
  assert.equal(a.status, 'pending');
  assert.equal(a.currentVersion, '1.0.0');
  assert.equal(a.config.openai_api_key, '[REDACTED]');
  assert.equal(a.config.temperature, 0);
  assert.equal((await w.services.agents.listVersions(principal, a.id)).items.length, 1);
  const upd = await w.services.agents.update(principal, a.id, { description: 'new' });
  assert.equal(upd.description, 'new');
  await assert.rejects(() => w.services.agents.update(principal, a.id, { status: 'connected' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(() => w.services.agents.update(principal, a.id, {}), { code: 'VALIDATION_ERROR' });
  await assert.rejects(() => w.newAgent(principal, 'support-bot'), { code: 'AGENT_NAME_EXISTS' });
  await w.services.agents.archive(principal, a.id);
  await assert.rejects(() => w.services.agents.get(principal, a.id), { code: 'AGENT_NOT_FOUND' });
  await w.newAgent(principal, 'support-bot'); // name is free again after archive
});

test('agent validation: framework, version format, endpoint rules, SSRF guard', async () => {
  const w = makeWorld();
  const { principal } = await w.signup();
  await assert.rejects(() => w.services.agents.create(principal, { name: 'x', framework: 'crewai-not-yet' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(() => w.newAgent(principal, 'v', { version: 'bad version!' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(() => w.newAgent(principal, 'e1', { endpointUrl: 'https://x.example.com' }), { code: 'VALIDATION_ERROR' }); // sdk agents have no endpoint
  await assert.rejects(() => w.newAgent(principal, 'e2', { integrationType: 'api' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(() => w.newAgent(principal, 'e3', { integrationType: 'api', endpointUrl: 'http://169.254.169.254/' }), { code: 'UNSAFE_ENDPOINT' });
  const ok = await w.newAgent(principal, 'e4', { integrationType: 'api', endpointUrl: 'https://agent.example.com/run' });
  assert.equal(ok.endpointUrl, 'https://agent.example.com/run');
  await assert.rejects(() => w.services.agents.update(principal, ok.id, { endpointUrl: 'http://localhost:1' }), { code: 'UNSAFE_ENDPOINT' });
});

test('versions: add, duplicate rejected, becomes current', async () => {
  const w = makeWorld();
  const { principal } = await w.signup();
  const a = await w.newAgent(principal);
  await w.services.agents.addVersion(principal, a.id, { version: '1.1.0', notes: 'better prompt' });
  assert.equal((await w.services.agents.get(principal, a.id)).currentVersion, '1.1.0');
  await assert.rejects(() => w.services.agents.addVersion(principal, a.id, { version: '1.1.0' }), { code: 'VERSION_EXISTS' });
});

test('pagination walks all agents without duplicates; bad cursor/limit rejected', async () => {
  const w = makeWorld();
  const { principal } = await w.signup();
  for (let i = 0; i < 5; i++) await w.newAgent(principal, `a${i}`);
  const seen = []; let cursor;
  for (let guard = 0; guard < 10; guard++) {
    const page = await w.services.agents.list(principal, { limit: '2', ...(cursor && { cursor }) });
    seen.push(...page.items.map((a) => a.name));
    if (!(cursor = page.nextCursor)) break;
  }
  assert.deepEqual(seen.sort(), ['a0', 'a1', 'a2', 'a3', 'a4']);
  await assert.rejects(() => w.services.agents.list(principal, { limit: '0' }), { code: 'INVALID_QUERY' });
  await assert.rejects(() => w.services.agents.list(principal, { cursor: 'zzz' }), { code: 'INVALID_CURSOR' });
  await assert.rejects(() => w.services.agents.list(principal, { name: { $ne: 'x' } }), { code: 'INVALID_QUERY' });
});

test('TENANT ISOLATION: org B can neither see nor modify org A agents, keys or versions', async () => {
  const w = makeWorld();
  const A = await w.signup('orga'), B = await w.signup('orgb');
  const agent = await w.newAgent(A.principal, 'secret-agent');
  const key = await w.services.apiKeys.create(A.principal, { name: 'k' });
  assert.deepEqual((await w.services.agents.list(B.principal)).items, []);
  for (const fn of [() => w.services.agents.get(B.principal, agent.id), () => w.services.agents.update(B.principal, agent.id, { description: 'x' }), () => w.services.agents.archive(B.principal, agent.id), () => w.services.agents.listVersions(B.principal, agent.id), () => w.services.apiKeys.revoke(B.principal, key.id)])
    await assert.rejects(fn, (e) => e.status === 404);
  assert.deepEqual((await w.services.apiKeys.list(B.principal)).items, []);
  await assert.rejects(() => w.services.apiKeys.create(B.principal, { name: 'k', agentId: agent.id }), { code: 'AGENT_NOT_FOUND' });
  assert.equal((await w.services.agents.get(A.principal, agent.id)).name, 'secret-agent'); // untouched
});

test('RBAC: viewer reads only; member writes but cannot delete or manage keys; admin can', async () => {
  const w = makeWorld();
  const { principal } = await w.signup();
  const as = (role) => ({ ...principal, role });
  const agent = await w.newAgent(principal);
  await w.services.agents.get(as('viewer'), agent.id);
  await assert.rejects(() => w.newAgent(as('viewer'), 'x'), { code: 'FORBIDDEN' });
  await w.newAgent(as('member'), 'm1');
  await assert.rejects(() => w.services.agents.archive(as('member'), agent.id), { code: 'FORBIDDEN' });
  await assert.rejects(() => w.services.apiKeys.create(as('member'), { name: 'k' }), { code: 'FORBIDDEN' });
  await w.services.apiKeys.create(as('admin'), { name: 'k' });
});

test('API keys: plaintext only at creation, lifecycle, revoke, expiry, malformed', async () => {
  const w = makeWorld();
  const { principal } = await w.signup();
  const created = await w.services.apiKeys.create(principal, { name: 'ci', scopes: ['traces:write', 'agents:write'], expiresInDays: 30 });
  assert.match(created.key, /^ae_live_/);
  const listed = (await w.services.apiKeys.list(principal)).items[0];
  assert.equal(listed.key, undefined);
  assert.equal(listed.keyHash, undefined);
  assert.equal(JSON.stringify(w.repos._db.keys).includes(created.key), false); // only the hash is stored

  const p = await w.services.apiKeys.authenticate(created.key);
  assert.equal(p.organizationId, principal.organizationId);
  assert.deepEqual(p.scopes, ['traces:write', 'agents:write']);

  w.repos._db.keys[0].expiresAt = new Date(Date.now() - 1000);
  await assert.rejects(() => w.services.apiKeys.authenticate(created.key), { code: 'INVALID_API_KEY' });
  w.repos._db.keys[0].expiresAt = null;
  await w.services.apiKeys.revoke(principal, created.id);
  await assert.rejects(() => w.services.apiKeys.authenticate(created.key), { code: 'INVALID_API_KEY' });
  for (const bad of ['ae_live_short', 'sk-123', `ae_live_${'A'.repeat(43)}`]) await assert.rejects(() => w.services.apiKeys.authenticate(bad), { code: 'INVALID_API_KEY' });
  await assert.rejects(() => w.services.apiKeys.create(principal, { name: 'x', scopes: ['keys:manage'] }), { code: 'VALIDATION_ERROR' });
});

test('API-key principals cannot manage keys, read traces, or delete agents; agent-bound keys are fenced', async () => {
  const w = makeWorld();
  const { principal } = await w.signup();
  const a1 = await w.newAgent(principal, 'a1'), a2 = await w.newAgent(principal, 'a2');
  const k = await w.services.apiKeys.create(principal, { name: 'bound', scopes: ['traces:write', 'agents:read', 'agents:write'], agentId: a1.id });
  const kp = await w.services.apiKeys.authenticate(k.key);
  await assert.rejects(() => w.services.apiKeys.create(kp, { name: 'x' }), { code: 'FORBIDDEN' });
  await assert.rejects(() => w.services.traces.get(kp, 'a'.repeat(32)), { code: 'FORBIDDEN' });
  await assert.rejects(() => w.services.agents.archive(kp, a1.id), { code: 'FORBIDDEN' });
  await assert.rejects(() => w.services.agents.create(kp, { name: 'new', framework: 'custom' }), { code: 'FORBIDDEN' });
  assert.equal((await w.services.agents.get(kp, a1.id)).id, a1.id);
  await assert.rejects(() => w.services.agents.get(kp, a2.id), { code: 'AGENT_NOT_FOUND' });
  assert.deepEqual((await w.services.agents.list(kp)).items.map((x) => x.id), [a1.id]);
});

test('archiving an agent revokes its bound keys', async () => {
  const w = makeWorld();
  const { principal } = await w.signup();
  const a = await w.newAgent(principal);
  const k = await w.services.apiKeys.create(principal, { name: 'bound', agentId: a.id });
  await w.services.agents.archive(principal, a.id);
  await assert.rejects(() => w.services.apiKeys.authenticate(k.key), { code: 'INVALID_API_KEY' });
});
