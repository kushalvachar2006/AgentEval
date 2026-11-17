import mongoose from 'mongoose';
import { tenantPlugin } from './tenantPlugin.js';

const { Schema } = mongoose;
const Mixed = Schema.Types.Mixed;
const opts = { timestamps: true, minimize: false };

const User = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
  name: { type: String, required: true, maxlength: 100 },
  passwordHash: { type: String, required: true },
  disabled: { type: Boolean, default: false },
}, opts);

const Organization = new Schema({
  name: { type: String, required: true, maxlength: 100 },
  members: [{ _id: false, userId: { type: Schema.Types.ObjectId, required: true }, role: { type: String, enum: ['viewer', 'member', 'admin', 'owner'], required: true } }],
  settings: { traceRetentionDays: { type: Number, default: 90, min: 1, max: 3650 } },
}, opts);
Organization.index({ 'members.userId': 1 });

const Agent = new Schema({
  name: { type: String, required: true, maxlength: 100 },
  description: { type: String, default: '', maxlength: 1000 },
  framework: { type: String, enum: ['langchain', 'langgraph', 'custom'], required: true },
  integrationType: { type: String, enum: ['sdk', 'api'], default: 'sdk' },
  endpointUrl: String,
  currentVersion: { type: String, required: true },
  status: { type: String, enum: ['pending', 'connected', 'archived'], default: 'pending' },
  isArchived: { type: Boolean, default: false },
  archivedAt: Date,
  config: Mixed,
  monitoring: Mixed,   // production monitoring policy (see modules/monitoring/policy.js)
  endpointTokenEnc: String,
  lastTraceAt: Date,
  createdBy: Schema.Types.ObjectId,
}, opts);
Agent.plugin(tenantPlugin);
Agent.index({ organizationId: 1, name: 1 }, { unique: true, partialFilterExpression: { isArchived: false } });
Agent.index({ organizationId: 1, isArchived: 1, _id: -1 });

const AgentVersion = new Schema({
  agentId: { type: Schema.Types.ObjectId, required: true },
  version: { type: String, required: true, maxlength: 32 },
  notes: { type: String, maxlength: 1000 },
  config: Mixed,
  source: { type: String, enum: ['manual', 'trace'], default: 'manual' },
}, opts);
AgentVersion.plugin(tenantPlugin);
AgentVersion.index({ organizationId: 1, agentId: 1, version: 1 }, { unique: true });

const ApiKey = new Schema({
  name: { type: String, required: true, maxlength: 64 },
  keyHash: { type: String, required: true, unique: true },
  keyPrefix: { type: String, required: true },
  scopes: [String],
  agentId: Schema.Types.ObjectId,
  createdBy: Schema.Types.ObjectId,
  expiresAt: Date,
  revokedAt: Date,
  lastUsedAt: Date,
}, opts);
ApiKey.plugin(tenantPlugin);

const AgentTrace = new Schema({
  agentId: { type: String, required: true },
  traceId: { type: String, required: true },
  schemaVersion: String,
  sessionId: String,
  agentVersion: String,
  environment: { type: String, enum: ['production', 'test', 'evaluation'], default: 'production' },
  framework: Mixed,
  status: { type: String, enum: ['success', 'error', 'cancelled', 'timeout'], required: true },
  startedAt: { type: Date, required: true },
  endedAt: { type: Date, required: true },
  durationMs: Number,
  input: Mixed, output: Mixed, error: Mixed, usage: Mixed, metadata: Mixed,
  spans: { type: [Mixed], default: [] },
  spanCount: Number, llmCallCount: Number, toolCallCount: Number, hasError: Boolean,
  inputPreview: String, outputPreview: String, isDemo: Boolean,
  sanitization: Mixed,
  ingestedAt: Date,
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } }, // per-document retention (TTL)
}, { minimize: false });
AgentTrace.plugin(tenantPlugin);
AgentTrace.index({ organizationId: 1, traceId: 1 }, { unique: true });
AgentTrace.index({ organizationId: 1, agentId: 1, startedAt: -1, _id: -1 });
AgentTrace.index({ organizationId: 1, agentId: 1, status: 1, startedAt: -1 });
AgentTrace.index({ organizationId: 1, startedAt: -1, _id: -1 });
AgentTrace.index({ organizationId: 1, agentId: 1, agentVersion: 1, startedAt: -1 });

