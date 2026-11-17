// Worker side: gathers the numbers a rule needs, evaluates it (pure), applies the lifecycle (open / update / resolve / suppress) and queues notifications.
import { evaluateRule, windowOf } from '../modules/alerts/rules.js';
import { nextStep } from '../modules/alerts/lifecycle.js';
import { gatherWindow } from '../modules/monitoring/windowStats.js';

const MIN = 60_000, DAY = 86_400_000;
const LEASE_MS = 2 * MIN;

export function createAlertEngine({ repos, config, now = () => new Date(), logger = console }) {
  async function qualityWindow(org, rule, from, to) {
    const rows = await repos.prodEvals.metricStats(org, { agentId: rule.agentId ?? undefined, from, to, metric: rule.params.metric });
    const m = rows.find((r) => r.metric === rule.params.metric);
    return { n: m?.n ?? 0, avgScore: m?.avgScore ?? null };
  }

  // The numbers for one rule. Production, non-demo traffic only.
  async function snapshot(rule, at) {
    const org = rule.organizationId;
    const w = windowOf(rule, at);
    switch (rule.type) {
      case 'error_rate': { const s = await gatherWindow(repos, org, { agentId: rule.agentId ?? undefined, from: w.from, to: w.to, withP95: false }); return { count: s.count, errors: s.errors }; }
      case 'latency': { const s = await gatherWindow(repos, org, { agentId: rule.agentId ?? undefined, from: w.from, to: w.to, withP95: rule.params.stat === 'p95' }); return { count: s.count, avgLatencyMs: s.avgLatencyMs, p95LatencyMs: s.p95LatencyMs, p95Exact: s.p95Exact }; }
      case 'cost_per_day': { const s = await gatherWindow(repos, org, { agentId: rule.agentId ?? undefined, from: w.from, to: w.to, withP95: false }); return { count: s.count, costN: s.costN, costUsd: s.costUsd ?? 0 }; }
      case 'silence': { const a = await repos.agents.get(org, rule.agentId); return { everConnected: Boolean(a?.lastTraceAt), lastTraceAt: a?.lastTraceAt ?? null }; }
      case 'quality_drop': {
        const current = await qualityWindow(org, rule, w.from, w.to);
        if (rule.params.baseline === 'last_run') {
          const runs = await repos.runs.list(org, { agentId: rule.agentId, limit: 20 });
          const last = runs.items.find((r) => r.status === 'completed');
          const stats = last ? await repos.results.metricStats(org, { runId: last.id, metric: rule.params.metric }) : [];
          const m = stats.find((r) => r.metric === rule.params.metric);
          return { current, baseline: { n: m?.n ?? 0, avgScore: m?.avgScore ?? null, kind: 'last_run' } };
        }
        return { current, baseline: { ...(await qualityWindow(org, rule, new Date(w.from - w.minutes * MIN), w.from)), kind: 'previous_window' } };
      }
      default: throw new Error(`unknown rule type ${rule.type}`);
    }
  }

  const alertDoc = (rule, ev, at, w) => ({
    ruleId: rule.id, ruleName: rule.name, ruleType: rule.type, severity: rule.severity, agentId: rule.agentId ?? undefined, status: 'open', openedAt: at, lastEvaluatedAt: at,
    explanation: ev.explanation, observed: ev.observed, threshold: ev.threshold, window: { from: w.from, to: w.to, minutes: w.minutes },
    expiresAt: new Date(at.getTime() + config.alertRetentionDays * DAY),
  });

  const notify = async (org, rule, alert, event) => {
    if (!rule.notify?.webhook?.urlEnc) return;
    await repos.jobs.enqueue(org, { type: 'notify_alert', idempotencyKey: `notify:${alert.id}:${event}`, payload: { alertId: alert.id, event }, maxAttempts: 4 });
  };

  async function evaluateOne(rule) {
    const org = rule.organizationId, at = now(), w = windowOf(rule, at);
    const evaluation = evaluateRule(rule, await snapshot(rule, at), at);
    const open = await repos.alerts.findOpenForRule(org, rule.id);
    const { action, rulePatch } = nextStep({ rule, evaluation, hasOpenAlert: Boolean(open), now: at });
    let alert = open;
    if (action === 'open') {
      const r = await repos.alerts.create(org, alertDoc(rule, evaluation, at, w));
      if (r.created) { alert = r.alert; await notify(org, rule, alert, 'opened'); }
      else alert = await repos.alerts.findOpenForRule(org, rule.id);   // another worker opened it first: de-duplicated
    } else if (action === 'update' || action === 'touch') {
      alert = await repos.alerts.incEvaluations(org, open.id, { lastEvaluatedAt: at, ...(action === 'update' && { explanation: evaluation.explanation, observed: evaluation.observed, threshold: evaluation.threshold, window: { from: w.from, to: w.to, minutes: w.minutes } }) });
    } else if (action === 'resolve') {
      alert = await repos.alerts.update(org, open.id, { status: 'resolved', resolvedAt: at, resolvedBy: 'auto', lastEvaluatedAt: at, explanation: `Resolved automatically. ${evaluation.explanation}` }, { ifStatusIn: ['open', 'acknowledged'] });
      if (alert) await notify(org, rule, alert, 'resolved');
    }
    await repos.alertRules.update(org, rule.id, { state: { ...(rule.state ?? {}), ...rulePatch }, nextEvalAt: new Date(at.getTime() + (rule.evalEveryMinutes ?? 1) * MIN) });
    return { ruleId: rule.id, action, state: evaluation.state, evaluation };
  }

  return {
    evaluateOne,
    // Evaluate without persisting anything ("test this rule" in the UI).
    async dryRun(rule) { const at = now(); const evaluation = evaluateRule(rule, await snapshot(rule, at), at); return { ...evaluation, evaluatedAt: at.toISOString() }; },
    // Scheduler tick: lease and evaluate due rules (exactly one worker gets each rule per interval).
    async tick({ max = 50 } = {}) {
      const results = [];
      for (let i = 0; i < max; i++) {
        const rule = await repos.alertRules.claimDue({ now: now(), leaseMs: LEASE_MS });
        if (!rule) break;
        try { results.push(await evaluateOne(rule)); }
        catch (e) { logger.error(JSON.stringify({ level: 'error', msg: 'alert rule evaluation failed', ruleId: rule.id, error: String(e.message).slice(0, 200) })); }   // lease expires, the rule is retried
      }
      return results;
    },
  };
}
