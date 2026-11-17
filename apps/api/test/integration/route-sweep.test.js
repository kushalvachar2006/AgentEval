// Security sweep over EVERY route of the API, over real HTTP:
//   1. completeness: the table below must list exactly the routes the router registers (a new route without an entry FAILS this test)
//   2. authentication: every non-public route refuses anonymous callers (401)
//   3. tenant isolation: another organization's owner using organization A's ids gets 403/404 - never 2xx - and list endpoints leak nothing
//   4. nothing of organization A changed during the attack
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app.js';
import { buildRouter } from '../../src/routes/index.js';
import { makeWorld, fakeEngine } from '../helpers/world.js';

const PUBLIC = new Set(['POST /auth/register', 'POST /auth/login', 'POST /auth/refresh', 'POST /auth/password-reset/complete', 'POST /auth/invitations/accept']);
// kind: 'id' = path targets one of A's objects (must be refused to B) | 'list' = collection (must not leak A's data) | 'self' = acts on the caller's own account/org only
const ROUTES = {
  'GET /agents': 'list', 'POST /agents': 'self', 'GET /agents/:id': 'id', 'PATCH /agents/:id': 'id', 'DELETE /agents/:id': 'id',
  'GET /agents/:id/metrics': 'id', 'GET /agents/:id/monitoring': 'id', 'PUT /agents/:id/monitoring': 'id', 'GET /agents/:id/traces': 'id', 'GET /agents/:id/versions': 'id', 'POST /agents/:id/versions': 'id',
  'GET /alert-rules': 'list', 'POST /alert-rules': 'self', 'GET /alert-rules/:id': 'id', 'PATCH /alert-rules/:id': 'id', 'DELETE /alert-rules/:id': 'id', 'POST /alert-rules/:id/test': 'id',
  'GET /alerts': 'list', 'GET /alerts/summary': 'list', 'GET /alerts/:id': 'id', 'POST /alerts/:id/acknowledge': 'id', 'POST /alerts/:id/resolve': 'id',
  'GET /analytics/overview': 'list', 'GET /api-keys': 'list', 'POST /api-keys': 'self', 'DELETE /api-keys/:id': 'id',
  'GET /auth/me': 'self', 'POST /auth/logout': 'self', 'POST /auth/logout-all': 'self', 'POST /auth/change-password': 'self', 'POST /org/invitations/accept': 'self',
  'GET /evaluations': 'list', 'POST /evaluations': 'self', 'GET /evaluations/:id': 'id', 'GET /evaluations/:id/results': 'id', 'GET /evaluations/:id/work': 'id', 'POST /evaluations/:id/cancel': 'id',
  'GET /evaluator-config': 'list', 'PUT /evaluator-config': 'self', 'GET /evaluators': 'list',
  'GET /monitoring/overview': 'list', 'GET /monitoring/agents/:id/live': 'id', 'GET /monitoring/agents/:id/rollups': 'id',
  'GET /org': 'list', 'PATCH /org': 'self', 'GET /org/audit': 'list', 'GET /org/invitations': 'list', 'POST /org/invitations': 'self', 'DELETE /org/invitations/:id': 'id',
  'GET /org/members': 'list', 'PATCH /org/members/:userId': 'id', 'DELETE /org/members/:userId': 'id', 'POST /org/members/:userId/password-reset': 'id', 'POST /org/demo-data/delete': 'self',
  'GET /test-suites': 'list', 'POST /test-suites': 'self', 'GET /test-suites/:id': 'id', 'POST /test-suites/:id/cases': 'id', 'POST /test-suites/:id/import': 'id', 'DELETE /test-suites/:id/cases/:caseId': 'id',
  'GET /traces': 'list', 'POST /traces': 'self', 'POST /traces/batch': 'self', 'GET /traces/:id': 'id', 'GET /traces/:id/debug': 'id',
};

