// Alert rule definitions: validation and PURE evaluation. No I/O and no clock reads (the caller passes `now`), so every rule
// is testable with a controllable clock. Every evaluation states WHICH numbers crossed WHICH threshold.
import { check } from '../../lib/validate.js';
import { isId } from '../../lib/ids.js';
import { PROD_EVALUATORS } from '../monitoring/policy.js';

export const RULE_TYPES = ['error_rate', 'latency', 'quality_drop', 'cost_per_day', 'silence'];
export const SEVERITIES = ['warning', 'critical'];
const num = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

const int = (c, v, path, { min, max, def }) => {
  if (v === undefined || v === null) return def;
  if (!Number.isInteger(v) || v < min || v > max) { c.fail(path, `must be a whole number from ${min} to ${max}`); return def; }
  return v;
};
const dec = (c, v, path, { min, max, def, exclusiveMin = false }) => {
  if (v === undefined || v === null) { if (def === undefined) c.fail(path, 'is required'); return def; }
  if (typeof v !== 'number' || !Number.isFinite(v) || (exclusiveMin ? v <= min : v < min) || v > max) { c.fail(path, `must be a number ${exclusiveMin ? 'above' : 'from'} ${min} ${exclusiveMin ? 'up to' : 'to'} ${max}`); return def; }
  return v;
};

export function validateParams(c, type, p = {}) {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) { c.fail('params', 'must be an object'); return {}; }
  switch (type) {
    case 'error_rate': return { windowMinutes: int(c, p.windowMinutes, 'params.windowMinutes', { min: 1, max: 1440, def: 15 }), thresholdPct: dec(c, p.thresholdPct, 'params.thresholdPct', { min: 0, max: 100, exclusiveMin: true }), minSamples: int(c, p.minSamples, 'params.minSamples', { min: 1, max: 100000, def: 20 }) };
    case 'latency': return { stat: c.oneOf(p.stat, 'params.stat', ['avg', 'p95'], { optional: true, fallback: 'p95' }), windowMinutes: int(c, p.windowMinutes, 'params.windowMinutes', { min: 1, max: 1440, def: 15 }), thresholdMs: dec(c, p.thresholdMs, 'params.thresholdMs', { min: 0, max: 3_600_000, exclusiveMin: true }), minSamples: int(c, p.minSamples, 'params.minSamples', { min: 1, max: 100000, def: 20 }) };
    case 'quality_drop': return { metric: c.oneOf(p.metric, 'params.metric', PROD_EVALUATORS), dropThreshold: dec(c, p.dropThreshold, 'params.dropThreshold', { min: 0, max: 1, exclusiveMin: true }), windowMinutes: int(c, p.windowMinutes, 'params.windowMinutes', { min: 5, max: 1440, def: 60 }), baseline: c.oneOf(p.baseline, 'params.baseline', ['previous_window', 'last_run'], { optional: true, fallback: 'previous_window' }), minSamples: int(c, p.minSamples, 'params.minSamples', { min: 1, max: 100000, def: 10 }) };
    case 'cost_per_day': return { thresholdUsd: dec(c, p.thresholdUsd, 'params.thresholdUsd', { min: 0, max: 1_000_000, exclusiveMin: true }), minSamples: int(c, p.minSamples, 'params.minSamples', { min: 1, max: 100000, def: 5 }) };
    case 'silence': { if (p.silenceMinutes === undefined || p.silenceMinutes === null) c.fail('params.silenceMinutes', 'is required'); return { silenceMinutes: int(c, p.silenceMinutes, 'params.silenceMinutes', { min: 1, max: 10080, def: undefined }) }; }
    default: return {};
  }
}

// Validates a full rule (create) or a partial one (patch: pass `existing`; unspecified fields keep their value).
export function validateRule(body, existing) {
  const c = check();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) { c.fail('body', 'must be an object'); c.done(); }
  const merged = { ...(existing ?? {}), ...body };
  const type = existing ? existing.type : c.oneOf(body.type, 'type', RULE_TYPES);
  if (existing && body.type !== undefined && body.type !== existing.type) c.fail('type', 'cannot be changed; create a new rule instead');
  const name = c.str(merged.name, 'name', { max: 100 });
  const severity = c.oneOf(merged.severity, 'severity', SEVERITIES, { optional: true, fallback: 'warning' });
  let agentId = merged.agentId ?? null;
  if (agentId !== null && !isId(agentId)) { c.fail('agentId', 'must be a valid agent id or null (all agents)'); agentId = null; }
  if (type === 'silence' && agentId === null) c.fail('agentId', 'is required for a silence rule (it watches one agent)');
  if (type === 'quality_drop' && merged.params?.baseline === 'last_run' && agentId === null) c.fail('agentId', 'is required when the baseline is the last evaluation run');
  const params = validateParams(c, type, existing && body.params === undefined ? existing.params : (existing ? { ...existing.params, ...body.params } : body.params ?? {}));
  const enabled = merged.enabled === undefined ? true : merged.enabled;
  if (typeof enabled !== 'boolean') c.fail('enabled', 'must be true or false');
  const cooldownMinutes = int(c, merged.cooldownMinutes, 'cooldownMinutes', { min: 0, max: 1440, def: 30 });
  const resolveAfterOk = int(c, merged.resolveAfterOk, 'resolveAfterOk', { min: 1, max: 10, def: 2 });
  const evalEveryMinutes = int(c, merged.evalEveryMinutes, 'evalEveryMinutes', { min: 1, max: 60, def: 1 });
  c.done();
  return { name, type, agentId, severity, params, enabled, cooldownMinutes, resolveAfterOk, evalEveryMinutes };
}

