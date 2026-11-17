// Worker side: evaluates ONE sampled production trace with reference-free evaluators.
// It never calls the user's agent: it only reads the stored trace (including recorded tool/retrieval output) and asks the Python engine.
import { UpstreamError } from '../lib/upstream.js';
import { CATALOG } from '../config/catalog.js';
import { caseStatusOf } from '../modules/evaluations/aggregate.js';
import { effectivePolicy, dayKey, JUDGE_CALLS_PER_TRACE } from '../modules/monitoring/policy.js';

const DAY = 86_400_000;
const preview = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? '')).slice(0, 300);

export function createProductionEvaluator({ repos, config, engine, evaluatorConfig, now = () => new Date() }) {
  return {
    // Returns {done:true, ...} or throws UpstreamError (retryable ones are retried by the queue).
    async handle(job) {
      const org = job.organizationId, traceId = job.payload?.traceId;
      const trace = await repos.traces.get(org, traceId);
      if (!trace) return { done: true, skipped: 'trace no longer exists' };
      if (await repos.prodEvals.byTraceId(org, traceId)) return { done: true, skipped: 'already evaluated' };
      const ageH = (now() - new Date(trace.ingestedAt ?? trace.startedAt)) / 3_600_000;
      if (ageH > config.prodEvalMaxAgeHours) return { done: true, skipped: 'stale: the evaluation queue was too far behind' };
      const agent = await repos.agents.get(org, trace.agentId);
      if (!agent) return { done: true, skipped: 'agent no longer exists' };
      const policy = effectivePolicy(agent.monitoring);
      if (!policy.enabled) return { done: true, skipped: 'monitoring was switched off' };

      // Evaluator versions are pinned from the catalogue, exactly as for evaluation runs.
      const evaluators = policy.evaluators.filter((m) => CATALOG[m] && (m !== 'instruction_adherence' || policy.constraints)).map((m) => ({ metric: m, version: CATALOG[m].version, config: {} }));
      if (!evaluators.length) return { done: true, skipped: 'no evaluators selected' };

      // AI-judge budget: reserved atomically per agent per UTC day BEFORE the call (parallel workers cannot overspend), unused calls refunded.
      let judge = null, granted = 0;
      const day = dayKey(now());
      if (policy.useJudge && policy.dailyJudgeBudget > 0) {
        const cfg = await evaluatorConfig.judgeFor(org);
        if (cfg) {
          granted = await repos.usage.reserve(org, agent.id, day, 'judgeCalls', JUDGE_CALLS_PER_TRACE, policy.dailyJudgeBudget, { expiresAt: new Date(now().getTime() + 35 * DAY) });
          if (granted > 0) judge = cfg;
        }
      }
      let out, used = 0;
      try {
        out = await engine.evaluate({
          trace: { status: trace.status, input: trace.input, output: trace.output, error: trace.error, durationMs: trace.durationMs, usage: trace.usage, spans: trace.spans, metadata: trace.metadata },
          testCase: policy.constraints ? { constraints: policy.constraints } : {},
          evaluators, judge, limits: { maxJudgeCalls: granted },
        });
        used = Math.min(out?.judgeCalls ?? 0, granted);
      } finally {
        if (granted - used > 0) await repos.usage.add(org, agent.id, day, { judgeCalls: used - granted }).catch(() => {});
      }
      if (!Array.isArray(out?.results)) throw new UpstreamError('Evaluation engine returned an unexpected response', { retryable: true });

      const at = now();
      await repos.prodEvals.insertIfAbsent(org, {
        agentId: trace.agentId, agentVersion: trace.agentVersion, traceId, status: caseStatusOf(out.results), reason: job.payload?.reason, metrics: out.results, judgeCalls: used,
        inputPreview: preview(trace.input), outputPreview: preview(trace.output), evaluatedAt: at, expiresAt: trace.expiresAt ?? new Date(at.getTime() + config.traceRetentionDays * DAY),
      });
      return { done: true };
    },
  };
}
