import { Router } from 'express';

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

export function healthRouter({ config, checks = {} }) {
  const r = Router();

  r.get('/', (_req, res) => {
    res.json({ status: 'ok', service: 'agenteval-api', version: config.version, time: new Date().toISOString() });
  });

  // Readiness: reports each dependency; 503 if any is down.
  r.get('/ready', async (_req, res) => {
    const out = {};
    await Promise.all(Object.entries(checks).map(async ([name, fn]) => {
      try { await withTimeout(fn(), 2000); out[name] = 'up'; } catch { out[name] = 'down'; }
    }));
    const ok = Object.values(out).every((v) => v === 'up');
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', dependencies: out });
  });
  return r;
}
