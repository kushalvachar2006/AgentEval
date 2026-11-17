import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { ah } from '../middleware/http.js';
import { sendError } from '../middleware/errors.js';
import { sha256Hex } from '../lib/crypto.js';
import { requirePermission } from '../lib/rbac.js';
import { CATALOG_LIST } from '../config/catalog.js';

export function buildRouter({ services, auth, config }) {
  const r = Router();
  const limiter = (opts) => rateLimit({ standardHeaders: 'draft-7', legacyHeaders: false, handler: (_q, res) => sendError(res, 429, 'RATE_LIMITED', 'Too many requests, slow down'), ...opts });

  // ---- auth (strict limiter counts only failed attempts) ----
  const authLimiter = limiter({ windowMs: config.authRateLimitWindowMs, limit: config.authRateLimitMax, skipSuccessfulRequests: true });
  r.post('/auth/register', authLimiter, express.json({ limit: '16kb' }), ah(async (req, res) => res.status(201).json(await services.auth.register(req.body, { ip: req.ip }))));
  r.post('/auth/login', authLimiter, express.json({ limit: '16kb' }), ah(async (req, res) => res.json(await services.auth.login(req.body, { ip: req.ip }))));
  r.get('/auth/me', auth, ah(async (req, res) => res.json(await services.auth.me(req.principal))));
  const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });
  r.post('/auth/refresh', authLimiter, express.json({ limit: '4kb' }), ah(async (req, res) => res.json(await services.auth.refresh(req.body, ctx(req)))));
  r.post('/auth/logout', auth, ah(async (req, res) => { await services.auth.logout(req.principal); res.status(204).end(); }));
  r.post('/auth/logout-all', auth, ah(async (req, res) => { await services.auth.logoutAll(req.principal); res.status(204).end(); }));
  r.post('/auth/change-password', authLimiter, auth, express.json({ limit: '4kb' }), ah(async (req, res) => res.json(await services.auth.changePassword(req.principal, req.body, ctx(req)))));
  r.post('/auth/password-reset/complete', authLimiter, express.json({ limit: '4kb' }), ah(async (req, res) => { await services.auth.completeReset(req.body, ctx(req)); res.status(204).end(); }));
  r.post('/auth/invitations/accept', authLimiter, express.json({ limit: '4kb' }), ah(async (req, res) => res.status(201).json(await services.auth.acceptInvitation(req.body, ctx(req)))));
  r.post('/org/invitations/accept', authLimiter, auth, express.json({ limit: '4kb' }), ah(async (req, res) => res.json(await services.auth.acceptInvitationAsUser(req.principal, req.body))));

  // ---- traces: auth first, THEN parse the (larger) body, so anonymous callers cannot make us parse megabytes ----
  const ingestLimiter = limiter({
    windowMs: 60_000, limit: config.ingestRateLimitMax,
    keyGenerator: (req) => sha256Hex(req.get('authorization') || req.get('x-api-key') || req.ip).slice(0, 24),
  });
  const bigJson = express.json({ limit: `${config.ingestBodyLimitKb}kb` });
  r.post('/traces/batch', auth, ingestLimiter, bigJson, ah(async (req, res) => res.json(await services.traces.ingestBatch(req.principal, req.body))));
  r.post('/traces', auth, ingestLimiter, bigJson, ah(async (req, res) => {
    const out = await services.traces.ingestOne(req.principal, req.body);
    res.status(out.status === 'accepted' ? 202 : 200).json(out);
  }));
  r.get('/traces', auth, ah(async (req, res) => res.json(await services.traces.explore(req.principal, req.query))));
  r.get('/traces/:id/debug', auth, ah(async (req, res) => res.json(await services.debug.debug(req.principal, req.params.id))));
  r.get('/traces/:id', auth, ah(async (req, res) => res.json(await services.traces.get(req.principal, req.params.id))));

  // ---- everything below uses the small default body limit ----
  const json = express.json({ limit: `${config.bodyLimitKb}kb` });
  r.get('/agents', auth, ah(async (req, res) => res.json(await services.agents.list(req.principal, req.query))));
  r.post('/agents', auth, json, ah(async (req, res) => res.status(201).json(await services.agents.create(req.principal, req.body))));
  r.get('/agents/:id', auth, ah(async (req, res) => res.json(await services.agents.get(req.principal, req.params.id))));
  r.patch('/agents/:id', auth, json, ah(async (req, res) => res.json(await services.agents.update(req.principal, req.params.id, req.body))));
  r.delete('/agents/:id', auth, ah(async (req, res) => { await services.agents.archive(req.principal, req.params.id); res.status(204).end(); }));
  r.get('/agents/:id/versions', auth, ah(async (req, res) => res.json(await services.agents.listVersions(req.principal, req.params.id))));
  r.post('/agents/:id/versions', auth, json, ah(async (req, res) => res.status(201).json(await services.agents.addVersion(req.principal, req.params.id, req.body))));
  r.get('/agents/:id/traces', auth, ah(async (req, res) => res.json(await services.traces.listForAgent(req.principal, req.params.id, req.query))));

  r.get('/api-keys', auth, ah(async (req, res) => res.json(await services.apiKeys.list(req.principal))));
  r.post('/api-keys', auth, json, ah(async (req, res) => res.status(201).json(await services.apiKeys.create(req.principal, req.body))));
  r.delete('/api-keys/:id', auth, ah(async (req, res) => { await services.apiKeys.revoke(req.principal, req.params.id); res.status(204).end(); }));

  // ---- analytics ----
  r.get('/analytics/overview', auth, ah(async (req, res) => res.json(await services.analytics.overview(req.principal, req.query))));
  r.get('/agents/:id/metrics', auth, ah(async (req, res) => res.json(await services.analytics.agentMetrics(req.principal, req.params.id, req.query))));

  // ---- test suites & cases ----
  const importJson = express.json({ limit: '3mb' }); // importer enforces its own 2 MB content limit
  r.get('/test-suites', auth, ah(async (req, res) => res.json(await services.suites.list(req.principal, req.query))));
  r.post('/test-suites', auth, json, ah(async (req, res) => res.status(201).json(await services.suites.create(req.principal, req.body))));
  r.get('/test-suites/:id', auth, ah(async (req, res) => res.json(await services.suites.get(req.principal, req.params.id, req.query))));
  r.post('/test-suites/:id/cases', auth, json, ah(async (req, res) => res.status(201).json(await services.suites.addCase(req.principal, req.params.id, req.body))));
  r.post('/test-suites/:id/import', auth, importJson, ah(async (req, res) => res.status(201).json(await services.suites.importCases(req.principal, req.params.id, req.body))));
  r.delete('/test-suites/:id/cases/:caseId', auth, ah(async (req, res) => { await services.suites.deleteCase(req.principal, req.params.id, req.params.caseId); res.status(204).end(); }));

  // ---- evaluations ----
  r.get('/evaluators', auth, ah(async (req, res) => { requirePermission(req.principal, 'evaluations:read'); res.json({ evaluators: CATALOG_LIST }); }));
  r.get('/evaluator-config', auth, ah(async (req, res) => res.json(await services.evaluatorConfig.get(req.principal))));
  r.put('/evaluator-config', auth, json, ah(async (req, res) => res.json(await services.evaluatorConfig.put(req.principal, req.body))));
  r.get('/evaluations', auth, ah(async (req, res) => res.json(await services.evaluations.list(req.principal, req.query))));
  r.post('/evaluations', auth, json, ah(async (req, res) => res.status(202).json(await services.evaluations.create(req.principal, req.body))));
  r.get('/evaluations/:id', auth, ah(async (req, res) => res.json(await services.evaluations.get(req.principal, req.params.id))));
  r.get('/evaluations/:id/results', auth, ah(async (req, res) => res.json(await services.evaluations.results(req.principal, req.params.id, req.query))));
  r.get('/evaluations/:id/work', auth, ah(async (req, res) => res.json(await services.evaluations.work(req.principal, req.params.id))));
  r.post('/evaluations/:id/cancel', auth, ah(async (req, res) => res.json(await services.evaluations.cancel(req.principal, req.params.id))));

  // ---- monitoring (live view, policy, rollups) ----
  r.get('/monitoring/overview', auth, ah(async (req, res) => res.json(await services.monitoring.overview(req.principal, req.query))));
  r.get('/monitoring/agents/:id/live', auth, ah(async (req, res) => res.json(await services.monitoring.live(req.principal, req.params.id, req.query))));
  r.get('/monitoring/agents/:id/rollups', auth, ah(async (req, res) => res.json(await services.monitoring.rollups(req.principal, req.params.id, req.query))));
  r.get('/agents/:id/monitoring', auth, ah(async (req, res) => res.json(await services.monitoring.getPolicy(req.principal, req.params.id))));
  r.put('/agents/:id/monitoring', auth, json, ah(async (req, res) => res.json(await services.monitoring.putPolicy(req.principal, req.params.id, req.body))));

  // ---- alerts ----
  r.get('/alert-rules', auth, ah(async (req, res) => res.json(await services.alerts.listRules(req.principal, req.query))));
  r.post('/alert-rules', auth, json, ah(async (req, res) => res.status(201).json(await services.alerts.createRule(req.principal, req.body))));
  r.get('/alert-rules/:id', auth, ah(async (req, res) => res.json(await services.alerts.getRule(req.principal, req.params.id))));
  r.patch('/alert-rules/:id', auth, json, ah(async (req, res) => res.json(await services.alerts.updateRule(req.principal, req.params.id, req.body))));
  r.delete('/alert-rules/:id', auth, ah(async (req, res) => { await services.alerts.deleteRule(req.principal, req.params.id); res.status(204).end(); }));
  r.post('/alert-rules/:id/test', auth, ah(async (req, res) => res.json(await services.alerts.testRule(req.principal, req.params.id))));
  r.get('/alerts', auth, ah(async (req, res) => res.json(await services.alerts.list(req.principal, req.query))));
  r.get('/alerts/summary', auth, ah(async (req, res) => res.json(await services.alerts.summary(req.principal))));
  r.get('/alerts/:id', auth, ah(async (req, res) => res.json(await services.alerts.get(req.principal, req.params.id))));
  r.post('/alerts/:id/acknowledge', auth, ah(async (req, res) => res.json(await services.alerts.acknowledge(req.principal, req.params.id))));
  r.post('/alerts/:id/resolve', auth, ah(async (req, res) => res.json(await services.alerts.resolve(req.principal, req.params.id))));

  // ---- organization settings, members, invitations, audit ----
  r.get('/org', auth, ah(async (req, res) => res.json(await services.org.get(req.principal))));
  r.patch('/org', auth, json, ah(async (req, res) => res.json(await services.org.update(req.principal, req.body))));
  r.get('/org/members', auth, ah(async (req, res) => res.json(await services.org.listMembers(req.principal))));
  r.patch('/org/members/:userId', auth, json, ah(async (req, res) => res.json(await services.org.changeRole(req.principal, req.params.userId, req.body))));
  r.delete('/org/members/:userId', auth, ah(async (req, res) => { await services.org.removeMember(req.principal, req.params.userId); res.status(204).end(); }));
  r.post('/org/members/:userId/password-reset', auth, ah(async (req, res) => res.status(201).json(await services.org.issuePasswordReset(req.principal, req.params.userId))));
  r.get('/org/invitations', auth, ah(async (req, res) => res.json(await services.org.listInvitations(req.principal))));
  r.post('/org/invitations', auth, json, ah(async (req, res) => res.status(201).json(await services.org.invite(req.principal, req.body))));
  r.delete('/org/invitations/:id', auth, ah(async (req, res) => { await services.org.revokeInvitation(req.principal, req.params.id); res.status(204).end(); }));
  r.get('/org/audit', auth, ah(async (req, res) => res.json(await services.org.audit(req.principal, req.query))));
  r.post('/org/demo-data/delete', auth, json, ah(async (req, res) => res.json(await services.org.deleteDemoData(req.principal, req.body))));
  return r;
}
