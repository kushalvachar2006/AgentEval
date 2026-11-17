import { AppError } from '../middleware/errors.js';
import { check, parseLimit, queryString, encodeCursor, decodeCursor } from '../lib/validate.js';
import { isId } from '../lib/ids.js';
import { requirePermission } from '../lib/rbac.js';
import { LIMITS, parseCases, normalizeCase, normalizeCases } from '../modules/testSuites/importers.js';

const publicSuite = (s) => ({ id: s.id, name: s.name, description: s.description ?? '', tags: s.tags ?? [], caseCount: s.caseCount ?? 0, createdAt: s.createdAt });
const publicCase = ({ organizationId, isDeleted, createdBy, updatedAt, ...c }) => c; // eslint-disable-line no-unused-vars

export function createTestSuiteService({ repos, audit }) {
  const orgOf = (p) => p.organizationId;
  async function suiteOr404(principal, id) {
    const s = isId(id) ? await repos.suites.get(orgOf(principal), id) : null;
    if (!s) throw new AppError(404, 'SUITE_NOT_FOUND', 'Test suite not found');
    return s;
  }
  async function addRows(principal, suite, rows) {
    if ((suite.caseCount ?? 0) + rows.length > LIMITS.maxSuiteCases) throw new AppError(422, 'SUITE_FULL', `A suite can hold at most ${LIMITS.maxSuiteCases} test cases`);
    const created = await repos.cases.insertMany(orgOf(principal), suite.id, rows, { startPosition: suite.caseCount ?? 0, createdBy: principal.userId });
    await repos.suites.incCases(orgOf(principal), suite.id, created.length);
    return created;
  }

  return {
    async create(principal, body) {
      requirePermission(principal, 'suites:write');
      const c = check();
      const name = c.str(body?.name, 'name', { max: 100 });
      const description = c.str(body?.description, 'description', { min: 0, max: 1000, optional: true });
      const tags = body?.tags === undefined ? [] : Array.isArray(body.tags) && body.tags.length <= 20 ? body.tags.map((t, i) => c.str(t, `tags[${i}]`, { max: 50 })).filter(Boolean) : (c.fail('tags', 'must be a list of at most 20 tags'), []);
      c.done();
      const s = await repos.suites.create(orgOf(principal), { name, description: description ?? '', tags, createdBy: principal.userId });
      await audit.log({ organizationId: orgOf(principal), actorId: principal.userId, action: 'suite.create', target: s.id });
      return publicSuite(s);
    },

    async list(principal, query = {}) {
      requirePermission(principal, 'suites:read');
      const limit = parseLimit(query.limit);
      const cur = decodeCursor(queryString(query, 'cursor'));
      if (cur && !isId(cur.id)) throw new AppError(400, 'INVALID_CURSOR', 'cursor is not valid');
      const { items, hasMore } = await repos.suites.list(orgOf(principal), { limit, cursorId: cur?.id });
      return { items: items.map(publicSuite), nextCursor: hasMore ? encodeCursor({ id: items.at(-1).id }) : null };
    },

    async get(principal, id, query = {}) {
      requirePermission(principal, 'suites:read');
      const suite = await suiteOr404(principal, id);
      const limit = parseLimit(query.limit, { def: 50, max: 200 });
      const cur = decodeCursor(queryString(query, 'cursor'));
      if (cur && !isId(cur.id)) throw new AppError(400, 'INVALID_CURSOR', 'cursor is not valid');
      const { items, hasMore } = await repos.cases.list(orgOf(principal), id, { limit, cursorId: cur?.id });
      return { ...publicSuite(suite), cases: { items: items.map(publicCase), nextCursor: hasMore ? encodeCursor({ id: items.at(-1).id }) : null } };
    },

    async addCase(principal, suiteId, body) {
      requirePermission(principal, 'suites:write');
      const suite = await suiteOr404(principal, suiteId);
      const r = normalizeCase(body, 0);
      if (r.errors) throw new AppError(422, 'VALIDATION_ERROR', 'Test case failed validation', r.errors.map(({ path, message }) => ({ path, message })));
      const [created] = await addRows(principal, suite, [r.value]);
      await audit.log({ organizationId: orgOf(principal), actorId: principal.userId, action: 'case.create', target: created.id });
      return publicCase(created);
    },

    async importCases(principal, suiteId, body) {
      requirePermission(principal, 'suites:write');
      const suite = await suiteOr404(principal, suiteId);
      let parsed;
      try { parsed = parseCases(body?.format, body?.content); } catch (e) { throw new AppError(422, 'INVALID_IMPORT', e.message); }
      const { cases, errors, redactions } = normalizeCases(parsed.rawCases);
      if (errors.length && body?.allowPartial !== true) {
        throw new AppError(422, 'IMPORT_ERRORS', `${errors.length} problem(s) found; nothing was imported (send "allowPartial": true to import the valid rows)`, errors.slice(0, 20));
      }
      if (!cases.length) throw new AppError(422, 'IMPORT_ERRORS', 'No valid test cases found', errors.slice(0, 20));
      await addRows(principal, suite, cases);
      await audit.log({ organizationId: orgOf(principal), actorId: principal.userId, action: 'case.import', target: suiteId, meta: { imported: cases.length, rejected: errors.length } });
      return { imported: cases.length, rejected: parsed.rawCases.length - cases.length, errors: errors.slice(0, 20), ignoredColumns: parsed.ignoredColumns, secretsRedacted: redactions };
    },

    async deleteCase(principal, suiteId, caseId) {
      requirePermission(principal, 'suites:write');
      const suite = await suiteOr404(principal, suiteId);
      if (!isId(caseId) || !(await repos.cases.softDelete(orgOf(principal), suite.id, caseId))) throw new AppError(404, 'CASE_NOT_FOUND', 'Test case not found');
      await repos.suites.incCases(orgOf(principal), suite.id, -1);
      await audit.log({ organizationId: orgOf(principal), actorId: principal.userId, action: 'case.delete', target: caseId });
    },
  };
}
