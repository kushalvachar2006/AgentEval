// Milestone 5 pure logic: sampling, policy validation, histogram, health, alert rule evaluation and lifecycle (controllable clock).
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSampling, hashUnit } from '../../src/modules/monitoring/sampling.js';
import { validatePolicy, effectivePolicy } from '../../src/modules/monitoring/policy.js';
import { bucketIndex, percentileFromBuckets, percentileExact, mergeBuckets, bucketKey, EDGES_MS } from '../../src/modules/monitoring/histogram.js';
import { computeHealth } from '../../src/modules/monitoring/health.js';
import { evaluateRule, validateRule } from '../../src/modules/alerts/rules.js';
import { nextStep } from '../../src/modules/alerts/lifecycle.js';
import * as P from '../../src/modules/analytics/pipelines.js';
import { hasTenantMatchStage } from '../../src/lib/tenant.js';

const AGENT = 'a'.repeat(24);
const T0 = new Date('2026-11-12T12:00:00Z');

// ---------------- sampling ----------------
test('sampling: errors always, sample rate respected deterministically, only production, never demo, off by default', () => {
  const on = { enabled: true, sampleRate: 0.2, alwaysEvaluateErrors: true };
  assert.equal(decideSampling(effectivePolicy(undefined), { environment: 'production', status: 'success', traceId: 'x' }).evaluate, false);   // default = off
  assert.deepEqual(decideSampling(on, { environment: 'production', status: 'error', traceId: 'x' }), { evaluate: true, reason: 'failed_execution' });
  assert.equal(decideSampling(on, { environment: 'production', status: 'timeout', traceId: 'x' }).evaluate, true);
  assert.equal(decideSampling({ ...on, alwaysEvaluateErrors: false, sampleRate: 0 }, { environment: 'production', status: 'error', traceId: 'x' }).evaluate, false);
  assert.equal(decideSampling(on, { environment: 'test', status: 'error', traceId: 'x' }).reason, 'not_production');
  assert.equal(decideSampling(on, { environment: 'production', status: 'error', isDemo: true, traceId: 'x' }).reason, 'demo');
  const t = { environment: 'production', status: 'success', traceId: 'abc123' };
  assert.deepEqual(decideSampling(on, t), decideSampling(on, t));   // same trace, same decision (idempotent re-delivery)
  let hits = 0; const N = 20_000;
  for (let i = 0; i < N; i++) if (decideSampling(on, { ...t, traceId: `trace-${i}` }).evaluate) hits++;
  assert.ok(Math.abs(hits / N - 0.2) < 0.015, `sample share ${hits / N}`);
  assert.equal(decideSampling({ ...on, sampleRate: 1 }, t).evaluate, true);
  const u = hashUnit('anything'); assert.ok(u >= 0 && u < 1);
});

test('policy validation: ranges, judge needs a daily cap, constraints whitelist, evaluator list', () => {
  const ok = validatePolicy({ enabled: true, sampleRate: 0.25, dailyTraceBudget: 500 });
  assert.deepEqual([ok.enabled, ok.sampleRate, ok.dailyTraceBudget, ok.alwaysEvaluateErrors, ok.useJudge], [true, 0.25, 500, true, false]);
  const fails = (body, path) => assert.throws(() => validatePolicy(body), (e) => e.code === 'VALIDATION_ERROR' && e.details.some((d) => d.path === path), path);
  fails({ sampleRate: 1.5 }, 'sampleRate');
  fails({ sampleRate: '0.5' }, 'sampleRate');
  fails({ dailyTraceBudget: -1 }, 'dailyTraceBudget');
  fails({ dailyTraceBudget: 1.5 }, 'dailyTraceBudget');
  fails({ useJudge: true }, 'dailyJudgeBudget');                                          // AI-judge cost must always be capped
  fails({ useJudge: true, dailyJudgeBudget: 0 }, 'dailyJudgeBudget');
  fails({ evaluators: ['accuracy'] }, 'evaluators');                                       // needs a reference answer: not allowed in production
  fails({ evaluators: [] }, 'evaluators');
  fails({ evaluators: ['relevance', 'relevance'] }, 'evaluators');
  fails({ evaluators: ['instruction_adherence'] }, 'constraints');
  fails({ constraints: { maxChars: -4 } }, 'constraints.maxChars');
  fails({ constraints: { regex: '.*' } }, 'constraints.regex');                            // user regular expressions are never supported
  fails({ constraints: { mustInclude: [''] } }, 'constraints.mustInclude');
  assert.ok(validatePolicy({ evaluators: ['instruction_adherence', 'operational'], constraints: { maxChars: 500, mustNotInclude: ['password'] } }));
  assert.throws(() => validatePolicy(null), { code: 'VALIDATION_ERROR' });
});

