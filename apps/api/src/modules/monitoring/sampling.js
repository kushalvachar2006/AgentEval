import crypto from 'node:crypto';

// Deterministic in [0, 1): the same traceId always lands in the same place, so a re-delivered trace gets the same decision.
export function hashUnit(traceId) {
  const h = crypto.createHash('sha256').update(String(traceId)).digest();
  return h.readUInt32BE(0) / 2 ** 32;
}

// Pure sampling decision for one freshly ingested trace. Budgets are applied afterwards (atomically, in the repository).
export function decideSampling(policy, trace) {
  if (!policy?.enabled) return { evaluate: false, reason: 'monitoring_off' };
  if (trace.environment !== 'production') return { evaluate: false, reason: 'not_production' };
  if (trace.isDemo) return { evaluate: false, reason: 'demo' };
  if (policy.alwaysEvaluateErrors && trace.status !== 'success') return { evaluate: true, reason: 'failed_execution' };
  if (policy.sampleRate > 0 && hashUnit(trace.traceId) < policy.sampleRate) return { evaluate: true, reason: 'sampled' };
  return { evaluate: false, reason: 'not_sampled' };
}
