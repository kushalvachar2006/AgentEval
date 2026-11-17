import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, CASES } from '../helpers/world.js';

test('suites: create, duplicate name, list/get with pagination, isolation, RBAC', async () => {
  const w = makeWorld();
  const A = await w.signup('orga'), B = await w.signup('orgb');
  const s = await w.services.suites.create(A.principal, { name: 'regression', description: 'd', tags: ['core'] });
  await assert.rejects(() => w.services.suites.create(A.principal, { name: 'regression' }), { code: 'SUITE_NAME_EXISTS' });
  await w.services.suites.create(B.principal, { name: 'regression' }); // same name in another org is fine
  await assert.rejects(() => w.services.suites.create(A.principal, { name: '' }), { code: 'VALIDATION_ERROR' });
  for (let i = 0; i < 5; i++) await w.services.suites.addCase(A.principal, s.id, { input: `q${i}` });
  const seen = []; let cursor;
  for (let g = 0; g < 10; g++) {
    const page = await w.services.suites.get(A.principal, s.id, { limit: '2', ...(cursor && { cursor }) });
    seen.push(...page.cases.items.map((c) => c.input));
    if (!(cursor = page.cases.nextCursor)) break;
  }
  assert.deepEqual(seen, ['q0', 'q1', 'q2', 'q3', 'q4']);
  assert.equal((await w.services.suites.get(A.principal, s.id)).caseCount, 5);
  await assert.rejects(() => w.services.suites.get(B.principal, s.id), { code: 'SUITE_NOT_FOUND' });
  await assert.rejects(() => w.services.suites.addCase(B.principal, s.id, { input: 'x' }), { code: 'SUITE_NOT_FOUND' });
  assert.equal((await w.services.suites.list(B.principal)).items.length, 1);
  const viewer = { ...A.principal, role: 'viewer' };
  await w.services.suites.get(viewer, s.id);
  await assert.rejects(() => w.services.suites.create(viewer, { name: 'x' }), { code: 'FORBIDDEN' });
  await assert.rejects(() => w.services.suites.addCase(viewer, s.id, { input: 'x' }), { code: 'FORBIDDEN' });
});

test('add case: validation errors carry paths; created case has no internal fields', async () => {
  const w = makeWorld();
  const { principal } = await w.signup();
  const s = await w.services.suites.create(principal, { name: 's' });
  await assert.rejects(() => w.services.suites.addCase(principal, s.id, { input: 'x', constraints: { regex: 'a+' } }), (e) => e.code === 'VALIDATION_ERROR' && e.details[0].path === 'constraints.regex');
  const c = await w.services.suites.addCase(principal, s.id, { input: 'x', referenceEvidence: ['key sk-abcdefghijklmnopqrstuvwxyz'], tags: ['a'] });
  assert.equal(c.organizationId, undefined);
  assert.equal(JSON.stringify(c).includes('sk-abc'), false);
});

test('import JSON/CSV: all-or-nothing by default, allowPartial, limits, suite cap', async () => {
  const w = makeWorld();
  const { principal } = await w.signup();
  const s = await w.services.suites.create(principal, { name: 's' });
  const ok = await w.services.suites.importCases(principal, s.id, { format: 'json', content: JSON.stringify(CASES) });
  assert.deepEqual([ok.imported, ok.rejected], [3, 0]);
  const mixed = JSON.stringify([{ input: 'good' }, { nope: 1 }, { input: 'good2' }]);
  await assert.rejects(() => w.services.suites.importCases(principal, s.id, { format: 'json', content: mixed }), (e) => e.code === 'IMPORT_ERRORS' && e.details[0].row === 2);
  assert.equal((await w.services.suites.get(principal, s.id)).caseCount, 3);          // nothing imported
  const part = await w.services.suites.importCases(principal, s.id, { format: 'json', content: mixed, allowPartial: true });
  assert.deepEqual([part.imported, part.rejected], [2, 1]);
  const csv = await w.services.suites.importCases(principal, s.id, { format: 'csv', content: 'input,referenceAnswer,tags\n"a, b",x,"t1|t2"\n' });
  assert.equal(csv.imported, 1);
  await assert.rejects(() => w.services.suites.importCases(principal, s.id, { format: 'csv', content: 'foo\n1' }), { code: 'INVALID_IMPORT' });
  await assert.rejects(() => w.services.suites.importCases(principal, s.id, { format: 'exe', content: 'x' }), { code: 'INVALID_IMPORT' });
  await assert.rejects(() => w.services.suites.importCases(principal, s.id, { format: 'json', content: '[]' }), { code: 'IMPORT_ERRORS' });
  w.repos._db.suites[0].caseCount = 4999;
  await assert.rejects(() => w.services.suites.addCase(principal, s.id, { input: 'x' }).then(() => w.services.suites.addCase(principal, s.id, { input: 'y' })), { code: 'SUITE_FULL' });
});

