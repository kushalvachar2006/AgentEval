import crypto from 'node:crypto';

// Polls the Mongo-backed queue, runs up to `workerConcurrency` jobs in parallel, retries with exponential backoff.
export function createWorkerLoop({ repos, executor, config, scheduler, now = () => new Date(), workerId = crypto.randomUUID(), leaseMs = 5 * 60_000, backoffMs = 2000, logger = console }) {
  let active = 0, poll, sweep, alerts;
  const log = (level, msg, extra = {}) => logger.log(JSON.stringify({ level, msg, ...extra }));

  async function runJob(job) {
    try {
      const out = await executor.handle(job);
      if (out.retry) await repos.jobs.fail(job.id, { error: out.error, now: now(), backoffMs, retry: true });
      else await repos.jobs.complete(job.id);
    } catch (e) {
      log('error', 'job crashed', { job: job.id, error: e.message });
      await repos.jobs.fail(job.id, { error: e.message, now: now(), backoffMs, retry: true }).catch(() => {});
    } finally { active -= 1; }
  }

  async function tick() {
    const started = [];
    while (active < config.workerConcurrency) {
      const job = await repos.jobs.claim({ workerId, now: now(), leaseMs });
      if (!job) break;
      active += 1;
      started.push(runJob(job));
    }
    return started;
  }

  return {
    tick,
    // Test helper: process everything that is currently due, then return.
    async drain() {
      for (let i = 0; i < 100_000; i++) {
        const started = await tick();
        if (!started.length && active === 0) return;
        await Promise.all(started);
      }
    },
    start({ pollMs = config.workerPollMs, sweepMs = 30_000 } = {}) {
      poll = setInterval(() => tick().catch((e) => log('error', 'tick failed', { error: e.message })), pollMs);
      sweep = setInterval(() => executor.sweepExpired().catch((e) => log('error', 'sweep failed', { error: e.message })), sweepMs);
      if (scheduler) alerts = setInterval(() => scheduler.tick().catch((e) => log('error', 'alert scheduler failed', { error: e.message })), config.alertTickMs);
    },
    async stop(timeoutMs = 10_000) {
      clearInterval(poll); clearInterval(sweep); clearInterval(alerts);
      const end = Date.now() + timeoutMs;
      while (active > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    },
    get active() { return active; },
  };
}
