import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from '../helpers/world.js';
import * as P from '../../src/modules/analytics/pipelines.js';
import { hasTenantMatchStage } from '../../src/lib/tenant.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const day = (n, h = 10) => new Date(Date.UTC(2026, 10, 10 - n, h));   // n days before "now"

async function setup() {
  const w = makeWorld({}, { now: () => new Date(NOW) });
  const A = await w.signup('orga');
  const a = await w.newAgent(A.principal, 'agent-a');
  const b = await w.newAgent(A.principal, 'agent-b');
  const key = await w.services.apiKeys.authenticate((await w.services.apiKeys.create(A.principal, { name: 'k', scopes: ['traces:write'] })).key);
  const put = (agent, o) => {
    const started = o.at;
    const t = w.traceFor(agent.id, { agentVersion: o.version, status: o.status ?? 'success', environment: o.env ?? 'production', startedAt: started.toISOString(), endedAt: new Date(started.getTime() + (o.ms ?? 1000)).toISOString(),
      durationMs: o.ms ?? 1000, usage: { totalTokens: o.tokens ?? 100, ...(o.cost !== undefined && { estimatedCostUsd: o.cost }) }, metadata: o.demo ? { demo: true } : {}, ...(o.status === 'error' && { error: { message: 'boom' } }) });
    if (o.cost === undefined) t.usage = { totalTokens: o.tokens ?? 100 };
    if (o.input) t.input = o.input;
    if (o.output) t.output = o.output;
    return w.services.traces.ingestOne(key, t);
  };
  // agent A: v1.0.0 is slow and flaky, v1.1.0 is better
  for (let i = 0; i < 6; i++) await put(a, { at: day(5, 8 + i), version: '1.0.0', ms: 4000, tokens: 200, cost: 0.02, status: i < 2 ? 'error' : 'success' });
  for (let i = 0; i < 4; i++) await put(a, { at: day(1, 8 + i), version: '1.1.0', ms: 2000, tokens: 100, cost: 0.01, status: i === 0 ? 'error' : 'success' });
  await put(a, { at: day(0, 9), version: '1.1.0', ms: 2000, tokens: 100, cost: 0.01, env: 'test', demo: true });
  for (let i = 0; i < 3; i++) await put(b, { at: day(2, 9 + i), version: '0.1.0', ms: 1000, tokens: 50 });
  await put(b, { at: day(60), version: '0.0.1' });                                   // outside the default 30-day window
  const res = (agent, runId, caseId, at, status, version, metrics) => w.repos.results.insertIfAbsent(A.principal.organizationId, { runId, testCaseId: caseId, agentId: agent.id, agentVersion: version, status, evaluatedAt: at, inputPreview: `question ${caseId}`, traceId: 'f'.repeat(32), metrics });
  const m = (metric, status, score, counts) => ({ metric, status, score, confidence: 0.9, ...(counts && { meta: { counts } }) });
  await res(a, '1'.repeat(24), 'c1', day(4), 'failed', '1.0.0', [m('accuracy', 'fail', 0.4), m('hallucination', 'fail', 0.0, { contradicted: 1, unsupported: 0, supported: 0 }), m('groundedness', 'fail', 0.0)]);
  await res(a, '1'.repeat(24), 'c2', day(4), 'passed', '1.0.0', [m('accuracy', 'pass', 1.0), m('hallucination', 'pass', 1.0, { contradicted: 0, unsupported: 0, supported: 3 }), m('groundedness', 'pass', 1.0)]);
  await res(a, '2'.repeat(24), 'c1', day(1), 'passed', '1.1.0', [m('accuracy', 'pass', 0.9), m('hallucination', 'pass', 1.0, { contradicted: 0, unsupported: 1, supported: 4 }), m('groundedness', 'pass', 0.8)]);
  await res(a, '2'.repeat(24), 'c2', day(1), 'error', '1.1.0', []);
  await res(b, '3'.repeat(24), 'c9', day(3), 'inconclusive', '0.1.0', [m('relevance', 'inconclusive', 0.5)]);
  return { w, A, a, b, key };
}

