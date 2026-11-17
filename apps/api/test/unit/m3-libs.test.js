import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createSecretBox } from '../../src/lib/secretbox.js';
import { safeRequest, buildLookup } from '../../src/lib/safeHttp.js';
import { createEngineClient } from '../../src/lib/engineClient.js';
import { parseCsv, parseCases, normalizeCase, normalizeCases } from '../../src/modules/testSuites/importers.js';
import { loadConfig } from '../../src/config/env.js';
import { testEnv } from '../helpers/world.js';

const key = () => crypto.randomBytes(32).toString('base64');

test('secretbox: round trip, unique ciphertexts, tamper/wrong key fail, nothing readable', () => {
  const box = createSecretBox(key());
  const a = box.encrypt('sk-super-secret'), b = box.encrypt('sk-super-secret');
  assert.notEqual(a, b);
  assert.equal(a.includes('super'), false);
  assert.equal(box.decrypt(a), 'sk-super-secret');
  const parts = a.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => box.decrypt(parts.join('.')), /decryption failed/);
  assert.throws(() => createSecretBox(key()).decrypt(a), /decryption failed/);
  assert.throws(() => box.decrypt('garbage'), /decryption failed/);
  assert.throws(() => createSecretBox('c2hvcnQ='), /32 bytes/);
});

test('config: new defaults', () => {
  const c = loadConfig(testEnv());
  assert.equal(c.workerConcurrency, 2);
  assert.equal(c.maxCasesPerRun, 500);
  assert.equal(c.engineUrl, 'http://127.0.0.1:8000');
  assert.throws(() => loadConfig({ ...testEnv(), WORKER_CONCURRENCY: '0' }), /WORKER_CONCURRENCY/);
});

// ---------------- importers ----------------
test('csv parser: quotes, escaped quotes, newline in quotes, CRLF, BOM', () => {
  const { headers, rows } = parseCsv('\uFEFFinput,referenceAnswer\r\n"Hello, ""world""","line1\nline2"\r\nplain,x\r\n');
  assert.deepEqual(headers, ['input', 'referenceAnswer']);
  assert.deepEqual(rows, [{ input: 'Hello, "world"', referenceAnswer: 'line1\nline2' }, { input: 'plain', referenceAnswer: 'x' }]);
  assert.throws(() => parseCsv('input\n"unterminated'), /unterminated/);
  assert.throws(() => parseCsv(''), /empty/);
  assert.throws(() => parseCsv('input\n' + 'a\n'.repeat(20), { maxRows: 5 }), /more than 5 rows/);
});

test('csv import maps aliases, splits lists, parses JSON cells, reports ignored columns', () => {
  const csv = 'question,expected,context,required_elements,expectedToolCalls,tags,weird\n' +
    '"Find laptop","Acme Book 14","doc one||doc two","Acme||47,999","[{""name"":""search"",""args"":{""maxPrice"":50000}}]","a|b",zzz\n';
  const { rawCases, ignoredColumns } = parseCases('csv', csv);
  assert.deepEqual(ignoredColumns, ['weird']);
  const { cases, errors } = normalizeCases(rawCases);
  assert.deepEqual(errors, []);
  assert.deepEqual(cases[0].referenceEvidence, ['doc one', 'doc two']);
  assert.deepEqual(cases[0].requiredElements, ['Acme', '47,999']);
  assert.deepEqual(cases[0].expectedToolCalls, [{ name: 'search', args: { maxPrice: 50000 } }]);
  assert.deepEqual(cases[0].tags, ['a', 'b']);
  assert.throws(() => parseCases('csv', 'foo,bar\n1,2'), /input/);
  const bad = normalizeCases(parseCases('csv', 'input,constraints\nhi,{not json}').rawCases);
  assert.equal(bad.errors[0].path, 'constraints');
});

