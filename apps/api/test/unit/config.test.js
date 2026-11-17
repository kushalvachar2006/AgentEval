import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadConfig } from '../../src/config/env.js';

const good = () => ({
  MONGODB_URI: 'mongodb://u:p@localhost:27017/agenteval?authSource=admin',
  JWT_SECRET: 'x'.repeat(40),
  ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
});

test('loads a valid config with defaults', () => {
  const c = loadConfig(good());
  assert.equal(c.port, 4000);
  assert.equal(c.bodyLimitKb, 1024);
  assert.equal(Object.isFrozen(c), true);
});

test('reports every missing variable by name', () => {
  assert.throws(() => loadConfig({}), (e) => e.code === 'INVALID_CONFIG' && ['MONGODB_URI', 'JWT_SECRET', 'ENCRYPTION_KEY'].every((n) => e.message.includes(n)));
});

test('rejects short JWT secret, bad key length, bad port - without echoing secret values', () => {
  const env = { ...good(), JWT_SECRET: 'shortsecret', ENCRYPTION_KEY: Buffer.from('tooshort').toString('base64'), PORT: '-5' };
  try { loadConfig(env); assert.fail('should throw'); } catch (e) {
    assert.match(e.message, /JWT_SECRET/);
    assert.match(e.message, /ENCRYPTION_KEY/);
    assert.match(e.message, /PORT/);
    assert.equal(e.message.includes('shortsecret'), false);
  }
});