test('overview: totals, execution KPIs, quality KPIs (default 30-day window)', async () => {
  const { w, A } = await setup();
  const o = await w.services.analytics.overview(A.principal);
  assert.deepEqual(o.totals, { agents: 2, executions: 14, evaluationRuns: 0, failedExecutions: 3 });   // the 60-day-old trace is excluded; no runs were created via the service
  assert.equal(o.execution.errorRate, round(3 / 14));
  assert.equal(o.execution.taskCompletionRate, round(11 / 14));
  assert.equal(o.execution.avgLatencyMs, Math.round((6 * 4000 + 5 * 2000 + 3 * 1000) / 14));
  assert.equal(o.execution.totalTokens, 6 * 200 + 5 * 100 + 3 * 50);
  assert.equal(o.execution.estimatedCostUsd, round(6 * 0.02 + 5 * 0.01, 6));
  assert.equal(o.execution.costCoverage, round(11 / 14));                                           // honest about partial cost data
  const q = o.quality;
  assert.equal(q.accuracy, round((0.4 + 1.0 + 0.9) / 3));
  assert.equal(q.groundedness, round((0 + 1 + 0.8) / 3));
  assert.equal(q.unsupportedClaimRate, round((1 + 1) / (1 + 3 + 5)));                               // (contradicted + unsupported) / all claims
  assert.equal(q.contradictedClaimRate, round(1 / 9));
  assert.deepEqual([q.evaluatedCases, q.failedTestCases], [5, 2]);                                 // 1 failed + 1 error
  assert.equal(q.passRate, round(2 / 5));
  assert.deepEqual(q.metrics.accuracy, { avgScore: round(2.3 / 3), n: 3, pass: 2, fail: 1, inconclusive: 0 });
  assert.equal(o.recentFailures.length, 2);
  assert.ok(new Date(o.recentFailures[0].evaluatedAt) >= new Date(o.recentFailures[1].evaluatedAt));   // newest first
  assert.deepEqual(o.recentFailures.find((r) => r.status === 'failed').failedMetrics.sort(), ['accuracy', 'groundedness', 'hallucination']);
  assert.equal(o.filters.agentId, null);
});
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

test('overview: every filter narrows the right section', async () => {
  const { w, A, a, b } = await setup();
  const ov = (q) => w.services.analytics.overview(A.principal, q);
  assert.equal((await ov({ agentId: b.id })).totals.executions, 3);
  assert.equal((await ov({ agentId: a.id, version: '1.0.0' })).totals.executions, 6);
  assert.equal((await ov({ environment: 'test' })).totals.executions, 1);
  assert.equal((await ov({ status: 'error' })).totals.executions, 3);
  const st = await ov({ status: 'error' });
  assert.equal(st.quality.evaluatedCases, 5);                                                       // execution status does not filter evaluation results
  assert.equal((await ov({ demo: 'true' })).totals.executions, 1);
  assert.equal((await ov({ demo: 'false' })).totals.executions, 13);
  const ranged = await ov({ from: day(3).toISOString(), to: day(0, 23).toISOString() });
  assert.equal(ranged.totals.executions, 8);                                                        // days 2,1,0 only
  assert.equal(ranged.quality.evaluatedCases, 3);
  const wide = await ov({ from: day(90).toISOString() });
  assert.equal(wide.totals.executions, 15);
  const onlyAcc = await ov({ metric: 'accuracy' });
  assert.deepEqual(Object.keys(onlyAcc.quality.metrics), ['accuracy']);
  assert.equal((await ov({ agentId: a.id, version: '1.1.0' })).quality.accuracy, 0.9);
});

test('overview: trends - daily buckets ascending, evaluation runs ordered by time with per-metric scores', async () => {
  const { w, A } = await setup();
  const o = await w.services.analytics.overview(A.principal);
  assert.deepEqual(o.trends.daily.map((d) => [d.date, d.count, d.errors]), [['2026-11-05', 6, 2], ['2026-11-08', 3, 0], ['2026-11-09', 4, 1], ['2026-11-10', 1, 0]]);
  assert.equal(o.trends.daily[0].avgLatencyMs, 4000);
  assert.deepEqual(o.trends.runs.map((r) => r.runId), ['1'.repeat(24), '3'.repeat(24), '2'.repeat(24)]);
  assert.deepEqual(o.trends.runs[0].scores, { accuracy: 0.7, hallucination: 0.5, groundedness: 0.5 });
});

test('agent metrics: per-version comparison (executions, error rate, latency, tokens, quality) and a missing agent', async () => {
  const { w, A, a } = await setup();
  const m = await w.services.analytics.agentMetrics(A.principal, a.id, {});
  assert.equal(m.totals.executions, 11);
  const v10 = m.versions.find((v) => v.version === '1.0.0'), v11 = m.versions.find((v) => v.version === '1.1.0');
  assert.deepEqual([v10.executions, v10.errorRate, v10.avgLatencyMs, v10.avgTokens], [6, round(2 / 6), 4000, 200]);
  assert.deepEqual([v11.executions, v11.errorRate, v11.avgLatencyMs, v11.avgTokens], [5, round(1 / 5), 2000, 100]);
  assert.deepEqual(v10.quality, { accuracy: 0.7, hallucination: 0.5, groundedness: 0.5 });
  assert.deepEqual(v11.quality, { accuracy: 0.9, hallucination: 1, groundedness: 0.8 });
  assert.deepEqual(m.versions.map((v) => v.version), ['1.0.0', '1.1.0']);                           // ordered by executions
  const onlyV = await w.services.analytics.agentMetrics(A.principal, a.id, { version: '1.0.0' });
  assert.equal(onlyV.versions.length, 2);                                                           // comparison still shows every version
  await assert.rejects(() => w.services.analytics.agentMetrics(A.principal, '0'.repeat(24), {}), { code: 'AGENT_NOT_FOUND' });
  await assert.rejects(() => w.services.analytics.agentMetrics(A.principal, 'nope', {}), { code: 'AGENT_NOT_FOUND' });
});

