// HTTP-level check of the Milestone 5 routes (Express + in-memory repos + fake engine).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.js';
import { makeWorld, fakeEngine } from '../helpers/world.js';

test('monitoring + alerts over HTTP: policy, live view, rules, alert lifecycle, validation, isolation', async () => {
  const w = makeWorld({}, { engine: fakeEngine() });
  const server = createApp({ config: w.config, services: w.services, checks: {} }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (path, { token, method = 'GET', body } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  try {
    const reg = (n) => call('/auth/register', { method: 'POST', body: { email: `${n}@example.com`, password: 'correct-horse-1', name: n, organizationName: n } });
    const jwt = (await reg('owner')).body.token, other = (await reg('other')).body.token;
    const agent = (await call('/agents', { token: jwt, method: 'POST', body: { name: 'a', framework: 'langchain' } })).body;
    const key = (await call('/api-keys', { token: jwt, method: 'POST', body: { name: 'k' } })).body.key;

    assert.equal((await call(`/agents/${agent.id}/monitoring`, { token: jwt })).body.policy.enabled, false);
    assert.equal((await call(`/agents/${agent.id}/monitoring`, { token: jwt, method: 'PUT', body: { enabled: true, sampleRate: 3 } })).status, 422);
    const put = await call(`/agents/${agent.id}/monitoring`, { token: jwt, method: 'PUT', body: { enabled: true, sampleRate: 1, dailyTraceBudget: 5 } });
    assert.deepEqual([put.status, put.body.policy.sampleRate], [200, 1]);

    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      const t = w.traceFor(agent.id, { environment: 'production', metadata: {}, status: i < 4 ? 'error' : 'success', ...(i < 4 && { error: { message: 'boom' } }), startedAt: new Date(now - 60_000).toISOString(), endedAt: new Date(now - 59_000).toISOString(), durationMs: 1000 });
      assert.equal((await call('/traces', { token: key, method: 'POST', body: t })).status, 202);
    }
    const live = await call(`/monitoring/agents/${agent.id}/live?windowMinutes=15`, { token: jwt });
    assert.deepEqual([live.status, live.body.current.count, live.body.current.errors, live.body.health.status, live.body.usage.evaluationsQueued, live.body.usage.skippedBudget], [200, 12, 4, 'failing', 5, 7]);
    assert.equal((await call('/monitoring/overview', { token: jwt })).body.agents[0].health.status, 'failing');
    assert.equal((await call(`/monitoring/agents/${agent.id}/rollups`, { token: jwt })).body.totals.count, 12);
    for (const bad of ['windowMinutes=2', 'windowMinutes=abc', 'windowMinutes[$ne]=1', 'demo=maybe']) assert.equal((await call(`/monitoring/agents/${agent.id}/live?${bad}`, { token: jwt })).status, 400, bad);

    const bodyRule = { name: 'Errors', type: 'error_rate', agentId: agent.id, params: { windowMinutes: 15, thresholdPct: 10, minSamples: 5 } };
    assert.equal((await call('/alert-rules', { token: key, method: 'POST', body: bodyRule })).status, 403);                  // API keys can't manage alerts
    assert.equal((await call('/alert-rules', { token: jwt, method: 'POST', body: { ...bodyRule, params: { thresholdPct: -1 } } })).status, 422);
    const rule = await call('/alert-rules', { token: jwt, method: 'POST', body: bodyRule });
    assert.equal(rule.status, 201);
    assert.equal((await call('/alert-rules', { token: other })).body.items.length, 0);
    assert.equal((await call(`/alert-rules/${rule.body.id}`, { token: other })).status, 404);
    const test_ = await call(`/alert-rules/${rule.body.id}/test`, { token: jwt, method: 'POST' });
    assert.deepEqual([test_.status, test_.body.state], [200, 'firing']);

    await w.services.alertEngine.tick();
    const list = await call('/alerts?status=active', { token: jwt });
    assert.equal(list.body.items.length, 1);
    const id = list.body.items[0].id;
    assert.equal((await call('/alerts/summary', { token: jwt })).body.active, 1);
    assert.equal((await call(`/alerts/${id}`, { token: other })).status, 404);
    assert.equal((await call(`/alerts/${id}/acknowledge`, { token: other, method: 'POST' })).status, 404);
    assert.equal((await call(`/alerts/${id}/acknowledge`, { token: jwt, method: 'POST' })).body.status, 'acknowledged');
    assert.equal((await call(`/alerts/${id}/acknowledge`, { token: jwt, method: 'POST' })).status, 409);
    assert.equal((await call(`/alerts/${id}/resolve`, { token: jwt, method: 'POST' })).body.status, 'resolved');
    assert.equal((await call('/alerts?status=bogus', { token: jwt })).status, 400);
    assert.equal((await call(`/alert-rules/${rule.body.id}`, { token: jwt, method: 'PATCH', body: { enabled: false } })).body.enabled, false);
    assert.equal((await call(`/alert-rules/${rule.body.id}`, { token: jwt, method: 'DELETE' })).status, 204);
    assert.equal((await call('/monitoring/overview')).status, 401);
  } finally { server.close(); }
});
