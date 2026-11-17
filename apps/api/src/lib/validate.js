import { AppError } from '../middleware/errors.js';

// Collects every problem so the client sees them all at once.
export function check() {
  const errors = [];
  const fail = (path, message) => { errors.push({ path, message }); return undefined; };
  return {
    errors,
    fail,
    str(value, path, { min = 1, max = 256, optional = false } = {}) {
      if (value === undefined || value === null) return optional ? undefined : fail(path, 'is required');
      if (typeof value !== 'string') return fail(path, 'must be a string');
      const s = value.trim();
      if (s.length < min || s.length > max) return fail(path, `must be ${min}-${max} characters`);
      return s;
    },
    oneOf(value, path, allowed, { optional = false, fallback } = {}) {
      if (value === undefined || value === null) return optional ? fallback : fail(path, 'is required');
      return allowed.includes(value) ? value : fail(path, `must be one of: ${allowed.join(', ')}`);
    },
    email(value, path) {
      const s = this.str(value, path, { max: 254 });
      if (s !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return fail(path, 'must be a valid email');
      return s?.toLowerCase();
    },
    obj(value, path, { maxBytes = 8192, optional = true } = {}) {
      if (value === undefined || value === null) return optional ? undefined : fail(path, 'is required');
      if (typeof value !== 'object' || Array.isArray(value)) return fail(path, 'must be an object');
      if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) return fail(path, `must be smaller than ${maxBytes} bytes`);
      return value;
    },
    done() {
      if (errors.length) throw new AppError(422, 'VALIDATION_ERROR', 'Request validation failed', errors);
    },
  };
}

// Express' query parser turns ?a[$ne]=x into objects. Only plain strings are accepted.
export function queryString(query, name) {
  const v = query?.[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new AppError(400, 'INVALID_QUERY', `Query parameter "${name}" must be a single string`);
  return v;
}

export function parseLimit(raw, { def = 20, max = 100 } = {}) {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new AppError(400, 'INVALID_QUERY', `limit must be an integer between 1 and ${max}`);
  return n;
}

export const encodeCursor = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
export function decodeCursor(raw) {
  if (raw === undefined) return undefined;
  try {
    const o = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (o && typeof o === 'object') return o;
  } catch { /* fall through */ }
  throw new AppError(400, 'INVALID_CURSOR', 'cursor is not valid');
}
