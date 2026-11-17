import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, isSensitiveKey } from '../../src/lib/redact.js';
import { check, queryString, parseLimit, encodeCursor, decodeCursor } from '../../src/lib/validate.js';
import { can, requirePermission } from '../../src/lib/rbac.js';
import { hasTenantFilter, hasTenantMatchStage } from '../../src/lib/tenant.js';

test('redacts by key name but keeps token COUNTS', () => {
  const r = sanitize({ password: 'p', api_key: 'k', apiKey: 'k', Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz', usage: { inputTokens: 5, max_tokens: 100, totalTokens: 9 }, nested: [{ client_secret: 'x' }] });
  assert.equal(r.value.password, '[REDACTED]');
  assert.equal(r.value.api_key, '[REDACTED]');
  assert.equal(r.value.apiKey, '[REDACTED]');
  assert.equal(r.value.Authorization, '[REDACTED]');
  assert.equal(r.value.nested[0].client_secret, '[REDACTED]');
  assert.deepEqual(r.value.usage, { inputTokens: 5, max_tokens: 100, totalTokens: 9 });
  assert.equal(r.redactions, 5);
  assert.equal(isSensitiveKey('totalTokens'), false);
});

test('redacts secret-looking values inside free text', () => {
  const text = 'use sk-abcdefghijklmnopqrstuvwx and AKIAABCDEFGHIJKLMNOP and Bearer abcdefghijklmnop1234 and ae_live_abcdefghijklmnopqrstuv ok';
  const { value, redactions } = sanitize({ msg: text, jwt: 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghijkl' });
  assert.equal(redactions, 5);
  assert.equal(/sk-|AKIA|Bearer|ae_live|eyJ/.test(JSON.stringify(value)), false);
});

test('truncates huge strings, limits depth, rewrites dangerous keys', () => {
  const big = 'a'.repeat(100);
  const r = sanitize({ big, '$where': 1, 'a.b': 2, '': 3, deep: { l1: { l2: { l3: 1 } } } }, { maxStringLen: 10, maxDepth: 3 });
  assert.match(r.value.big, /^a{10}…\[truncated 90 chars\]$/);
  assert.equal('$where' in r.value, false);
  assert.equal(r.value['\uff04where'], 1);
  assert.equal(r.value['a\uff0eb'], 2);
  assert.equal(r.value._empty, 3);
  assert.equal(r.value.deep.l1.l2, '[DEPTH_LIMIT]');
  const proto = sanitize(JSON.parse('{"__proto__": {"x": 1}}'));
  assert.equal(Object.getPrototypeOf(proto.value), Object.prototype);
  assert.equal(proto.keysRewritten, 1);
});

test('validator collects all errors', () => {
  const c = check();
  c.str(undefined, 'name');
  c.email('nope', 'email');
  c.oneOf('x', 'framework', ['a', 'b']);
  assert.throws(() => c.done(), (e) => e.code === 'VALIDATION_ERROR' && e.details.length === 3);
  const ok = check();
  assert.equal(ok.email('  A@B.io ', 'e'), 'a@b.io');
  assert.doesNotThrow(() => ok.done());
});

test('query helpers reject operator injection and bad limits/cursors', () => {
  assert.throws(() => queryString({ name: { $ne: 'x' } }, 'name'), { code: 'INVALID_QUERY' });
  assert.throws(() => queryString({ name: ['a', 'b'] }, 'name'), { code: 'INVALID_QUERY' });
  assert.equal(queryString({}, 'name'), undefined);
  assert.equal(parseLimit(undefined), 20);
  for (const bad of ['0', '101', 'abc', '1.5']) assert.throws(() => parseLimit(bad), { code: 'INVALID_QUERY' });
  assert.deepEqual(decodeCursor(encodeCursor({ id: 'x' })), { id: 'x' });
  assert.throws(() => decodeCursor('!!!'), { code: 'INVALID_CURSOR' });
});

test('rbac: roles and api-key scopes', () => {
  const viewer = { type: 'user', role: 'viewer' }, member = { type: 'user', role: 'member' }, admin = { type: 'user', role: 'admin' };
  assert.equal(can(viewer, 'agents:read'), true);
  assert.equal(can(viewer, 'agents:write'), false);
  assert.equal(can(member, 'agents:write'), true);
  assert.equal(can(member, 'keys:manage'), false);
  assert.equal(can(admin, 'keys:manage'), true);
  assert.equal(can({ type: 'user', role: 'hacker' }, 'agents:read'), false);
  const key = { type: 'apiKey', scopes: ['traces:write'] };
  assert.equal(can(key, 'traces:write'), true);
  assert.equal(can(key, 'traces:read'), false);
  assert.throws(() => requirePermission(key, 'keys:manage'), { code: 'FORBIDDEN' });
  assert.equal(can(null, 'agents:read'), false);
});

test('tenant filter guard accepts only plain equality on organizationId', () => {
  assert.equal(hasTenantFilter({ organizationId: 'abc', x: 1 }), true);
  for (const bad of [{}, null, { organizationId: null }, { organizationId: { $ne: 'abc' } }, { organizationId: { $in: ['a'] } }, { $or: [{ organizationId: 'a' }] }, { organizationId: '' }])
    assert.equal(hasTenantFilter(bad), false, JSON.stringify(bad));
  assert.equal(hasTenantMatchStage([{ $match: { organizationId: 'a' } }, { $group: {} }]), true);
  assert.equal(hasTenantMatchStage([{ $group: {} }]), false);
});