// Audit entries: no secrets or payloads. organizationId is optional (failed logins have no tenant), so no tenant plugin.
const AuditLog = new Schema({
  organizationId: { type: Schema.Types.ObjectId, index: true },
  actorId: Schema.Types.ObjectId,
  action: { type: String, required: true },
  target: String,
  ip: String,
  meta: Mixed,
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 365 * 86_400_000), index: { expireAfterSeconds: 0 } },
}, { minimize: false });


const TestSuite = new Schema({
  name: { type: String, required: true, maxlength: 100 },
  description: { type: String, default: '', maxlength: 1000 },
  tags: [String],
  caseCount: { type: Number, default: 0 },
  createdBy: Schema.Types.ObjectId,
}, opts);
TestSuite.plugin(tenantPlugin);
TestSuite.index({ organizationId: 1, name: 1 }, { unique: true });

const TestCase = new Schema({
  suiteId: { type: Schema.Types.ObjectId, required: true },
  position: { type: Number, default: 0 },
  input: { type: Mixed, required: true },
  referenceAnswer: String, expectedBehavior: String,
  referenceEvidence: Mixed, evaluationCriteria: [String], requiredElements: Mixed, expectedToolCalls: Mixed, constraints: Mixed,
  tags: [String], metadata: Mixed,
  isDeleted: { type: Boolean, default: false },
  createdBy: Schema.Types.ObjectId,
}, opts);
TestCase.plugin(tenantPlugin);
TestCase.index({ organizationId: 1, suiteId: 1, isDeleted: 1, position: 1, _id: 1 });

const EvaluatorConfig = new Schema({
  judge: {
    enabled: { type: Boolean, default: false },
    provider: { type: String, enum: ['openai_compatible', 'anthropic'] },
    model: String, baseUrl: String, apiKeyEnc: String, temperature: Number, maxTokens: Number,
  },
  updatedBy: Schema.Types.ObjectId,
}, opts);
EvaluatorConfig.plugin(tenantPlugin);
EvaluatorConfig.index({ organizationId: 1 }, { unique: true });

const EvaluationRun = new Schema({
  name: { type: String, maxlength: 100 },
  agentId: { type: Schema.Types.ObjectId, required: true },
  suiteId: { type: Schema.Types.ObjectId, required: true },
  mode: { type: String, enum: ['sdk', 'endpoint'], required: true },
  status: { type: String, enum: ['queued', 'awaiting_traces', 'running', 'completed', 'cancelled', 'failed'], required: true },
  evaluators: Mixed, useJudge: Boolean, limits: Mixed,
  caseIds: [String],
  progress: { total: Number, completed: { type: Number, default: 0 }, passed: { type: Number, default: 0 }, failed: { type: Number, default: 0 }, inconclusive: { type: Number, default: 0 }, error: { type: Number, default: 0 } },
  counters: { judgeCalls: { type: Number, default: 0 } },
  summary: Mixed,
  awaitDeadline: Date, startedAt: Date, completedAt: Date, cancelledAt: Date,
  createdBy: Schema.Types.ObjectId,
}, opts);
EvaluationRun.plugin(tenantPlugin);
EvaluationRun.index({ organizationId: 1, _id: -1 });
EvaluationRun.index({ organizationId: 1, agentId: 1, _id: -1 });
EvaluationRun.index({ status: 1, awaitDeadline: 1 });

const EvaluationResult = new Schema({
  runId: { type: Schema.Types.ObjectId, required: true },
  testCaseId: { type: String, required: true },
  agentId: String, agentVersion: String, traceId: String,
  status: { type: String, enum: ['passed', 'failed', 'inconclusive', 'error'], required: true },
  metrics: { type: [Mixed], default: [] },
  error: String, inputPreview: String, outputPreview: String,
  latencyMs: Number, tokens: Number, costUsd: Number, judgeCalls: Number,
  evaluatedAt: Date,
}, opts);
EvaluationResult.plugin(tenantPlugin);
EvaluationResult.index({ organizationId: 1, runId: 1, testCaseId: 1 }, { unique: true });
EvaluationResult.index({ organizationId: 1, runId: 1, status: 1, _id: 1 });
EvaluationResult.index({ organizationId: 1, evaluatedAt: -1 });
EvaluationResult.index({ organizationId: 1, traceId: 1 });

