// Milestone 5 services on the in-memory repositories: ingest hook, rollups, budgets, production evaluation, alert lifecycle, isolation, RBAC, webhooks.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeWorld, fakeEngine } from '../helpers/world.js';
import { createAlertNotifier, sign } from '../../src/services/alertNotifier.js';
import { safeRequest } from '../../src/lib/safeHttp.js';
import { percentileExact } from '../../src/modules/monitoring/histogram.js';

const MIN = 60_000;
function setup(extraDeps = {}, env = {}) {
  const clock = { t: new Date('2026-11-12T12:00:00.000Z') };
  const engine = fakeEngine();
  const logs = [];
  const w = makeWorld(env, { now: () => clock.t, engine, logger: { error: (m) => logs.push(m), log: () => {} }, ...extraDeps });
  const advance = (min) => { clock.t = new Date(clock.t.getTime() + min * MIN); };
  // A production trace that started `ageMin` minutes before the clock.
  const trace = (agentId, { ageMin = 0, status = 'success', durationMs = 800, cost, tokens = 100, output, input, metadata = {}, version = '1.0.0' } = {}) => {
    const start = new Date(clock.t.getTime() - ageMin * MIN);
    return w.traceFor(agentId, {
      environment: 'production', agentVersion: version, status, ...(status === 'error' && { error: { message: 'boom' } }), startedAt: start.toISOString(), endedAt: new Date(start.getTime() + durationMs).toISOString(), durationMs,
      usage: { totalTokens: tokens, ...(cost !== undefined && { estimatedCostUsd: cost }) }, metadata, ...(output && { output }), ...(input && { input }),
    });
  };
  const ingest = (principal, t) => w.services.traces.ingestOne(principal, t);
  return { w, clock, engine, logs, advance, trace, ingest };
}
const asRole = (p, role) => ({ ...p, role });
const jobsOf = (w, type) => w.repos._db.jobs.filter((j) => j.type === type);

// ---------------- ingest hook, rollups ----------------
test('ingest updates hourly rollups; rollup totals equal the raw aggregation for the same window', async () => {
  const { w, clock, trace, ingest } = setup();
  const A = await w.signup(); const agent = await w.newAgent(A.principal);
  const durations = [], t0 = clock.t.getTime();
  for (let i = 0; i < 60; i++) {
    const d = 100 + ((i * 53) % 2500);
    durations.push(d);
    await ingest(A.principal, trace(agent.id, { ageMin: (i % 3) * 60 + (i % 7), status: i % 6 === 0 ? 'error' : 'success', durationMs: d, cost: i % 4 === 0 ? undefined : 0.01 * (i % 5 + 1), tokens: 50 + i }));
  }
  const from = new Date(Math.floor(t0 / 3_600_000) * 3_600_000 - 3 * 3_600_000), to = new Date(Math.floor(t0 / 3_600_000) * 3_600_000 + 3_600_000);   // hour-aligned
  const roll = await w.services.monitoring.rollups(A.principal, agent.id, { from: from.toISOString(), to: to.toISOString() });
  const raw = await w.repos.traces.stats(A.principal.organizationId, { agentId: agent.id, environment: 'production', isDemo: false, from, to });
  assert.equal(roll.totals.count, 60);
  assert.deepEqual([roll.totals.count, roll.totals.errors, roll.totals.failed, roll.totals.totalTokens, roll.totals.costN], [raw.count, raw.errors, raw.failed, raw.totalTokens, raw.costN]);
  assert.ok(Math.abs(roll.totals.costUsd - raw.costUsd) < 1e-9);
  assert.ok(Math.abs(roll.totals.avgLatencyMs - raw.avgLatencyMs) <= 1);
  assert.equal(roll.hourly.reduce((n, h) => n + h.count, 0), 60);
  const exact = percentileExact(durations, 0.95);
  assert.ok(roll.totals.p95LatencyMs >= exact && roll.totals.p95LatencyMs <= exact * 2.1, `histogram p95 ${roll.totals.p95LatencyMs} vs exact ${exact}`);   // conservative and within one bucket
  assert.match(roll.totals.p95Note, /upper bound/);
  const v = await w.services.monitoring.rollups(A.principal, agent.id, { from: from.toISOString(), to: to.toISOString(), version: 'nope' });
  assert.equal(v.totals.count, 0);
});

test('duplicate trace deliveries do not double-count rollups; test/demo traffic is kept apart', async () => {
  const { w, trace, ingest } = setup();
  const A = await w.signup(); const agent = await w.newAgent(A.principal);
  const t = trace(agent.id);
  assert.equal((await ingest(A.principal, t)).status, 'accepted');
  assert.equal((await ingest(A.principal, t)).status, 'duplicate');
  await ingest(A.principal, trace(agent.id, { metadata: { demo: true } }));
  await ingest(A.principal, { ...trace(agent.id), environment: 'test' });
  const live = await w.services.monitoring.live(A.principal, agent.id, { windowMinutes: '60' });
  assert.equal(live.current.count, 1);                                                      // production, non-demo only
  const withDemo = await w.services.monitoring.live(A.principal, agent.id, { windowMinutes: '60', demo: 'true' });
  assert.equal(withDemo.current.count, 2);
  const roll = await w.services.monitoring.rollups(A.principal, agent.id, {});
  assert.equal(roll.totals.count, 1);
});

