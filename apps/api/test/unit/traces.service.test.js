import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from '../helpers/world.js';

async function setup(env) {
  const w = makeWorld(env);
  const A = await w.signup('orga');
  const agent = await w.newAgent(A.principal, 'laptop-agent');
  const key = await w.services.apiKeys.create(A.principal, { name: 'sdk', scopes: ['traces:write'] });
  const kp = await w.services.apiKeys.authenticate(key.key);
  return { w, A, agent, kp };
}

test('ingest: accepted, then duplicate (idempotent); agent becomes connected; version auto-registered', async () => {
  const { w, A, agent, kp } = await setup();
  const t = w.traceFor(agent.id);
  assert.deepEqual(await w.services.traces.ingestOne(kp, t), { traceId: t.traceId, status: 'accepted' });
  assert.equal((await w.services.traces.ingestOne(kp, t)).status, 'duplicate');
  assert.equal(w.repos._db.traces.length, 1);
  const a = await w.services.agents.get(A.principal, agent.id);
  assert.equal(a.status, 'connected');
  assert.ok(a.lastTraceAt);
  assert.ok((await w.services.agents.listVersions(A.principal, agent.id)).items.some((v) => v.version === '1.0.0'));
});

test('stored document: counts, usage totals, previews, retention expiry, nothing from client can set organizationId', async () => {
  const { w, agent, kp } = await setup({ TRACE_RETENTION_DAYS: '30' });
  const t = w.traceFor(agent.id, { organizationId: 'attacker-org', usage: undefined });
  delete t.usage;
  await w.services.traces.ingestOne(kp, t);
  const d = w.repos._db.traces[0];
  assert.equal(d.organizationId, kp.organizationId);
  assert.equal(d.spanCount, 5);
  assert.equal(d.llmCallCount, 2);
  assert.equal(d.toolCallCount, 1);
  assert.deepEqual(d.usage, { inputTokens: 812, outputTokens: 96, totalTokens: 908 });
  assert.match(d.inputPreview, /cheapest laptop/);
  const days = Math.round((d.expiresAt - d.ingestedAt) / 86_400_000);
  assert.equal(days, 30);
});

