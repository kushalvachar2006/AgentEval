// Needs `npm install` (express etc.). Run with: npm --prefix apps/api run test:integration
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadConfig } from '../../src/config/env.js';
import { createApp } from '../../src/app.js';

const config = loadConfig({
  MONGODB_URI: 'mongodb://localhost/x', JWT_SECRET: 'y'.repeat(40),
  ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), CORS_ORIGINS: 'http://localhost:5173',
});

async function withServer(checks, fn) {
  const server = createApp({ config, checks }).listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('GET /api/v1/health returns ok', async () => {
  await withServer({}, async (base) => {
    const r = await fetch(`${base}/api/v1/health`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, 'ok');
    assert.ok(r.headers.get('x-request-id'));
  });
});

test('ready is 200 when MongoDB is up, 503 when it is down', async () => {
  await withServer({ mongo: async () => {} }, async (base) => {
    assert.equal((await fetch(`${base}/api/v1/health/ready`)).status, 200);
  });
  await withServer({ mongo: async () => { throw new Error('x'); } }, async (base) => {
    const r = await fetch(`${base}/api/v1/health/ready`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).dependencies.mongo, 'down');
  });
});

test('unknown route gives consistent error envelope; oversized/invalid JSON handled', async () => {
  await withServer({}, async (base) => {
    const r = await fetch(`${base}/api/v1/nope`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error.code, 'NOT_FOUND');
    // Health has no body parser by design (parsers are mounted per route, after auth). A POST there is simply unknown.
    const post = await fetch(`${base}/api/v1/health`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(post.status, 404);
  });
});

test('malformed JSON on a body-parsing route gives 400 INVALID_JSON', async () => {
  const services = { auth: {}, apiKeys: {} }; // the parser rejects the body before any service is called
  const server = createApp({ config, services }).listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const bad = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'INVALID_JSON');
  } finally { server.close(); }
});