test('a failing monitoring hook never fails ingestion and logs no payloads', async () => {
  const { w, trace, ingest, logs } = setup();
  const A = await w.signup(); const agent = await w.newAgent(A.principal);
  w.repos.rollups.record = async () => { throw new Error('mongo down'); };
  const out = await ingest(A.principal, trace(agent.id, { input: 'SECRET-CUSTOMER-TEXT' }));
  assert.equal(out.status, 'accepted');
  assert.ok(logs.some((l) => l.includes('rollup write failed')));
  assert.ok(!logs.join('').includes('SECRET-CUSTOMER-TEXT'));
});

// ---------------- policy + budgets ----------------
test('policy: default off, only admins change it, audited, validated; archived/other-agent keys cannot read it', async () => {
  const { w } = setup();
  const A = await w.signup(); const agent = await w.newAgent(A.principal);
  const def = await w.services.monitoring.getPolicy(A.principal, agent.id);
  assert.deepEqual([def.policy.enabled, def.policy.sampleRate, def.usage.evaluationsQueued], [false, 0, 0]);
  await assert.rejects(() => w.services.monitoring.putPolicy(asRole(A.principal, 'member'), agent.id, { enabled: true, sampleRate: 0.5 }), { code: 'FORBIDDEN' });
  await assert.rejects(() => w.services.monitoring.putPolicy(asRole(A.principal, 'viewer'), agent.id, { enabled: true }), { code: 'FORBIDDEN' });
  await assert.rejects(() => w.services.monitoring.putPolicy(A.principal, agent.id, { sampleRate: 7 }), { code: 'VALIDATION_ERROR' });
  const admin = asRole(A.principal, 'admin');
  const set = await w.services.monitoring.putPolicy(admin, agent.id, { enabled: true, sampleRate: 0.5, dailyTraceBudget: 100 });
  assert.deepEqual([set.policy.enabled, set.policy.sampleRate, set.policy.dailyTraceBudget], [true, 0.5, 100]);
  assert.ok(w.repos._db.audit.some((e) => e.action === 'monitoring-policy.update' && e.target === agent.id));
  assert.equal((await w.services.monitoring.getPolicy(asRole(A.principal, 'viewer'), agent.id)).policy.sampleRate, 0.5);
  await assert.rejects(() => w.services.monitoring.getPolicy({ ...A.principal, type: 'apiKey', scopes: ['agents:read'], agentId: 'f'.repeat(24) }, agent.id), { code: 'AGENT_NOT_FOUND' });
});

test('sampled evaluation: errors always, others by rate; jobs idempotent; policy off queues nothing', async () => {
  const { w, trace, ingest } = setup();
  const A = await w.signup(); const agent = await w.newAgent(A.principal);
  await ingest(A.principal, trace(agent.id, { status: 'error' }));
  assert.equal(jobsOf(w, 'evaluate_trace').length, 0);                                    // default policy: off
  await w.services.monitoring.putPolicy(A.principal, agent.id, { enabled: true, sampleRate: 0, alwaysEvaluateErrors: true });
  await ingest(A.principal, trace(agent.id, { status: 'success' }));
  await ingest(A.principal, trace(agent.id, { status: 'timeout' }));
  const errTrace = trace(agent.id, { status: 'error' });
  await ingest(A.principal, errTrace); await ingest(A.principal, errTrace);
  assert.equal(jobsOf(w, 'evaluate_trace').length, 2);                                    // timeout + error; the duplicate delivery queued nothing
  await w.services.monitoring.putPolicy(A.principal, agent.id, { enabled: true, sampleRate: 1, alwaysEvaluateErrors: false });
  await ingest(A.principal, trace(agent.id));
  assert.equal(jobsOf(w, 'evaluate_trace').length, 3);
});

test('daily trace budget holds under concurrent ingestion (atomic reserve)', async () => {
  const { w, trace, ingest } = setup();
  const A = await w.signup(); const agent = await w.newAgent(A.principal);
  await w.services.monitoring.putPolicy(A.principal, agent.id, { enabled: true, sampleRate: 1, dailyTraceBudget: 10 });
  await Promise.all(Array.from({ length: 60 }, () => ingest(A.principal, trace(agent.id))));
  assert.equal(jobsOf(w, 'evaluate_trace').length, 10);
  const u = (await w.services.monitoring.getPolicy(A.principal, agent.id)).usage;
  assert.deepEqual([u.evaluationsQueued, u.skippedBudget], [10, 50]);
  assert.equal((await w.services.monitoring.live(A.principal, agent.id, {})).usage.skippedBudget, 50);       // visible in the UI payload
});

test('budget is per agent, per day; zero budget evaluates nothing; a new UTC day starts fresh', async () => {
  const { w, trace, ingest, advance } = setup();
  const A = await w.signup(); const a1 = await w.newAgent(A.principal, 'a1'); const a2 = await w.newAgent(A.principal, 'a2');
  for (const a of [a1, a2]) await w.services.monitoring.putPolicy(A.principal, a.id, { enabled: true, sampleRate: 1, dailyTraceBudget: 2 });
  for (let i = 0; i < 5; i++) { await ingest(A.principal, trace(a1.id)); await ingest(A.principal, trace(a2.id)); }
  assert.equal(jobsOf(w, 'evaluate_trace').length, 4);
  advance(13 * 60);                                                                       // 12:00 -> 01:00 next day
  await ingest(A.principal, trace(a1.id)); await ingest(A.principal, trace(a1.id)); await ingest(A.principal, trace(a1.id));
  assert.equal(jobsOf(w, 'evaluate_trace').length, 6);
  await w.services.monitoring.putPolicy(A.principal, a2.id, { enabled: true, sampleRate: 1, dailyTraceBudget: 0 });
  await ingest(A.principal, trace(a2.id));
  assert.equal(jobsOf(w, 'evaluate_trace').length, 6);
});

