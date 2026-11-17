import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from '../helpers/world.js';

test('register creates user + org (owner) and returns a working token; password never stored in clear', async () => {
  const w = makeWorld();
  const r = await w.signup('alice');
  assert.equal(r.organizations[0].role, 'owner');
  assert.equal(r.principal.role, 'owner');
  assert.equal(JSON.stringify(w.repos._db.users).includes('correct-horse-1'), false);
  assert.equal(r.user.passwordHash, undefined);
});

test('register validates input and rejects duplicate email', async () => {
  const w = makeWorld();
  await assert.rejects(() => w.services.auth.register({ email: 'bad', password: 'short', name: '', organizationName: '' }), (e) => e.code === 'VALIDATION_ERROR' && e.details.length >= 4);
  await w.signup('bob');
  await assert.rejects(() => w.services.auth.register({ email: 'BOB@example.com', password: 'correct-horse-1', name: 'x', organizationName: 'y' }), { code: 'EMAIL_IN_USE' });
});

test('login: right password works, wrong password / unknown email give the SAME error', async () => {
  const w = makeWorld();
  await w.signup('carol');
  const ok = await w.services.auth.login({ email: 'Carol@Example.com', password: 'correct-horse-1' });
  assert.ok(ok.token);
  const wrong = await w.services.auth.login({ email: 'carol@example.com', password: 'nope-nope-nope' }).catch((e) => e);
  const unknown = await w.services.auth.login({ email: 'ghost@example.com', password: 'nope-nope-nope' }).catch((e) => e);
  assert.equal(wrong.code, 'INVALID_CREDENTIALS');
  assert.equal(unknown.code, 'INVALID_CREDENTIALS');
  assert.equal(wrong.message, unknown.message);
  assert.equal(w.repos._db.audit.filter((a) => a.action === 'user.login_failed').length, 2);
  assert.equal(JSON.stringify(w.repos._db.audit).includes('nope-nope'), false);
});

test('disabled user cannot log in or use an existing token', async () => {
  const w = makeWorld();
  const r = await w.signup('dave');
  w.repos._db.users[0].disabled = true;
  await assert.rejects(() => w.services.auth.login({ email: r.email, password: 'correct-horse-1' }), { code: 'INVALID_CREDENTIALS' });
  await assert.rejects(() => w.services.auth.authenticateUser(r.token), { code: 'INVALID_TOKEN' });
});

test('client-supplied organization id is verified against membership', async () => {
  const w = makeWorld();
  const a = await w.signup('erin'), b = await w.signup('frank');
  const own = await w.services.auth.authenticateUser(a.token, a.organizations[0].id);
  assert.equal(own.organizationId, a.organizations[0].id);
  await assert.rejects(() => w.services.auth.authenticateUser(a.token, b.organizations[0].id), { code: 'FORBIDDEN_ORG' });
  await assert.rejects(() => w.services.auth.authenticateUser(a.token, 'not-an-id'), { code: 'FORBIDDEN_ORG' });
  // two orgs -> header becomes mandatory
  w.repos._db.orgs.find((o) => o.id === b.organizations[0].id).members.push({ userId: a.user.id, role: 'viewer' });
  await assert.rejects(() => w.services.auth.authenticateUser(a.token), { code: 'ORG_REQUIRED' });
  assert.equal((await w.services.auth.authenticateUser(a.token, b.organizations[0].id)).role, 'viewer');
});

test('tampered or garbage token rejected', async () => {
  const w = makeWorld();
  const r = await w.signup('gina');
  await assert.rejects(() => w.services.auth.authenticateUser(r.token.slice(0, -2) + 'xx'), { code: 'INVALID_TOKEN' });
  await assert.rejects(() => w.services.auth.authenticateUser('garbage'), { code: 'INVALID_TOKEN' });
});