test('empty organization: nulls and zeros, never NaN', async () => {
  const w = makeWorld({}, { now: () => new Date(NOW) });
  const { principal } = await w.signup();
  const o = await w.services.analytics.overview(principal);
  assert.deepEqual(o.totals, { agents: 0, executions: 0, evaluationRuns: 0, failedExecutions: 0 });
  assert.deepEqual([o.execution.avgLatencyMs, o.execution.errorRate, o.execution.estimatedCostUsd, o.quality.accuracy, o.quality.passRate, o.quality.unsupportedClaimRate], [null, null, null, null, null, null]);
  assert.deepEqual([o.trends.daily, o.trends.runs, o.recentFailures], [[], [], []]);
  assert.equal(JSON.stringify(o).includes('NaN'), false);
});

test('validation of filters: dates, ranges, enums, injection attempts', async () => {
  const { w, A } = await setup();
  const ov = (q) => w.services.analytics.overview(A.principal, q);
  for (const q of [{ from: 'yesterday' }, { to: 'x' }, { from: day(0).toISOString(), to: day(5).toISOString() }, { from: day(400).toISOString() }, { metric: 'vibes' }, { environment: 'moon' }, { status: 'meh' },
    { agentId: 'nope' }, { demo: 'maybe' }, { version: 'x'.repeat(65) }, { agentId: { $ne: 'x' } }, { status: ['a', 'b'] }])
    await assert.rejects(() => ov(q), { code: 'INVALID_QUERY' }, JSON.stringify(q));
  await assert.rejects(() => ov({ agentId: '0'.repeat(24) }), { code: 'AGENT_NOT_FOUND' });
});

test('access control and tenant isolation of analytics', async () => {
  const { w, A, a, key } = await setup();
  const viewer = { ...A.principal, role: 'viewer' };
  assert.equal((await w.services.analytics.overview(viewer)).totals.agents, 2);
  await assert.rejects(() => w.services.analytics.overview(key), { code: 'FORBIDDEN' });
  await assert.rejects(() => w.services.analytics.agentMetrics(key, a.id), { code: 'FORBIDDEN' });
  const B = await w.signup('orgb');
  const o = await w.services.analytics.overview(B.principal);
  assert.deepEqual([o.totals.agents, o.totals.executions, o.quality.evaluatedCases, o.recentFailures.length], [0, 0, 0, 0]);
  await assert.rejects(() => w.services.analytics.overview(B.principal, { agentId: a.id }), { code: 'AGENT_NOT_FOUND' });
  await assert.rejects(() => w.services.analytics.agentMetrics(B.principal, a.id), { code: 'AGENT_NOT_FOUND' });
});

// ---------------- trace explorer ----------------
test('explorer: filter combinations, pagination without duplicates, summaries only', async () => {
  const { w, A, a, b } = await setup();
  const ex = (q) => w.services.traces.explore(A.principal, q);
  assert.equal((await ex({ limit: '100' })).items.length, 15);
  assert.equal((await ex({ agentId: b.id, limit: '100' })).items.length, 4);
  assert.equal((await ex({ status: 'error', limit: '100' })).items.length, 3);
  assert.equal((await ex({ environment: 'test' })).items.length, 1);
  assert.equal((await ex({ version: '1.0.0' })).items.length, 6);
  assert.equal((await ex({ minDurationMs: '3000' })).items.length, 6);
  assert.equal((await ex({ demo: 'true' })).items.length, 1);
  assert.equal((await ex({ from: day(3).toISOString(), to: day(0, 23).toISOString() })).items.length, 8);
  const seen = []; let cursor;
  for (let g = 0; g < 20; g++) {
    const p = await ex({ limit: '4', ...(cursor && { cursor }) });
    for (const it of p.items) { assert.equal(it.spans, undefined); assert.equal(it.input, undefined); seen.push(it.traceId); }
    if (!(cursor = p.nextCursor)) break;
  }
  assert.equal(seen.length, 15);
  assert.equal(new Set(seen).size, 15);
  const all = (await ex({ limit: '100' })).items.map((t) => new Date(t.startedAt).getTime());
  assert.deepEqual(all, [...all].sort((x, y) => y - x));                                           // newest first
  assert.equal(a.id.length, 24);
});

