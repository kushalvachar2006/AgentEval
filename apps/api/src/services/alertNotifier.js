// Delivers alert notifications. In-app notification needs no delivery (the alert row IS the notification); this sends the optional webhook.
// The webhook URL is user-supplied, so every send goes through the SSRF-safe client (DNS pinning, no redirects, size/time limits).
// Payloads carry numbers, names and ids only - never trace content, never secrets.
import crypto from 'node:crypto';
import { safeRequest } from '../lib/safeHttp.js';
import { UpstreamError } from '../lib/upstream.js';

export function buildWebhookPayload({ alert, rule, event, config }) {
  const link = config.publicWebUrl ? `${config.publicWebUrl}/#/alerts/${alert.id}` : undefined;
  const base = {
    event, alertId: alert.id, status: alert.status, severity: alert.severity, rule: { id: alert.ruleId, name: alert.ruleName, type: alert.ruleType }, agentId: alert.agentId ?? null,
    explanation: alert.explanation, observed: alert.observed, threshold: alert.threshold, openedAt: alert.openedAt, ...(alert.resolvedAt && { resolvedAt: alert.resolvedAt }), ...(link && { link }),
  };
  if (rule?.notify?.webhook?.format === 'slack') {
    const icon = event === 'resolved' ? ':white_check_mark:' : alert.severity === 'critical' ? ':rotating_light:' : ':warning:';
    return { text: `${icon} *AgentEval alert ${event}:* ${alert.ruleName} (${alert.severity})\n${alert.explanation}${link ? `\n${link}` : ''}` };
  }
  return base;
}

export const sign = (secret, timestamp, body) => `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

export function createAlertNotifier({ repos, config, secrets, now = () => new Date(), http = safeRequest, logger = console }) {
  return {
    // job payload: { alertId, event: 'opened' | 'resolved' }
    async handle(job) {
      const org = job.organizationId, { alertId, event } = job.payload ?? {};
      const alert = await repos.alerts.get(org, alertId);
      if (!alert) return { done: true, skipped: 'alert no longer exists' };
      const rule = await repos.alertRules.get(org, alert.ruleId);
      const hook = rule?.notify?.webhook;
      if (!hook?.urlEnc) return { done: true, skipped: 'no webhook configured' };
      const body = JSON.stringify(buildWebhookPayload({ alert, rule, event, config }));
      const ts = String(Math.floor(now().getTime() / 1000));
      const headers = { 'content-type': 'application/json', 'user-agent': 'AgentEval-Alerts/1', 'x-agenteval-event': event, 'x-agenteval-timestamp': ts };
      if (hook.secretEnc) headers['x-agenteval-signature'] = sign(secrets.decrypt(hook.secretEnc), ts, body);
      const entry = { channel: 'webhook', event, at: now(), host: hook.urlHost };
      try {
        const res = await http(secrets.decrypt(hook.urlEnc), { headers, body, timeoutMs: 10_000, maxBytes: 64 * 1024, allowPrivate: config.allowPrivateEndpoints });
        if (res.status === 408 || res.status === 429 || res.status >= 500) throw new UpstreamError(`Webhook returned HTTP ${res.status}`, { retryable: true });
        const ok = res.status >= 200 && res.status < 300;
        await repos.alerts.pushNotification(org, alert.id, { ...entry, ok, status: res.status });
        return { done: true };
      } catch (e) {
        const retryable = e instanceof UpstreamError ? e.retryable : false;   // SSRF refusals and other validation errors are final
        await repos.alerts.pushNotification(org, alert.id, { ...entry, ok: false, error: String(e.message).slice(0, 200) }).catch(() => {});
        if (retryable && job.attempts < job.maxAttempts) return { retry: true, error: e.message };
        logger.error(JSON.stringify({ level: 'error', msg: 'webhook delivery failed', alertId: alert.id, error: String(e.message).slice(0, 200) }));
        return { done: true };
      }
    },
  };
}
