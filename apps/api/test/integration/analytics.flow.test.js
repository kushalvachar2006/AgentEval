// HTTP-level check of the Milestone 4 routes (Express + in-memory repos + fake engine). Needs `npm install`.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createApp } from '../../src/app.js';
import { makeWorld, fakeEngine } from '../helpers/world.js';

test('traces -> overview / agent metrics / explorer / debug over HTTP, with validation and tenant isolation', async () => {
  const engine = fakeEngine();
  engine.debug = async (p) => ({ traceId: p.trace.traceId, verdict: 'failed', headline: 'Likely: x', findings: [{ id: 'f1' }], failedMetrics: [], caveats: ['not a proven root cause'], suspectedPath: [] });
  const w = makeWorld({}, { engine });
  const server = createApp({ config: w.config, services: w.services, checks: {} }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (path, { token, method = 'GET', body } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  try {
    const reg = await call('/auth/register', { method: 'POST', body: { email: 'm4@example.com', password: 'correct-horse-1', name: 'M', organizationName: 'M' } });
    const jwt = reg.body.token;
    const agent = (await call('/agents', { token: jwt, method: 'POST', body: { name: 'a', framework: 'langchain' } })).body;
    const key = (await call('/api-keys', { token: jwt, method: 'POST', body: { name: 'k' } })).body.key;
    const now = Date.now();
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const t = w.traceFor(agent.id, { agentVersion: i < 2 ? '1.0.0' : '1.1.0', status: i === 0 ? 'error' : 'success', ...(i === 0 && { error: { message: 'boom' } }), startedAt: new Date(now - i * 3_600_000).toISOString(), endedAt: new Date(now - i * 3_600_000 + 1000).toISOString(), durationMs: 1000, input: i === 3 ? 'where is my parcel' : 'hello', metadata: i === 1 ? { demo: true } : {} });
      ids.push(t.traceId);
      assert.equal((await call('/traces', { token: key, method: 'POST', body: t })).status, 202);
    }

    const ov = await call('/analytics/overview', { token: jwt });
    assert.deepEqual([ov.status, ov.body.totals.executions, ov.body.totals.failedExecutions, ov.body.execution.errorRate], [200, 4, 1, 0.25]);
    const m = await call(`/agents/${agent.id}/metrics?demo=false`, { token: jwt });
    assert.equal(m.body.totals.executions, 3);
    assert.deepEqual(m.body.versions.map((v) => v.version).sort(), ['1.0.0', '1.1.0']);

    const ex = await call('/traces?status=error', { token: jwt });
    assert.deepEqual([ex.status, ex.body.items.length, ex.body.items[0].spans], [200, 1, undefined]);
    assert.equal((await call('/traces?q=parcel', { token: jwt })).body.items.length, 1);
    assert.equal((await call('/traces?q=.*', { token: jwt })).body.items.length, 0);                    // literal search, not a regex
    assert.equal((await call('/traces?demo=true', { token: jwt })).body.items.length, 1);
    const page = await call('/traces?limit=3', { token: jwt });
    assert.ok(page.body.nextCursor);
    assert.equal((await call(`/traces?limit=3&cursor=${page.body.nextCursor}`, { token: jwt })).body.items.length, 1);

    const dbg = await call(`/traces/${ids[0]}/debug`, { token: jwt });
    assert.deepEqual([dbg.status, dbg.body.engineAvailable, dbg.body.verdict], [200, true, 'failed']);

    for (const bad of ['/analytics/overview?from=yesterday', '/analytics/overview?metric=vibes', '/analytics/overview?agentId[$ne]=x', '/traces?status[$ne]=x', '/traces?minDurationMs=-5'])
      assert.equal((await call(bad, { token: jwt })).status, 400, bad);
    assert.equal((await call(`/agents/${'0'.repeat(24)}/metrics`, { token: jwt })).status, 404);
    assert.equal((await call('/analytics/overview', { token: key })).status, 403);                      // API keys can write traces, never read analytics
    assert.equal((await call('/analytics/overview')).status, 401);

    const other = await call('/auth/register', { method: 'POST', body: { email: 'other4@example.com', password: 'correct-horse-1', name: 'O', organizationName: 'O' } });
    const o2 = await call('/analytics/overview', { token: other.body.token });
    assert.deepEqual([o2.body.totals.executions, o2.body.totals.agents], [0, 0]);
    assert.equal((await call(`/traces/${ids[0]}/debug`, { token: other.body.token })).status, 404);
    assert.deepEqual((await call('/traces', { token: other.body.token })).body.items, []);
    assert.equal((await call(`/agents/${agent.id}/metrics`, { token: other.body.token })).status, 404);
    void crypto;
  } finally { server.close(); }
});
