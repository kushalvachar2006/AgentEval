import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, seedSuite, listen, fakeEngine, CASES } from '../helpers/world.js';

const ENV = { ALLOW_PRIVATE_ENDPOINTS: 'true' };
const clockWorld = (engineFn, env = ENV) => {
  const clock = { t: new Date('2026-11-05T10:00:00.000Z') };
  const engine = fakeEngine(engineFn);
  const w = makeWorld(env, { now: () => new Date(clock.t), engine });
  return { w, clock, engine };
};

async function endpointSetup({ engineFn, handler, env } = {}) {
  const { w, clock, engine } = clockWorld(engineFn, env);
  const A = await w.signup('orga');
  const hits = [];
  const srv = await listen((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const body = JSON.parse(b); hits.push({ headers: req.headers, body });
      if (handler) return handler(req, res, body, hits.length);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ output: `echo: ${body.input}` }));
    });
  });
  const agent = await w.newAgent(A.principal, 'callable', { integrationType: 'api', endpointUrl: `http://127.0.0.1:${srv.port}/run`, endpointToken: 'agent-secret-token' });
  const suite = await seedSuite(w, A.principal);
  return { w, A, clock, engine, srv, hits, agent, suite };
}
const startRun = (x, extra = {}) => x.w.services.evaluations.create(x.A.principal, { agentId: x.agent.id, suiteId: x.suite.id, mode: 'endpoint', ...extra });

test('endpoint mode: full run - agent called with token + contract, results stored, summary aggregated, run completed', async () => {
  const x = await endpointSetup();
  try {
    const run = await startRun(x);
    assert.equal(run.status, 'queued');
    assert.deepEqual(run.progress, { total: 3, completed: 0, passed: 0, failed: 0, inconclusive: 0, error: 0 });
    assert.deepEqual(run.evaluators.map((e) => `${e.metric}@${e.version}`).sort(), ['accuracy@1.0.0', 'hallucination@1.0.0', 'groundedness@1.0.0', 'completeness@1.0.0', 'tool_usage@1.0.0', 'instruction_adherence@1.0.0', 'relevance@1.0.0'].sort());
    await x.w.worker.loop.drain();

    assert.equal(x.hits.length, 3);
    assert.equal(x.hits[0].headers.authorization, 'Bearer agent-secret-token');
    assert.equal(x.hits[0].headers['x-agenteval-run'], run.id);
    assert.equal(x.hits[0].body.input, CASES[0].input);
    assert.match(x.hits[0].body.traceId, /^[0-9a-f]{32}$/);

    const done = await x.w.services.evaluations.get(x.A.principal, run.id);
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.progress, { total: 3, completed: 3, passed: 3, failed: 0, inconclusive: 0, error: 0 });
    assert.equal(done.summary.cases.passed, 3);
    assert.equal(done.summary.passRate, 1);
    assert.equal(done.summary.metrics.accuracy.pass, 3);
    assert.ok(done.completedAt);

    const res = await x.w.services.evaluations.results(x.A.principal, run.id);
    assert.equal(res.items.length, 3);
    assert.equal(res.items[0].organizationId, undefined);
    assert.match(res.items[0].outputPreview, /^echo:/);
    assert.equal(x.w.repos._db.traces.length, 3);                                 // synthesized traces are stored for the trace explorer
    assert.equal(x.w.repos._db.traces[0].metadata.synthesized, true);
    assert.equal(x.w.repos._db.traces[0].environment, 'evaluation');
    // the engine received a payload with the case fields and pinned evaluator versions, and no organization data
    const p = x.engine.calls[0];
    assert.equal(p.testCase.referenceAnswer, CASES[0].referenceAnswer);
    assert.ok(p.evaluators.every((e) => e.version === '1.0.0'));
    assert.equal(JSON.stringify(p).includes(x.A.principal.organizationId), false);
    assert.equal(p.judge, null);
  } finally { x.srv.close(); }
});