test('json import: array or {cases}; size, row and format limits', () => {
  assert.equal(parseCases('json', '[{"input":"a"}]').rawCases.length, 1);
  assert.equal(parseCases('json', '{"cases":[{"input":"a"},{"input":"b"}]}').rawCases.length, 2);
  assert.throws(() => parseCases('json', '{"x":1}'), /array of cases/);
  assert.throws(() => parseCases('json', 'nope'), /invalid JSON/);
  assert.throws(() => parseCases('xml', '<a/>'), /format/);
  assert.throws(() => parseCases('json', ''), /empty/);
  assert.throws(() => parseCases('json', '[' + '{"input":"a"},'.repeat(1001) + '{"input":"a"}]'), /more than 1000/);
  assert.throws(() => parseCases('json', 'x'.repeat(2 * 1024 * 1024 + 1)), /larger than/);
});

test('case validation: required input, unknown fields, types, limits, no regex constraints', () => {
  assert.equal(normalizeCase({ input: 'x' }).errors, undefined);
  const e = (raw) => normalizeCase(raw).errors.map((x) => `${x.path}:${x.message}`).join(' | ');
  assert.match(e({}), /input:is required/);
  assert.match(e({ input: 'x', bogus: 1 }), /bogus:unknown field/);
  assert.match(e({ input: 5 }), /input/);
  assert.match(e({ input: 'x'.repeat(20001) }), /at most 20000/);
  assert.match(e({ input: 'x', tags: Array(21).fill('t') }), /tags/);
  assert.match(e({ input: 'x', expectedToolCalls: [{ args: {} }] }), /name:is required/);
  assert.match(e({ input: 'x', expectedToolCalls: [{ name: 'a', order: -1 }] }), /order/);
  assert.match(e({ input: 'x', constraints: { regex: '(a+)+$' } }), /regular expressions are not supported/);
  assert.match(e({ input: 'x', constraints: { format: 'xml' } }), /format/);
  assert.match(e({ input: 'x', referenceEvidence: [5] }), /referenceEvidence/);
  assert.match(e({ input: 'x', metadata: 'no' }), /metadata/);
});

test('case sanitising: control chars stripped, secrets redacted, hostile keys rewritten', () => {
  const r = normalizeCase({ input: 'hi\u0000there\u0007', referenceEvidence: ['key is sk-abcdefghijklmnopqrstuvwxyz ok'], metadata: { '$where': 1, password: 'p' } });
  assert.equal(r.value.input, 'hithere');
  assert.equal(r.value.referenceEvidence[0].includes('sk-abc'), false);
  assert.equal(r.value.metadata['\uff04where'], 1);
  assert.equal(r.value.metadata.password, '[REDACTED]');
  assert.ok(r.redactions >= 2);
  const many = normalizeCases([{ input: 'ok' }, { nope: 1 }, { input: 'ok2' }]);
  assert.deepEqual([many.cases.length, many.errors.length, many.errors[0].row], [2, 2, 2]);
});

// ---------------- safeHttp ----------------
function listen(handler) {
  return new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res({ s, port: s.address().port, close: () => s.close() })); });
}

test('safeRequest: JSON round trip, headers and body arrive, status/text returned', async () => {
  let seen;
  const srv = await listen((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { seen = { method: req.method, headers: req.headers, body: b }; res.setHeader('content-type', 'application/json'); res.end('{"output":"hi"}'); }); });
  try {
    const r = await safeRequest(`http://127.0.0.1:${srv.port}/run`, { allowPrivate: true, headers: { 'content-type': 'application/json', authorization: 'Bearer t' }, body: { input: 'x' } });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { output: 'hi' });
    assert.equal(seen.method, 'POST');
    assert.equal(JSON.parse(seen.body).input, 'x');
    assert.equal(seen.headers.authorization, 'Bearer t');
  } finally { srv.close(); }
});

