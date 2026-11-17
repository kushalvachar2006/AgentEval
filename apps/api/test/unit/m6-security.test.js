// Milestone 6 security tests: SSRF matrix, redirect/rebinding behaviour, secret-leak checks, importer and validator fuzzing.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { assertSafeUrl } from '../../src/lib/ssrf.js';
import { safeRequest } from '../../src/lib/safeHttp.js';
import { parseCases, normalizeCases } from '../../src/modules/testSuites/importers.js';
import { validateTrace } from '../../src/modules/traces/traceSchema.js';
import { sanitize } from '../../src/lib/redact.js';
import { makeWorld, fakeEngine } from '../helpers/world.js';

// ---------------- SSRF matrix ----------------
const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }];
const MATRIX_BLOCKED = [
  // schemes / syntax
  'ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/', 'javascript:alert(1)', 'data:text/plain,hi', 'http://', 'http:///path', '//example.com', 'example.com', '', ' ',
  'http://user:pass@example.com/', 'http://example.com@127.0.0.1/', 'http://127.0.0.1#@example.com/', 'http://a b/',
  // loopback / private / link-local / metadata, many spellings
  'http://127.0.0.1/', 'http://127.1/', 'http://127.000.000.001/', 'http://0177.0.0.1/', 'http://0x7f000001/', 'http://2130706433/', 'http://017700000001/', 'http://0/', 'http://0.0.0.0/',
  'http://10.0.0.1/', 'http://172.16.5.4/', 'http://192.168.0.10/', 'http://169.254.169.254/latest/meta-data/', 'http://100.64.1.1/', 'http://198.51.100.7/', 'http://203.0.113.9/', 'http://224.0.0.1/', 'http://240.0.0.1/',
  'http://[::1]/', 'http://[::]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[fe80::1]/', 'http://[fd00::1]/', 'http://[fc00::1]/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/', 'http://[::127.0.0.1]/',
  'http://[0:0:0:0:0:ffff:a00:1]/', 'http://[::ffff:169.254.169.254]/',
  // names
  'http://localhost/', 'http://LOCALHOST/', 'http://localhost./', 'http://foo.localhost/', 'http://metadata.google.internal/', 'http://service.internal/', 'http://printer.local/', 'http://intranet/', 'http://kubernetes.default.svc/',
];
test('SSRF matrix: every dangerous URL spelling is refused before any connection', async () => {
  const leaks = [];
  for (const url of MATRIX_BLOCKED) {
    try { await assertSafeUrl(url, { resolve: PUBLIC }); leaks.push(url); } catch (e) { assert.ok(['UNSAFE_ENDPOINT', 'INVALID_URL'].includes(e.code), `${url} -> ${e.code}`); }
  }
  assert.deepEqual(leaks, []);
});
test('SSRF matrix: harmless public URLs are accepted (no false alarms)', async () => {
  for (const url of ['https://example.com/', 'http://example.com:8080/x?y=1', 'https://sub.example.co.uk/path', 'https://hooks.slack.com/services/T/B/X', 'http://93.184.216.34/', 'http://[2606:4700:4700::1111]/'])
    assert.ok((await assertSafeUrl(url, { resolve: PUBLIC })).url, url);
});
test('SSRF matrix: DNS answers are checked, including mixed and rebinding-style answers', async () => {
  const answers = { 'ok.example': [{ address: '93.184.216.34', family: 4 }], 'priv.example': [{ address: '10.0.0.5', family: 4 }], 'mixed.example': [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
    'v6priv.example': [{ address: 'fd00::1', family: 6 }], 'mapped.example': [{ address: '::ffff:10.0.0.1', family: 6 }], 'empty.example': [] };
  const resolve = async (h) => answers[h] ?? (() => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); })();
  assert.ok((await assertSafeUrl('http://ok.example/', { resolve })).url);
  for (const h of ['priv', 'mixed', 'v6priv', 'mapped', 'empty', 'unknown']) await assert.rejects(() => assertSafeUrl(`http://${h}.example/`, { resolve }), (e) => ['UNSAFE_ENDPOINT', 'INVALID_URL'].includes(e.code), h);
});
test('SSRF: private targets are allowed ONLY with the explicit self-hosting switch', async () => {
  assert.ok((await assertSafeUrl('http://127.0.0.1:9/', { allowPrivate: true, resolve: PUBLIC })).url);
  await assert.rejects(() => assertSafeUrl('http://127.0.0.1:9/', { allowPrivate: false, resolve: PUBLIC }));
});
test('SSRF: a redirect to an internal address is never followed (real local server)', async () => {
  let hits = 0;
  const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
  const internal = await listen(http.createServer((_q, r) => { hits++; r.end('SECRET-INTERNAL'); }));
  const redirector = await listen(http.createServer((_q, r) => { r.writeHead(302, { location: `http://127.0.0.1:${internal.address().port}/secret` }); r.end(); }));
  try {
    const res = await safeRequest(`http://127.0.0.1:${redirector.address().port}/`, { method: 'POST', body: '{}', allowPrivate: true, timeoutMs: 3000 }).catch((e) => ({ error: e }));
    assert.equal(hits, 0, 'the redirect target must never be contacted');
    assert.ok(res.error || res.status === 302);
    assert.ok(!JSON.stringify(res).includes('SECRET-INTERNAL'));
  } finally { internal.close(); redirector.close(); }
});
test('SSRF: response size limit is enforced', async () => {
  const big = await new Promise((ok) => { const srv = http.createServer((_q, r) => { r.end('x'.repeat(5_000_000)); }); srv.listen(0, '127.0.0.1', () => ok(srv)); });
  try { await assert.rejects(() => safeRequest(`http://127.0.0.1:${big.address().port}/`, { method: 'GET', allowPrivate: true, maxBytes: 100_000, timeoutMs: 3000 })); } finally { big.close(); }
});

