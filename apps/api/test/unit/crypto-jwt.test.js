import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, generateApiKey, API_KEY_RE, sha256Hex } from '../../src/lib/crypto.js';
import { signJwt, verifyJwt } from '../../src/lib/jwt.js';
import crypto from 'node:crypto';

test('password hashing: verifies right password, rejects wrong, salts differ', async () => {
  const a = await hashPassword('correct horse battery');
  const b = await hashPassword('correct horse battery');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('correct horse battery', a), true);
  assert.equal(await verifyPassword('wrong', a), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
  assert.equal(a.includes('correct'), false);
});

test('api keys: format, uniqueness, hash stored not key', () => {
  const k1 = generateApiKey(), k2 = generateApiKey();
  assert.match(k1.key, API_KEY_RE);
  assert.notEqual(k1.key, k2.key);
  assert.equal(k1.keyHash, sha256Hex(k1.key));
  assert.equal(k1.keyPrefix, k1.key.slice(0, 12));
});

const opts = { secret: 's'.repeat(40), ttlSeconds: 60 };
test('jwt: round trip', () => {
  const t = signJwt({ sub: 'u1' }, opts);
  assert.equal(verifyJwt(t, opts).sub, 'u1');
});
test('jwt: rejects expired, tampered, wrong secret, alg none, garbage', () => {
  const now = Date.now();
  const t = signJwt({ sub: 'u1' }, { ...opts, now: () => now });
  assert.throws(() => verifyJwt(t, { secret: opts.secret, now: () => now + 61_000 }), { code: 'INVALID_TOKEN' });
  const [h, p, s] = t.split('.');
  const evil = Buffer.from(JSON.stringify({ sub: 'admin', iss: 'agenteval', exp: 9999999999 })).toString('base64url');
  assert.throws(() => verifyJwt(`${h}.${evil}.${s}`, opts), { code: 'INVALID_TOKEN' });
  assert.throws(() => verifyJwt(t, { secret: 'o'.repeat(40) }), { code: 'INVALID_TOKEN' });
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
  assert.throws(() => verifyJwt(none, opts), { code: 'INVALID_TOKEN' });
  for (const g of ['', 'a.b', 'a.b.c', null, undefined]) assert.throws(() => verifyJwt(g, opts), { code: 'INVALID_TOKEN' });
});
test('jwt: HS256 token signed with a different alg header is rejected even with valid MAC', () => {
  const hdr = Buffer.from('{"alg":"HS512","typ":"JWT"}').toString('base64url');
  const pl = Buffer.from(JSON.stringify({ iss: 'agenteval', exp: 9999999999 })).toString('base64url');
  const sig = crypto.createHmac('sha256', opts.secret).update(`${hdr}.${pl}`).digest('base64url');
  assert.throws(() => verifyJwt(`${hdr}.${pl}.${sig}`, opts), { code: 'INVALID_TOKEN' });
});