test('run is idempotent: processing the same job twice never double counts', async () => {
  const x = await endpointSetup();
  try {
    const run = await startRun(x);
    await x.w.worker.loop.drain();
    const job = { ...x.w.repos._db.jobs[0], attempts: 1 };
    assert.deepEqual(await x.w.worker.executor.handle(job), { done: true, skipped: 'run is not active' });   // run already completed
    // simulate a duplicate delivery while the run is still active: results.insertIfAbsent must refuse the second write
    const r = x.w.repos._db.results[0];
    assert.deepEqual(await x.w.repos.results.insertIfAbsent(r.organizationId, { ...r }), { created: false });
    assert.equal((await x.w.services.evaluations.get(x.A.principal, run.id)).progress.completed, 3);
    // enqueueing the same case twice is a no-op as well
    assert.equal((await x.w.repos.jobs.enqueue(r.organizationId, { type: 'evaluate_case', runId: run.id, testCaseId: r.testCaseId, idempotencyKey: `eval:${run.id}:${r.testCaseId}` })).created, false);
  } finally { x.srv.close(); }
});

test('failures: engine fail/inconclusive map to case statuses; permanent agent error -> error result; run still completes', async () => {
  let n = 0;
  const x = await endpointSetup({
    engineFn: (p) => { n++; const status = n === 1 ? 'fail' : n === 2 ? 'inconclusive' : 'pass'; return { results: [{ metric: 'relevance', status, score: 0.5, confidence: 0.8, evaluatorVersion: '1.0.0', explanation: '', findings: [], meta: {} }], judgeCalls: 0 }; },
    handler: (req, res, body) => { if (body.input.startsWith('What is the refund')) { res.statusCode = 400; return res.end('{}'); } res.setHeader('content-type', 'application/json'); res.end('{"output":"ok"}'); },
  });
  try {
    const run = await startRun(x, { metrics: [{ metric: 'relevance' }] });
    await x.w.worker.loop.drain();
    const done = await x.w.services.evaluations.get(x.A.principal, run.id);
    assert.equal(done.status, 'completed');
    assert.deepEqual([done.progress.failed, done.progress.inconclusive, done.progress.error, done.progress.passed], [1, 1, 1, 0]);
    const byStatus = Object.fromEntries((await x.w.services.evaluations.results(x.A.principal, run.id)).items.map((r) => [r.inputPreview.slice(0, 8), r.status]));
    assert.equal(byStatus['What is '], 'error');                       // agent answered HTTP 400 -> permanent
    assert.deepEqual(Object.values(byStatus).sort(), ['error', 'failed', 'inconclusive']);
    const err = (await x.w.services.evaluations.results(x.A.principal, run.id, { status: 'error' })).items[0];
    assert.match(err.error, /HTTP 400/);
    assert.equal(done.summary.cases.error, 1);
  } finally { x.srv.close(); }
});

test('transient agent failure (503) is retried with backoff and then succeeds', async () => {
  let calls = 0;
  const x = await endpointSetup({ handler: (req, res, body, n) => { calls = n; if (n === 1) { res.statusCode = 503; return res.end('{}'); } res.setHeader('content-type', 'application/json'); res.end('{"output":"fine"}'); } });
  try {
    await x.w.services.suites.importCases(x.A.principal, x.suite.id, { format: 'json', content: '[]', allowPartial: true }).catch(() => {});
    const solo = await seedSuite(x.w, x.A.principal, 'solo', [{ input: 'only one' }]);
    const run = await x.w.services.evaluations.create(x.A.principal, { agentId: x.agent.id, suiteId: solo.id, mode: 'endpoint', metrics: [{ metric: 'relevance' }] });
    await x.w.worker.loop.drain();
    assert.equal((await x.w.services.evaluations.get(x.A.principal, run.id)).progress.completed, 0);      // waiting for backoff
    assert.equal(x.w.repos._db.jobs[0].status, 'queued');
    x.clock.t = new Date(x.clock.t.getTime() + 5000);                                                    // advance past the 2 s backoff
    await x.w.worker.loop.drain();
    const done = await x.w.services.evaluations.get(x.A.principal, run.id);
    assert.equal(done.status, 'completed');
    assert.equal(done.progress.passed, 1);
    assert.equal(calls, 2);
  } finally { x.srv.close(); }
});