// ---------------- secret leaks ----------------
test('secret-leak sweep: passwords, tokens, keys and webhook secrets never appear in logs, responses, audit or (in clear) in the database', async () => {
  const captured = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => captured.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  const S = { password: 'Pw-LEAKCHECK-7731-xyz', password2: 'Pw2-LEAKCHECK-9912-xyz', judge: 'sk-LEAKCHECKjudgekey1234567890abcdef', hook: 'https://hooks.example.com/services/T0/B0/WEBHOOKTOKENLEAK', hookSecret: 'signing-LEAKCHECK-5521', endpointToken: 'endpoint-LEAKCHECK-token-8812', customer: 'CUSTOMER-PII-4455' };
  const responses = [];
  try {
    const w = makeWorld({}, { engine: fakeEngine(), logger: console });
    const reg = await w.services.auth.register({ email: 'leak@example.com', password: S.password, name: 'Leak', organizationName: 'Leak Org' });
    const owner = await w.services.auth.authenticateUser(reg.token);
    const note = (v) => { responses.push(JSON.stringify(v)); return v; };
    const agent = note(await w.services.agents.create(owner, { name: 'api-agent', framework: 'custom', integrationType: 'api', endpointUrl: 'https://agent.example.com/run', endpointToken: S.endpointToken }));
    note(await w.services.agents.get(owner, agent.id)); note(await w.services.agents.list(owner, {}));
    note(await w.services.evaluatorConfig.put(owner, { judge: { enabled: true, provider: 'openai_compatible', model: 'm', apiKey: S.judge } })); note(await w.services.evaluatorConfig.get(owner));
    const key = await w.services.apiKeys.create(owner, { name: 'k' }); note(await w.services.apiKeys.list(owner));
    const rule = note(await w.services.alerts.createRule(owner, { name: 'r', type: 'error_rate', params: { thresholdPct: 5 }, notify: { webhook: { url: S.hook, secret: S.hookSecret } } }));
    note(await w.services.alerts.listRules(owner)); note(await w.services.alerts.getRule(owner, rule.id));
    const inv = await w.services.org.invite(owner, { email: 'i@example.com' });
    note(await w.services.org.listInvitations(owner)); note(await w.services.org.listMembers(owner));
    const t = w.traceFor(agent.id, { input: `my key ${S.judge} and password=${S.password}`, metadata: {} });
    await w.services.traces.ingestOne(owner, t); note(await w.services.traces.get(owner, t.traceId)); note(await w.services.traces.explore(owner, {}));
    for (const bad of [() => w.services.auth.login({ email: 'leak@example.com', password: S.password2 }), () => w.services.auth.register({ email: 'x@example.com', password: S.password2.slice(0, 5), name: 'x', organizationName: 'x' }),
      () => w.services.auth.changePassword(owner, { currentPassword: S.password2, newPassword: S.password2 }), () => w.services.auth.completeReset({ token: S.password2, newPassword: S.password }), () => w.services.auth.refresh({ refreshToken: S.password2 })]) {
      try { await bad(); } catch (e) { responses.push(JSON.stringify({ code: e.code, message: e.message, details: e.details })); }
    }
    note(await w.services.org.audit(owner, { limit: '100' }));
    const issued = [reg.token, reg.refreshToken, key.key, inv.token];
    const everything = [...responses.filter((_, i) => true), ...captured].join('\n');
    // 1. forbidden strings that must appear in NO response (except tokens that are returned once at creation, which are checked separately)
    for (const [name, secret] of Object.entries(S)) {
      if (name === 'customer') continue;
      const hay = responses.join('\n');
      assert.ok(!hay.includes(secret), `${name} appears in an API response`);
      assert.ok(!captured.join('\n').includes(secret), `${name} appears in the logs`);
    }
    for (const tok of issued) assert.ok(!captured.join('\n').includes(tok), 'an issued token appears in the logs');
    for (const tok of [reg.refreshToken, key.key, inv.token]) assert.ok(!responses.join('\n').includes(tok), 'a one-time token appears in a later response');
    assert.ok(!everything.includes(w.config.jwtSecret), 'JWT secret leaked');
    assert.ok(!everything.includes(w.config.encryptionKey?.toString?.('base64') ?? 'n/a'), 'encryption key leaked');
    // 2. at rest: nothing sensitive in clear text in the stored documents (hashes and ciphertext only)
    const db = JSON.stringify(w.repos._db);
    for (const [name, secret] of Object.entries(S)) assert.ok(!db.includes(secret), `${name} stored in clear text`);
    for (const tok of [reg.refreshToken, key.key, inv.token]) assert.ok(!db.includes(tok), 'a raw token is stored in clear text');
    assert.ok(db.includes('hooks.example.com'), 'sanity: host is stored (for display)');
  } finally { Object.assign(console, orig); }
});