export const windowOf = (rule, now) => {
  const minutes = rule.type === 'cost_per_day' ? 1440 : rule.params.windowMinutes ?? 0;
  const to = new Date(now);
  return { from: new Date(to.getTime() - minutes * 60_000), to, minutes };
};

const result = (state, observed, threshold, explanation) => ({ state, observed, threshold, explanation });

/**
 * snapshot shape per type:
 *   error_rate    { count, errors }
 *   latency       { count, avgLatencyMs, p95LatencyMs, p95Exact }
 *   quality_drop  { current: {n, avgScore}, baseline: {n, avgScore, kind} }
 *   cost_per_day  { count, costN, costUsd }
 *   silence       { everConnected, lastTraceAt }
 */
export function evaluateRule(rule, s, now) {
  const p = rule.params;
  switch (rule.type) {
    case 'error_rate': {
      if (s.count < p.minSamples) return result('insufficient_data', { count: s.count, errors: s.errors }, p.thresholdPct, `Only ${s.count} trace(s) in the last ${p.windowMinutes} min; at least ${p.minSamples} are needed before the error rate is judged.`);
      const rate = s.errors / s.count;
      const firing = rate * 100 > p.thresholdPct;
      return result(firing ? 'firing' : 'ok', { errorRatePct: num(rate * 100, 2), errors: s.errors, count: s.count }, p.thresholdPct,
        `Error rate ${pct(rate)} (${s.errors} of ${s.count} traces in the last ${p.windowMinutes} min) ${firing ? 'is above' : 'is at or below'} the ${p.thresholdPct}% threshold.`);
    }
    case 'latency': {
      if (s.count < p.minSamples) return result('insufficient_data', { count: s.count }, p.thresholdMs, `Only ${s.count} trace(s) in the last ${p.windowMinutes} min; at least ${p.minSamples} are needed.`);
      const value = p.stat === 'p95' ? s.p95LatencyMs : s.avgLatencyMs;
      if (value === null || value === undefined) return result('insufficient_data', { count: s.count }, p.thresholdMs, 'No latency values were recorded in the window.');
      const firing = value > p.thresholdMs;
      return result(firing ? 'firing' : 'ok', { [p.stat === 'p95' ? 'p95LatencyMs' : 'avgLatencyMs']: Math.round(value), count: s.count, ...(p.stat === 'p95' && { p95Exact: Boolean(s.p95Exact) }) }, p.thresholdMs,
        `${p.stat === 'p95' ? 'p95' : 'Average'} latency ${Math.round(value)} ms over ${s.count} traces in the last ${p.windowMinutes} min ${firing ? 'is above' : 'is at or below'} the ${p.thresholdMs} ms threshold${p.stat === 'p95' && !s.p95Exact ? ' (p95 estimated from the most recent traces)' : ''}.`);
    }
    case 'quality_drop': {
      const { current: cur, baseline: base } = s;
      if (cur.n < p.minSamples || base.n < p.minSamples || cur.avgScore === null || base.avgScore === null) {
        return result('insufficient_data', { currentN: cur.n, baselineN: base.n }, p.dropThreshold, `Need at least ${p.minSamples} scored ${p.metric} results in both the last ${p.windowMinutes} min (have ${cur.n}) and the baseline (${base.kind === 'last_run' ? 'last evaluation run' : 'previous window'}, have ${base.n}).`);
      }
      const drop = base.avgScore - cur.avgScore;
      const firing = drop > p.dropThreshold;
      return result(firing ? 'firing' : 'ok', { current: num(cur.avgScore), baseline: num(base.avgScore), drop: num(drop), currentN: cur.n, baselineN: base.n }, p.dropThreshold,
        `${p.metric} score ${num(cur.avgScore, 3)} (${cur.n} traces, last ${p.windowMinutes} min) vs ${num(base.avgScore, 3)} (${base.kind === 'last_run' ? 'last evaluation run' : 'previous window'}, ${base.n}): a drop of ${num(drop, 3)} ${firing ? 'exceeds' : 'does not exceed'} the ${p.dropThreshold} threshold.`);
    }
    case 'cost_per_day': {
      if (s.costN < p.minSamples) return result('insufficient_data', { tracesWithCost: s.costN, count: s.count }, p.thresholdUsd, `Only ${s.costN} trace(s) in the last 24 h report a cost; at least ${p.minSamples} are needed. Costs are only known when the agent reports them.`);
      const firing = s.costUsd > p.thresholdUsd;
      return result(firing ? 'firing' : 'ok', { costUsd: num(s.costUsd, 4), tracesWithCost: s.costN, count: s.count }, p.thresholdUsd,
        `Cost over the last 24 h is $${num(s.costUsd, 4)} (from ${s.costN} of ${s.count} traces that report a cost) and ${firing ? 'is above' : 'is at or below'} the $${p.thresholdUsd} threshold.`);
    }
    case 'silence': {
      if (!s.everConnected || !s.lastTraceAt) return result('insufficient_data', {}, p.silenceMinutes, 'This agent has never sent a trace, so silence cannot be judged.');
      const minutes = (new Date(now).getTime() - new Date(s.lastTraceAt).getTime()) / 60_000;
      const firing = minutes > p.silenceMinutes;
      return result(firing ? 'firing' : 'ok', { minutesSinceLastTrace: Math.round(minutes * 10) / 10, lastTraceAt: new Date(s.lastTraceAt).toISOString() }, p.silenceMinutes,
        `Last production trace arrived ${Math.round(minutes)} min ago (${firing ? 'longer' : 'not longer'} than the ${p.silenceMinutes} min allowed).`);
    }
    default: throw new Error(`unknown rule type ${rule.type}`);
  }
}
