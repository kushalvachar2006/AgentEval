// End-to-end: Node services + worker + REAL Python evaluation engine process (HTTP, shared token). Skipped if Python 3 is missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeWorld, seedSuite, findPython, CASES } from '../helpers/world.js';
import { createEngineClient } from '../../src/lib/engineClient.js';

const python = findPython();
const ENGINE_DIR = fileURLToPath(new URL('../../../../evaluation-engine/', import.meta.url));
const TOKEN = 'e'.repeat(24);

function startEngine() {
  const proc = spawn(python, ['-m', 'agenteval_engine.server'], { cwd: ENGINE_DIR, env: { ...process.env, PYTHONPATH: 'src', PYTHONUNBUFFERED: '1', ENGINE_TOKEN: TOKEN, ENGINE_PORT: '0', ENGINE_HOST: '127.0.0.1' } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill(); reject(new Error('engine did not start')); }, 15_000);
    let buf = '';
    proc.stdout.on('data', (d) => { buf += d; const m = buf.match(/"port": (\d+)/); if (m) { clearTimeout(timer); resolve({ proc, port: Number(m[1]) }); } });
    proc.stderr.on('data', (d) => { if (/Error|Traceback/.test(String(d))) { clearTimeout(timer); proc.kill(); reject(new Error(String(d))); } });
  });
}

test('full run through the real Python engine: the planted wrong price is caught, with the offending tool span', { skip: !python && 'Python 3 not found' }, async () => {
  const { proc, port } = await startEngine();
  try {
    const engine = createEngineClient({ url: `http://127.0.0.1:${port}`, token: TOKEN, timeoutMs: 15_000 });
    const w = makeWorld({}, { engine });
    const A = await w.signup('orga');
    const agent = await w.newAgent(A.principal, 'sdk-agent');
    const suite = await seedSuite(w, A.principal);
    const key = await w.services.apiKeys.authenticate((await w.services.apiKeys.create(A.principal, { name: 'k', scopes: ['traces:write', 'evaluations:run'] })).key);
    const run = await w.services.evaluations.create(A.principal, { agentId: agent.id, suiteId: suite.id, mode: 'sdk' });
    const work = await w.services.evaluations.work(key, run.id);
    const tag = (c) => ({ metadata: { evaluation: { runId: run.id, testCaseId: c.testCaseId } } });
    const [c0, c1, c2] = work.cases;

    await w.services.traces.ingestOne(key, w.traceFor(agent.id, tag(c0)));    // fixture: tool says 47,999, answer says 52,999
    await w.services.traces.ingestOne(key, w.traceFor(agent.id, { ...tag(c1), input: CASES[1].input, output: 'Refunds are available within 30 days of purchase.', spans: [], usage: undefined }));
    await w.services.traces.ingestOne(key, w.traceFor(agent.id, { ...tag(c2), input: CASES[2].input, output: 'Hello!', spans: [], usage: undefined }));
    await w.worker.loop.drain();

    const done = await w.services.evaluations.get(A.principal, run.id);
    assert.equal(done.status, 'completed');
    assert.deepEqual([done.summary.cases.passed, done.summary.cases.failed, done.summary.cases.error], [2, 1, 0]);

    const results = (await w.services.evaluations.results(A.principal, run.id)).items;
    const laptop = results.find((r) => r.testCaseId === c0.testCaseId);
    assert.equal(laptop.status, 'failed');
    const m = Object.fromEntries(laptop.metrics.map((x) => [x.metric, x]));
    assert.equal(m.hallucination.status, 'fail');
    assert.equal(m.hallucination.findings[0].classification, 'contradicted');
    assert.equal(m.hallucination.findings[0].evidence[0].spanId, 'b7ad6b7169203331');      // points at the tool step that holds the truth
    assert.match(m.hallucination.findings[0].reason, /52999.*47999/);
    assert.equal(m.tool_usage.meta.subscores.interpretation, 0);
    assert.equal(m.tool_usage.meta.subscores.parameters, 1);
    assert.equal(m.accuracy.status, 'fail');
    assert.equal(m.completeness.score, 0.5);                                               // Acme Book 14 present, ₹47,999 missing
    assert.equal(m.relevance.status, 'pass');                                              // wrong, but on topic: metrics are independent
    assert.ok(laptop.metrics.every((x) => x.evaluatorVersion === '1.0.0' && x.meta.configHash));

    const refund = results.find((r) => r.testCaseId === c1.testCaseId);
    const rm = Object.fromEntries(refund.metrics.map((x) => [x.metric, x.status]));
    assert.deepEqual([rm.accuracy, rm.hallucination, rm.groundedness], ['pass', 'pass', 'pass']);
    const hello = results.find((r) => r.testCaseId === c2.testCaseId);
    assert.equal(hello.metrics.find((x) => x.metric === 'instruction_adherence').status, 'pass');
    assert.equal(hello.metrics.find((x) => x.metric === 'relevance').status, 'inconclusive');   // weak lexical signal is NOT reported as a pass

    assert.equal(done.summary.metrics.hallucination.fail, 1);
    assert.ok(done.summary.metrics.accuracy.avgScore < 1);
    assert.equal((await engine.catalog()).evaluators.length, 8);

    // Debugging engine, through the real Python process: the evaluation results for this trace are merged into the analysis.
    const dbg = await w.services.debug.debug(A.principal, laptop.traceId);
    assert.equal(dbg.engineAvailable, true);
    assert.equal(dbg.verdict, 'failed');
    const contra = dbg.findings.find((f) => f.type === 'contradiction');
    assert.equal(contra.spanId, 'b7ad6b7169203331');
    assert.equal(contra.certainty, 'likely');                                              // never claims a proven root cause
    assert.deepEqual([contra.conflict.claim, contra.conflict.evidence], [52999, 47999]);
    assert.ok(contra.affectedMetrics.includes('hallucination') && contra.affectedMetrics.includes('tool_usage'));   // real evaluation results attached
    assert.deepEqual(contra.path.map((p) => p.type), ['agent', 'chain', 'tool']);
    assert.match(dbg.caveats[0], /not a proven root cause/);
    assert.ok(dbg.failedMetrics.some((m) => m.metric === 'accuracy'));
    assert.equal(dbg.evaluation[0].runId, run.id);
    assert.equal((await w.services.debug.debug(A.principal, results.find((r) => r.testCaseId === c1.testCaseId).traceId)).verdict, 'clean');   // the correct refund answer is clean
  } finally { proc.kill(); }
});

test('engine rejects a wrong token with a permanent error (no retry storm)', { skip: !python && 'Python 3 not found' }, async () => {
  const { proc, port } = await startEngine();
  try {
    const bad = createEngineClient({ url: `http://127.0.0.1:${port}`, token: 'wrong-token-wrong-token', timeoutMs: 5000 });
    await assert.rejects(() => bad.evaluate({ trace: {}, evaluators: [{ metric: 'accuracy' }] }), (e) => e.status === 401 && e.retryable === false);
  } finally { proc.kill(); }
});
