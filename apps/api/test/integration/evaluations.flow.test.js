// HTTP-level check of the Milestone 3 routes (Express + in-memory repos + a fake engine). Needs `npm install`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.js';
import { makeWorld, validTrace, fakeEngine, CASES } from '../helpers/world.js';
import crypto from 'node:crypto';

test('suites -> import -> run -> SDK work list -> linked trace -> worker -> results over HTTP', async () => {
  const w = makeWorld({}, { engine: fakeEngine() });
  const server = createApp({ config: w.config, services: w.services, checks: {} }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }) }, body: body && JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  try {
    const reg = await call('POST', '/auth/register', { body: { email: 'e@example.com', password: 'correct-horse-1', name: 'E', organizationName: 'E' } });
    const jwt = reg.body.token;
    const suite = await call('POST', '/test-suites', { token: jwt, body: { name: 'http-suite' } });
    assert.equal(suite.status, 201);
    const imp = await call('POST', `/test-suites/${suite.body.id}/import`, { token: jwt, body: { format: 'json', content: JSON.stringify(CASES) } });
    assert.deepEqual([imp.status, imp.body.imported], [201, 3]);
    const bad = await call('POST', `/test-suites/${suite.body.id}/import`, { token: jwt, body: { format: 'json', content: '[{"nope":1}]' } });
    assert.deepEqual([bad.status, bad.body.error.code, bad.body.error.details[0].row], [422, 'IMPORT_ERRORS', 1]);
    assert.equal((await call('GET', `/test-suites/${suite.body.id}`, { token: jwt })).body.cases.items.length, 3);

    const agent = await call('POST', '/agents', { token: jwt, body: { name: 'a', framework: 'langchain' } });
    const key = await call('POST', '/api-keys', { token: jwt, body: { name: 'k', scopes: ['traces:write', 'evaluations:run'] } });
    const run = await call('POST', '/evaluations', { token: jwt, body: { agentId: agent.body.id, suiteId: suite.body.id, mode: 'sdk', metrics: [{ metric: 'relevance' }] } });
    assert.deepEqual([run.status, run.body.status], [202, 'awaiting_traces']);

    const work = await call('GET', `/evaluations/${run.body.id}/work`, { token: key.body.key });
    assert.equal(work.body.cases.length, 3);
    assert.equal((await call('GET', `/evaluations/${run.body.id}/work`)).status, 401);
    for (const c of work.body.cases) {
      const t = { ...structuredClone(validTrace), agentId: agent.body.id, traceId: crypto.randomBytes(16).toString('hex'), metadata: { evaluation: { runId: run.body.id, testCaseId: c.testCaseId } } };
      const r = await call('POST', '/traces', { token: key.body.key, body: t });
      assert.deepEqual([r.status, r.body.linked], [202, true]);
    }
    await w.worker.loop.drain();

    const done = await call('GET', `/evaluations/${run.body.id}`, { token: jwt });
    assert.deepEqual([done.body.status, done.body.progress.completed], ['completed', 3]);
    const res = await call('GET', `/evaluations/${run.body.id}/results?status=passed&limit=2`, { token: jwt });
    assert.equal(res.body.items.length, 2);
    assert.ok(res.body.nextCursor);
    assert.equal((await call('GET', `/evaluations/${run.body.id}/results?status[$ne]=x`, { token: jwt })).status, 400);
    assert.equal((await call('POST', `/evaluations/${run.body.id}/cancel`, { token: jwt })).status, 409);

    const put = await call('PUT', '/evaluator-config', { token: jwt, body: { judge: { enabled: true, provider: 'openai_compatible', model: 'm', apiKey: 'sk-secret-secret-1' } } });
    assert.deepEqual([put.status, put.body.judge.hasApiKey, JSON.stringify(put.body).includes('secret')], [200, true, false]);
    assert.equal((await call('GET', '/evaluators', { token: jwt })).body.evaluators.length, 8);

    const other = await call('POST', '/auth/register', { body: { email: 'f@example.com', password: 'correct-horse-1', name: 'F', organizationName: 'F' } });
    assert.equal((await call('GET', `/evaluations/${run.body.id}`, { token: other.body.token })).status, 404);
    assert.equal((await call('GET', `/test-suites/${suite.body.id}`, { token: other.body.token })).status, 404);
  } finally { server.close(); }
});
