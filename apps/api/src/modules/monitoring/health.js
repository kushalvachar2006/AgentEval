// Agent health from recent numbers. Pure; every verdict carries the numbers that caused it.
// Defaults are deliberately simple and documented (docs/architecture/ARCHITECTURE.md ADR-30); alert rules are the precise, per-team tool.
export const HEALTH_DEFAULTS = Object.freeze({ minSamples: 10, degradedErrorRate: 0.05, failingErrorRate: 0.25, latencyIncreaseFactor: 2, qualityFailRate: 0.3, minQualitySamples: 5 });
const pct = (x) => `${(x * 100).toFixed(1)}%`;

/**
 * @param current  { count, errors, avgLatencyMs }  stats for the live window
 * @param previous { count, avgLatencyMs }           stats for the window before it (may be empty)
 * @param quality  { n, failed }                     recently evaluated production traces (n results, failed ones)
 * @param alerts   { critical, warning }             open alert counts for the agent
 * @param silence  { everConnected, minutesSinceLastTrace }
 */
export function computeHealth({ current, previous, quality, alerts, silence }, opt = HEALTH_DEFAULTS) {
  const reasons = [];
  let level = 0; // 0 healthy, 1 degraded, 2 failing
  const bump = (to, text) => { level = Math.max(level, to); reasons.push(text); };

  if (alerts?.critical) bump(2, `${alerts.critical} critical alert(s) open`);
  if (alerts?.warning) bump(1, `${alerts.warning} warning alert(s) open`);

  if (current.count < opt.minSamples) {
    if (!reasons.length) {
      const idle = silence?.everConnected && silence.minutesSinceLastTrace !== null ? ` Last trace ${Math.round(silence.minutesSinceLastTrace)} min ago.` : '';
      return { status: 'no_data', reasons: [`Only ${current.count} trace(s) in the window (need ${opt.minSamples} for a verdict).${idle}`] };
    }
  } else {
    const er = current.errors / current.count;
    if (er >= opt.failingErrorRate) bump(2, `Error rate ${pct(er)} (${current.errors} of ${current.count}) is at or above ${pct(opt.failingErrorRate)}`);
    else if (er >= opt.degradedErrorRate) bump(1, `Error rate ${pct(er)} (${current.errors} of ${current.count}) is at or above ${pct(opt.degradedErrorRate)}`);
    if (previous?.count >= opt.minSamples && previous.avgLatencyMs > 0 && current.avgLatencyMs >= previous.avgLatencyMs * opt.latencyIncreaseFactor) {
      bump(1, `Average latency ${Math.round(current.avgLatencyMs)} ms is ${(current.avgLatencyMs / previous.avgLatencyMs).toFixed(1)}x the previous window (${Math.round(previous.avgLatencyMs)} ms)`);
    }
  }
  if (quality?.n >= opt.minQualitySamples && quality.failed / quality.n >= opt.qualityFailRate) {
    bump(1, `${quality.failed} of ${quality.n} recently evaluated production traces failed a quality check`);
  }
  return { status: level === 2 ? 'failing' : level === 1 ? 'degraded' : 'healthy', reasons: reasons.length ? reasons : [`${current.count} traces in the window, error rate ${pct(current.errors / current.count)}, no open alerts`] };
}
