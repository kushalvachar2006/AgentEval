import crypto from 'node:crypto';

const N = 32768, R = 8, P = 1, KEYLEN = 64;
const scrypt = (pw, salt, n, r, p, len) =>
  new Promise((res, rej) => crypto.scrypt(pw, salt, len, { N: n, r, p, maxmem: 128 * n * r * 2 }, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, N, R, P, KEYLEN);
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [alg, n, r, p, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt' || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Used so "unknown email" costs the same time as "wrong password" (no account enumeration by timing).
let dummy;
export async function dummyVerify(password) {
  dummy ??= await hashPassword('agenteval-dummy-password');
  await verifyPassword(password, dummy);
  return false;
}

export const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function generateApiKey() {
  const key = `ae_live_${crypto.randomBytes(32).toString('base64url')}`;
  return { key, keyHash: sha256Hex(key), keyPrefix: key.slice(0, 12) };
}
export const API_KEY_RE = /^ae_live_[A-Za-z0-9_-]{43}$/;