test('delete case is a soft delete: hidden from lists, still readable by id (old runs stay reproducible)', async () => {
  const w = makeWorld();
  const { principal } = await w.signup();
  const s = await w.services.suites.create(principal, { name: 's' });
  const c = await w.services.suites.addCase(principal, s.id, { input: 'keep me reproducible' });
  await w.services.suites.deleteCase(principal, s.id, c.id);
  assert.equal((await w.services.suites.get(principal, s.id)).cases.items.length, 0);
  assert.equal((await w.services.suites.get(principal, s.id)).caseCount, 0);
  assert.equal((await w.repos.cases.get(principal.organizationId, c.id)).input, 'keep me reproducible');
  await assert.rejects(() => w.services.suites.deleteCase(principal, s.id, c.id), { code: 'CASE_NOT_FOUND' });
});

test('judge config: key encrypted at rest and never returned; keep/clear semantics; admin only; SSRF guard; validation', async () => {
  const w = makeWorld();
  const { principal } = await w.signup();
  assert.equal((await w.services.evaluatorConfig.get(principal)).judge.enabled, false);
  const saved = await w.services.evaluatorConfig.put(principal, { judge: { enabled: true, provider: 'openai_compatible', model: 'gpt-x', baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-live-very-secret-key', temperature: 0 } });
  assert.deepEqual([saved.judge.hasApiKey, saved.judge.baseUrl, saved.judge.apiKey], [true, 'https://api.example.com/v1', undefined]);
  assert.equal(JSON.stringify(w.repos._db.evalConfigs).includes('very-secret'), false);
  assert.equal(JSON.stringify(await w.services.evaluatorConfig.get(principal)).includes('secret'), false);
  const j = await w.services.evaluatorConfig.judgeFor(principal.organizationId);
  assert.deepEqual([j.apiKey, j.model, j.temperature], ['sk-live-very-secret-key', 'gpt-x', 0]);

  await w.services.evaluatorConfig.put(principal, { judge: { enabled: true, provider: 'openai_compatible', model: 'gpt-y' } });   // key omitted -> kept
  assert.equal((await w.services.evaluatorConfig.judgeFor(principal.organizationId)).apiKey, 'sk-live-very-secret-key');
  await w.services.evaluatorConfig.put(principal, { judge: { enabled: true, provider: 'openai_compatible', model: 'gpt-y', clearApiKey: true } });
  assert.equal((await w.services.evaluatorConfig.judgeFor(principal.organizationId)).apiKey, '');
  await w.services.evaluatorConfig.put(principal, { judge: { enabled: false } });
  assert.equal(await w.services.evaluatorConfig.judgeFor(principal.organizationId), null);

  await assert.rejects(() => w.services.evaluatorConfig.put({ ...principal, role: 'member' }, { judge: { enabled: false } }), { code: 'FORBIDDEN' });
  await assert.rejects(() => w.services.evaluatorConfig.put(principal, { judge: { enabled: true, provider: 'openai_compatible', model: 'm', baseUrl: 'http://169.254.169.254/' } }), { code: 'UNSAFE_ENDPOINT' });
  for (const bad of [{ enabled: true }, { enabled: true, provider: 'x', model: 'm' }, { enabled: 'yes' }, { enabled: true, provider: 'anthropic', model: 'm' }, { enabled: false, temperature: 9 }, { enabled: false, apiKey: 'short' }])
    await assert.rejects(() => w.services.evaluatorConfig.put(principal, { judge: bad }), { code: 'VALIDATION_ERROR' }, JSON.stringify(bad));
  const B = await w.signup('other');
  assert.equal((await w.services.evaluatorConfig.get(B.principal)).judge.enabled, false);       // other org untouched
});

test('agent endpoint token: encrypted, never exposed, only for api agents', async () => {
  const w = makeWorld();
  const { principal } = await w.signup();
  const a = await w.newAgent(principal, 'callable', { integrationType: 'api', endpointUrl: 'https://agent.example.com/run', endpointToken: 'agent-secret-token' });
  assert.equal(a.hasEndpointToken, true);
  assert.equal(JSON.stringify(a).includes('agent-secret'), false);
  assert.equal(JSON.stringify(w.repos._db.agents).includes('agent-secret'), false);
  assert.equal(w.services.secrets.decrypt(w.repos._db.agents[0].endpointTokenEnc), 'agent-secret-token');
  const cleared = await w.services.agents.update(principal, a.id, { clearEndpointToken: true });
  assert.equal(cleared.hasEndpointToken, false);
  const sdk = await w.newAgent(principal, 'sdk-agent');
  await assert.rejects(() => w.services.agents.update(principal, sdk.id, { endpointToken: 'whatever-token' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(() => w.newAgent(principal, 'bad', { endpointToken: 'x-12345678' }), { code: 'VALIDATION_ERROR' });
});