// Mongo-backed job queue (no separate queue service): claim = atomic findOneAndUpdate with a lease.
const Job = new Schema({
  type: { type: String, required: true },
  runId: String, testCaseId: String,
  idempotencyKey: { type: String, required: true },
  payload: Mixed,
  status: { type: String, enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'], default: 'queued' },
  attempts: { type: Number, default: 0 }, maxAttempts: { type: Number, default: 3 },
  runAt: { type: Date, default: Date.now },
  lockedUntil: Date, lockedBy: String, lastError: String,
}, opts);
Job.plugin(tenantPlugin);
Job.index({ organizationId: 1, idempotencyKey: 1 }, { unique: true });
Job.index({ status: 1, runAt: 1 });
Job.index({ status: 1, lockedUntil: 1 });
Job.index({ organizationId: 1, runId: 1 });
Job.index({ updatedAt: 1 }, { expireAfterSeconds: 14 * 86400, partialFilterExpression: { status: { $in: ['succeeded', 'failed', 'cancelled'] } } }); // finished jobs are cleaned up


// ---- Milestone 5: live monitoring & alerts ----
// Hourly pre-computed rollups (per org / agent / version / environment / demo flag): updated atomically at ingest.
const TraceRollup = new Schema({
  agentId: { type: String, required: true }, agentVersion: { type: String, default: '' }, environment: { type: String, required: true }, isDemo: { type: Boolean, default: false },
  hour: { type: Date, required: true },
  count: { type: Number, default: 0 }, errors: { type: Number, default: 0 }, failed: { type: Number, default: 0 },
  sumDurationMs: { type: Number, default: 0 }, maxDurationMs: { type: Number, default: 0 }, durationN: { type: Number, default: 0 },
  tokens: { type: Number, default: 0 }, costUsd: { type: Number, default: 0 }, costN: { type: Number, default: 0 },
  lat: Mixed,   // latency histogram: { b0: n, b1: n, ... } (modules/monitoring/histogram.js)
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
}, { minimize: false });
TraceRollup.plugin(tenantPlugin);
TraceRollup.index({ organizationId: 1, agentId: 1, agentVersion: 1, environment: 1, isDemo: 1, hour: 1 }, { unique: true });
TraceRollup.index({ organizationId: 1, hour: 1 });

// Daily per-agent counters used for budget enforcement (conditional atomic $inc) and for the cost-control panel.
const UsageDaily = new Schema({
  agentId: { type: String, required: true }, day: { type: String, required: true },
  queued: { type: Number, default: 0 }, skippedBudget: { type: Number, default: 0 }, judgeCalls: { type: Number, default: 0 },
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
}, { minimize: false });
UsageDaily.plugin(tenantPlugin);
UsageDaily.index({ organizationId: 1, agentId: 1, day: 1 }, { unique: true });

// Evaluation of a sampled PRODUCTION trace. Kept apart from evaluation_results (which belong to test runs) so dashboards never mix them.
const ProductionEvaluation = new Schema({
  agentId: { type: String, required: true }, agentVersion: String, traceId: { type: String, required: true },
  status: { type: String, enum: ['passed', 'failed', 'inconclusive'], required: true },
  reason: String, metrics: { type: [Mixed], default: [] }, judgeCalls: { type: Number, default: 0 },
  inputPreview: String, outputPreview: String, evaluatedAt: { type: Date, required: true },
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
}, { minimize: false });
ProductionEvaluation.plugin(tenantPlugin);
ProductionEvaluation.index({ organizationId: 1, traceId: 1 }, { unique: true });
ProductionEvaluation.index({ organizationId: 1, agentId: 1, evaluatedAt: -1 });
ProductionEvaluation.index({ organizationId: 1, evaluatedAt: -1 });

const AlertRule = new Schema({
  name: { type: String, required: true, maxlength: 100 },
  type: { type: String, enum: ['error_rate', 'latency', 'quality_drop', 'cost_per_day', 'silence'], required: true },
  agentId: String, severity: { type: String, enum: ['warning', 'critical'], default: 'warning' },
  params: Mixed, enabled: { type: Boolean, default: true },
  cooldownMinutes: Number, resolveAfterOk: Number, evalEveryMinutes: Number,
  notify: Mixed,   // { webhook: { urlEnc, urlHost, secretEnc?, format } } - the URL is treated as a secret (Slack URLs are)
  state: Mixed,    // scheduler/lifecycle state: okStreak, lastResolvedAt, lastEvaluatedAt, lastState, lastObserved, lastExplanation
  nextEvalAt: { type: Date, default: Date.now },
  createdBy: Schema.Types.ObjectId,
}, opts);
AlertRule.plugin(tenantPlugin);
AlertRule.index({ organizationId: 1, _id: -1 });
AlertRule.index({ enabled: 1, nextEvalAt: 1 });

// Fired alert events. One OPEN/ACKNOWLEDGED alert per rule at any time (partial unique index = de-duplication even across workers).
const Alert = new Schema({
  ruleId: { type: String, required: true }, ruleName: String, ruleType: String, severity: String, agentId: String,
  status: { type: String, enum: ['open', 'acknowledged', 'resolved'], default: 'open' },
  openedAt: { type: Date, required: true }, lastEvaluatedAt: Date, resolvedAt: Date, resolvedBy: String,
  acknowledgedAt: Date, acknowledgedBy: String,
  explanation: String, observed: Mixed, threshold: Number, window: Mixed, evaluations: { type: Number, default: 1 },
  notifications: { type: [Mixed], default: [] },
  expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
}, opts);
Alert.plugin(tenantPlugin);
Alert.index({ organizationId: 1, status: 1, openedAt: -1 });
Alert.index({ organizationId: 1, agentId: 1, openedAt: -1 });
Alert.index({ organizationId: 1, ruleId: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['open', 'acknowledged'] } } });