// ---------------- histogram ----------------
test('histogram: bucket edges, p95 estimate is a conservative upper bound, exact percentile', () => {
  assert.deepEqual([bucketIndex(0), bucketIndex(50), bucketIndex(51), bucketIndex(60_000), bucketIndex(60_001), bucketIndex(-1), bucketIndex(NaN)], [0, 0, 1, 10, 11, null, null]);
  const values = Array.from({ length: 1000 }, (_, i) => 20 + (i * 37) % 4000);          // spread 20..4019 ms
  const buckets = mergeBuckets(values.map((v) => ({ [bucketKey(bucketIndex(v))]: 1 })));
  const exact = percentileExact(values, 0.95);
  const est = percentileFromBuckets(buckets, 0.95);
  assert.ok(est.valueMs >= exact, `estimate ${est.valueMs} must not undercut exact ${exact}`);
  const next = EDGES_MS.find((e) => e >= exact);
  assert.equal(est.valueMs, next);                                                           // it is the edge of the bucket containing the exact value
  assert.equal(percentileFromBuckets({}, 0.95), null);
  assert.equal(percentileFromBuckets({ b11: 5 }, 0.95).overflow, true);
  assert.equal(percentileExact([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentileExact([], 0.95), null);
});

// ---------------- health ----------------
test('health: verdict and reasons carry the numbers; no verdict on tiny samples', () => {
  const cur = (count, errors, avg = 500) => ({ count, errors, avgLatencyMs: avg });
  assert.equal(computeHealth({ current: cur(3, 3), previous: cur(0, 0, 0) }).status, 'no_data');
  const ok = computeHealth({ current: cur(100, 1), previous: cur(100, 1) });
  assert.equal(ok.status, 'healthy');
  const deg = computeHealth({ current: cur(100, 8), previous: cur(100, 1) });
  assert.equal(deg.status, 'degraded'); assert.match(deg.reasons[0], /8\.0% \(8 of 100\)/);
  const fail = computeHealth({ current: cur(100, 40), previous: cur(100, 1) });
  assert.equal(fail.status, 'failing'); assert.match(fail.reasons[0], /40\.0%/);
  assert.equal(computeHealth({ current: cur(50, 0, 1200), previous: cur(50, 0, 500) }).status, 'degraded');                 // latency 2.4x previous
  assert.equal(computeHealth({ current: cur(100, 0), previous: cur(100, 0), alerts: { critical: 1, warning: 0 } }).status, 'failing');
  assert.equal(computeHealth({ current: cur(100, 0), previous: cur(100, 0), quality: { n: 10, failed: 4 } }).status, 'degraded');
  assert.equal(computeHealth({ current: cur(2, 0), previous: cur(0, 0, 0), alerts: { critical: 0, warning: 1 } }).status, 'degraded');   // an open alert still counts without traffic
});

// ---------------- alert rule validation ----------------
test('rule validation: required params, ranges, silence needs an agent, type is immutable, unknown fields ignored', () => {
  const bad = (body, path) => assert.throws(() => validateRule(body), (e) => e.code === 'VALIDATION_ERROR' && e.details.some((d) => d.path === path), `${path} for ${JSON.stringify(body)}`);
  bad({ name: 'x', type: 'nope' }, 'type');
  bad({ type: 'error_rate', params: { thresholdPct: 10 } }, 'name');
  bad({ name: 'x', type: 'error_rate', params: {} }, 'params.thresholdPct');
  bad({ name: 'x', type: 'error_rate', params: { thresholdPct: 0 } }, 'params.thresholdPct');
  bad({ name: 'x', type: 'error_rate', params: { thresholdPct: 101 } }, 'params.thresholdPct');
  bad({ name: 'x', type: 'error_rate', params: { thresholdPct: 5, windowMinutes: 0 } }, 'params.windowMinutes');
  bad({ name: 'x', type: 'error_rate', params: { thresholdPct: 5, minSamples: 1.5 } }, 'params.minSamples');
  bad({ name: 'x', type: 'latency', params: { thresholdMs: 100, stat: 'p50' } }, 'params.stat');
  bad({ name: 'x', type: 'silence', params: { silenceMinutes: 10 } }, 'agentId');
  bad({ name: 'x', type: 'silence', agentId: AGENT, params: {} }, 'params.silenceMinutes');
  bad({ name: 'x', type: 'quality_drop', params: { metric: 'accuracy', dropThreshold: 0.1 } }, 'params.metric');   // needs a reference answer: not available in production
  bad({ name: 'x', type: 'quality_drop', params: { metric: 'relevance', dropThreshold: 0.1, baseline: 'last_run' } }, 'agentId');
  bad({ name: 'x', type: 'cost_per_day', params: { thresholdUsd: -1 } }, 'params.thresholdUsd');
  bad({ name: 'x', type: 'error_rate', agentId: 'not-an-id', params: { thresholdPct: 5 } }, 'agentId');
  bad({ name: 'x', type: 'error_rate', cooldownMinutes: 99999, params: { thresholdPct: 5 } }, 'cooldownMinutes');
  const r = validateRule({ name: ' Errors ', type: 'error_rate', params: { thresholdPct: 20 }, evil: 1, state: { okStreak: 99 } });
  assert.deepEqual([r.name, r.agentId, r.severity, r.params, r.cooldownMinutes, r.resolveAfterOk, r.evalEveryMinutes, r.enabled, 'evil' in r, 'state' in r], ['Errors', null, 'warning', { windowMinutes: 15, thresholdPct: 20, minSamples: 20 }, 30, 2, 1, true, false, false]);
  assert.throws(() => validateRule({ type: 'latency' }, { type: 'error_rate', name: 'n', params: { thresholdPct: 5, windowMinutes: 15, minSamples: 20 } }), (e) => e.details.some((d) => d.path === 'type'));
  const patched = validateRule({ params: { thresholdPct: 40 } }, { type: 'error_rate', name: 'n', agentId: null, severity: 'critical', params: { thresholdPct: 5, windowMinutes: 30, minSamples: 9 } });
  assert.deepEqual([patched.params, patched.severity, patched.name], [{ windowMinutes: 30, thresholdPct: 40, minSamples: 9 }, 'critical', 'n']);
});

// ---------------- alert rule evaluation ----------------
const rule = (type, params) => ({ type, params });
test('error_rate rule: explains which numbers crossed which threshold, minimum sample size', () => {
  const r = rule('error_rate', { windowMinutes: 10, thresholdPct: 20, minSamples: 20 });
  const few = evaluateRule(r, { count: 3, errors: 3 }, T0);
  assert.equal(few.state, 'insufficient_data'); assert.match(few.explanation, /Only 3 trace/);                    // never alert on 3 traces
  const fire = evaluateRule(r, { count: 50, errors: 15 }, T0);
  assert.equal(fire.state, 'firing'); assert.deepEqual(fire.observed, { errorRatePct: 30, errors: 15, count: 50 }); assert.equal(fire.threshold, 20);
  assert.match(fire.explanation, /30\.0% \(15 of 50 traces in the last 10 min\) is above the 20% threshold/);
  assert.equal(evaluateRule(r, { count: 50, errors: 10 }, T0).state, 'ok');                                            // exactly at the threshold is not above it
});

test('latency rule: avg and p95, estimated p95 is disclosed', () => {
  const p95 = rule('latency', { stat: 'p95', windowMinutes: 15, thresholdMs: 2000, minSamples: 10 });
  const f = evaluateRule(p95, { count: 40, avgLatencyMs: 900, p95LatencyMs: 3500, p95Exact: true }, T0);
  assert.equal(f.state, 'firing'); assert.match(f.explanation, /p95 latency 3500 ms over 40 traces .* above the 2000 ms/);
  assert.match(evaluateRule(p95, { count: 6000, avgLatencyMs: 900, p95LatencyMs: 3500, p95Exact: false }, T0).explanation, /estimated/);
  assert.equal(evaluateRule({ ...p95, params: { ...p95.params, stat: 'avg' } }, { count: 40, avgLatencyMs: 900, p95LatencyMs: 3500 }, T0).state, 'ok');
  assert.equal(evaluateRule(p95, { count: 40, avgLatencyMs: 1, p95LatencyMs: null }, T0).state, 'insufficient_data');
});

test('quality_drop rule: needs enough scored results in BOTH windows; absolute drop', () => {
  const r = rule('quality_drop', { metric: 'relevance', dropThreshold: 0.1, windowMinutes: 60, minSamples: 10 });
  const snap = (c, b, kind = 'previous_window') => ({ current: { n: c[0], avgScore: c[1] }, baseline: { n: b[0], avgScore: b[1], kind } });
  assert.equal(evaluateRule(r, snap([4, 0.2], [50, 0.9]), T0).state, 'insufficient_data');
  assert.equal(evaluateRule(r, snap([30, 0.7], [3, 0.9]), T0).state, 'insufficient_data');
  const f = evaluateRule(r, snap([30, 0.7], [50, 0.9]), T0);
  assert.equal(f.state, 'firing'); assert.equal(f.observed.drop, 0.2); assert.match(f.explanation, /relevance score 0\.7.*vs 0\.9 \(previous window, 50\).*drop of 0\.2 exceeds the 0\.1/);
  assert.equal(evaluateRule(r, snap([30, 0.85], [50, 0.9]), T0).state, 'ok');
  assert.match(evaluateRule(r, snap([30, 0.5], [20, 0.9], 'last_run'), T0).explanation, /last evaluation run/);
  assert.equal(evaluateRule(r, snap([30, 0.95], [50, 0.9]), T0).state, 'ok');                                            // an improvement never fires
});

test('cost_per_day rule: only traces that report a cost count, and the explanation says so', () => {
  const r = rule('cost_per_day', { thresholdUsd: 50, minSamples: 5 });
  assert.equal(evaluateRule(r, { count: 100, costN: 2, costUsd: 99 }, T0).state, 'insufficient_data');
  const f = evaluateRule(r, { count: 100, costN: 80, costUsd: 61.2345 }, T0);
  assert.equal(f.state, 'firing'); assert.match(f.explanation, /\$61\.2345 \(from 80 of 100 traces that report a cost\) and is above the \$50/);
  assert.equal(evaluateRule(r, { count: 100, costN: 80, costUsd: 50 }, T0).state, 'ok');
});

test('silence rule uses the supplied clock; a never-connected agent is never "silent"', () => {
  const r = rule('silence', { silenceMinutes: 10 });
  const last = new Date(T0.getTime() - 25 * 60_000);
  const f = evaluateRule(r, { everConnected: true, lastTraceAt: last }, T0);
  assert.equal(f.state, 'firing'); assert.equal(f.observed.minutesSinceLastTrace, 25); assert.match(f.explanation, /25 min ago/);
  assert.equal(evaluateRule(r, { everConnected: true, lastTraceAt: last }, new Date(T0.getTime() - 20 * 60_000)).state, 'ok');   // 5 min since last trace at that earlier time
  assert.equal(evaluateRule(r, { everConnected: false, lastTraceAt: null }, T0).state, 'insufficient_data');
});

// ---------------- lifecycle ----------------
const ev = (state) => ({ state, observed: { x: 1 }, threshold: 1, explanation: `e-${state}` });
const R = (state = {}, extra = {}) => ({ cooldownMinutes: 30, resolveAfterOk: 2, state, ...extra });
test('lifecycle: open once, update while firing, insufficient data changes nothing, resolve only after consecutive OKs', () => {
  assert.equal(nextStep({ rule: R(), evaluation: ev('firing'), hasOpenAlert: false, now: T0 }).action, 'open');
  assert.equal(nextStep({ rule: R(), evaluation: ev('firing'), hasOpenAlert: true, now: T0 }).action, 'update');            // de-duplication: no second alert
  assert.equal(nextStep({ rule: R(), evaluation: ev('insufficient_data'), hasOpenAlert: false, now: T0 }).action, 'none');
  const touch = nextStep({ rule: R({ okStreak: 1 }), evaluation: ev('insufficient_data'), hasOpenAlert: true, now: T0 });
  assert.deepEqual([touch.action, touch.rulePatch.okStreak], ['touch', undefined]);                                           // streak untouched by missing data
  const s1 = nextStep({ rule: R({ okStreak: 0 }), evaluation: ev('ok'), hasOpenAlert: true, now: T0 });
  assert.deepEqual([s1.action, s1.rulePatch.okStreak], ['touch', 1]);
  const s2 = nextStep({ rule: R({ okStreak: 1 }), evaluation: ev('ok'), hasOpenAlert: true, now: T0 });
  assert.equal(s2.action, 'resolve'); assert.deepEqual(s2.rulePatch.lastResolvedAt, T0);
  assert.equal(nextStep({ rule: R({ okStreak: 1 }), evaluation: ev('firing'), hasOpenAlert: true, now: T0 }).rulePatch.okStreak, 0);   // a relapse resets the streak
  assert.equal(nextStep({ rule: R(), evaluation: ev('ok'), hasOpenAlert: false, now: T0 }).action, 'none');
});

test('lifecycle: cooldown suppresses re-opening until it passes (controllable clock)', () => {
  const resolvedAt = new Date(T0.getTime() - 10 * 60_000);
  const within = nextStep({ rule: R({ lastResolvedAt: resolvedAt }), evaluation: ev('firing'), hasOpenAlert: false, now: T0 });
  assert.equal(within.action, 'suppressed'); assert.equal(within.rulePatch.suppressedUntil.getTime(), resolvedAt.getTime() + 30 * 60_000);
  assert.equal(nextStep({ rule: R({ lastResolvedAt: resolvedAt }), evaluation: ev('firing'), hasOpenAlert: false, now: new Date(T0.getTime() + 21 * 60_000) }).action, 'open');
  assert.equal(nextStep({ rule: R({ lastResolvedAt: resolvedAt }, { cooldownMinutes: 0 }), evaluation: ev('firing'), hasOpenAlert: false, now: T0 }).action, 'open');
});

// ---------------- pipelines ----------------
test('new aggregation pipelines start with a tenant $match (rollup filters too)', () => {
  const ORG = 'org-1';
  for (const [name, p] of Object.entries({ traceBucketsPipeline: P.traceBucketsPipeline(ORG, { from: T0, to: T0 }, 5), prodStatusPipeline: P.prodStatusPipeline(ORG, {}), alertOpenCountsPipeline: P.alertOpenCountsPipeline(ORG) })) {
    assert.ok(hasTenantMatchStage(p), name);
    assert.doesNotMatch(JSON.stringify(p), /\$where|\$function|\$accumulator/, name);
  }
  assert.equal(P.rollupMatch(ORG, { agentId: 'x' }).organizationId, ORG);
  assert.deepEqual(P.traceMatch(ORG, { failedOnly: true }).status, { $ne: 'success' });
  assert.equal(P.resultMatch(ORG, { runId: 'r1' }).runId, 'r1');
});
