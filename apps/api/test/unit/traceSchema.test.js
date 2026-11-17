import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateTrace } from '../../src/modules/traces/traceSchema.js';

const dir = new URL('../../../../packages/trace-schema/fixtures/', import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));

function applyOps(trace, ops) {
  const t = structuredClone(trace);
  for (const op of ops) {
    const keys = op.path.split('.');
    let cur = t;
    for (const k of keys.slice(0, -1)) cur = cur[k];
    const last = keys.at(-1);
    if (op.delete) delete cur[last]; else cur[last] = op.value;
  }
  return t;
}

test('valid fixture is accepted', () => {
  const r = validateTrace(load('valid-trace.json'));
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid, true);
});

for (const c of load('invalid-cases.json')) {
  test(`rejects: ${c.name}`, () => {
    const r = validateTrace(applyOps(load('valid-trace.json'), c.ops));
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.path.includes(c.expectPath)), `expected an error at "${c.expectPath}", got ${JSON.stringify(r.errors)}`);
  });
}

test('rejects non-object input and span flood', () => {
  assert.equal(validateTrace(null).valid, false);
  assert.equal(validateTrace(load('valid-trace.json'), { maxSpans: 2 }).valid, false);
});