// ---------------- production evaluation ----------------
test('worker evaluates a sampled production trace with reference-free evaluators, never calls the agent, stores a separate result', async () => {
  const calledAgent = [];
  const { w, trace, ingest, engine } = setup({ http: async (...a) => { calledAgent.push(a); throw new Error('agent must not be called'); } });
  const A = await w.signup();
  const agent = await w.newAgent(A.principal, 'api-agent', { integrationType: 'api', endpointUrl: 'https://agent.example.com/run' });
  await w.services.monitoring.putPolicy(A.principal, agent.id, { enabled: true, sampleRate: 1, evaluators: ['hallucination', 'relevance', 'tool_usage', 'instruction_adherence', 'operational'], constraints: { maxChars: 200 } });
  const t = trace(agent.id, { output: 'ok' });
  await ingest(A.principal, t);
  await w.worker.loop.drain();
  assert.equal(calledAgent.length, 0);
  assert.equal(engine.calls.length, 1);
  const call = engine.calls[0];
  assert.deepEqual(call.evaluators.map((e) => e.metric), ['hallucination', 'relevance', 'tool_usage', 'instruction_adherence', 'operational']);
  assert.ok(call.evaluators.every((e) => /^\d+\.\d+\.\d+$/.test(e.version)));            // versions pinned
  assert.deepEqual(call.testCase, { constraints: { maxChars: 200 } });                     // no reference answer / evidence invented
  assert.equal(call.judge, null);
  const org = A.principal.organizationId;
  const res = await w.repos.prodEvals.byTraceId(org, t.traceId);
  assert.equal(res.status, 'passed'); assert.equal(res.agentId, agent.id);
  assert.equal(w.repos._db.results.length, 0);                                            // never mixed into test-run results
  assert.equal(w.repos._db.jobs.find((j) => j.type === 'evaluate_trace').status, 'succeeded');
  const live = await w.services.monitoring.live(A.principal, agent.id, {});
  assert.deepEqual([live.quality.evaluated, live.quality.passed, live.quality.recent[0].traceId], [1, 1, t.traceId]);
  await ingest(A.principal, trace(agent.id));
  await w.worker.loop.drain();                                                              // same trace is not evaluated twice if its job is replayed
  assert.equal(engine.calls.length, 2);
  await w.worker.production.handle({ organizationId: org, payload: { traceId: t.traceId } });
  assert.equal(engine.calls.length, 2);
});

test('instruction_adherence is dropped when no constraints are configured; stale jobs are skipped; deleted traces are skipped', async () => {
  const { w, trace, ingest, engine, advance } = setup();
  const A = await w.signup(); const agent = await w.newAgent(A.principal);
  await w.services.monitoring.putPolicy(A.principal, agent.id, { enabled: true, sampleRate: 1, evaluators: ['relevance', 'operational'] });
  const t = trace(agent.id); await ingest(A.principal, t);
  await w.repos.agents.update(A.principal.organizationId, agent.id, { monitoring: { enabled: true, sampleRate: 1, evaluators: ['relevance', 'instruction_adherence'], constraints: null } });
  await w.worker.loop.drain();
  assert.deepEqual(engine.calls[0].evaluators.map((e) => e.metric), ['relevance']);
  const t2 = trace(agent.id); await ingest(A.principal, t2);
  const before = engine.calls.length;
  advance(60 * 26);                                                                       // worker was down for 26 h: the job is stale
  await w.worker.loop.drain();
  assert.equal(engine.calls.length, before);                                              // 25+ h old -> skipped, nothing evaluated
  assert.equal(await w.repos.prodEvals.byTraceId(A.principal.organizationId, t2.traceId), null);
});

test('judge budget (per agent per day) cannot be overspent by parallel workers; unused calls are refunded', async () => {
  const { w, trace, ingest, engine } = setup();
  engine.evaluate = async (p) => { engine.calls.push(p); await new Promise((r) => setTimeout(r, 2)); return { results: [{ metric: 'relevance', status: 'pass', score: 1, evaluatorVersion: '1.0.0', findings: [], meta: {} }], judgeCalls: p.limits.maxJudgeCalls }; };
  const A = await w.signup(); const agent = await w.newAgent(A.principal);
  await w.services.evaluatorConfig.put(A.principal, { judge: { enabled: true, provider: 'openai_compatible', model: 'm', apiKey: 'k'.repeat(12) } });
  await w.services.monitoring.putPolicy(A.principal, agent.id, { enabled: true, sampleRate: 1, useJudge: true, dailyJudgeBudget: 20, evaluators: ['relevance'] });
  for (let i = 0; i < 12; i++) await ingest(A.principal, trace(agent.id));
  await Promise.all(jobsOf(w, 'evaluate_trace').map((j) => w.worker.production.handle(j)));
  const total = engine.calls.reduce((n, c) => n + c.limits.maxJudgeCalls, 0);
  assert.ok(total <= 20, `granted ${total} judge calls`);
  assert.ok(total >= 16, `most of the budget is used (${total})`);
  assert.equal(engine.calls.filter((c) => c.judge === null).length, 12 - engine.calls.filter((c) => c.judge).length);   // out of budget -> no judge, evaluation still runs
  const usage = (await w.services.monitoring.getPolicy(A.principal, agent.id)).usage;
  assert.equal(usage.judgeCalls, total);
  // refund of unused calls
  const { w: w2, trace: trace2, ingest: ingest2, engine: engine2 } = setup();
  engine2.evaluate = async (p) => { engine2.calls.push(p); return { results: [{ metric: 'relevance', status: 'pass', score: 1, evaluatorVersion: '1.0.0', findings: [], meta: {} }], judgeCalls: 1 }; };
  const B = await w2.signup(); const ag2 = await w2.newAgent(B.principal);
  await w2.services.evaluatorConfig.put(B.principal, { judge: { enabled: true, provider: 'openai_compatible', model: 'm', apiKey: 'k'.repeat(12) } });
  await w2.services.monitoring.putPolicy(B.principal, ag2.id, { enabled: true, sampleRate: 1, useJudge: true, dailyJudgeBudget: 20, evaluators: ['relevance'] });
  await ingest2(B.principal, trace2(ag2.id)); await w2.worker.loop.drain();
  assert.equal((await w2.services.monitoring.getPolicy(B.principal, ag2.id)).usage.judgeCalls, 1);
});

