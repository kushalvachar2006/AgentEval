#!/usr/bin/env node
// Load test for trace ingestion.
//   Against a real deployment (measures YOUR MongoDB, network and hardware):
//     node scripts/loadtest-ingest.mjs --url http://localhost:4000/api/v1 --api-key ae_live_... --agent-id <id> --seconds 30 --concurrency 20 --batch 10
//   In-process (no MongoDB/Docker needed; measures the API layer only: auth, validation, redaction, rollups, sampling, with in-memory storage):
//     node scripts/loadtest-ingest.mjs --inprocess --seconds 10 --concurrency 20 --batch 10
// Prints traces/second, request latency percentiles and error counts. Nothing is written to disk.
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : a), []));
const seconds = Number(args.seconds ?? 10), concurrency = Number(args.concurrency ?? 10), batch = Number(args.batch ?? 10);
const sample = JSON.parse(readFileSync(new URL('../packages/trace-schema/fixtures/valid-trace.json', import.meta.url), 'utf8'));

let base = args.url, key = args['api-key'], agentId = args['agent-id'], closer = () => {};
if (args.inprocess) {
  const { createApp } = await import('../apps/api/src/app.js');
  const { makeWorld } = await import('../apps/api/test/helpers/world.js');
  const w = makeWorld({ RATE_LIMIT_MAX: '10000000', INGEST_RATE_LIMIT_MAX: '10000000' });
  const A = await w.signup('load');
  const agent = await w.newAgent(A.principal, 'load-agent');
  await w.services.monitoring.putPolicy({ ...A.principal, role: 'owner' }, agent.id, { enabled: true, sampleRate: 0.1, dailyTraceBudget: 1000 });   // exercise the sampling path too
  key = (await w.services.apiKeys.create(A.principal, { name: 'load' })).key; agentId = agent.id;
  const server = createApp({ config: w.config, services: w.services, checks: {} }).listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/v1`; closer = () => server.close();
  console.log('mode: in-process, in-memory storage (API layer only - NOT a MongoDB benchmark)');
}
if (!base || !key || !agentId) { console.error('Need --url, --api-key and --agent-id (or --inprocess)'); process.exit(2); }

const makeTrace = () => {
  const t = structuredClone(sample);
  const start = new Date(Date.now() - 1000);
  Object.assign(t, { agentId, traceId: crypto.randomBytes(16).toString('hex'), environment: 'production', metadata: {}, startedAt: start.toISOString(), endedAt: new Date().toISOString(), durationMs: 1000 });
  return t;
};
const lat = [], codes = {};
let traces = 0, stop = false;
const worker = async () => {
  while (!stop) {
    const body = JSON.stringify({ traces: Array.from({ length: batch }, makeTrace) });
    const t0 = performance.now();
    try {
      const r = await fetch(`${base}/traces/batch`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body });
      const j = await r.json().catch(() => ({}));
      lat.push(performance.now() - t0);
      codes[r.status] = (codes[r.status] ?? 0) + 1;
      if (r.ok) traces += j.accepted ?? 0;
    } catch { codes.network = (codes.network ?? 0) + 1; }
  }
};
const t0 = Date.now();
setTimeout(() => { stop = true; }, seconds * 1000);
await Promise.all(Array.from({ length: concurrency }, worker));
const secs = (Date.now() - t0) / 1000;
lat.sort((a, b) => a - b);
const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(1) : 'n/a');
console.log(JSON.stringify({ seconds: Number(secs.toFixed(1)), concurrency, batchSize: batch, requests: lat.length, tracesAccepted: traces, tracesPerSecond: Math.round(traces / secs), requestLatencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99) }, statusCodes: codes }, null, 2));
closer();
