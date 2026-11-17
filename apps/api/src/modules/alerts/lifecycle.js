// Alert lifecycle as a pure function: given the rule's persisted state, the latest evaluation and whether an alert is currently open,
// decide what to do. De-duplication (one open alert per rule), cooldown after resolution, hysteresis (several OK evaluations before
// auto-resolve) and "insufficient data never opens or closes anything" all live here.
export const nextStep = ({ rule, evaluation, hasOpenAlert, now }) => {
  const st = rule.state ?? {};
  const t = new Date(now).getTime();
  const patch = { lastEvaluatedAt: new Date(now), lastState: evaluation.state, lastObserved: evaluation.observed, lastExplanation: evaluation.explanation };

  if (evaluation.state === 'insufficient_data') return { action: hasOpenAlert ? 'touch' : 'none', rulePatch: patch };

  if (evaluation.state === 'firing') {
    patch.okStreak = 0;
    if (hasOpenAlert) return { action: 'update', rulePatch: patch };
    const coolingUntil = st.lastResolvedAt ? new Date(st.lastResolvedAt).getTime() + (rule.cooldownMinutes ?? 0) * 60_000 : 0;
    if (t < coolingUntil) return { action: 'suppressed', rulePatch: { ...patch, suppressedUntil: new Date(coolingUntil) } };
    return { action: 'open', rulePatch: patch };
  }

  // ok
  if (!hasOpenAlert) return { action: 'none', rulePatch: { ...patch, okStreak: 0 } };
  const streak = (st.okStreak ?? 0) + 1;
  if (streak >= (rule.resolveAfterOk ?? 1)) return { action: 'resolve', rulePatch: { ...patch, okStreak: 0, lastResolvedAt: new Date(now) } };
  return { action: 'touch', rulePatch: { ...patch, okStreak: streak } };
};
