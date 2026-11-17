// Latency histogram stored inside hourly rollups so percentiles can be estimated without keeping every duration.
// The estimate is the UPPER bound of the bucket holding the percentile (a conservative over-estimate, never optimistic).
export const EDGES_MS = [50, 100, 200, 400, 800, 1500, 3000, 6000, 12000, 30000, 60000];   // bucket i holds (EDGES[i-1], EDGES[i]]; the last bucket is "above 60 s"
export const BUCKETS = EDGES_MS.length + 1;

export function bucketIndex(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  const i = EDGES_MS.findIndex((e) => ms <= e);
  return i === -1 ? EDGES_MS.length : i;
}
export const bucketKey = (i) => `b${i}`;

export function mergeBuckets(list) {
  const out = {};
  for (const b of list) for (const [k, v] of Object.entries(b ?? {})) out[k] = (out[k] ?? 0) + v;
  return out;
}

// Returns { valueMs, exact:false, overflow } or null when the histogram is empty.
export function percentileFromBuckets(buckets, p) {
  const counts = Array.from({ length: BUCKETS }, (_, i) => buckets?.[bucketKey(i)] ?? 0);
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const rank = Math.ceil(p * total);
  let seen = 0;
  for (let i = 0; i < BUCKETS; i++) {
    seen += counts[i];
    if (seen >= rank) return i === EDGES_MS.length ? { valueMs: EDGES_MS.at(-1), overflow: true } : { valueMs: EDGES_MS[i], overflow: false };
  }
  return null;
}

// Exact nearest-rank percentile over raw durations (used for short alert windows).
export function percentileExact(values, p) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.max(0, Math.ceil(p * v.length) - 1)];
}
