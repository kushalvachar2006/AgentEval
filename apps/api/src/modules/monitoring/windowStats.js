// Shared by the live view and the alert engine so both always compute the same numbers for the same window.
import { percentileExact } from './histogram.js';

export const DURATION_CAP = 5000;   // newest durations used for an exact p95; beyond this the p95 is flagged as estimated
const round = (n, d = 4) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);

// Real production traffic only: demo traces never trigger or mask real problems.
export const prodFilter = ({ agentId, from, to, includeDemo = false }) => ({ environment: 'production', from, to, ...(agentId && { agentId }), ...(!includeDemo && { isDemo: false }) });

export async function gatherWindow(repos, org, { agentId, from, to, includeDemo = false, withP95 = true }) {
  const f = prodFilter({ agentId, from, to, includeDemo });
  const stats = await repos.traces.stats(org, f);
  let p95LatencyMs = null, p95Exact = true;
  if (withP95 && stats.count > 0) {
    const durations = await repos.traces.durations(org, f, DURATION_CAP);
    p95LatencyMs = percentileExact(durations, 0.95);
    p95Exact = stats.count <= DURATION_CAP;
  }
  return {
    count: stats.count, errors: stats.errors, failed: stats.failed,
    errorRate: stats.count ? round(stats.errors / stats.count) : null,
    avgLatencyMs: stats.avgLatencyMs === null ? null : Math.round(stats.avgLatencyMs),
    p95LatencyMs, p95Exact,
    totalTokens: stats.totalTokens, costUsd: stats.costN ? round(stats.costUsd, 6) : null, costN: stats.costN, costCoverage: stats.count ? round(stats.costN / stats.count) : null,
  };
}
