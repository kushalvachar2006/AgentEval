// Minimal HS256 JWT using node:crypto (no dependency). Pins the algorithm; rejects anything else.
import crypto from 'node:crypto';
import { AppError } from '../middleware/errors.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sign = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest();
const ISS = 'agenteval';

export function signJwt(payload, { secret, ttlSeconds, now = Date.now }) {
  const iat = Math.floor(now() / 1000);
  const body = { ...payload, iss: ISS, iat, exp: iat + ttlSeconds };
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(body)}`;
  return `${data}.${sign(data, secret).toString('base64url')}`;
}

export function verifyJwt(token, { secret, now = Date.now }) {
  const bad = () => new AppError(401, 'INVALID_TOKEN', 'Invalid or expired token');
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw bad();
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { throw bad(); }
  if (header?.alg !== 'HS256' || header?.typ !== 'JWT') throw bad();
  const given = Buffer.from(parts[2], 'base64url');
  const expected = sign(`${parts[0]}.${parts[1]}`, secret);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw bad();
  if (payload.iss !== ISS || !Number.isFinite(payload.exp) || payload.exp * 1000 <= now()) throw bad();
  return payload;
}