test('secrets in traces are redacted before storage; huge strings truncated; oversize rejected', async () => {
  const { w, agent, kp } = await setup({ MAX_TRACE_BYTES: '20000' });
  const t = w.traceFor(agent.id);
  t.spans[3].tool.input = { query: 'laptop', api_key: 'sk-abcdefghijklmnopqrstuvwxyz', headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' } };
  t.input = 'my key is sk-abcdefghijklmnopqrstuvwxyz1234 please help';
  t.metadata = { '$where': 'x', 'a.b': 1 };
  await w.services.traces.ingestOne(kp, t);
  const stored = JSON.stringify(w.repos._db.traces[0]);
  assert.equal(/sk-abcdef|Bearer abcdef/.test(stored), false);
  assert.ok(w.repos._db.traces[0].sanitization.redactions >= 3);
  assert.deepEqual(Object.keys(w.repos._db.traces[0].metadata).sort(), ['a\uff0eb', '\uff04where'].sort());

  const huge = w.traceFor(agent.id);
  huge.output = 'x'.repeat(100_000);
  await assert.rejects(() => w.services.traces.ingestOne(kp, huge), { code: 'TRACE_TOO_LARGE' }); // 32 KB after truncation > 20 KB test limit
});

test('truncation keeps huge strings small under the default size limit', async () => {
  const { w, agent, kp } = await setup();
  const t = w.traceFor(agent.id);
  t.output = 'x'.repeat(10_000_000);
  await w.services.traces.ingestOne(kp, t);
  const d = w.repos._db.traces[0];
  assert.ok(d.output.length < 33_000);
  assert.equal(d.sanitization.truncated, 1);
  assert.ok(d.spans.length === 5);
});

test('rejections: invalid trace (with details), unknown agent, malformed agent id', async () => {
  const { w, agent, kp } = await setup();
  const bad = w.traceFor(agent.id, { traceId: 'nothex' });
  await assert.rejects(() => w.services.traces.ingestOne(kp, bad), (e) => e.code === 'INVALID_TRACE' && e.details.some((d) => d.path === 'traceId'));
  await assert.rejects(() => w.services.traces.ingestOne(kp, w.traceFor('0'.repeat(24))), { code: 'AGENT_NOT_FOUND' });
  await assert.rejects(() => w.services.traces.ingestOne(kp, w.traceFor('not-an-object-id')), { code: 'AGENT_NOT_FOUND' });
});

test('TENANT ISOLATION: org B key cannot write to org A agent; same traceId in two orgs does not collide; reads are fenced', async () => {
  const { w, A, agent, kp } = await setup();
  const B = await w.signup('orgb');
  const bAgent = await w.newAgent(B.principal, 'b-agent');
  const bKey = await w.services.apiKeys.authenticate((await w.services.apiKeys.create(B.principal, { name: 'k' })).key);
  const t = w.traceFor(agent.id);
  await assert.rejects(() => w.services.traces.ingestOne(bKey, t), { code: 'AGENT_NOT_FOUND' }); // looks identical to "no such agent"
  await w.services.traces.ingestOne(kp, t);
  await w.services.traces.ingestOne(bKey, { ...t, agentId: bAgent.id }); // same traceId, different tenant -> both accepted
  assert.equal(w.repos._db.traces.length, 2);
  assert.equal((await w.services.traces.get(A.principal, t.traceId)).agentId, agent.id);
  assert.equal((await w.services.traces.get(B.principal, t.traceId)).agentId, bAgent.id);
  await assert.rejects(() => w.services.traces.listForAgent(B.principal, agent.id), { code: 'AGENT_NOT_FOUND' });
  const orgBOnlyHasOwn = await w.services.traces.listForAgent(B.principal, bAgent.id);
  assert.equal(orgBOnlyHasOwn.items.length, 1);
});

test('agent-bound key may only write its own agent', async () => {
  const { w, A, agent } = await setup();
  const other = await w.newAgent(A.principal, 'other');
  const bound = await w.services.apiKeys.authenticate((await w.services.apiKeys.create(A.principal, { name: 'b', agentId: agent.id })).key);
  await w.services.traces.ingestOne(bound, w.traceFor(agent.id));
  await assert.rejects(() => w.services.traces.ingestOne(bound, w.traceFor(other.id)), { code: 'FORBIDDEN' });
});

test('batch: per-item results, mixed outcomes, size limits; infrastructure errors fail the whole request', async () => {
  const { w, agent, kp } = await setup();
  const good = w.traceFor(agent.id), dup = w.traceFor(agent.id);
  await w.services.traces.ingestOne(kp, dup);
  const r = await w.services.traces.ingestBatch(kp, { traces: [good, dup, w.traceFor(agent.id, { status: 'weird' }), null] });
  assert.deepEqual([r.accepted, r.duplicates, r.rejected], [1, 1, 2]);
  assert.deepEqual(r.results.map((x) => x.status), ['accepted', 'duplicate', 'rejected', 'rejected']);
  assert.equal(r.results[3].traceId, null);
  await assert.rejects(() => w.services.traces.ingestBatch(kp, { traces: [] }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(() => w.services.traces.ingestBatch(kp, { traces: Array(101).fill(good) }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(() => w.services.traces.ingestBatch(kp, {}), { code: 'VALIDATION_ERROR' });
  w.repos.traces.insertIfAbsent = async () => { throw new Error('db down'); };
  await assert.rejects(() => w.services.traces.ingestBatch(kp, { traces: [w.traceFor(agent.id)] }), /db down/);
});

test('list: newest first, filters, cursor pagination covers everything exactly once, summaries omit spans', async () => {
  const { w, A, agent, kp } = await setup();
  const base = Date.parse('2026-11-04T10:00:00.000Z');
  for (let i = 0; i < 7; i++) {
    const t = w.traceFor(agent.id, { status: i % 3 === 0 ? 'error' : 'success', error: i % 3 === 0 ? { message: 'boom' } : undefined,
      startedAt: new Date(base + i * 1000).toISOString(), endedAt: new Date(base + i * 1000 + 500).toISOString() });
    if (!t.error) delete t.error;
    await w.services.traces.ingestOne(kp, t);
  }
  const ids = []; let cursor;
  for (let g = 0; g < 10; g++) {
    const p = await w.services.traces.listForAgent(A.principal, agent.id, { limit: '3', ...(cursor && { cursor }) });
    for (const it of p.items) { assert.equal(it.spans, undefined); assert.equal(it.input, undefined); ids.push(it.traceId); }
    if (!(cursor = p.nextCursor)) break;
  }
  assert.equal(ids.length, 7);
  assert.equal(new Set(ids).size, 7);
  const errors = await w.services.traces.listForAgent(A.principal, agent.id, { status: 'error' });
  assert.equal(errors.items.length, 3);
  const ranged = await w.services.traces.listForAgent(A.principal, agent.id, { from: new Date(base + 2000).toISOString(), to: new Date(base + 4000).toISOString() });
  assert.equal(ranged.items.length, 3);
  assert.ok(new Date(ranged.items[0].startedAt) >= new Date(ranged.items[2].startedAt));
  for (const q of [{ status: 'nope' }, { from: 'yesterday' }, { status: { $ne: 'x' } }]) await assert.rejects(() => w.services.traces.listForAgent(A.principal, agent.id, q), { code: 'INVALID_QUERY' });
  await assert.rejects(() => w.services.traces.listForAgent(A.principal, agent.id, { cursor: Buffer.from('{"t":"x","id":"y"}').toString('base64url') }), { code: 'INVALID_CURSOR' });
});

test('get trace: found returns spans and hides organizationId; unknown/malformed id is 404', async () => {
  const { w, A, agent, kp } = await setup();
  const t = w.traceFor(agent.id);
  await w.services.traces.ingestOne(kp, t);
  const d = await w.services.traces.get(A.principal, t.traceId);
  assert.equal(d.spans.length, 5);
  assert.equal(d.organizationId, undefined);
  await assert.rejects(() => w.services.traces.get(A.principal, 'f'.repeat(32)), { code: 'TRACE_NOT_FOUND' });
  await assert.rejects(() => w.services.traces.get(A.principal, '../etc/passwd'), { code: 'TRACE_NOT_FOUND' });
});