test('agent that always fails: after max attempts the case becomes an error result (run does not hang)', async () => {
  const x = await endpointSetup({ handler: (req, res) => { res.statusCode = 502; res.end('{}'); } });
  try {
    const solo = await seedSuite(x.w, x.A.principal, 'solo', [{ input: 'only one' }]);
    const run = await x.w.services.evaluations.create(x.A.principal, { agentId: x.agent.id, suiteId: solo.id, mode: 'endpoint', metrics: [{ metric: 'relevance' }] });
    for (let i = 0; i < 5; i++) { await x.w.worker.loop.drain(); x.clock.t = new Date(x.clock.t.getTime() + 60_000); }
    const done = await x.w.services.evaluations.get(x.A.principal, run.id);
    assert.deepEqual([done.status, done.progress.error], ['completed', 1]);
    assert.equal(x.hits.length, 3);                                       // maxAttempts = 3
    assert.match((await x.w.services.evaluations.results(x.A.principal, run.id)).items[0].error, /HTTP 502/);
  } finally { x.srv.close(); }
});

test('engine outage retries then records errors; engine 400 is permanent', async () => {
  const { UpstreamError } = await import('../../src/lib/upstream.js');
  let mode = 'down';
  const x = await endpointSetup({ engineFn: () => { throw new UpstreamError(mode === 'down' ? 'Evaluation engine is unreachable' : 'Evaluation engine returned 400', { retryable: mode === 'down' }); } });
  try {
    const solo = await seedSuite(x.w, x.A.principal, 'solo', [{ input: 'only one' }]);
    const run = await x.w.services.evaluations.create(x.A.principal, { agentId: x.agent.id, suiteId: solo.id, mode: 'endpoint', metrics: [{ metric: 'relevance' }] });
    await x.w.worker.loop.drain();
    assert.equal(x.w.repos._db.jobs.at(-1).status, 'queued');            // retryable -> back in the queue
    for (let i = 0; i < 4; i++) { x.clock.t = new Date(x.clock.t.getTime() + 60_000); await x.w.worker.loop.drain(); }
    assert.equal((await x.w.services.evaluations.get(x.A.principal, run.id)).progress.error, 1);
    mode = 'bad';
    const run2 = await x.w.services.evaluations.create(x.A.principal, { agentId: x.agent.id, suiteId: solo.id, mode: 'endpoint', metrics: [{ metric: 'relevance' }] });
    await x.w.worker.loop.drain();
    assert.equal(x.w.repos._db.jobs.filter((j) => j.runId === run2.id)[0].attempts, 1);   // no retry for permanent errors
    assert.equal((await x.w.services.evaluations.get(x.A.principal, run2.id)).progress.error, 1);
  } finally { x.srv.close(); }
});

test('cancel: queued jobs are cancelled, no results appear, state is final; double cancel is 409', async () => {
  const x = await endpointSetup();
  try {
    const run = await startRun(x);
    const c = await x.w.services.evaluations.cancel(x.A.principal, run.id);
    assert.equal(c.status, 'cancelled');
    await x.w.worker.loop.drain();
    assert.equal(x.hits.length, 0);
    assert.equal(x.w.repos._db.results.length, 0);
    assert.ok(x.w.repos._db.jobs.every((j) => j.status === 'cancelled'));
    await assert.rejects(() => x.w.services.evaluations.cancel(x.A.principal, run.id), { code: 'RUN_FINISHED' });
    await assert.rejects(() => x.w.services.evaluations.cancel({ ...x.A.principal, role: 'viewer' }, run.id), { code: 'FORBIDDEN' });
  } finally { x.srv.close(); }
});

