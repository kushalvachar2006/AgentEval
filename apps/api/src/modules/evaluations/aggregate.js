// Pure functions: how per-metric results roll up into a case status and a run summary.
export const caseStatusOf = (metrics) =>
  metrics.some((m) => m.status === 'fail') ? 'failed' : metrics.some((m) => m.status === 'pass') ? 'passed' : 'inconclusive';

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (n, d = 4) => (n === null ? null : Math.round(n * 10 ** d) / 10 ** d);

export function aggregateRun(results, run) {
  const cases = { total: results.length, passed: 0, failed: 0, inconclusive: 0, error: 0 };
  const byMetric = {};
  const latencies = [];
  let tokens = 0, cost = 0, anyCost = false, judgeCalls = 0;
  for (const r of results) {
    cases[r.status] += 1;
    judgeCalls += r.judgeCalls ?? 0;
    if (typeof r.latencyMs === 'number') latencies.push(r.latencyMs);
    if (typeof r.tokens === 'number') tokens += r.tokens;
    if (typeof r.costUsd === 'number') { cost += r.costUsd; anyCost = true; }
    for (const m of r.metrics ?? []) {
      const b = (byMetric[m.metric] ??= { pass: 0, fail: 0, inconclusive: 0, scores: [], confidences: [] });
      b[m.status] += 1;
      if (typeof m.score === 'number') b.scores.push(m.score);
      if (typeof m.confidence === 'number') b.confidences.push(m.confidence);
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    cases,
    passRate: cases.total ? round(cases.passed / cases.total) : null,
    metrics: Object.fromEntries(Object.entries(byMetric).map(([k, b]) => [k, { pass: b.pass, fail: b.fail, inconclusive: b.inconclusive, avgScore: round(avg(b.scores)), avgConfidence: round(avg(b.confidences)) }])),
    latencyMs: { avg: round(avg(latencies), 1), p95: sorted.length ? sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] : null },
    tokens,
    costUsd: anyCost ? round(cost, 6) : null,
    judgeCalls,
    evaluators: (run.evaluators ?? []).map((e) => ({ metric: e.metric, version: e.version })),
  };
}
