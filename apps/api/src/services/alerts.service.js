// Alert rules (who may edit: admins), alert events (who may acknowledge/resolve: members), summary badge.
import { AppError } from '../middleware/errors.js';
import { isId } from '../lib/ids.js';
import { requirePermission } from '../lib/rbac.js';
import { check, parseLimit, queryString } from '../lib/validate.js';
import { assertSafeUrl } from '../lib/ssrf.js';
import { validateRule, RULE_TYPES } from '../modules/alerts/rules.js';

const STATUSES = ['open', 'acknowledged', 'resolved'];
const FORMATS = ['json', 'slack'];
const iso = (d) => (d ? new Date(d).toISOString() : null);

// Secrets (the webhook URL may itself be a secret, e.g. Slack) are never returned: only the host and whether a signing secret exists.
export const publicRule = (r) => ({
  id: r.id, name: r.name, type: r.type, agentId: r.agentId ?? null, severity: r.severity, params: r.params, enabled: r.enabled,
  cooldownMinutes: r.cooldownMinutes, resolveAfterOk: r.resolveAfterOk, evalEveryMinutes: r.evalEveryMinutes,
  notify: { webhook: r.notify?.webhook?.urlEnc ? { host: r.notify.webhook.urlHost, format: r.notify.webhook.format ?? 'json', hasSecret: Boolean(r.notify.webhook.secretEnc) } : null },
  lastEvaluation: r.state?.lastEvaluatedAt ? { at: r.state.lastEvaluatedAt, state: r.state.lastState, observed: r.state.lastObserved, explanation: r.state.lastExplanation } : null,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

// Hash links into the website: the dashboard window and the failing traces behind the alert.
export function linksFor(a) {
  const q = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const from = iso(a.window?.from), to = iso(a.window?.to);
  const monitoring = a.agentId ? `#/monitoring/${a.agentId}?${q({ windowMinutes: a.window?.minutes && a.window.minutes <= 1440 ? Math.max(5, a.window.minutes) : undefined })}` : '#/monitoring';
  const base = { agentId: a.agentId, environment: 'production', from, to };
  const traces = a.ruleType === 'error_rate' ? `#/traces?${q({ ...base, status: 'error' })}`
    : a.ruleType === 'latency' && a.threshold ? `#/traces?${q({ ...base, minDurationMs: Math.round(a.threshold) })}`
      : a.ruleType === 'silence' ? null : `#/traces?${q(base)}`;
  return { monitoring, traces };
}
const publicAlert = ({ organizationId, expiresAt, ...a }) => ({ ...a, links: linksFor(a) }); // eslint-disable-line no-unused-vars

export function createAlertsService({ repos, config, audit, secrets, engine, deps = {}, now = () => new Date() }) {
  const safeUrl = deps.assertSafeUrl ?? assertSafeUrl;

  async function buildNotify(c, input, prev) {
    if (input === undefined) return prev;
    if (input === null) return undefined;
    if (typeof input !== 'object' || Array.isArray(input)) { c.fail('notify', 'must be an object or null'); return prev; }
    const hook = input.webhook;
    if (hook === null) return undefined;
    if (hook === undefined) return prev;
    if (typeof hook !== 'object' || Array.isArray(hook)) { c.fail('notify.webhook', 'must be an object or null'); return prev; }
    const before = prev?.webhook;
    const format = hook.format === undefined ? before?.format ?? 'json' : hook.format;
    if (!FORMATS.includes(format)) c.fail('notify.webhook.format', `must be one of: ${FORMATS.join(', ')}`);
    let urlEnc = before?.urlEnc, urlHost = before?.urlHost, secretEnc = before?.secretEnc;
    if (hook.url !== undefined) {
      if (typeof hook.url !== 'string' || hook.url.length > 1000) c.fail('notify.webhook.url', 'must be a URL of at most 1000 characters');
      else {
        try { const { url } = await safeUrl(hook.url, { allowPrivate: config.allowPrivateEndpoints }); urlEnc = secrets.encrypt(url); urlHost = new URL(url).host; }
        catch (e) { if (e instanceof AppError) c.fail('notify.webhook.url', e.message); else throw e; }
      }
    } else if (!before) c.fail('notify.webhook.url', 'is required');
    if (hook.secret !== undefined) {
      if (typeof hook.secret !== 'string' || hook.secret.length < 8 || hook.secret.length > 200) c.fail('notify.webhook.secret', 'must be a string of 8-200 characters');
      else secretEnc = secrets.encrypt(hook.secret);
    }
    if (hook.clearSecret === true) secretEnc = undefined;
    return { webhook: { urlEnc, urlHost, secretEnc, format } };
  }

  async function ruleOr404(principal, id) {
    const rule = isId(id) ? await repos.alertRules.get(principal.organizationId, id) : null;
    if (!rule) throw new AppError(404, 'ALERT_RULE_NOT_FOUND', 'Alert rule not found');
    return rule;
  }
  async function alertOr404(principal, id) {
    const a = isId(id) ? await repos.alerts.get(principal.organizationId, id) : null;
    if (!a) throw new AppError(404, 'ALERT_NOT_FOUND', 'Alert not found');
    return a;
  }
  async function ensureAgent(org, agentId) { if (agentId && !(await repos.agents.get(org, agentId))) throw new AppError(404, 'AGENT_NOT_FOUND', 'Agent not found'); }

  return {
    // ---------- rules ----------
    async createRule(principal, body) {
      requirePermission(principal, 'alerts:manage');
      const org = principal.organizationId;
      if ((await repos.alertRules.count(org)) >= config.maxAlertRules) throw new AppError(409, 'ALERT_RULE_LIMIT', `An organization may have at most ${config.maxAlertRules} alert rules`);
      const v = validateRule(body);
      await ensureAgent(org, v.agentId);
      const c = check();
      const notify = await buildNotify(c, body?.notify, undefined);
      c.done();
      const rule = await repos.alertRules.create(org, { ...v, notify, state: {}, createdBy: principal.userId, nextEvalAt: now() });
      await audit.log({ organizationId: org, actorId: principal.userId, action: 'alert-rule.create', target: rule.id, meta: { type: v.type, severity: v.severity, webhook: Boolean(notify?.webhook) } });
      return publicRule(rule);
    },
    async listRules(principal, query = {}) {
      requirePermission(principal, 'alerts:read');
      const agentId = queryString(query, 'agentId');
      if (agentId && !isId(agentId)) throw new AppError(400, 'INVALID_QUERY', 'agentId must be a valid id');
      const cursorId = queryString(query, 'cursor');
      if (cursorId && !isId(cursorId)) throw new AppError(400, 'INVALID_CURSOR', 'cursor is not valid');
      const limit = parseLimit(query.limit, { def: 50, max: 100 });
      const { items, hasMore } = await repos.alertRules.list(principal.organizationId, { agentId, cursorId, limit });
      return { items: items.map(publicRule), nextCursor: hasMore ? items.at(-1).id : null, supportedTypes: RULE_TYPES };
    },
    async getRule(principal, id) { requirePermission(principal, 'alerts:read'); return publicRule(await ruleOr404(principal, id)); },
    async updateRule(principal, id, body) {
      requirePermission(principal, 'alerts:manage');
      const org = principal.organizationId, existing = await ruleOr404(principal, id);
      const v = validateRule(body, existing);
      await ensureAgent(org, v.agentId);
      const c = check();
      const notify = await buildNotify(c, body?.notify, existing.notify);
      c.done();
      const resetState = body?.params !== undefined || body?.agentId !== undefined || body?.enabled === true;
      const updated = await repos.alertRules.update(org, existing.id, { ...v, notify: notify ?? null, ...(resetState && { nextEvalAt: now() }) });
      await audit.log({ organizationId: org, actorId: principal.userId, action: 'alert-rule.update', target: existing.id, meta: { fields: Object.keys(body ?? {}).filter((k) => k !== 'notify') , webhookChanged: body?.notify !== undefined } });
      return publicRule(updated);
    },
    async deleteRule(principal, id) {
      requirePermission(principal, 'alerts:manage');
      const org = principal.organizationId, rule = await ruleOr404(principal, id);
      const open = await repos.alerts.findOpenForRule(org, rule.id);
      if (open) await repos.alerts.update(org, open.id, { status: 'resolved', resolvedAt: now(), resolvedBy: 'rule_deleted' });
      await repos.alertRules.remove(org, rule.id);
      await audit.log({ organizationId: org, actorId: principal.userId, action: 'alert-rule.delete', target: rule.id, meta: { type: rule.type } });
    },
    // Evaluate the rule right now against live data without recording anything.
    async testRule(principal, id) {
      requirePermission(principal, 'alerts:read');
      return engine.dryRun(await ruleOr404(principal, id));
    },

    // ---------- alerts ----------
    async list(principal, query = {}) {
      requirePermission(principal, 'alerts:read');
      const f = { limit: parseLimit(query.limit, { def: 25, max: 100 }) };
      const status = queryString(query, 'status');
      if (status) { if (status === 'active') f.status = ['open', 'acknowledged']; else if (STATUSES.includes(status)) f.status = status; else throw new AppError(400, 'INVALID_QUERY', `status must be one of: ${[...STATUSES, 'active'].join(', ')}`); }
      for (const k of ['agentId', 'ruleId']) { const v = queryString(query, k); if (v) { if (!isId(v)) throw new AppError(400, 'INVALID_QUERY', `${k} must be a valid id`); f[k] = v; } }
      const cursor = queryString(query, 'cursor');
      if (cursor) { if (!isId(cursor)) throw new AppError(400, 'INVALID_CURSOR', 'cursor is not valid'); f.cursorId = cursor; }
      const { items, hasMore } = await repos.alerts.list(principal.organizationId, f);
      return { items: items.map(publicAlert), nextCursor: hasMore ? items.at(-1).id : null };
    },
    async summary(principal) {
      requirePermission(principal, 'alerts:read');
      const counts = await repos.alerts.openCounts(principal.organizationId);
      const n = (pred) => counts.filter(pred).reduce((s, c) => s + c.n, 0);
      return { active: n(() => true), critical: n((c) => c.severity === 'critical'), warning: n((c) => c.severity === 'warning') };
    },
    async get(principal, id) { requirePermission(principal, 'alerts:read'); return publicAlert(await alertOr404(principal, id)); },
    async acknowledge(principal, id) {
      requirePermission(principal, 'alerts:ack');
      const org = principal.organizationId, a = await alertOr404(principal, id);
      if (a.status !== 'open') throw new AppError(409, 'ALERT_STATE', `Only an open alert can be acknowledged (this one is ${a.status})`);
      const u = await repos.alerts.update(org, a.id, { status: 'acknowledged', acknowledgedAt: now(), acknowledgedBy: principal.userId }, { ifStatusIn: ['open'] });
      if (!u) throw new AppError(409, 'ALERT_STATE', 'The alert changed in the meantime; reload and try again');
      await audit.log({ organizationId: org, actorId: principal.userId, action: 'alert.acknowledge', target: a.id });
      return publicAlert(u);
    },
    // Manual resolve also starts the rule's cooldown, so a still-firing rule does not instantly re-open the alert.
    async resolve(principal, id) {
      requirePermission(principal, 'alerts:ack');
      const org = principal.organizationId, a = await alertOr404(principal, id);
      if (a.status === 'resolved') throw new AppError(409, 'ALERT_STATE', 'This alert is already resolved');
      const at = now();
      const u = await repos.alerts.update(org, a.id, { status: 'resolved', resolvedAt: at, resolvedBy: principal.userId }, { ifStatusIn: ['open', 'acknowledged'] });
      if (!u) throw new AppError(409, 'ALERT_STATE', 'The alert changed in the meantime; reload and try again');
      const rule = await repos.alertRules.get(org, a.ruleId);
      if (rule) await repos.alertRules.update(org, rule.id, { state: { ...(rule.state ?? {}), lastResolvedAt: at, okStreak: 0 } });
      await audit.log({ organizationId: org, actorId: principal.userId, action: 'alert.resolve', target: a.id });
      return publicAlert(u);
    },
  };
}