test('cancel while a case is in flight: late result is discarded and the run stays cancelled', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const x = await endpointSetup({ engineFn: async () => { await gate; return { results: [{ metric: 'relevance', status: 'pass', score: 1, confidence: 0.9, evaluatorVersion: '1.0.0', explanation: '', findings: [], meta: {} }], judgeCalls: 0 }; } });
  try {
    const run = await startRun(x, { metrics: [{ metric: 'relevance' }] });
    const started = await x.w.worker.loop.tick();                         // jobs are now running, blocked inside the engine call
    await new Promise((r) => setTimeout(r, 100));
    await x.w.services.evaluations.cancel(x.A.principal, run.id);
    release();
    await Promise.all(started);
    await x.w.worker.loop.drain();
    assert.equal((await x.w.services.evaluations.get(x.A.principal, run.id)).status, 'cancelled');
    assert.equal(x.w.repos._db.results.length, 0);
  } finally { x.srv.close(); }
});

test('judge: not configured -> 422; configured -> used within a strict budget; credentials only reach the engine, never the API', async () => {
  const used2 = (p) => ({ results: p.evaluators.map((e) => ({ metric: e.metric, status: 'pass', score: 1, confidence: 0.9, evaluatorVersion: e.version, explanation: '', findings: [], meta: {} })), judgeCalls: p.judge ? 2 : 0 });
  const x = await endpointSetup({ engineFn: used2, env: { ...ENV, WORKER_CONCURRENCY: '1' } });
  try {
    await assert.rejects(() => startRun(x, { useJudge: true }), { code: 'JUDGE_NOT_CONFIGURED' });
    await x.w.services.evaluatorConfig.put(x.A.principal, { judge: { enabled: true, provider: 'openai_compatible', model: 'm', apiKey: 'sk-judge-key-1234' } });
    const run = await startRun(x, { limits: { maxJudgeCalls: 3 } });
    assert.equal(run.useJudge, true);                                     // defaults to on when a judge is configured
    assert.equal(JSON.stringify(run).includes('judge-key'), false);
    await x.w.worker.loop.drain();
    // budget 3, one worker: case1 granted 3, used 2 (1 refunded); case2 granted the 1 left; case3 gets no judge at all
    assert.deepEqual(x.engine.calls.map((c) => c.judge?.apiKey ?? null), ['sk-judge-key-1234', 'sk-judge-key-1234', null]);
    assert.deepEqual(x.engine.calls.map((c) => c.limits.maxJudgeCalls), [3, 1, 0]);
    const done = await x.w.services.evaluations.get(x.A.principal, run.id);
    assert.equal(done.counters.judgeCalls, 3);                            // never exceeds the budget
    assert.equal(done.summary.judgeCalls, 3);
    assert.equal((await startRun(x, { useJudge: false })).useJudge, false);
  } finally { x.srv.close(); }
});

test('judge budget cannot be overspent by parallel workers', async () => {
  const x = await endpointSetup({ engineFn: (p) => ({ results: p.evaluators.map((e) => ({ metric: e.metric, status: 'pass', score: 1, confidence: 0.9, evaluatorVersion: e.version, explanation: '', findings: [], meta: {} })), judgeCalls: p.limits.maxJudgeCalls }), env: { ...ENV, WORKER_CONCURRENCY: '3' } });
  try {
    await x.w.services.evaluatorConfig.put(x.A.principal, { judge: { enabled: true, provider: 'openai_compatible', model: 'm', apiKey: 'sk-judge-key-1234' } });
    const run = await startRun(x, { limits: { maxJudgeCalls: 5 } });   // 3 cases run at the same time, each would happily use up to 8
    await x.w.worker.loop.drain();
    const done = await x.w.services.evaluations.get(x.A.principal, run.id);
    assert.ok(done.counters.judgeCalls <= 5, `spent ${done.counters.judgeCalls} of 5`);
    assert.equal(done.status, 'completed');
    assert.ok(x.engine.calls.reduce((n, c) => n + c.limits.maxJudgeCalls, 0) <= 5 + 5);   // every grant was bounded
  } finally { x.srv.close(); }
});