// ---------------- alerts: lifecycle end to end ----------------
async function adminWorld(env = {}) {
  const s = setup({}, env); const A = await s.w.signup(); const admin = asRole(A.principal, 'admin');
  const agent = await s.w.newAgent(A.principal);
  return { ...s, A, admin, agent, org: A.principal.organizationId };
}
const burst = async (s, agentId, n, errors, extra = {}) => { for (let i = 0; i < n; i++) await s.ingest(s.A.principal, s.trace(agentId, { status: i < errors ? 'error' : 'success', ageMin: 0, ...extra })); };

test('alert lifecycle: fires with an explanation, de-duplicates, auto-resolves after consecutive OKs, respects cooldown', async () => {
  const s = await adminWorld();
  const rule = await s.w.services.alerts.createRule(s.admin, { name: 'Errors', type: 'error_rate', agentId: s.agent.id, severity: 'critical', cooldownMinutes: 20, resolveAfterOk: 2, params: { windowMinutes: 10, thresholdPct: 20, minSamples: 5 } });
  const eng = s.w.services.alertEngine;
  await burst(s, s.agent.id, 3, 3);                                                         // 3 errors out of 3: below the minimum sample size
  assert.equal((await eng.tick())[0].action, 'none');
  assert.equal((await s.w.services.alerts.summary(s.admin)).active, 0);
  await burst(s, s.agent.id, 7, 2);                                                         // now 10 traces, 5 errors
  s.advance(1);
  const r1 = await eng.tick();
  assert.deepEqual([r1[0].action, r1[0].state], ['open', 'firing']);
  const list = await s.w.services.alerts.list(s.admin, { status: 'active' });
  assert.equal(list.items.length, 1);
  const a = list.items[0];
  assert.match(a.explanation, /Error rate 50\.0% \(5 of 10 traces in the last 10 min\) is above the 20% threshold/);
  assert.deepEqual([a.observed.errors, a.observed.count, a.threshold, a.severity, a.agentId], [5, 10, 20, 'critical', s.agent.id]);
  assert.match(a.links.traces, /^#\/traces\?.*status=error/); assert.match(a.links.monitoring, new RegExp(`^#/monitoring/${s.agent.id}`));
  s.advance(1);
  assert.equal((await eng.tick())[0].action, 'update');                                     // still firing: no second alert
  assert.equal((await s.w.services.alerts.list(s.admin, {})).items.length, 1);
  assert.equal((await s.w.services.alerts.list(s.admin, {})).items[0].evaluations, 2);
  assert.equal((await s.w.services.alerts.summary(s.admin)).critical, 1);
  const live = await s.w.services.monitoring.live(s.admin, s.agent.id, {});
  assert.equal(live.health.status, 'failing');                                              // open critical alert + 50% errors
  assert.ok(live.health.reasons.some((r) => /critical alert/.test(r)) && live.health.reasons.some((r) => /50\.0%/.test(r)));

  s.advance(11);                                                                            // errors leave the 10-minute window; nothing new arrived
  assert.equal((await eng.tick())[0].action, 'touch');                                      // insufficient data never resolves anything
  assert.equal((await s.w.services.alerts.list(s.admin, { status: 'open' })).items.length, 1);
  await burst(s, s.agent.id, 12, 0);                                                        // healthy traffic returns
  s.advance(1); assert.equal((await eng.tick())[0].action, 'touch');                        // OK #1
  s.advance(1); assert.equal((await eng.tick())[0].action, 'resolve');                      // OK #2 -> auto-resolved
  const resolved = (await s.w.services.alerts.list(s.admin, { status: 'resolved' })).items[0];
  assert.deepEqual([resolved.resolvedBy, resolved.status], ['auto', 'resolved']); assert.match(resolved.explanation, /^Resolved automatically/);
  assert.equal((await s.w.services.alerts.summary(s.admin)).active, 0);

  await burst(s, s.agent.id, 12, 12);                                                       // relapse inside the 20 min cooldown
  s.advance(1); assert.equal((await eng.tick())[0].action, 'suppressed');
  assert.equal((await s.w.services.alerts.list(s.admin, { status: 'open' })).items.length, 0);
  s.advance(20);                                                                            // cooldown over; fresh failures in the window
  await burst(s, s.agent.id, 12, 12);
  assert.equal((await eng.tick())[0].action, 'open');
  assert.equal((await s.w.services.alerts.list(s.admin, {})).items.length, 2);              // history keeps both
  assert.equal((await s.w.services.alerts.getRule(s.admin, rule.id)).lastEvaluation.state, 'firing');
});

test('manual acknowledge / resolve: members may, viewers may not; resolve starts the cooldown; double actions are refused', async () => {
  const s = await adminWorld();
  await s.w.services.alerts.createRule(s.admin, { name: 'Err', type: 'error_rate', agentId: s.agent.id, cooldownMinutes: 30, params: { windowMinutes: 10, thresholdPct: 10, minSamples: 5 } });
  await burst(s, s.agent.id, 10, 6); await s.w.services.alertEngine.tick();
  const [alert] = (await s.w.services.alerts.list(s.admin, {})).items;
  await assert.rejects(() => s.w.services.alerts.acknowledge(asRole(s.A.principal, 'viewer'), alert.id), { code: 'FORBIDDEN' });
  const ack = await s.w.services.alerts.acknowledge(asRole(s.A.principal, 'member'), alert.id);
  assert.deepEqual([ack.status, ack.acknowledgedBy], ['acknowledged', s.A.principal.userId]);
  await assert.rejects(() => s.w.services.alerts.acknowledge(s.admin, alert.id), { code: 'ALERT_STATE' });
  s.advance(1); assert.equal((await s.w.services.alertEngine.tick())[0].action, 'update');  // still de-duplicated while acknowledged
  assert.equal((await s.w.services.alerts.summary(s.admin)).active, 1);
  const res = await s.w.services.alerts.resolve(asRole(s.A.principal, 'member'), alert.id);
  assert.deepEqual([res.status, res.resolvedBy], ['resolved', s.A.principal.userId]);
  await assert.rejects(() => s.w.services.alerts.resolve(s.admin, alert.id), { code: 'ALERT_STATE' });
  s.advance(1); assert.equal((await s.w.services.alertEngine.tick())[0].action, 'suppressed');   // manual resolve snoozes the rule for its cooldown
});

test('latency, cost, silence and quality rules fire from real stored data', async () => {
  const s = await adminWorld();
  const { alerts } = s.w.services;
  await alerts.createRule(s.admin, { name: 'p95', type: 'latency', agentId: s.agent.id, params: { stat: 'p95', windowMinutes: 15, thresholdMs: 2000, minSamples: 10 } });
  await alerts.createRule(s.admin, { name: 'cost', type: 'cost_per_day', agentId: s.agent.id, params: { thresholdUsd: 1, minSamples: 5 } });
  await alerts.createRule(s.admin, { name: 'quiet', type: 'silence', agentId: s.agent.id, params: { silenceMinutes: 30 } });
  await alerts.createRule(s.admin, { name: 'quality', type: 'quality_drop', agentId: s.agent.id, params: { metric: 'relevance', dropThreshold: 0.2, windowMinutes: 60, minSamples: 5 } });
  for (let i = 0; i < 20; i++) await s.ingest(s.A.principal, s.trace(s.agent.id, { durationMs: i < 17 ? 500 : 4000, cost: 0.1 }));   // 15% slow -> p95 = 4000
  // production evaluations: previous window good (0.9), current window bad (0.5)
  const evalAt = (minAgo, score) => s.w.repos.prodEvals.insertIfAbsent(s.org, { agentId: s.agent.id, traceId: crypto.randomBytes(8).toString('hex'), status: 'passed', metrics: [{ metric: 'relevance', status: 'pass', score }], evaluatedAt: new Date(s.clock.t.getTime() - minAgo * MIN) });
  for (let i = 0; i < 6; i++) { await evalAt(10 + i, 0.5); await evalAt(70 + i, 0.9); }
  const out = await s.w.services.alertEngine.tick();
  const by = Object.fromEntries(out.map((o) => [o.evaluation.explanation.split(' ')[0], o]));
  assert.equal(out.filter((o) => o.state === 'firing').length, 3, JSON.stringify(out.map((o) => [o.state, o.evaluation.explanation])));   // p95, cost ($2.00 > $1) and quality; silence is fine (traces just arrived)
  const active = (await alerts.list(s.admin, { status: 'open' })).items;
  assert.deepEqual(active.map((a) => a.ruleType).sort(), ['cost_per_day', 'latency', 'quality_drop']);
  assert.match(active.find((a) => a.ruleType === 'latency').explanation, /p95 latency 4000 ms over 20 traces/);
  assert.match(active.find((a) => a.ruleType === 'cost_per_day').explanation, /\$2 \(from 20 of 20 traces/);
  assert.match(active.find((a) => a.ruleType === 'quality_drop').explanation, /relevance score 0\.5.*vs 0\.9 \(previous window/);
  assert.ok(by);
  s.advance(45);                                                                            // nothing arrives for 45 minutes
  const later = await s.w.services.alertEngine.tick();
  assert.equal(later.find((o) => o.ruleId && o.evaluation.explanation.includes('Last production trace')).state, 'firing');
  assert.equal((await alerts.testRule(s.A.principal, (await alerts.listRules(s.A.principal)).items.find((r) => r.type === 'silence').id)).state, 'firing');   // dry run, any viewer
});

test('quality baseline can be the last completed evaluation run', async () => {
  const s = await adminWorld();
  const run = await s.w.repos.runs.create(s.org, { agentId: s.agent.id, suiteId: 'b'.repeat(24), mode: 'sdk', status: 'completed', evaluators: [], caseIds: [], progress: { total: 8 } });
  for (let i = 0; i < 8; i++) await s.w.repos.results.insertIfAbsent(s.org, { runId: run.id, testCaseId: `c${i}`, agentId: s.agent.id, status: 'passed', metrics: [{ metric: 'relevance', status: 'pass', score: 0.95 }], evaluatedAt: s.clock.t });
  await s.w.services.alerts.createRule(s.admin, { name: 'vs run', type: 'quality_drop', agentId: s.agent.id, params: { metric: 'relevance', baseline: 'last_run', dropThreshold: 0.2, windowMinutes: 60, minSamples: 5 } });
  for (let i = 0; i < 6; i++) await s.w.repos.prodEvals.insertIfAbsent(s.org, { agentId: s.agent.id, traceId: `t${i}`, status: 'failed', metrics: [{ metric: 'relevance', status: 'fail', score: 0.4 }], evaluatedAt: new Date(s.clock.t.getTime() - 5 * MIN) });
  const [r] = await s.w.services.alertEngine.tick();
  assert.equal(r.state, 'firing'); assert.match(r.evaluation.explanation, /last evaluation run, 8/);
});

// ---------------- isolation, RBAC ----------------
test('tenant isolation: rules, alerts, policies and live data of one organization are invisible and untouchable from another; org-wide rules ignore foreign traces', async () => {
  const s = setup(); const A = await s.w.signup('a'); const B = await s.w.signup('b');
  const adminA = asRole(A.principal, 'admin'), adminB = asRole(B.principal, 'admin');
  const agentA = await s.w.newAgent(A.principal, 'x'), agentB = await s.w.newAgent(B.principal, 'x');
  const ruleA = await s.w.services.alerts.createRule(adminA, { name: 'A', type: 'error_rate', params: { windowMinutes: 10, thresholdPct: 10, minSamples: 5 } });   // org-wide
  for (let i = 0; i < 20; i++) await s.ingest(B.principal, s.trace(agentB.id, { status: 'error' }));                 // org B melts down
  for (let i = 0; i < 20; i++) await s.ingest(A.principal, s.trace(agentA.id));                                       // org A is fine
  const out = await s.w.services.alertEngine.tick();
  assert.equal(out.length, 1); assert.equal(out[0].state, 'ok'); assert.deepEqual(out[0].evaluation.observed, { errorRatePct: 0, errors: 0, count: 20 });
  // make A fail, B must not see the alert
  for (let i = 0; i < 20; i++) await s.ingest(A.principal, s.trace(agentA.id, { status: 'error' }));
  s.advance(1); await s.w.services.alertEngine.tick();
  const alertA = (await s.w.services.alerts.list(adminA, {})).items[0];
  assert.ok(alertA);
  assert.equal((await s.w.services.alerts.list(adminB, {})).items.length, 0);
  assert.equal((await s.w.services.alerts.summary(adminB)).active, 0);
  assert.equal((await s.w.services.alerts.listRules(adminB)).items.length, 0);
  for (const fn of [() => s.w.services.alerts.get(adminB, alertA.id), () => s.w.services.alerts.acknowledge(adminB, alertA.id), () => s.w.services.alerts.resolve(adminB, alertA.id)]) await assert.rejects(fn, { code: 'ALERT_NOT_FOUND' });
  for (const fn of [() => s.w.services.alerts.getRule(adminB, ruleA.id), () => s.w.services.alerts.updateRule(adminB, ruleA.id, { name: 'hacked' }), () => s.w.services.alerts.deleteRule(adminB, ruleA.id), () => s.w.services.alerts.testRule(adminB, ruleA.id)]) await assert.rejects(fn, { code: 'ALERT_RULE_NOT_FOUND' });
  await assert.rejects(() => s.w.services.alerts.createRule(adminB, { name: 'x', type: 'silence', agentId: agentA.id, params: { silenceMinutes: 5 } }), { code: 'AGENT_NOT_FOUND' });
  for (const fn of [() => s.w.services.monitoring.live(adminB, agentA.id, {}), () => s.w.services.monitoring.getPolicy(adminB, agentA.id), () => s.w.services.monitoring.putPolicy(adminB, agentA.id, { enabled: true }), () => s.w.services.monitoring.rollups(adminB, agentA.id, {})]) await assert.rejects(fn, { code: 'AGENT_NOT_FOUND' });
  const ovB = await s.w.services.monitoring.overview(adminB, {});
  assert.deepEqual(ovB.agents.map((a) => a.id), [agentB.id]);
  assert.equal(ovB.agents[0].health.openAlerts.critical + ovB.agents[0].health.openAlerts.warning, 0);
});

test('RBAC: viewers read alerts; members acknowledge; only admins edit rules; API keys get nothing', async () => {
  const s = await adminWorld();
  const v = asRole(s.A.principal, 'viewer'), m = asRole(s.A.principal, 'member');
  const body = { name: 'r', type: 'error_rate', params: { thresholdPct: 10 } };
  for (const p of [v, m]) {
    await assert.rejects(() => s.w.services.alerts.createRule(p, body), { code: 'FORBIDDEN' });
  }
  const rule = await s.w.services.alerts.createRule(s.admin, body);
  for (const p of [v, m]) {
    await assert.rejects(() => s.w.services.alerts.updateRule(p, rule.id, { enabled: false }), { code: 'FORBIDDEN' });
    await assert.rejects(() => s.w.services.alerts.deleteRule(p, rule.id), { code: 'FORBIDDEN' });
  }
  assert.equal((await s.w.services.alerts.listRules(v)).items.length, 1);
  assert.equal((await s.w.services.alerts.summary(v)).active, 0);
  const key = { ...s.A.principal, type: 'apiKey', scopes: ['traces:write', 'agents:read'] };
  await assert.rejects(() => s.w.services.alerts.list(key, {}), { code: 'FORBIDDEN' });
  await assert.rejects(() => s.w.services.monitoring.live(key, s.agent.id, {}), { code: 'FORBIDDEN' });
  await assert.rejects(() => s.w.services.monitoring.overview(key, {}), { code: 'FORBIDDEN' });
  await s.w.services.alerts.deleteRule(s.admin, rule.id);
  assert.equal((await s.w.services.alerts.listRules(s.admin)).items.length, 0);
});

test('rule API: limits, validation errors, patching keeps type, deleting resolves the open alert, query validation', async () => {
  const s = await adminWorld({ MAX_ALERT_RULES: '2' });
  const { alerts } = s.w.services;
  await assert.rejects(() => alerts.createRule(s.admin, { name: 'x', type: 'error_rate', params: { thresholdPct: 'a lot' } }), { code: 'VALIDATION_ERROR' });
  await alerts.createRule(s.admin, { name: 'one', type: 'error_rate', params: { thresholdPct: 5 } });
  const r2 = await alerts.createRule(s.admin, { name: 'two', type: 'latency', params: { thresholdMs: 100 } });
  await assert.rejects(() => alerts.createRule(s.admin, { name: 'three', type: 'error_rate', params: { thresholdPct: 5 } }), { code: 'ALERT_RULE_LIMIT' });
  const upd = await alerts.updateRule(s.admin, r2.id, { params: { thresholdMs: 250 }, severity: 'critical', enabled: false });
  assert.deepEqual([upd.params.thresholdMs, upd.params.stat, upd.severity, upd.enabled], [250, 'p95', 'critical', false]);
  await assert.rejects(() => alerts.updateRule(s.admin, r2.id, { type: 'silence' }), { code: 'VALIDATION_ERROR' });
  for (const q of [{ status: 'bogus' }, { agentId: 'x' }, { ruleId: { $ne: 1 } }, { cursor: 'nope' }, { limit: '0' }, { limit: '101' }]) await assert.rejects(() => alerts.list(s.admin, q), (e) => e.status === 400, JSON.stringify(q));
  const page1 = await alerts.listRules(s.admin, { limit: '1' }); assert.ok(page1.nextCursor);
  assert.equal((await alerts.listRules(s.admin, { limit: '1', cursor: page1.nextCursor })).items.length, 1);
  assert.equal(s.w.repos._db.alertRules.find((r) => r.id === r2.id).enabled, false);
  // a disabled rule is not evaluated
  const ids = (await s.w.services.alertEngine.tick()).map((r) => r.ruleId);
  assert.deepEqual(ids, [(await alerts.listRules(s.admin)).items.find((r) => r.name === 'one').id]);
  // deleting a rule with an open alert resolves that alert
  await burst(s, s.agent.id, 30, 30);
  await alerts.updateRule(s.admin, r2.id, { enabled: true });
  const one = (await alerts.listRules(s.admin)).items.find((r) => r.name === 'one');
  s.advance(1); await s.w.services.alertEngine.tick();
  assert.equal((await alerts.list(s.admin, { status: 'open' })).items.length, 2);   // the error-rate rule and the re-enabled latency rule (800 ms > 250 ms)
  await alerts.deleteRule(s.admin, one.id);
  const [closed] = (await alerts.list(s.admin, { status: 'resolved' })).items;
  assert.equal(closed.resolvedBy, 'rule_deleted');
});

test('two workers racing for the same rule: it is leased once and only one alert exists', async () => {
  const s = await adminWorld();
  await s.w.services.alerts.createRule(s.admin, { name: 'Err', type: 'error_rate', agentId: s.agent.id, params: { windowMinutes: 10, thresholdPct: 10, minSamples: 5 } });
  await burst(s, s.agent.id, 10, 8);
  const results = await Promise.all([s.w.services.alertEngine.tick(), s.w.services.alertEngine.tick()]);
  assert.equal(results.flat().length, 1);
  assert.equal(s.w.repos._db.alerts.length, 1);
  // even if both evaluations did run, the unique open-alert guard keeps a single alert
  const rule = s.w.repos._db.alertRules[0];
  await Promise.all([s.w.services.alertEngine.evaluateOne({ ...rule, state: {} }), s.w.services.alertEngine.evaluateOne({ ...rule, state: {} })]);
  assert.equal(s.w.repos._db.alerts.length, 1);
});

// ---------------- webhooks: SSRF, secrets, signing, retries ----------------
test('webhook channel: SSRF-blocked at creation, URL stored encrypted, never returned, never audited', async () => {
  const s = await adminWorld();
  const { alerts } = s.w.services;
  const secretUrl = 'https://hooks.example.com/services/T000/B000/SUPERSECRETTOKEN';
  await assert.rejects(() => alerts.createRule(s.admin, { name: 'w', type: 'error_rate', params: { thresholdPct: 5 }, notify: { webhook: { url: 'http://169.254.169.254/latest/meta-data' } } }),
    (e) => e.code === 'VALIDATION_ERROR' && e.details.some((d) => d.path === 'notify.webhook.url'));
  await assert.rejects(() => alerts.createRule(s.admin, { name: 'w', type: 'error_rate', params: { thresholdPct: 5 }, notify: { webhook: { format: 'json' } } }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(() => alerts.createRule(s.admin, { name: 'w', type: 'error_rate', params: { thresholdPct: 5 }, notify: { webhook: { url: secretUrl, secret: 'short' } } }), { code: 'VALIDATION_ERROR' });
  const rule = await alerts.createRule(s.admin, { name: 'w', type: 'error_rate', params: { thresholdPct: 5 }, notify: { webhook: { url: secretUrl, secret: 'signing-secret-123', format: 'slack' } } });
  assert.deepEqual(rule.notify.webhook, { host: 'hooks.example.com', format: 'slack', hasSecret: true });
  const stored = s.w.repos._db.alertRules[0].notify.webhook;
  assert.ok(stored.urlEnc && !stored.urlEnc.includes('SUPERSECRET') && !JSON.stringify(stored).includes('signing-secret-123'));
  const everything = JSON.stringify([rule, await alerts.listRules(s.admin), await alerts.getRule(s.admin, rule.id), s.w.repos._db.audit]);
  assert.ok(!everything.includes('SUPERSECRETTOKEN') && !everything.includes('signing-secret-123'));
  // partial update keeps the URL, can rotate the secret or remove the channel
  const up = await alerts.updateRule(s.admin, rule.id, { notify: { webhook: { secret: 'another-secret-456' } } });
  assert.equal(up.notify.webhook.host, 'hooks.example.com');
  assert.equal((await alerts.updateRule(s.admin, rule.id, { notify: null })).notify.webhook, null);
});

test('webhook delivery: opened + resolved notifications are queued once, signed, free of trace content and secrets', async () => {
  const sent = [];
  const s = setup({ http: async (url, o) => { sent.push({ url, ...o }); return { status: 200, text: 'ok' }; } }, { PUBLIC_WEB_URL: 'https://agenteval.example.com/' });
  const A = await s.w.signup(); const admin = asRole(A.principal, 'admin'); const agent = await s.w.newAgent(A.principal);
  const url = 'https://hooks.example.com/hook/TOKEN123';
  await s.w.services.alerts.createRule(admin, { name: 'Err', type: 'error_rate', agentId: agent.id, resolveAfterOk: 1, params: { windowMinutes: 10, thresholdPct: 10, minSamples: 5 }, notify: { webhook: { url, secret: 'signing-secret-123' } } });
  for (let i = 0; i < 10; i++) await s.ingest(A.principal, s.trace(agent.id, { status: i < 6 ? 'error' : 'success', input: 'PRIVATE CUSTOMER QUESTION', output: 'PRIVATE ANSWER' }));
  await s.w.services.alertEngine.tick(); await s.w.services.alertEngine.tick();
  await s.w.worker.loop.drain();
  assert.equal(sent.length, 1);
  const body = sent[0].body;
  assert.equal(sent[0].url, url);
  const parsed = JSON.parse(body);
  assert.deepEqual([parsed.event, parsed.severity, parsed.rule.type, parsed.agentId], ['opened', 'warning', 'error_rate', agent.id]);
  assert.match(parsed.explanation, /60\.0% \(6 of 10/);
  assert.match(parsed.link, /^https:\/\/agenteval\.example\.com\/#\/alerts\//);
  assert.ok(!body.includes('PRIVATE') && !body.includes('signing-secret-123') && !body.includes('TOKEN123'));
  const h = sent[0].headers;
  assert.equal(h['x-agenteval-signature'], sign('signing-secret-123', h['x-agenteval-timestamp'], body));
  assert.equal(sent[0].allowPrivate, false);
  assert.ok(!JSON.stringify(h).includes('signing-secret-123'));
  // resolution: errors age out of the window, healthy traffic arrives -> auto-resolve (resolveAfterOk 1) -> one more notification
  s.advance(11);
  for (let i = 0; i < 10; i++) await s.ingest(A.principal, s.trace(agent.id));
  await s.w.services.alertEngine.tick(); await s.w.worker.loop.drain();
  assert.equal(sent.length, 2);
  assert.equal(JSON.parse(sent[1].body).event, 'resolved');
});

test('webhook delivery: real SSRF guard refuses internal targets even if one was stored; 5xx is retried; refusal is final and recorded', async () => {
  const s = setup(); const A = await s.w.signup(); const admin = asRole(A.principal, 'admin'); const agent = await s.w.newAgent(A.principal);
  const rule = await s.w.services.alerts.createRule(admin, { name: 'E', type: 'error_rate', agentId: agent.id, params: { windowMinutes: 10, thresholdPct: 10, minSamples: 5 }, notify: { webhook: { url: 'https://hooks.example.com/x' } } });
  const org = A.principal.organizationId;
  const alertDoc = (await s.w.repos.alerts.create(org, { ruleId: rule.id, ruleName: 'E', ruleType: 'error_rate', severity: 'warning', agentId: agent.id, status: 'open', openedAt: s.clock.t, explanation: 'x', observed: {}, threshold: 10 })).alert;
  // tamper: store an internal URL directly (bypassing creation-time validation) - the send-time guard must still refuse it
  const r = s.w.repos._db.alertRules.find((x) => x.id === rule.id);
  r.notify.webhook.urlEnc = s.w.services.secrets.encrypt('http://127.0.0.1:9/hook');
  const real = createAlertNotifier({ repos: s.w.repos, config: s.w.config, secrets: s.w.services.secrets, http: safeRequest, logger: { error: () => {} } });
  const out = await real.handle({ organizationId: org, attempts: 1, maxAttempts: 4, payload: { alertId: alertDoc.id, event: 'opened' } });
  assert.deepEqual(out, { done: true });
  const n = (await s.w.repos.alerts.get(org, alertDoc.id)).notifications.at(-1);
  assert.deepEqual([n.ok, n.channel], [false, 'webhook']); assert.ok(n.error);
  const flaky = createAlertNotifier({ repos: s.w.repos, config: s.w.config, secrets: s.w.services.secrets, http: async () => ({ status: 503, text: '' }), logger: { error: () => {} } });
  r.notify.webhook.urlEnc = s.w.services.secrets.encrypt('https://hooks.example.com/x');
  assert.equal((await flaky.handle({ organizationId: org, attempts: 1, maxAttempts: 4, payload: { alertId: alertDoc.id, event: 'opened' } })).retry, true);
  assert.deepEqual(await flaky.handle({ organizationId: org, attempts: 4, maxAttempts: 4, payload: { alertId: alertDoc.id, event: 'opened' } }), { done: true });
});
