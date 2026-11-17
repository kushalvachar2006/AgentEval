// Routes queue jobs by type: evaluation-run cases, sampled production traces, alert notifications. Same contract as the executor.
export function createJobRouter({ executor, production, notifier }) {
  return {
    async handle(job) {
      try {
        if (job.type === 'evaluate_trace') return await production.handle(job);
        if (job.type === 'notify_alert') return await notifier.handle(job);
        return await executor.handle(job);
      } catch (e) {
        const retryable = e?.retryable ?? true;   // UpstreamError carries `retryable`; unknown failures get another chance
        if (retryable && job.attempts < job.maxAttempts) return { retry: true, error: e.message };
        return { done: true, error: String(e.message).slice(0, 200) };
      }
    },
    sweepExpired: () => executor.sweepExpired(),
  };
}