test('run creation validation: metrics, versions, modes, empty/missing suite, tenant isolation', async () => {
  const x = await endpointSetup();
  try {
    const mk = (extra) => x.w.services.evaluations.create(x.A.principal, { agentId: x.agent.id, suiteId: x.suite.id, mode: 'endpoint', ...extra });
    await assert.rejects(() => mk({ metrics: [{ metric: 'vibes' }] }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(() => mk({ metrics: [{ metric: 'accuracy', version: '9.9.9' }] }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(() => mk({ metrics: [{ metric: 'accuracy', config: 'no' }] }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(() => mk({ metrics: [] }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(() => mk({ mode: 'magic' }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(() => mk({ limits: { maxJudgeCalls: -1 } }), { code: 'VALIDATION_ERROR' });
    const sdkAgent = await x.w.newAgent(x.A.principal, 'sdk-agent');
    await assert.rejects(() => x.w.services.evaluations.create(x.A.principal, { agentId: sdkAgent.id, suiteId: x.suite.id, mode: 'endpoint' }), { code: 'AGENT_NOT_CALLABLE' });
    const empty = await x.w.services.suites.create(x.A.principal, { name: 'empty' });
    await assert.rejects(() => mk({ suiteId: empty.id }), { code: 'SUITE_EMPTY' });
    await assert.rejects(() => mk({ suiteId: '0'.repeat(24) }), { code: 'SUITE_NOT_FOUND' });
    await assert.rejects(() => mk({ agentId: '0'.repeat(24) }), { code: 'AGENT_NOT_FOUND' });
    const key = await x.w.services.apiKeys.create(x.A.principal, { name: 'k', scopes: ['evaluations:run'] });
    const keyPrincipal = await x.w.services.apiKeys.authenticate(key.key);
    await assert.rejects(() => x.w.services.evaluations.create(keyPrincipal, { agentId: x.agent.id, suiteId: x.suite.id, mode: 'sdk' }), { code: 'FORBIDDEN' });
    const run = await mk({ metrics: [{ metric: 'operational', config: { maxLatencyMs: 5000 } }] });
    assert.equal(run.evaluators[0].config.maxLatencyMs, 5000);

    const B = await x.w.signup('orgb');
    for (const fn of [() => x.w.services.evaluations.get(B.principal, run.id), () => x.w.services.evaluations.results(B.principal, run.id), () => x.w.services.evaluations.cancel(B.principal, run.id), () => x.w.services.evaluations.work(B.principal, run.id)])
      await assert.rejects(fn, { code: 'RUN_NOT_FOUND' });
    await assert.rejects(() => x.w.services.evaluations.create(B.principal, { agentId: x.agent.id, suiteId: x.suite.id, mode: 'endpoint' }), { code: 'AGENT_NOT_FOUND' });
    assert.deepEqual((await x.w.services.evaluations.list(B.principal)).items, []);
    assert.equal((await x.w.services.evaluations.list(x.A.principal)).items.length, 1);
    await assert.rejects(() => x.w.services.evaluations.results(x.A.principal, run.id, { status: 'nope' }), { code: 'INVALID_QUERY' });
  } finally { x.srv.close(); }
});

test('default metrics follow what the test cases contain', async () => {
  const { w } = clockWorld();
  const A = await w.signup();
  const agent = await w.newAgent(A.principal, 'a');
  const only = await seedSuite(w, A.principal, 's1', [{ input: 'plain' }]);
  const r1 = await w.services.evaluations.create(A.principal, { agentId: agent.id, suiteId: only.id, mode: 'sdk' });
  assert.deepEqual(r1.evaluators.map((e) => e.metric), ['relevance']);
  const rich = await seedSuite(w, A.principal, 's2');
  const r2 = await w.services.evaluations.create(A.principal, { agentId: agent.id, suiteId: rich.id, mode: 'sdk' });
  assert.deepEqual(r2.evaluators.map((e) => e.metric).sort(), ['accuracy', 'completeness', 'groundedness', 'hallucination', 'instruction_adherence', 'relevance', 'tool_usage']);
});

// ---------------- SDK mode ----------------
async function sdkSetup() {
  const { w, clock, engine } = clockWorld();
  const A = await w.signup('orga');
  const agent = await w.newAgent(A.principal, 'sdk-agent');
  const suite = await seedSuite(w, A.principal);
  const key = await w.services.apiKeys.create(A.principal, { name: 'sdk', scopes: ['traces:write', 'evaluations:run'] });
  const kp = await w.services.apiKeys.authenticate(key.key);
  const run = await w.services.evaluations.create(A.principal, { agentId: agent.id, suiteId: suite.id, mode: 'sdk', metrics: [{ metric: 'relevance' }] });
  return { w, clock, engine, A, agent, suite, kp, run };
}
const tagged = (x, caseId, patch = {}) => x.w.traceFor(x.agent.id, { metadata: { evaluation: { runId: x.run.id, testCaseId: caseId } }, ...patch });

test('sdk mode: work list -> traces linked via metadata -> evaluated -> run completes; completed cases leave the work list', async () => {
  const x = await sdkSetup();
  assert.equal(x.run.status, 'awaiting_traces');
  assert.ok(x.run.awaitDeadline);
  let work = await x.w.services.evaluations.work(x.kp, x.run.id);
  assert.deepEqual(work.cases.map((c) => c.input), CASES.map((c) => c.input));

  const first = work.cases[0].testCaseId;
  const r1 = await x.w.services.traces.ingestOne(x.kp, tagged(x, first));
  assert.deepEqual([r1.status, r1.linked], ['accepted', true]);
  assert.equal((await x.w.services.evaluations.work(x.kp, x.run.id)).cases.length, 2);   // taken even before it is evaluated
  const dup = await x.w.services.traces.ingestOne(x.kp, tagged(x, first, { traceId: x.w.repos._db.traces[0].traceId }));
  assert.equal(dup.status, 'duplicate');
  assert.equal(x.w.repos._db.jobs.length, 1);                                              // no double enqueue

  for (const c of work.cases.slice(1)) await x.w.services.traces.ingestOne(x.kp, tagged(x, c.testCaseId));
  await x.w.worker.loop.drain();
  const done = await x.w.services.evaluations.get(x.A.principal, x.run.id);
  assert.deepEqual([done.status, done.progress.completed, done.progress.passed], ['completed', 3, 3]);
  await assert.rejects(() => x.w.services.evaluations.work(x.kp, x.run.id), { code: 'RUN_NOT_ACCEPTING' });
  assert.equal(x.engine.calls[0].trace.spans.length, 5);                                   // the real SDK trace reached the engine
});

test('sdk mode: wrong agent / other run / unknown case / not-awaiting run / ordinary traces are NOT linked (and still ingested)', async () => {
  const x = await sdkSetup();
  const caseId = (await x.w.services.evaluations.work(x.kp, x.run.id)).cases[0].testCaseId;
  const other = await x.w.newAgent(x.A.principal, 'other-agent');
  const k2 = await x.w.services.apiKeys.authenticate((await x.w.services.apiKeys.create(x.A.principal, { name: 'k2', scopes: ['traces:write'] })).key);
  const linkedOf = async (t) => (await x.w.services.traces.ingestOne(k2, t)).linked;
  assert.equal(await linkedOf(x.w.traceFor(other.id, { metadata: { evaluation: { runId: x.run.id, testCaseId: caseId } } })), false);   // different agent than the run's
  assert.equal(await linkedOf(tagged(x, '0'.repeat(24))), false);                                                                       // case not part of the run
  assert.equal(await linkedOf(x.w.traceFor(x.agent.id, { metadata: { evaluation: { runId: '0'.repeat(24), testCaseId: caseId } } })), false);
  assert.equal(await linkedOf(x.w.traceFor(x.agent.id, { metadata: { evaluation: 'garbage' } })), undefined);       // not a link at all: treated as an ordinary trace
  assert.equal((await x.w.services.traces.ingestOne(k2, x.w.traceFor(x.agent.id))).linked, undefined);                                    // normal trace: no link field
  assert.equal(x.w.repos._db.jobs.length, 0);
  assert.equal(x.w.repos._db.traces.length, 5);                                                                                          // all were stored regardless
  await x.w.services.evaluations.cancel(x.A.principal, x.run.id);
  assert.equal(await linkedOf(tagged(x, caseId)), false);                                                                                // cancelled run accepts nothing
  await assert.rejects(() => x.w.services.evaluations.work(x.kp, x.run.id), { code: 'RUN_NOT_ACCEPTING' });
});

test('sdk mode: key bound to another agent cannot fetch the work list; endpoint-mode runs have no SDK work', async () => {
  const x = await sdkSetup();
  const other = await x.w.newAgent(x.A.principal, 'other-agent');
  const bound = await x.w.services.apiKeys.authenticate((await x.w.services.apiKeys.create(x.A.principal, { name: 'b', scopes: ['evaluations:run'], agentId: other.id })).key);
  await assert.rejects(() => x.w.services.evaluations.work(bound, x.run.id), { code: 'RUN_NOT_FOUND' });
  const noScope = await x.w.services.apiKeys.authenticate((await x.w.services.apiKeys.create(x.A.principal, { name: 'n', scopes: ['traces:write'] })).key);
  await assert.rejects(() => x.w.services.evaluations.work(noScope, x.run.id), { code: 'FORBIDDEN' });
});

test('sdk mode deadline: cases without a trace become error results and the run finishes; late traces are refused', async () => {
  const x = await sdkSetup();
  const work = await x.w.services.evaluations.work(x.kp, x.run.id);
  await x.w.services.traces.ingestOne(x.kp, tagged(x, work.cases[0].testCaseId));
  await x.w.worker.loop.drain();
  assert.equal((await x.w.worker.executor.sweepExpired()), 0);                              // before the deadline: nothing happens
  x.clock.t = new Date(x.clock.t.getTime() + 31 * 60_000);
  assert.equal(await x.w.services.traces.ingestOne(x.kp, tagged(x, work.cases[1].testCaseId)).then((r) => r.linked), false);
  assert.equal(await x.w.worker.executor.sweepExpired(), 2);
  const done = await x.w.services.evaluations.get(x.A.principal, x.run.id);
  assert.deepEqual([done.status, done.progress.passed, done.progress.error], ['completed', 1, 2]);
  assert.equal(await x.w.worker.executor.sweepExpired(), 0);                                // idempotent
  const errs = (await x.w.services.evaluations.results(x.A.principal, x.run.id, { status: 'error' })).items;
  assert.ok(errs.every((e) => /deadline/.test(e.error)));
});

test('worker crash: a job whose lease expired is picked up again, and gives up after maxAttempts', async () => {
  const x = await sdkSetup();
  const caseId = (await x.w.services.evaluations.work(x.kp, x.run.id)).cases[0].testCaseId;
  await x.w.services.traces.ingestOne(x.kp, tagged(x, caseId));
  const job = await x.w.repos.jobs.claim({ workerId: 'crashed', now: x.clock.t, leaseMs: 1000 });   // a worker takes it, then dies
  assert.equal(job.attempts, 1);
  assert.equal(await x.w.repos.jobs.claim({ workerId: 'other', now: x.clock.t, leaseMs: 1000 }), null);   // lease still valid
  x.clock.t = new Date(x.clock.t.getTime() + 5000);
  await x.w.worker.loop.drain();
  assert.equal(x.w.repos._db.results.length, 1);
  // repeated crashes: attempts beyond maxAttempts -> error result instead of looping forever
  const caseId2 = (await x.w.services.evaluations.work(x.kp, x.run.id)).cases[0].testCaseId;
  await x.w.services.traces.ingestOne(x.kp, tagged(x, caseId2));
  for (let i = 0; i < 4; i++) { await x.w.repos.jobs.claim({ workerId: 'crashy', now: x.clock.t, leaseMs: 1000 }); x.clock.t = new Date(x.clock.t.getTime() + 5000); }
  await x.w.worker.loop.drain();
  const r = x.w.repos._db.results.find((q) => q.testCaseId === caseId2);
  assert.equal(r.status, 'error');
  assert.match(r.error, /stopped repeatedly/);
});