test('explorer text search: literal (no regex), bounded in time, length-capped', async () => {
  const { w, A, a } = await setup();
  const key = await w.services.apiKeys.authenticate((await w.services.apiKeys.create(A.principal, { name: 'k2', scopes: ['traces:write'] })).key);
  const t = w.traceFor(a.id, { input: 'Where is my parcel 12345?', output: 'It left the depot (today).', startedAt: day(1).toISOString(), endedAt: day(1).toISOString() });
  await w.services.traces.ingestOne(key, t);
  const ex = (q) => w.services.traces.explore(A.principal, q);
  assert.equal((await ex({ q: 'PARCEL' })).items.length, 1);                                        // case-insensitive
  assert.equal((await ex({ q: 'depot (today)' })).items.length, 1);                                 // metacharacters are literal
  assert.equal((await ex({ q: '.*' })).items.length, 0);                                            // NOT "match everything"
  assert.equal((await ex({ q: '(a+)+$' })).items.length, 0);
  assert.equal((await ex({ q: 'parcel', agentId: a.id })).items[0].traceId, t.traceId);
  await assert.rejects(() => ex({ q: 'x'.repeat(101) }), { code: 'INVALID_QUERY' });
  const old = w.traceFor(a.id, { input: 'ancient parcel question', startedAt: day(45).toISOString(), endedAt: day(45).toISOString() });
  await w.services.traces.ingestOne(key, old);
  assert.equal((await ex({ q: 'ancient' })).items.length, 0);                                       // search defaults to the last 30 days
  assert.equal((await ex({ q: 'ancient', from: day(90).toISOString() })).items.length, 1);
});

test('explorer validation and isolation', async () => {
  const { w, A, key } = await setup();
  const ex = (p, q) => w.services.traces.explore(p, q);
  for (const q of [{ status: 'meh' }, { environment: 'moon' }, { from: 'x' }, { minDurationMs: '-1' }, { minDurationMs: 'abc' }, { agentId: 'nope' }, { demo: 'x' }, { limit: '0' }, { cursor: 'zzz' }, { status: { $ne: 'x' } }, { cursor: Buffer.from('{"t":"x","id":"y"}').toString('base64url') }])
    await assert.rejects(() => ex(A.principal, q), (e) => ['INVALID_QUERY', 'INVALID_CURSOR'].includes(e.code), JSON.stringify(q));
  await assert.rejects(() => ex(key, {}), { code: 'FORBIDDEN' });
  const B = await w.signup('orgb');
  assert.deepEqual((await ex(B.principal, { limit: '100' })).items, []);
});

// ---------------- pipelines (tenant safety checkable without a database) ----------------
test('every aggregation pipeline starts with a tenant $match and contains no code-execution operators', () => {
  const ORG = { sentinel: 'org' };
  const f = { from: day(5), to: day(0), agentId: 'a'.repeat(24), version: '1.0', environment: 'test', status: 'error', metric: 'accuracy', q: 'x.*', isDemo: false, minDurationMs: 5 };
  for (const [name, build] of Object.entries({ traceStatsPipeline: P.traceStatsPipeline, traceDailyPipeline: P.traceDailyPipeline, traceByVersionPipeline: P.traceByVersionPipeline, metricStatsPipeline: P.metricStatsPipeline,
    caseStatsPipeline: P.caseStatsPipeline, runTrendPipeline: P.runTrendPipeline, versionQualityPipeline: P.versionQualityPipeline })) {
    const pipe = build(ORG, f);
    assert.equal(pipe[0].$match.organizationId, ORG, name);
    assert.equal(hasTenantMatchStage(pipe), true, name);
    assert.equal(/\$where|\$function|\$accumulator|\$expr/.test(JSON.stringify(pipe)), false, name);
    assert.equal(build(ORG, {})[0].$match.organizationId, ORG, `${name} with no filters`);
  }
  assert.equal(P.traceMatch(ORG, { q: 'a.*b(c)' }).$or[0].inputPreview.$regex, 'a\\.\\*b\\(c\\)');       // user text is escaped, never a pattern
  assert.deepEqual(P.metricStatsPipeline(ORG, { metric: 'accuracy' })[2], { $match: { 'metrics.metric': 'accuracy' } });
  assert.equal(P.escapeRegex('x'.repeat(500)).length, 100);
  assert.equal(P.traceMatch(ORG, { isDemo: false }).isDemo.$ne, true);
});
