// MongoDB implementation of the repository interface the services depend on.
// Every tenant-owned method takes organizationId first and puts it in the filter (plus the model plugin enforces it).
import mongoose from 'mongoose';
import { models } from '../models/index.js';
import { AppError } from '../middleware/errors.js';
import { isId } from '../lib/ids.js';
import * as P from '../modules/analytics/pipelines.js';

const { Types } = mongoose;
const oid = (id) => (isId(id) ? new Types.ObjectId(id) : null);
const isDup = (e) => e?.code === 11000;

export function normalize(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(normalize);
  if (v instanceof Date) return v;
  if (v?._bsontype === 'ObjectId' || v?._bsontype === 'ObjectID') return v.toString();
  if (typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) { if (k !== '__v') o[k === '_id' ? 'id' : k] = normalize(val); }
    return o;
  }
  return v;
}
const lean = async (q) => normalize(await q.lean());
const withOrg = (orgId) => ({ organizationId: oid(orgId) });

export function createMongoRepos() {
  const { User, Organization, Agent, AgentVersion, ApiKey, AgentTrace, AuditLog, TestSuite, TestCase, EvaluatorConfig, EvaluationRun, EvaluationResult, Job, TraceRollup, UsageDaily, ProductionEvaluation, AlertRule, Alert, Session, OneTimeToken, LoginThrottle } = models;

  return {
    users: {
      findByEmail: (email) => lean(User.findOne({ email })),
      findById: (id) => (isId(id) ? lean(User.findById(id)) : null),
      async create(doc) {
        try { return normalize((await User.create(doc)).toObject()); }
        catch (e) { if (isDup(e)) throw new AppError(409, 'EMAIL_IN_USE', 'An account with this email already exists'); throw e; }
      },
      count: () => User.estimatedDocumentCount(),
      update: (id, patch) => lean(User.findByIdAndUpdate(oid(id), { $set: patch }, { new: true })),
      findByIds: async (ids) => (await User.find({ _id: { $in: ids.filter(isId).map(oid) } }).select('email name disabled').lean()).map(normalize),
    },

    orgs: {
      async create(doc) {
        const members = doc.members.map((m) => ({ ...m, userId: oid(m.userId) }));
        return normalize((await Organization.create({ ...doc, members })).toObject());
      },
      get: (id) => (isId(id) ? lean(Organization.findById(oid(id))) : null),
      update: (id, patch) => lean(Organization.findByIdAndUpdate(oid(id), { $set: patch }, { new: true })),
      // Atomic: adds the member only if the user is not already one.
      async addMember(orgId, userId, role) { return (await Organization.updateOne({ _id: oid(orgId), 'members.userId': { $ne: oid(userId) } }, { $push: { members: { userId: oid(userId), role } } })).modifiedCount === 1; },
      async setMemberRole(orgId, userId, role) { return (await Organization.updateOne({ _id: oid(orgId), 'members.userId': oid(userId) }, { $set: { 'members.$.role': role } })).modifiedCount === 1; },
      async removeMember(orgId, userId) { return (await Organization.updateOne({ _id: oid(orgId) }, { $pull: { members: { userId: oid(userId) } } })).modifiedCount === 1; },
      listForUser: async (userId) => (isId(userId) ? (await Organization.find({ 'members.userId': oid(userId) }).lean()).map(normalize) : []),
    },

    agents: {
      async create(orgId, doc) {
        try { return normalize((await Agent.create({ ...doc, createdBy: oid(doc.createdBy) ?? undefined, ...withOrg(orgId) })).toObject()); }
        catch (e) { if (isDup(e)) throw new AppError(409, 'AGENT_NAME_EXISTS', 'An agent with this name already exists'); throw e; }
      },
      async list(orgId, { limit, cursorId, name, framework, onlyId }) {
        const filter = { ...withOrg(orgId), isArchived: false };
        if (name) filter.name = name;
        if (framework) filter.framework = framework;
        if (onlyId) filter._id = oid(onlyId);
        else if (cursorId) filter._id = { $lt: oid(cursorId) };
        const rows = (await Agent.find(filter).sort({ _id: -1 }).limit(limit + 1).lean()).map(normalize);
        return { items: rows.slice(0, limit), hasMore: rows.length > limit };
      },
      get: (orgId, id) => (isId(id) ? lean(Agent.findOne({ ...withOrg(orgId), _id: oid(id), isArchived: false })) : null),
      count: (orgId) => Agent.countDocuments({ ...withOrg(orgId), isArchived: false }),
      async update(orgId, id, patch) {
        try { return await lean(Agent.findOneAndUpdate({ ...withOrg(orgId), _id: oid(id), isArchived: false }, { $set: patch }, { new: true, runValidators: true })); }
        catch (e) { if (isDup(e)) throw new AppError(409, 'AGENT_NAME_EXISTS', 'An agent with this name already exists'); throw e; }
      },
      archive: (orgId, id) => lean(Agent.findOneAndUpdate({ ...withOrg(orgId), _id: oid(id), isArchived: false }, { $set: { isArchived: true, status: 'archived', archivedAt: new Date() } }, { new: true })),
      async markConnected(orgId, id, at) { // throttled: at most one write per agent per minute
        await Agent.updateOne({ ...withOrg(orgId), _id: oid(id), isArchived: false, $or: [{ lastTraceAt: null }, { lastTraceAt: { $lt: new Date(at.getTime() - 60_000) } }] }, { $set: { status: 'connected', lastTraceAt: at } });
      },
    },

    versions: {
      async create(orgId, doc) {
        try { return normalize((await AgentVersion.create({ ...doc, agentId: oid(doc.agentId), ...withOrg(orgId) })).toObject()); }
        catch (e) { if (isDup(e)) throw new AppError(409, 'VERSION_EXISTS', 'This version already exists for the agent'); throw e; }
      },
      async ensure(orgId, agentId, version, source) {
        await AgentVersion.updateOne({ ...withOrg(orgId), agentId: oid(agentId), version }, { $setOnInsert: { source } }, { upsert: true });
      },
      list: async (orgId, agentId) => (await AgentVersion.find({ ...withOrg(orgId), agentId: oid(agentId) }).sort({ _id: -1 }).lean()).map(normalize),
    },

    apiKeys: {
      async create(orgId, doc) { return normalize((await ApiKey.create({ ...doc, agentId: oid(doc.agentId) ?? undefined, createdBy: oid(doc.createdBy) ?? undefined, ...withOrg(orgId) })).toObject()); },
      list: async (orgId) => (await ApiKey.find(withOrg(orgId)).select('-keyHash').sort({ _id: -1 }).lean()).map(normalize),
      findByHash: (keyHash) => lean(ApiKey.findOne({ keyHash }).setOptions({ skipTenantCheck: true })), // discovers the tenant
      revoke: (orgId, id, at) => lean(ApiKey.findOneAndUpdate({ ...withOrg(orgId), _id: oid(id), revokedAt: null }, { $set: { revokedAt: at } }, { new: true })),
      async touch(id, at) { await ApiKey.updateOne({ _id: oid(id) }, { $set: { lastUsedAt: at } }).setOptions({ skipTenantCheck: true }); },
      async revokeForAgent(orgId, agentId, at) { await ApiKey.updateMany({ ...withOrg(orgId), agentId: oid(agentId), revokedAt: null }, { $set: { revokedAt: at } }); },
    },

    traces: {
      async deleteDemo(orgId) { return (await AgentTrace.deleteMany({ ...withOrg(orgId), isDemo: true })).deletedCount; },
      async insertIfAbsent(orgId, doc) {
        try { await AgentTrace.create({ ...doc, ...withOrg(orgId) }); return { inserted: true }; }
        catch (e) { if (isDup(e)) return { inserted: false }; throw e; }
      },
      get: (orgId, traceId) => lean(AgentTrace.findOne({ ...withOrg(orgId), traceId })),
      async listFiltered(orgId, f) { // trace explorer: any combination of filters across agents
        const filter = P.traceMatch(oid(orgId), f);
        if (f.cursor) { const t = new Date(f.cursor.t); filter.$and = [{ $or: [{ startedAt: { $lt: t } }, { startedAt: t, _id: { $lt: oid(f.cursor.id) } }] }]; }
        const rows = (await AgentTrace.find(filter).select('-spans -metadata -input -output -error').sort({ startedAt: -1, _id: -1 }).limit(f.limit + 1).lean()).map(normalize);
        return { items: rows.slice(0, f.limit), hasMore: rows.length > f.limit };
      },
      // Newest-first durations for exact short-window percentiles (capped; the caller learns whether the cap was hit).
      async durations(orgId, f, limit) {
        const rows = await AgentTrace.find(P.traceMatch(oid(orgId), f)).select('durationMs').sort({ startedAt: -1 }).limit(limit).lean();
        return rows.map((r) => r.durationMs).filter((d) => typeof d === 'number');
      },
      buckets: async (orgId, f, binMinutes) => (await AgentTrace.aggregate(P.traceBucketsPipeline(oid(orgId), f, binMinutes))).map((r) => ({ at: r._id, count: r.count, errors: r.errors, avgLatencyMs: r.avgLatencyMs, tokens: r.tokens ?? 0, costUsd: r.costUsd ?? 0 })),
      stats: async (orgId, f) => normalize((await AgentTrace.aggregate(P.traceStatsPipeline(oid(orgId), f)))[0] ?? { count: 0, errors: 0, failed: 0, avgLatencyMs: null, totalTokens: 0, costUsd: 0, costN: 0 }),
      daily: async (orgId, f) => (await AgentTrace.aggregate(P.traceDailyPipeline(oid(orgId), f))).map((r) => ({ date: r._id, count: r.count, errors: r.errors, avgLatencyMs: r.avgLatencyMs })),
      byVersion: async (orgId, f) => (await AgentTrace.aggregate(P.traceByVersionPipeline(oid(orgId), f))).map((r) => ({ version: r._id, count: r.count, errors: r.errors, avgLatencyMs: r.avgLatencyMs, totalTokens: r.totalTokens })),
      async list(orgId, agentId, { status, from, to, limit, cursor }) {
        const and = [{ ...withOrg(orgId), agentId }];
        if (status) and.push({ status });
        if (from || to) and.push({ startedAt: { ...(from && { $gte: from }), ...(to && { $lte: to }) } });
        if (cursor) { const t = new Date(cursor.t); and.push({ $or: [{ startedAt: { $lt: t } }, { startedAt: t, _id: { $lt: oid(cursor.id) } }] }); }
        const filter = { organizationId: oid(orgId), $and: and };
        const rows = (await AgentTrace.find(filter).select('-spans -metadata -input -output -error').sort({ startedAt: -1, _id: -1 }).limit(limit + 1).lean()).map(normalize);
        return { items: rows.slice(0, limit), hasMore: rows.length > limit };
      },
    },

    suites: {
      async create(orgId, doc) {
        try { return normalize((await TestSuite.create({ ...doc, createdBy: oid(doc.createdBy) ?? undefined, ...withOrg(orgId) })).toObject()); }
        catch (e) { if (isDup(e)) throw new AppError(409, 'SUITE_NAME_EXISTS', 'A test suite with this name already exists'); throw e; }
      },
      async list(orgId, { limit, cursorId }) {
        const filter = { ...withOrg(orgId), ...(cursorId && { _id: { $lt: oid(cursorId) } }) };
        const rows = (await TestSuite.find(filter).sort({ _id: -1 }).limit(limit + 1).lean()).map(normalize);
        return { items: rows.slice(0, limit), hasMore: rows.length > limit };
      },
      get: (orgId, id) => (isId(id) ? lean(TestSuite.findOne({ ...withOrg(orgId), _id: oid(id) })) : null),
      async incCases(orgId, id, n) { await TestSuite.updateOne({ ...withOrg(orgId), _id: oid(id) }, { $inc: { caseCount: n } }); },
    },

    cases: {
      async insertMany(orgId, suiteId, docs, { startPosition = 0, createdBy } = {}) {
        const rows = docs.map((d, i) => ({ ...d, suiteId: oid(suiteId), position: startPosition + i, createdBy: oid(createdBy) ?? undefined, ...withOrg(orgId) }));
        return (await TestCase.insertMany(rows)).map((d) => normalize(d.toObject()));
      },
      async list(orgId, suiteId, { limit, cursorId }) {
        const filter = { ...withOrg(orgId), suiteId: oid(suiteId), isDeleted: false, ...(cursorId && { _id: { $gt: oid(cursorId) } }) };
        const rows = (await TestCase.find(filter).sort({ _id: 1 }).limit(limit + 1).lean()).map(normalize);
        return { items: rows.slice(0, limit), hasMore: rows.length > limit };
      },
      get: (orgId, id) => (isId(id) ? lean(TestCase.findOne({ ...withOrg(orgId), _id: oid(id) })) : null), // includes soft-deleted: runs stay reproducible
      getMany: async (orgId, ids) => (await TestCase.find({ ...withOrg(orgId), _id: { $in: ids.filter(isId).map(oid) } }).lean()).map(normalize),
      async softDelete(orgId, suiteId, id) {
        const r = await TestCase.updateOne({ ...withOrg(orgId), suiteId: oid(suiteId), _id: oid(id), isDeleted: false }, { $set: { isDeleted: true } });
        return r.modifiedCount === 1;
      },
      async summary(orgId, suiteId, max) {
        const base = { ...withOrg(orgId), suiteId: oid(suiteId), isDeleted: false };
        const ids = (await TestCase.find(base).select('_id').sort({ position: 1, _id: 1 }).limit(max + 1).lean()).map((d) => String(d._id));
        const has = async (f) => {
          const nonEmpty = f === 'referenceAnswer'
            ? { $exists: true, $nin: [null, ''] }   // String field: can't compare to []
            : { $exists: true, $ne: [] };           // Mixed fields: unchanged
          return (await TestCase.countDocuments({ ...base, [f]: nonEmpty })) > 0;
        };
        const [reference, evidence, required, tools, constraints] = await Promise.all(['referenceAnswer', 'referenceEvidence', 'requiredElements', 'expectedToolCalls', 'constraints'].map(has));
        return { ids, flags: { reference, evidence, required, tools, constraints } };
      },
    },

    evaluatorConfigs: {
      get: (orgId) => lean(EvaluatorConfig.findOne(withOrg(orgId))),
      upsert: (orgId, doc) => lean(EvaluatorConfig.findOneAndUpdate(withOrg(orgId), { $set: { ...doc, updatedBy: oid(doc.updatedBy) ?? undefined } }, { upsert: true, new: true, setDefaultsOnInsert: true })),
    },

    runs: {
      async create(orgId, doc) { return normalize((await EvaluationRun.create({ ...doc, agentId: oid(doc.agentId), suiteId: oid(doc.suiteId), createdBy: oid(doc.createdBy) ?? undefined, ...withOrg(orgId) })).toObject()); },
      get: (orgId, id) => (isId(id) ? lean(EvaluationRun.findOne({ ...withOrg(orgId), _id: oid(id) })) : null),
      count: (orgId, { agentId, from, to } = {}) => EvaluationRun.countDocuments({ ...withOrg(orgId), ...(agentId && { agentId: oid(agentId) }), ...((from || to) && { createdAt: { ...(from && { $gte: from }), ...(to && { $lte: to }) } }) }),
      async list(orgId, { agentId, limit, cursorId }) {
        const filter = { ...withOrg(orgId), ...(agentId && { agentId: oid(agentId) }), ...(cursorId && { _id: { $lt: oid(cursorId) } }) };
        const rows = (await EvaluationRun.find(filter).select('-caseIds').sort({ _id: -1 }).limit(limit + 1).lean()).map(normalize);
        return { items: rows.slice(0, limit), hasMore: rows.length > limit };
      },
      update: (orgId, id, patch, { ifStatusIn } = {}) => lean(EvaluationRun.findOneAndUpdate({ ...withOrg(orgId), _id: oid(id), ...(ifStatusIn && { status: { $in: ifStatusIn } }) }, { $set: patch }, { new: true })),
      incProgress(orgId, id, inc, judgeCalls = 0) {
        const $inc = Object.fromEntries(Object.entries(inc).map(([k, v]) => [`progress.${k}`, v]));
        if (judgeCalls) $inc['counters.judgeCalls'] = judgeCalls;
        return lean(EvaluationRun.findOneAndUpdate({ ...withOrg(orgId), _id: oid(id) }, { $inc }, { new: true }));
      },
      // Atomically reserve judge calls against the run budget (halving the ask if the full amount no longer fits). Returns the granted amount.
      async reserveJudgeCalls(orgId, id, wanted, max) {
        for (const want of [...new Set([wanted, Math.ceil(wanted / 2), 1])].filter((n) => n > 0)) {
          const hit = await EvaluationRun.findOneAndUpdate({ ...withOrg(orgId), _id: oid(id), 'counters.judgeCalls': { $lte: max - want } }, { $inc: { 'counters.judgeCalls': want } }, { new: true }).lean();
          if (hit) return want;
        }
        return 0;
      },
      async listExpiredAwaiting(now) { // system-level sweep across tenants
        return (await EvaluationRun.find({ mode: 'sdk', status: { $in: ['awaiting_traces', 'running'] }, awaitDeadline: { $lte: now } }).setOptions({ skipTenantCheck: true }).lean()).map(normalize);
      },
    },

    results: {
      async insertIfAbsent(orgId, doc) {
        try { await EvaluationResult.create({ ...doc, runId: oid(doc.runId), ...withOrg(orgId) }); return { created: true }; }
        catch (e) { if (isDup(e)) return { created: false }; throw e; }
      },
      get: (orgId, runId, testCaseId) => lean(EvaluationResult.findOne({ ...withOrg(orgId), runId: oid(runId), testCaseId })),
      async list(orgId, runId, { status, limit, cursorId }) {
        const filter = { ...withOrg(orgId), runId: oid(runId), ...(status && { status }), ...(cursorId && { _id: { $gt: oid(cursorId) } }) };
        const rows = (await EvaluationResult.find(filter).sort({ _id: 1 }).limit(limit + 1).lean()).map(normalize);
        return { items: rows.slice(0, limit), hasMore: rows.length > limit };
      },
      listAll: async (orgId, runId) => (await EvaluationResult.find({ ...withOrg(orgId), runId: oid(runId) }).sort({ _id: 1 }).limit(5000).lean()).map(normalize),
      byTraceId: async (orgId, traceId) => (await EvaluationResult.find({ ...withOrg(orgId), traceId }).sort({ _id: -1 }).limit(20).lean()).map(normalize),
      metricStats: async (orgId, f) => (await EvaluationResult.aggregate(P.metricStatsPipeline(oid(orgId), { ...f, runId: f.runId ? oid(f.runId) : undefined }))).map((r) => ({ metric: r._id, n: r.n, pass: r.pass, fail: r.fail, inconclusive: r.inconclusive, avgScore: r.avgScore, contradicted: r.contradicted, unsupported: r.unsupported, supported: r.supported })),
      async caseStats(orgId, f) { const out = { total: 0, passed: 0, failed: 0, inconclusive: 0, error: 0 }; for (const r of await EvaluationResult.aggregate(P.caseStatsPipeline(oid(orgId), f))) { out[r._id] = r.n; out.total += r.n; } return out; },
      runTrend: async (orgId, f) => (await EvaluationResult.aggregate(P.runTrendPipeline(oid(orgId), f))).map((r) => ({ runId: String(r._id.runId), metric: r._id.metric, avgScore: r.avgScore, at: r.at })),
      versionQuality: async (orgId, f) => (await EvaluationResult.aggregate(P.versionQualityPipeline(oid(orgId), f))).map((r) => ({ version: r._id.version, metric: r._id.metric, avgScore: r.avgScore, n: r.n })),
      async failedCases(orgId, f, limit) {
        const filter = { ...P.resultMatch(oid(orgId), f), status: { $in: ['failed', 'error'] } };
        return (await EvaluationResult.find(filter).select('runId testCaseId inputPreview status error evaluatedAt traceId metrics.metric metrics.status').sort({ evaluatedAt: -1 }).limit(limit).lean())
          .map(normalize).map((r) => ({ runId: r.runId, testCaseId: r.testCaseId, traceId: r.traceId, inputPreview: r.inputPreview, status: r.status, error: r.error, evaluatedAt: r.evaluatedAt, failedMetrics: (r.metrics ?? []).filter((m) => m.status === 'fail').map((m) => m.metric) }));
      },
    },

    jobs: {
      async enqueue(orgId, job) {
        try { return { created: true, job: normalize((await Job.create({ ...job, ...withOrg(orgId) })).toObject()) }; }
        catch (e) { if (isDup(e)) return { created: false }; throw e; }
      },
      // Atomic claim: a queued job that is due, or a running job whose lease expired (crashed worker). System-level, so tenant check is skipped explicitly.
      async claim({ workerId, now, leaseMs }) {
        return lean(Job.findOneAndUpdate(
          { $or: [{ status: 'queued', runAt: { $lte: now } }, { status: 'running', lockedUntil: { $lt: now } }] },
          { $set: { status: 'running', lockedBy: workerId, lockedUntil: new Date(now.getTime() + leaseMs) }, $inc: { attempts: 1 } },
          { sort: { runAt: 1 }, new: true },
        ).setOptions({ skipTenantCheck: true }));
      },
      async complete(id) { await Job.updateOne({ _id: oid(id) }, { $set: { status: 'succeeded', lockedUntil: null } }).setOptions({ skipTenantCheck: true }); },
      async fail(id, { error, now, backoffMs, retry }) {
        const j = await Job.findOne({ _id: oid(id) }).setOptions({ skipTenantCheck: true }).lean();
        if (!j) return { state: 'missing' };
        const again = retry && j.attempts < j.maxAttempts;
        await Job.updateOne({ _id: oid(id) }, { $set: again ? { status: 'queued', runAt: new Date(now.getTime() + backoffMs * 2 ** (j.attempts - 1)), lockedUntil: null, lastError: String(error).slice(0, 500) } : { status: 'failed', lockedUntil: null, lastError: String(error).slice(0, 500) } }).setOptions({ skipTenantCheck: true });
        return { state: again ? 'queued' : 'failed' };
      },
      async cancelForRun(orgId, runId) { return (await Job.updateMany({ ...withOrg(orgId), runId, status: { $in: ['queued', 'running'] } }, { $set: { status: 'cancelled' } })).modifiedCount; },
      caseIdsForRun: async (orgId, runId) => (await Job.find({ ...withOrg(orgId), runId, status: { $ne: 'cancelled' } }).select('testCaseId').lean()).map((j) => j.testCaseId),
    },


    // ---- Milestone 5 ----
    rollups: {
      async deleteDemo(orgId) { return (await TraceRollup.deleteMany({ ...withOrg(orgId), isDemo: true })).deletedCount; },
      // Atomic upsert + $inc: concurrent ingests of the same hour never lose updates. A racing first insert (duplicate key) is retried once.
      async record(orgId, r) {
        const key = { ...withOrg(orgId), agentId: r.agentId, agentVersion: r.agentVersion ?? '', environment: r.environment, isDemo: Boolean(r.isDemo), hour: r.hour };
        const $inc = { count: 1, errors: r.status === 'error' ? 1 : 0, failed: r.status !== 'success' ? 1 : 0, tokens: r.tokens ?? 0 };
        if (typeof r.durationMs === 'number') { $inc.sumDurationMs = r.durationMs; $inc.durationN = 1; if (r.bucket !== null && r.bucket !== undefined) $inc[`lat.${r.bucket}`] = 1; }
        if (typeof r.costUsd === 'number') { $inc.costUsd = r.costUsd; $inc.costN = 1; }
        const update = { $inc, $max: { maxDurationMs: r.durationMs ?? 0 }, $setOnInsert: { expiresAt: r.expiresAt } };
        try { await TraceRollup.updateOne(key, update, { upsert: true }); } catch (e) { if (!isDup(e)) throw e; await TraceRollup.updateOne(key, update, { upsert: true }); }
      },
      range: async (orgId, f) => (await TraceRollup.find(P.rollupMatch(oid(orgId), f)).sort({ hour: 1 }).limit(24 * 400).lean()).map(normalize),
    },

    usage: {
      // Reserve `wanted` units of a daily counter against `max` (null = unlimited). Conditional atomic $inc: concurrent workers cannot overspend.
      // If the full amount no longer fits it is halved, then 1. Returns the granted amount (0 = budget exhausted).
      async reserve(orgId, agentId, day, field, wanted, max, { expiresAt } = {}) {
        const key = { ...withOrg(orgId), agentId, day };
        const ensure = async () => { try { await UsageDaily.updateOne(key, { $setOnInsert: { expiresAt } }, { upsert: true }); } catch (e) { if (!isDup(e)) throw e; } };
        if (max === null || max === undefined) { await ensure(); await UsageDaily.updateOne(key, { $inc: { [field]: wanted } }); return wanted; }
        await ensure();
        for (const want of [...new Set([wanted, Math.ceil(wanted / 2), 1])].filter((n) => n > 0)) {
          const hit = await UsageDaily.findOneAndUpdate({ ...key, [field]: { $lte: max - want } }, { $inc: { [field]: want } }, { new: true }).lean();
          if (hit) return want;
        }
        return 0;
      },
      async add(orgId, agentId, day, inc, { expiresAt } = {}) {
        const key = { ...withOrg(orgId), agentId, day };
        try { await UsageDaily.updateOne(key, { $inc: inc, $setOnInsert: { expiresAt } }, { upsert: true }); } catch (e) { if (!isDup(e)) throw e; await UsageDaily.updateOne(key, { $inc: inc }); }
      },
      get: async (orgId, agentId, day) => lean(UsageDaily.findOne({ ...withOrg(orgId), agentId, day })),
    },

    prodEvals: {
      async insertIfAbsent(orgId, doc) {
        try { await ProductionEvaluation.create({ ...doc, ...withOrg(orgId) }); return { created: true }; }
        catch (e) { if (isDup(e)) return { created: false }; throw e; }
      },
      byTraceId: (orgId, traceId) => lean(ProductionEvaluation.findOne({ ...withOrg(orgId), traceId })),
      async recent(orgId, { agentId, limit }) {
        const filter = { ...withOrg(orgId), ...(agentId && { agentId }) };
        return (await ProductionEvaluation.find(filter).select('agentId agentVersion traceId status reason evaluatedAt inputPreview metrics.metric metrics.status metrics.score').sort({ evaluatedAt: -1 }).limit(limit).lean()).map(normalize);
      },
      metricStats: async (orgId, f) => (await ProductionEvaluation.aggregate(P.metricStatsPipeline(oid(orgId), f))).map((r) => ({ metric: r._id, n: r.n, pass: r.pass, fail: r.fail, inconclusive: r.inconclusive, avgScore: r.avgScore })),
      async statusCounts(orgId, f) { const out = { total: 0, passed: 0, failed: 0, inconclusive: 0 }; for (const r of await ProductionEvaluation.aggregate(P.prodStatusPipeline(oid(orgId), f))) { out[r._id] = r.n; out.total += r.n; } return out; },
    },

    alertRules: {
      async create(orgId, doc) { return normalize((await AlertRule.create({ ...doc, createdBy: oid(doc.createdBy) ?? undefined, ...withOrg(orgId) })).toObject()); },
      get: (orgId, id) => (isId(id) ? lean(AlertRule.findOne({ ...withOrg(orgId), _id: oid(id) })) : null),
      count: (orgId) => AlertRule.countDocuments(withOrg(orgId)),
      async list(orgId, { limit, cursorId, agentId }) {
        const filter = { ...withOrg(orgId), ...(agentId && { agentId }), ...(cursorId && { _id: { $lt: oid(cursorId) } }) };
        const rows = (await AlertRule.find(filter).sort({ _id: -1 }).limit(limit + 1).lean()).map(normalize);
        return { items: rows.slice(0, limit), hasMore: rows.length > limit };
      },
      update: (orgId, id, patch) => lean(AlertRule.findOneAndUpdate({ ...withOrg(orgId), _id: oid(id) }, { $set: patch }, { new: true })),
      async remove(orgId, id) { return (await AlertRule.deleteOne({ ...withOrg(orgId), _id: oid(id) })).deletedCount === 1; },
      // System-level scheduler claim (all tenants): atomically lease one due rule so exactly one worker evaluates it per interval.
      claimDue: ({ now, leaseMs }) => lean(AlertRule.findOneAndUpdate({ enabled: true, nextEvalAt: { $lte: now } }, { $set: { nextEvalAt: new Date(now.getTime() + leaseMs) } }, { sort: { nextEvalAt: 1 }, new: true }).setOptions({ skipTenantCheck: true })),
    },

    alerts: {
      findOpenForRule: (orgId, ruleId) => lean(Alert.findOne({ ...withOrg(orgId), ruleId, status: { $in: ['open', 'acknowledged'] } })),
      async create(orgId, doc) { // the partial unique index makes a second open alert for the same rule impossible
        try { return { created: true, alert: normalize((await Alert.create({ ...doc, ...withOrg(orgId) })).toObject()) }; }
        catch (e) { if (isDup(e)) return { created: false }; throw e; }
      },
      get: (orgId, id) => (isId(id) ? lean(Alert.findOne({ ...withOrg(orgId), _id: oid(id) })) : null),
      update: (orgId, id, patch, { ifStatusIn } = {}) => lean(Alert.findOneAndUpdate({ ...withOrg(orgId), _id: oid(id), ...(ifStatusIn && { status: { $in: ifStatusIn } }) }, { $set: patch }, { new: true })),
      async incEvaluations(orgId, id, patch) { return lean(Alert.findOneAndUpdate({ ...withOrg(orgId), _id: oid(id), status: { $in: ['open', 'acknowledged'] } }, { $set: patch, $inc: { evaluations: 1 } }, { new: true })); },
      async pushNotification(orgId, id, entry) { await Alert.updateOne({ ...withOrg(orgId), _id: oid(id) }, { $push: { notifications: { $each: [entry], $slice: -20 } } }); },
      async list(orgId, { status, agentId, ruleId, limit, cursorId }) {
        const filter = { ...withOrg(orgId), ...(status && { status: Array.isArray(status) ? { $in: status } : status }), ...(agentId && { agentId }), ...(ruleId && { ruleId }), ...(cursorId && { _id: { $lt: oid(cursorId) } }) };
        const rows = (await Alert.find(filter).sort({ _id: -1 }).limit(limit + 1).lean()).map(normalize);
        return { items: rows.slice(0, limit), hasMore: rows.length > limit };
      },
      async openCounts(orgId) { return (await Alert.aggregate(P.alertOpenCountsPipeline(oid(orgId)))).map((r) => ({ agentId: r._id.agentId ?? null, severity: r._id.severity, n: r.n })); },
    },


    // ---- Milestone 6 ----
    sessions: {
      async create(doc) { return normalize((await Session.create({ ...doc, userId: oid(doc.userId) })).toObject()); },
      get: (id) => (isId(id) ? lean(Session.findById(oid(id))) : null),
      findByRefreshHash: (h) => lean(Session.findOne({ $or: [{ refreshHash: h }, { previousHashes: h }] })),
      // Atomic rotation: only succeeds if the presented (old) hash is still current and the session is live.
      rotate: (id, oldHash, newHash, at, expiresAt) => lean(Session.findOneAndUpdate({ _id: oid(id), refreshHash: oldHash, revokedAt: null }, { $set: { refreshHash: newHash, lastUsedAt: at, expiresAt }, $push: { previousHashes: { $each: [oldHash], $slice: -5 } } }, { new: true })),
      async revoke(id, at) { await Session.updateOne({ _id: oid(id), revokedAt: null }, { $set: { revokedAt: at } }); },
      async revokeAllForUser(userId, at) { await Session.updateMany({ userId: oid(userId), revokedAt: null }, { $set: { revokedAt: at } }); },
    },
    tokens: {
      async create(orgId, doc) { return normalize((await OneTimeToken.create({ ...doc, userId: oid(doc.userId) ?? undefined, createdBy: oid(doc.createdBy) ?? undefined, ...withOrg(orgId) })).toObject()); },
      findByHash: (h) => lean(OneTimeToken.findOne({ tokenHash: h }).setOptions({ skipTenantCheck: true })),   // discovers the tenant from a secret the caller holds
      // Single use, enforced by the database: only the first caller gets the document.
      consume: (h, now) => lean(OneTimeToken.findOneAndUpdate({ tokenHash: h, usedAt: null, revokedAt: null, expiresAt: { $gt: now } }, { $set: { usedAt: now } }, { new: true }).setOptions({ skipTenantCheck: true })),
      async listPending(orgId, purpose, now) { return (await OneTimeToken.find({ ...withOrg(orgId), purpose, usedAt: null, revokedAt: null, expiresAt: { $gt: now } }).select('-tokenHash').sort({ _id: -1 }).limit(200).lean()).map(normalize); },
      revoke: (orgId, id, at) => lean(OneTimeToken.findOneAndUpdate({ ...withOrg(orgId), _id: oid(id), usedAt: null, revokedAt: null }, { $set: { revokedAt: at } }, { new: true })),
    },
    throttle: {
      get: (key) => lean(LoginThrottle.findOne({ key })),
      async fail(key, now, { max, windowMs, lockMs }) {
        await LoginThrottle.deleteOne({ key, expiresAt: { $lte: now } });   // an expired window starts fresh
        const bump = () => LoginThrottle.findOneAndUpdate({ key }, { $inc: { count: 1 }, $setOnInsert: { windowStart: now, expiresAt: new Date(now.getTime() + windowMs) } }, { upsert: true, new: true }).lean();
        let doc; try { doc = await bump(); } catch (e) { if (!isDup(e)) throw e; doc = await bump(); }
        if (doc.count >= max) {
          const lockedUntil = new Date(now.getTime() + lockMs);
          doc = await LoginThrottle.findOneAndUpdate({ key }, { $set: { lockedUntil, expiresAt: new Date(Math.max(lockedUntil.getTime(), doc.expiresAt.getTime())) } }, { new: true }).lean();
        }
        return normalize(doc);
      },
      async clear(key) { await LoginThrottle.deleteOne({ key }); },
    },
    audit: {
      append: (entry) => AuditLog.create({ ...entry, organizationId: oid(entry.organizationId) ?? undefined, actorId: oid(entry.actorId) ?? undefined }),
      async list(orgId, { action, limit, cursorId }) {
        const filter = { ...(action && { action }), organizationId: oid(orgId), ...(cursorId && { _id: { $lt: oid(cursorId) } }) };
        const rows = (await AuditLog.find(filter).sort({ _id: -1 }).limit(limit + 1).lean()).map(normalize);
        return { items: rows.slice(0, limit), hasMore: rows.length > limit };
      },
    },
  };
}
