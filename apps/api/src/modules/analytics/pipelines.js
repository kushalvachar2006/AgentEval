// Pure builders for MongoDB filters / aggregation pipelines. Every pipeline STARTS with a $match that pins organizationId
// (the tenant plugin refuses anything else), so tenant isolation is checkable without a database.
export const escapeRegex = (s) => String(s).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function traceMatch(org, f = {}) {
  const m = { organizationId: org };
  if (f.from || f.to) m.startedAt = { ...(f.from && { $gte: f.from }), ...(f.to && { $lte: f.to }) };
  if (f.agentId) m.agentId = f.agentId;
  if (f.version) m.agentVersion = f.version;
  if (f.environment) m.environment = f.environment;
  if (f.status) m.status = f.status;
  if (f.failedOnly) m.status = { $ne: 'success' };
  if (typeof f.isDemo === 'boolean') m.isDemo = f.isDemo ? true : { $ne: true };
  if (f.minDurationMs) m.durationMs = { $gte: f.minDurationMs };
  if (f.q) { const re = { $regex: escapeRegex(f.q), $options: 'i' }; m.$or = [{ inputPreview: re }, { outputPreview: re }]; } // escaped: user text can never become a pattern
  return m;
}

const isErr = { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] };
export const traceStatsPipeline = (org, f) => [
  { $match: traceMatch(org, f) },
  { $group: { _id: null, count: { $sum: 1 }, errors: { $sum: isErr }, failed: { $sum: { $cond: [{ $ne: ['$status', 'success'] }, 1, 0] } },
    avgLatencyMs: { $avg: '$durationMs' }, totalTokens: { $sum: '$usage.totalTokens' }, costUsd: { $sum: '$usage.estimatedCostUsd' },
    costN: { $sum: { $cond: [{ $isNumber: '$usage.estimatedCostUsd' }, 1, 0] } } } },
];
export const traceDailyPipeline = (org, f) => [
  { $match: traceMatch(org, f) },
  { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: 'UTC' } }, count: { $sum: 1 }, errors: { $sum: isErr }, avgLatencyMs: { $avg: '$durationMs' } } },
  { $sort: { _id: 1 } },
];
export const traceByVersionPipeline = (org, f) => [
  { $match: traceMatch(org, f) },
  { $group: { _id: { $ifNull: ['$agentVersion', 'unversioned'] }, count: { $sum: 1 }, errors: { $sum: isErr }, avgLatencyMs: { $avg: '$durationMs' }, totalTokens: { $sum: '$usage.totalTokens' } } },
  { $sort: { count: -1 } },
];

export function resultMatch(org, f = {}) {
  const m = { organizationId: org };
  if (f.from || f.to) m.evaluatedAt = { ...(f.from && { $gte: f.from }), ...(f.to && { $lte: f.to }) };
  if (f.agentId) m.agentId = f.agentId;
  if (f.version) m.agentVersion = f.version;
  if (f.runId) m.runId = f.runId;
  return m;
}
const metricStage = (f) => [{ $unwind: '$metrics' }, ...(f.metric ? [{ $match: { 'metrics.metric': f.metric } }] : [])];
const statusIs = (s) => ({ $sum: { $cond: [{ $eq: ['$metrics.status', s] }, 1, 0] } });

export const metricStatsPipeline = (org, f) => [
  { $match: resultMatch(org, f) }, ...metricStage(f),
  { $group: { _id: '$metrics.metric', n: { $sum: 1 }, pass: statusIs('pass'), fail: statusIs('fail'), inconclusive: statusIs('inconclusive'), avgScore: { $avg: '$metrics.score' },
    contradicted: { $sum: '$metrics.meta.counts.contradicted' }, unsupported: { $sum: '$metrics.meta.counts.unsupported' }, supported: { $sum: '$metrics.meta.counts.supported' } } },
  { $sort: { _id: 1 } },
];
export const caseStatsPipeline = (org, f) => [{ $match: resultMatch(org, f) }, { $group: { _id: '$status', n: { $sum: 1 } } }];
export const runTrendPipeline = (org, f) => [
  { $match: resultMatch(org, f) }, ...metricStage(f),
  { $group: { _id: { runId: '$runId', metric: '$metrics.metric' }, avgScore: { $avg: '$metrics.score' }, at: { $max: '$evaluatedAt' } } },
  { $sort: { at: -1 } }, { $limit: 2000 },
];
export const versionQualityPipeline = (org, f) => [
  { $match: resultMatch(org, f) }, ...metricStage(f),
  { $group: { _id: { version: { $ifNull: ['$agentVersion', 'unversioned'] }, metric: '$metrics.metric' }, avgScore: { $avg: '$metrics.score' }, n: { $sum: 1 } } },
];

// ---- Milestone 5 ----
// Live-window series: execution counts per N-minute bin ($dateTrunc needs MongoDB 5.0+; the compose file uses 7).
export const traceBucketsPipeline = (org, f, binMinutes) => [
  { $match: traceMatch(org, f) },
  { $group: { _id: { $dateTrunc: { date: '$startedAt', unit: 'minute', binSize: binMinutes } }, count: { $sum: 1 }, errors: { $sum: isErr }, avgLatencyMs: { $avg: '$durationMs' }, tokens: { $sum: '$usage.totalTokens' }, costUsd: { $sum: '$usage.estimatedCostUsd' } } },
  { $sort: { _id: 1 } },
];
// Evaluation status counts of sampled production traces (same tenant-first rule).
export const prodStatusPipeline = (org, f) => [{ $match: resultMatch(org, f) }, { $group: { _id: '$status', n: { $sum: 1 } } }];
// Open alerts per agent and severity (for health status).
export const alertOpenCountsPipeline = (org) => [
  { $match: { organizationId: org, status: { $in: ['open', 'acknowledged'] } } },
  { $group: { _id: { agentId: '$agentId', severity: '$severity' }, n: { $sum: 1 } } },
];
export const rollupMatch = (org, f = {}) => {
  const m = { organizationId: org };
  if (f.from || f.to) m.hour = { ...(f.from && { $gte: f.from }), ...(f.to && { $lt: f.to }) };
  if (f.agentId) m.agentId = f.agentId;
  if (f.version !== undefined) m.agentVersion = f.version;
  if (f.environment) m.environment = f.environment;
  if (typeof f.isDemo === 'boolean') m.isDemo = f.isDemo;
  return m;
};
