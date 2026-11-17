import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, seedSuite, fakeEngine } from '../helpers/world.js';
import { UpstreamError } from '../../src/lib/upstream.js';

async function setup(engine) {
  const w = makeWorld({}, { engine });
  const A = await w.signup('orga');
  const agent = await w.newAgent(A.principal, 'a');
  const key = await w.services.apiKeys.authenticate((await w.services.apiKeys.create(A.principal, { name: 'k', scopes: ['traces:write'] })).key);
  const t = w.traceFor(agent.id);
  await w.services.traces.ingestOne(key, t);
  return { w, A, agent, key, t };
}
const withDebug = (fn) => { const e = fakeEngine(); e.debug = fn; return e; };

test('debug: passes the stored trace and linked evaluation results to the engine, returns its analysis plus evaluation links', async () => {
  let seen;
  const x = await setup(withDebug(async (p) => { seen = p; return { traceId: p.trace.traceId, verdict: 'failed', headline: 'h', findings: [{ id: 'f1' }], failedMetrics: [], caveats: ['c'], suspectedPath: [] }; }));
  await x.w.repos.results.insertIfAbsent(x.A.principal.organizationId, { runId: '1'.repeat(24), testCaseId: 'c1', status: 'failed', traceId: x.t.traceId, evaluatedAt: new Date(), metrics: [{ metric: 'hallucination', status: 'fail', score: 0 }] });
  const r = await x.w.services.debug.debug(x.A.principal, x.t.traceId);
  assert.deepEqual([r.engineAvailable, r.verdict, r.findings.length], [true, 'failed', 1]);
  assert.equal(seen.trace.spans.length, 5);
  assert.equal(seen.trace.organizationId, undefined);
  assert.equal(JSON.stringify(seen).includes(x.A.principal.organizationId), false);                 // no tenant data leaves for the engine
  assert.equal(seen.results[0].metrics[0].metric, 'hallucination');
  assert.deepEqual(r.evaluation.map((e) => [e.runId, e.status]), [['1'.repeat(24), 'failed']]);
});

test('debug: engine outage is reported, not a 500; non-upstream bugs still surface', async () => {
  const x = await setup(withDebug(async () => { throw new UpstreamError('Evaluation engine is unreachable', { retryable: true }); }));
  const r = await x.w.services.debug.debug(x.A.principal, x.t.traceId);
  assert.deepEqual([r.engineAvailable, r.verdict, r.findings], [false, 'unknown', []]);
  assert.match(r.caveats[0], /engine/);
  const y = await setup(withDebug(async () => { throw new TypeError('bug'); }));
  await assert.rejects(() => y.w.services.debug.debug(y.A.principal, y.t.traceId), TypeError);
});

test('debug: tenant isolation, malformed ids, permissions', async () => {
  const x = await setup(withDebug(async () => ({ verdict: 'clean', findings: [], caveats: [] })));
  const B = await x.w.signup('orgb');
  await assert.rejects(() => x.w.services.debug.debug(B.principal, x.t.traceId), { code: 'TRACE_NOT_FOUND' });
  for (const bad of ['nope', '../x', 'F'.repeat(32), '0'.repeat(32)]) await assert.rejects(() => x.w.services.debug.debug(x.A.principal, bad), { code: 'TRACE_NOT_FOUND' });
  await assert.rejects(() => x.w.services.debug.debug(x.key, x.t.traceId), { code: 'FORBIDDEN' });
  assert.equal((await x.w.services.debug.debug({ ...x.A.principal, role: 'viewer' }, x.t.traceId)).engineAvailable, true);
});

test('evaluation results record the agent version of the trace (feeds version comparison)', async () => {
  const w = makeWorld({}, { engine: fakeEngine() });
  const A = await w.signup('orga');
  const agent = await w.newAgent(A.principal, 'a');
  const suite = await seedSuite(w, A.principal, 's', [{ input: 'q' }]);
  const key = await w.services.apiKeys.authenticate((await w.services.apiKeys.create(A.principal, { name: 'k', scopes: ['traces:write', 'evaluations:run'] })).key);
  const run = await w.services.evaluations.create(A.principal, { agentId: agent.id, suiteId: suite.id, mode: 'sdk', metrics: [{ metric: 'relevance' }] });
  const [c] = (await w.services.evaluations.work(key, run.id)).cases;
  await w.services.traces.ingestOne(key, w.traceFor(agent.id, { agentVersion: '2.0.0', metadata: { evaluation: { runId: run.id, testCaseId: c.testCaseId } } }));
  await w.worker.loop.drain();
  assert.equal(w.repos._db.results[0].agentVersion, '2.0.0');
  const m = await w.services.analytics.agentMetrics(A.principal, agent.id, {});
  assert.deepEqual(m.versions.find((v) => v.version === '2.0.0').quality, { relevance: 1 });
});