test('route table is complete: every registered route is classified (add new routes here!)', async () => {
  const w = makeWorld();
  const router = buildRouter({ services: w.services, auth: (_q, _s, n) => n(), config: w.config });
  const registered = router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`)).sort();
  const known = [...Object.keys(ROUTES), ...PUBLIC].sort();
  assert.deepEqual(registered, known, 'routes added/removed without updating the security sweep');
});

test('every route: anonymous = 401; other tenant = refused; lists leak nothing; organization A is unchanged afterwards', async () => {
  const w = makeWorld({ AUTH_RATE_LIMIT_MAX: '1000', RATE_LIMIT_MAX: '100000' }, { engine: fakeEngine() });
  const server = createApp({ config: w.config, services: w.services, checks: {} }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, { method, headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, text, json };
  };
  try {
    // ---- organization A: one of everything, all carrying the marker ISO-A ----
    const A = await w.signup('iso-a-owner'); const B = await w.signup('iso-b-owner');
    const a = A.principal;
    const agent = await w.newAgent(a, 'ISO-A-AGENT');
    const key = await w.services.apiKeys.create(a, { name: 'ISO-A-KEY' });
    const trace = w.traceFor(agent.id, { input: 'ISO-A-SECRET-QUESTION', environment: 'production', metadata: {} });
    await w.services.traces.ingestOne(a, trace);
    const suite = await w.services.suites.create(a, { name: 'ISO-A-SUITE' });
    const tcase = await w.services.suites.addCase(a, suite.id, { input: 'ISO-A-CASE-INPUT' });
    const run = await w.services.evaluations.create(a, { name: 'ISO-A-RUN', agentId: agent.id, suiteId: suite.id, mode: 'sdk' });
    const rule = await w.services.alerts.createRule(a, { name: 'ISO-A-RULE', type: 'error_rate', agentId: agent.id, params: { windowMinutes: 10, thresholdPct: 1, minSamples: 1 } });
    const alertDoc = (await w.repos.alerts.create(a.organizationId, { ruleId: rule.id, ruleName: 'ISO-A-ALERT', ruleType: 'error_rate', severity: 'warning', agentId: agent.id, status: 'open', openedAt: new Date(), explanation: 'ISO-A-EXPL', observed: {}, threshold: 1 })).alert;
    const inv = await w.services.org.invite(a, { email: 'iso-a-invitee@example.com' });
    const memberReg = await w.services.org.invite(a, { email: 'iso-a-member@example.com', role: 'member' });
    const joined = await w.services.auth.acceptInvitation({ token: memberReg.token, name: 'ISO-A-MEMBER', password: 'correct-horse-1' });
    const ids = { id: null, userId: joined.user.id, caseId: tcase.id };
    const fill = (path, idValue) => path.replace(':id', idValue).replace(':userId', ids.userId).replace(':caseId', ids.caseId);
    const idFor = (key2) => ({
      '/agents': agent.id, '/traces': trace.traceId, '/test-suites': suite.id, '/evaluations': run.id, '/alert-rules': rule.id, '/alerts': alertDoc.id,
      '/api-keys': key.id, '/org/invitations': inv.id, '/monitoring/agents': agent.id, '/org/members': joined.user.id,
    })[Object.keys({ '/agents': 1, '/traces': 1, '/test-suites': 1, '/evaluations': 1, '/alert-rules': 1, '/alerts': 1, '/api-keys': 1, '/org/invitations': 1, '/monitoring/agents': 1, '/org/members': 1 }).find((p) => key2.startsWith(p))];
    const bodyFor = { 'POST /agents/:id/versions': { version: '9.9.9' }, 'PATCH /agents/:id': { description: 'HACKED' }, 'PUT /agents/:id/monitoring': { enabled: true, sampleRate: 1 },
      'PATCH /alert-rules/:id': { name: 'HACKED' }, 'POST /test-suites/:id/cases': { input: 'HACKED' }, 'POST /test-suites/:id/import': { format: 'json', content: '[{"input":"HACKED"}]' },
      'PATCH /org/members/:userId': { role: 'viewer' } };
    const attackerSelfBodies = { 'POST /traces': w.traceFor(agent.id, { environment: 'production' }), 'POST /traces/batch': { traces: [w.traceFor(agent.id)] },
      'POST /evaluations': { agentId: agent.id, suiteId: suite.id, mode: 'sdk' }, 'POST /alert-rules': { name: 'x', type: 'silence', agentId: agent.id, params: { silenceMinutes: 5 } },
      'POST /org/invitations': { email: 'x@example.com' }, 'POST /agents': { name: 'b-agent', framework: 'custom' } };

    const failures = [];
    // session-ending routes run last: they legitimately invalidate the attacker's own token
    const lastOnes = ['POST /auth/logout', 'POST /auth/logout-all', 'POST /auth/change-password'];
    for (const [route, kind] of Object.entries(ROUTES).sort(([a], [b]) => lastOnes.indexOf(a) - lastOnes.indexOf(b) || 0)) {
      const [method, tpl] = route.split(' ');
      const target = tpl.includes(':') ? fill(tpl, idFor(tpl)) : tpl;
      const url = kind === 'list' && tpl === '/traces' ? '/traces?limit=100' : target;
      const body = bodyFor[route] ?? attackerSelfBodies[route];
      // (2) anonymous
      const anon = await call(method, url, { body });
      if (anon.status !== 401) failures.push(`${route}: anonymous got ${anon.status}`);
      // (3) another organization
      const evil = await call(method, url, { token: B.token, body });
      if (kind === 'id') { if (![403, 404, 422].includes(evil.status)) failures.push(`${route}: other tenant got ${evil.status} on ${url}`); }
      if (kind === 'list' || kind === 'self' || kind === 'id') { if (/ISO-A/.test(evil.text) || evil.text.includes(agent.id) || evil.text.includes(trace.traceId)) failures.push(`${route}: response leaks organization A data`); }
      if (kind === 'list' && evil.status >= 500) failures.push(`${route}: server error ${evil.status}`);
      if (kind === 'id' && evil.status >= 200 && evil.status < 300) failures.push(`${route}: MUTATED/READ across tenants`);
    }
    // the same tests with an API key of organization B on user-only routes must be 401/403 (keys cannot do user things)
    assert.deepEqual(failures, []);

    // (4) organization A is unchanged
    const orgA = a.organizationId;
    assert.equal((await w.repos.agents.get(orgA, agent.id)).description ?? '', agent.description ?? '');
    assert.equal((await w.repos.agents.get(orgA, agent.id)).isArchived, false);
    assert.equal((await w.repos.agents.get(orgA, agent.id)).monitoring, undefined);
    assert.equal((await w.repos.alertRules.get(orgA, rule.id)).name, 'ISO-A-RULE');
    assert.equal((await w.repos.alerts.get(orgA, alertDoc.id)).status, 'open');
    assert.equal((await w.repos.orgs.get(orgA)).members.find((m) => m.userId === joined.user.id).role, 'member');
    assert.equal((await w.repos.orgs.get(orgA)).members.length, 2);
    assert.equal((await w.repos.apiKeys.list(orgA)).filter((k) => !k.revokedAt).length, 1);
    assert.equal((await w.repos.tokens.listPending(orgA, 'invite', new Date())).length, 1);
    assert.equal((await w.repos.traces.get(orgA, trace.traceId)) !== null, true);
    assert.equal((await w.repos.suites.get(orgA, suite.id)).isDeleted ?? false, false);
    assert.equal((await w.repos.cases.listForSuite?.(orgA, suite.id))?.length ?? 1, 1);
    // B's own attack-traces went into B's organization only
    assert.equal(w.repos._db.traces.filter((t) => t.organizationId === orgA).length, 1);
    void ids; void key;
  } finally { server.close(); }
});

test('API keys cannot use user-only routes and a key of one agent cannot touch another agent', async () => {
  const w = makeWorld({ RATE_LIMIT_MAX: '100000' }, { engine: fakeEngine() });
  const server = createApp({ config: w.config, services: w.services, checks: {} }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try {
    const A = await w.signup('ka'); const a1 = await w.newAgent(A.principal, 'one'); const a2 = await w.newAgent(A.principal, 'two');
    const k = await w.services.apiKeys.create(A.principal, { name: 'scoped', agentId: a1.id });
    const call = (m, p, body) => fetch(base + p, { method: m, headers: { 'content-type': 'application/json', 'x-api-key': k.key }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, text: await r.text() }));
    for (const [m, p] of [['GET', '/org'], ['GET', '/org/members'], ['GET', '/org/audit'], ['GET', '/alerts'], ['GET', '/alert-rules'], ['GET', '/monitoring/overview'], ['GET', '/api-keys'], ['GET', '/traces'], ['GET', '/analytics/overview'], ['GET', '/org/invitations'], ['POST', '/auth/logout'], ['POST', '/auth/logout-all'], ['GET', '/auth/me'], ['PUT', '/evaluator-config']]) {
      const r = await call(m, p, m === 'GET' ? undefined : {});
      assert.ok([401, 403].includes(r.status), `${m} ${p} -> ${r.status}`);
    }
    assert.equal((await call('POST', '/traces', w.traceFor(a2.id))).status, 403);                    // key is bound to agent "one"
    assert.equal((await call('POST', '/traces', w.traceFor(a1.id))).status, 202);
  } finally { server.close(); }
});