// ---- Milestone 6: sessions (refresh tokens), one-time tokens (invitations / password reset), login throttling ----
const Session = new Schema({
  userId: { type: Schema.Types.ObjectId, required: true, index: true },
  refreshHash: { type: String, required: true, unique: true },   // sha256 of the opaque refresh token; the token itself is never stored
  previousHashes: { type: [String], default: [], index: true },   // the last few rotated-away hashes: presenting one proves the token was copied (reuse detection)
  userAgent: { type: String, maxlength: 120 }, ip: String,
  createdAt: { type: Date, default: Date.now }, lastUsedAt: Date, revokedAt: Date,
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
}, { minimize: false });

const OneTimeToken = new Schema({
  purpose: { type: String, enum: ['invite', 'reset'], required: true },
  tokenHash: { type: String, required: true, unique: true },
  email: String, role: { type: String, enum: ['viewer', 'member', 'admin', 'owner'] },
  userId: Schema.Types.ObjectId, createdBy: Schema.Types.ObjectId,
  usedAt: Date, revokedAt: Date,
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 7 * 86400 } },   // kept a week past expiry for the admin's pending-list, then removed
}, opts);
OneTimeToken.plugin(tenantPlugin);
OneTimeToken.index({ organizationId: 1, purpose: 1, _id: -1 });

const LoginThrottle = new Schema({
  key: { type: String, required: true, unique: true },   // sha256(email): counted for ALL emails, existing or not, so lockouts reveal nothing
  count: { type: Number, default: 0 }, windowStart: Date, lockedUntil: Date,
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
}, { minimize: false });

export const models = {
  User: mongoose.model('User', User, 'users'),
  Organization: mongoose.model('Organization', Organization, 'organizations'),
  Agent: mongoose.model('Agent', Agent, 'agents'),
  AgentVersion: mongoose.model('AgentVersion', AgentVersion, 'agent_versions'),
  ApiKey: mongoose.model('ApiKey', ApiKey, 'api_keys'),
  AgentTrace: mongoose.model('AgentTrace', AgentTrace, 'agent_traces'),
  AuditLog: mongoose.model('AuditLog', AuditLog, 'audit_logs'),
  TestSuite: mongoose.model('TestSuite', TestSuite, 'test_suites'),
  TestCase: mongoose.model('TestCase', TestCase, 'test_cases'),
  EvaluatorConfig: mongoose.model('EvaluatorConfig', EvaluatorConfig, 'evaluator_configs'),
  EvaluationRun: mongoose.model('EvaluationRun', EvaluationRun, 'evaluation_runs'),
  EvaluationResult: mongoose.model('EvaluationResult', EvaluationResult, 'evaluation_results'),
  Job: mongoose.model('Job', Job, 'jobs'),
  TraceRollup: mongoose.model('TraceRollup', TraceRollup, 'trace_rollups'),
  UsageDaily: mongoose.model('UsageDaily', UsageDaily, 'usage_daily'),
  ProductionEvaluation: mongoose.model('ProductionEvaluation', ProductionEvaluation, 'production_evaluations'),
  AlertRule: mongoose.model('AlertRule', AlertRule, 'alert_rules'),
  Alert: mongoose.model('Alert', Alert, 'alerts'),
  Session: mongoose.model('Session', Session, 'sessions'),
  OneTimeToken: mongoose.model('OneTimeToken', OneTimeToken, 'one_time_tokens'),
  LoginThrottle: mongoose.model('LoginThrottle', LoginThrottle, 'login_throttles'),
};