test('safeRequest: redirects are NOT followed, oversized responses abort, slow agents time out (retryable)', async () => {
  const srv = await listen((req, res) => {
    if (req.url === '/redir') { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/'); res.end(); }
    else if (req.url === '/big') { res.write('x'.repeat(5000)); res.write('y'.repeat(5000)); setTimeout(() => res.end(), 50); }
    else if (req.url === '/slow') { /* never answers */ }
    else res.end('ok');
  });
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    const r = await safeRequest(`${base}/redir`, { allowPrivate: true, body: {} });
    assert.equal(r.status, 302);                                        // handed back, never followed
    await assert.rejects(() => safeRequest(`${base}/big`, { allowPrivate: true, body: {}, maxBytes: 1000 }), (e) => e.name === 'UpstreamError' && !e.retryable && /larger than/.test(e.message));
    await assert.rejects(() => safeRequest(`${base}/slow`, { allowPrivate: true, body: {}, timeoutMs: 150 }), (e) => e.retryable && /timed out/.test(e.message));
  } finally { srv.close(); }
});

test('safeRequest: connection refused is retryable; SSRF guard blocks internal targets unless allowPrivate', async () => {
  await assert.rejects(() => safeRequest('http://127.0.0.1:1/', { allowPrivate: true, body: {}, timeoutMs: 1000 }), (e) => e.retryable);
  for (const u of ['http://127.0.0.1:8000/', 'http://localhost/', 'http://169.254.169.254/latest', 'http://[::1]/'])
    await assert.rejects(() => safeRequest(u, { body: {} }), { code: 'UNSAFE_ENDPOINT' }, u);
});

test('safeRequest pins DNS: connects to the validated address even though the hostname cannot be resolved', async () => {
  const srv = await listen((_req, res) => res.end('pinned-ok'));
  try {
    // 'agent.pin.test' does not exist in DNS. If the request succeeds, the pinned address was used instead of a fresh lookup.
    const r = await safeRequest(`http://agent.pin.test:${srv.port}/`, { body: {}, assertUrl: async (u) => ({ url: u, addresses: ['127.0.0.1'] }) });
    assert.equal(r.text, 'pinned-ok');
  } finally { srv.close(); }
  const lookup = buildLookup(['2606:4700::1111', '93.184.216.34']);
  lookup('x', {}, (err, addr, fam) => assert.deepEqual([err, addr, fam], [null, '2606:4700::1111', 6]));
  lookup('x', { all: true }, (err, list) => assert.deepEqual(list, [{ address: '2606:4700::1111', family: 6 }, { address: '93.184.216.34', family: 4 }]));
});

// ---------------- engineClient ----------------
test('engine client: success, retryable vs permanent errors, token header sent', async () => {
  let seenToken;
  const srv = await listen((req, res) => {
    seenToken = req.headers['x-engine-token'];
    if (req.url === '/v1/evaluate') {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        const p = JSON.parse(b);
        if (p.mode === 'bad') { res.statusCode = 400; return res.end('{"error":"payload.trace must be an object"}'); }
        if (p.mode === 'down') { res.statusCode = 503; return res.end('{}'); }
        if (p.mode === 'html') return res.end('<html>');
        res.end(JSON.stringify({ results: [], judgeCalls: 0 }));
      });
    } else res.end('{"evaluators":[]}');
  });
  const c = createEngineClient({ url: `http://127.0.0.1:${srv.port}`, token: 'tok-123', timeoutMs: 2000 });
  try {
    assert.deepEqual(await c.evaluate({ mode: 'ok' }), { results: [], judgeCalls: 0 });
    assert.equal(seenToken, 'tok-123');
    await assert.rejects(() => c.evaluate({ mode: 'bad' }), (e) => !e.retryable && e.status === 400 && /trace must be/.test(e.message));
    await assert.rejects(() => c.evaluate({ mode: 'down' }), (e) => e.retryable);
    await assert.rejects(() => c.evaluate({ mode: 'html' }), (e) => e.retryable && /invalid JSON/.test(e.message));
  } finally { srv.close(); }
  await assert.rejects(() => createEngineClient({ url: 'http://127.0.0.1:1', token: 'x', timeoutMs: 500 }).evaluate({}), (e) => e.retryable && /unreachable/.test(e.message));
});