test('error responses are uniform: 500s carry no stack, internals or request data', async () => {
  const w = makeWorld({ RATE_LIMIT_MAX: '100000' }, { engine: fakeEngine() });
  const { createApp } = await import('../../src/app.js');
  w.services.agents.list = async () => { throw new Error('boom: mongodb://user:SECRETPW@db:27017 stack at /app/src/x.js'); };
  const server = createApp({ config: w.config, services: w.services, checks: {} }).listen(0);
  const orig = console.error; const logs = []; console.error = (...a) => logs.push(a.join(' '));
  try {
    const A = await w.signup('err');
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/agents`, { headers: { authorization: `Bearer ${A.token}` } });
    const text = await r.text();
    assert.equal(r.status, 500);
    assert.deepEqual(Object.keys(JSON.parse(text).error).sort(), ['code', 'message', 'requestId']);
    assert.ok(!/SECRETPW|mongodb:|\/app\/src|stack/i.test(text));
    const headers = [...r.headers.keys()].join(',');
    assert.ok(!/x-powered-by/i.test(headers));
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  } finally { console.error = orig; server.close(); }
});

// ---------------- fuzzing ----------------
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const ALPHABET = ['"', "'", ',', '\n', '\r\n', '\t', '\u0000', '\u202e', '\ud800', '{', '}', '[', ']', '\\', '\u00e9', '日本', 'null', 'true', '1e999', '$where', '__proto__', 'constructor', ';', '=', '=cmd|calc', '@', ' ', 'a', 'input', 'tags'];
const junk = (r, n) => Array.from({ length: n }, () => ALPHABET[Math.floor(r() * ALPHABET.length)]).join('');

test('fuzz: importers never crash or hang on hostile CSV/JSON/JSONL (only clean errors), and never pollute prototypes', () => {
  const r = rng(1234);
  const started = Date.now();
  for (let i = 0; i < 1500; i++) {
    const format = ['csv', 'json', 'jsonl'][i % 3];
    const content = i % 5 === 0 ? junk(r, 5 + Math.floor(r() * 400)) : format === 'csv' ? `input,tags,expected\n${junk(r, 30)},${junk(r, 10)},${junk(r, 10)}\n${junk(r, 30)}` : format === 'json' ? `[${junk(r, 3)}{"input":"${junk(r, 20)}","tags":["${junk(r, 5)}"],"metadata":{"${junk(r, 4)}":${junk(r, 4)}}}]` : `{"input":"${junk(r, 15)}"}\n${junk(r, 25)}`;
    try { const { rawCases } = parseCases(format, content); normalizeCases(rawCases); }
    catch (e) { assert.ok(e instanceof Error && !/Cannot read|is not a function|undefined/.test(e.message), `unclean failure: ${e.message} for ${JSON.stringify(content).slice(0, 80)}`); }
  }
  assert.equal({}.polluted, undefined); assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'input'), false);
  assert.ok(Date.now() - started < 15_000, 'fuzz run too slow (possible ReDoS)');
});
test('fuzz: importers keep their hard limits (rows, size, depth)', () => {
  assert.throws(() => parseCases('json', JSON.stringify(Array.from({ length: 100_000 }, () => ({ input: 'x' })))));
  assert.throws(() => parseCases('csv', 'input\n' + 'x\n'.repeat(500_000)));
  assert.doesNotThrow(() => { const { rawCases } = parseCases('json', '['.repeat(50_000) + ']'.repeat(50_000)); const out = normalizeCases(rawCases); assert.equal(out.cases.length, 0); });   // hostile nesting: rejected as invalid, no stack overflow
  assert.throws(() => parseCases('xml', '<a/>'));
  assert.throws(() => parseCases('json', null));
  const t0 = Date.now(); try { parseCases('csv', '"'.repeat(200_000)); } catch { /* clean rejection is fine */ } assert.ok(Date.now() - t0 < 3000, 'pathological quotes must not be slow');
});
test('fuzz: trace validator and sanitizer survive arbitrary JSON shapes without throwing', () => {
  const r = rng(99);
  const rnd = (d = 0) => { const k = Math.floor(r() * 9); if (d > 5 || k < 3) return [null, true, 7, -1e308, 'x'.repeat(Math.floor(r() * 50)), junk(r, 8)][Math.floor(r() * 6)]; if (k < 6) return Array.from({ length: Math.floor(r() * 4) }, () => rnd(d + 1)); return Object.fromEntries(Array.from({ length: Math.floor(r() * 5) }, () => [junk(r, 3) || 'k', rnd(d + 1)])); };
  const base = JSON.parse(JSON.stringify(makeWorld().traceFor('a'.repeat(24))));
  for (let i = 0; i < 2000; i++) {
    const mutated = i % 2 ? rnd() : { ...base, ...Object.fromEntries(Object.keys(base).filter(() => r() < 0.3).map((k) => [k, rnd()])) };
    const v = validateTrace(mutated);
    assert.equal(typeof v.valid, 'boolean');
    if (!v.valid) assert.ok(Array.isArray(v.errors) && v.errors.length > 0);
    sanitize(mutated);
  }
  const cyc = {}; cyc.self = cyc;
  assert.doesNotThrow(() => validateTrace(cyc)); assert.doesNotThrow(() => sanitize({ a: cyc }));
  assert.doesNotThrow(() => { const deep = {}; let n = deep; for (let i = 0; i < 20000; i++) { n.x = {}; n = n.x; } validateTrace(deep); sanitize(deep); });
});
void crypto;
