// Parsing + validation of test cases (manual, JSON and CSV import). Everything here treats input as hostile:
// hard size/row limits, no regex execution, control characters stripped, secrets redacted, unknown fields rejected.
import { sanitize } from '../../lib/redact.js';

export const LIMITS = { maxBytes: 2 * 1024 * 1024, maxRows: 1000, maxCaseBytes: 256 * 1024, maxInput: 20_000, maxText: 50_000, maxSuiteCases: 5000 };
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const FORMATS = ['json', 'csv'];
const CONSTRAINT_FORMATS = ['json', 'single_line', 'bullet_list'];

// ---------- CSV (RFC 4180 subset: quotes, "" escapes, CRLF, newlines inside quotes, BOM) ----------
export function parseCsv(text, { maxRows = LIMITS.maxRows } = {}) {
  const src = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false, i = 0;
  const endRow = () => { row.push(field); field = ''; if (row.some((c) => c !== '')) rows.push(row); row = []; if (rows.length > maxRows + 1) throw new Error(`more than ${maxRows} rows`); };
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i += 2; continue; } inQuotes = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { endRow(); i++; continue; }
    field += ch; i++;
  }
  if (inQuotes) throw new Error('unterminated quoted field');
  if (field !== '' || row.length) endRow();
  if (!rows.length) throw new Error('CSV is empty');
  const headers = rows[0].map((h) => h.trim());
  return { headers, rows: rows.slice(1).map((r) => Object.fromEntries(headers.map((h, idx) => [h, r[idx] ?? '']))) };
}

const ALIASES = {
  input: ['input', 'prompt', 'question'], referenceAnswer: ['referenceanswer', 'reference_answer', 'expected', 'expected_answer', 'answer'],
  referenceEvidence: ['referenceevidence', 'reference_evidence', 'evidence', 'context'], expectedBehavior: ['expectedbehavior', 'expected_behavior'],
  evaluationCriteria: ['evaluationcriteria', 'evaluation_criteria', 'criteria'], requiredElements: ['requiredelements', 'required_elements'],
  expectedToolCalls: ['expectedtoolcalls', 'expected_tool_calls'], constraints: ['constraints'], tags: ['tags'], metadata: ['metadata'],
};
const LISTY = new Set(['referenceEvidence', 'evaluationCriteria', 'requiredElements']);
const JSONY = new Set(['expectedToolCalls', 'constraints', 'metadata']);

export function csvRowToRaw(row, headerMap) {
  const raw = {};
  for (const [field, header] of Object.entries(headerMap)) {
    const v = (row[header] ?? '').trim();
    if (v === '') continue;
    if (LISTY.has(field)) raw[field] = v.split('||').map((s) => s.trim()).filter(Boolean);
    else if (field === 'tags') raw[field] = v.split(/[|,]/).map((s) => s.trim()).filter(Boolean);
    else if (JSONY.has(field)) { try { raw[field] = JSON.parse(v); } catch { raw[`__badjson_${field}`] = true; } }
    else raw[field] = v;
  }
  return raw;
}

// ---------- entry point ----------
export function parseCases(format, content) {
  if (!FORMATS.includes(format)) throw new Error(`format must be one of: ${FORMATS.join(', ')}`);
  if (typeof content !== 'string' || !content.trim()) throw new Error('content is empty');
  if (Buffer.byteLength(content) > LIMITS.maxBytes) throw new Error(`content is larger than ${LIMITS.maxBytes} bytes`);
  if (format === 'json') {
    let data;
    try { data = JSON.parse(content); } catch (e) { throw new Error(`invalid JSON: ${e.message.slice(0, 100)}`); }
    const arr = Array.isArray(data) ? data : Array.isArray(data?.cases) ? data.cases : null;
    if (!arr) throw new Error('JSON must be an array of cases or {"cases": [...]}');
    if (arr.length > LIMITS.maxRows) throw new Error(`more than ${LIMITS.maxRows} cases`);
    return { rawCases: arr, ignoredColumns: [] };
  }
  const { headers, rows } = parseCsv(content);
  const headerMap = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    const h = headers.find((x) => names.includes(x.toLowerCase().replace(/[\s-]/g, '_')) || names.includes(x.toLowerCase()));
    if (h) headerMap[field] = h;
  }
  if (!headerMap.input) throw new Error('CSV needs an "input" column (aliases: prompt, question)');
  const used = new Set(Object.values(headerMap));
  return { rawCases: rows.map((r) => csvRowToRaw(r, headerMap)), ignoredColumns: headers.filter((h) => h && !used.has(h)) };
}

// ---------- per-case validation ----------
const clean = (s) => s.replace(CONTROL, '');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function normalizeCase(raw, index = 0) {
  const errors = [];
  const bad = (path, message) => errors.push({ row: index + 1, path, message });
  if (!isObj(raw)) return { errors: [{ row: index + 1, path: '', message: 'case must be an object' }] };
  const allowed = new Set(Object.keys(ALIASES));
  for (const k of Object.keys(raw)) {
    if (k.startsWith('__badjson_')) bad(k.slice(10), 'is not valid JSON');
    else if (!allowed.has(k)) bad(k, 'unknown field');
  }
  const str = (v, path, max, { optional = true } = {}) => {
    if (v === undefined || v === null || v === '') { if (!optional) bad(path, 'is required'); return undefined; }
    if (typeof v !== 'string') { bad(path, 'must be a string'); return undefined; }
    if (v.length > max) { bad(path, `must be at most ${max} characters`); return undefined; }
    return clean(v);
  };
  const strList = (v, path, { maxItems, maxLen }) => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length > maxItems) { bad(path, `must be a list of at most ${maxItems} items`); return undefined; }
    return v.map((x, i) => str(x, `${path}[${i}]`, maxLen, { optional: false })).filter((x) => x !== undefined);
  };

  const out = {};
  if (typeof raw.input === 'object' && raw.input !== null) {
    out.input = JSON.stringify(raw.input).length <= LIMITS.maxInput && isObj(raw.input) ? raw.input : (bad('input', 'object input must be a small JSON object'), undefined);
  } else out.input = str(raw.input, 'input', LIMITS.maxInput, { optional: false });
  out.referenceAnswer = str(raw.referenceAnswer, 'referenceAnswer', LIMITS.maxInput);
  out.expectedBehavior = str(raw.expectedBehavior, 'expectedBehavior', 2000);
  out.evaluationCriteria = strList(raw.evaluationCriteria, 'evaluationCriteria', { maxItems: 20, maxLen: 500 });
  out.tags = strList(raw.tags, 'tags', { maxItems: 20, maxLen: 50 });

  if (raw.referenceEvidence !== undefined) {
    if (!Array.isArray(raw.referenceEvidence) || raw.referenceEvidence.length > 50) bad('referenceEvidence', 'must be a list of at most 50 items');
    else out.referenceEvidence = raw.referenceEvidence.map((e, i) => {
      if (typeof e === 'string') return str(e, `referenceEvidence[${i}]`, LIMITS.maxText, { optional: false });
      if (isObj(e)) { const text = str(e.text, `referenceEvidence[${i}].text`, LIMITS.maxText, { optional: false }); const source = str(e.source, `referenceEvidence[${i}].source`, 100); return text === undefined ? undefined : { text, ...(source && { source }) }; }
      bad(`referenceEvidence[${i}]`, 'must be a string or {source, text}'); return undefined;
    }).filter(Boolean);
  }
  if (raw.requiredElements !== undefined) {
    if (!Array.isArray(raw.requiredElements) || raw.requiredElements.length > 50) bad('requiredElements', 'must be a list of at most 50 items');
    else out.requiredElements = raw.requiredElements.map((e, i) => {
      if (typeof e === 'string') return str(e, `requiredElements[${i}]`, 500, { optional: false });
      if (isObj(e)) { const text = str(e.text, `requiredElements[${i}].text`, 500, { optional: false }); const alternatives = strList(e.alternatives ?? [], `requiredElements[${i}].alternatives`, { maxItems: 10, maxLen: 500 }); return text === undefined ? undefined : { text, alternatives }; }
      bad(`requiredElements[${i}]`, 'must be a string or {text, alternatives}'); return undefined;
    }).filter(Boolean);
  }
  if (raw.expectedToolCalls !== undefined) {
    if (!Array.isArray(raw.expectedToolCalls) || raw.expectedToolCalls.length > 20) bad('expectedToolCalls', 'must be a list of at most 20 items');
    else out.expectedToolCalls = raw.expectedToolCalls.map((t, i) => {
      if (!isObj(t)) { bad(`expectedToolCalls[${i}]`, 'must be an object'); return undefined; }
      const name = str(t.name, `expectedToolCalls[${i}].name`, 100, { optional: false });
      const call = { name };
      if (t.args !== undefined) { if (!isObj(t.args) || JSON.stringify(t.args).length > 4096) bad(`expectedToolCalls[${i}].args`, 'must be an object under 4 KB'); else call.args = t.args; }
      if (t.required !== undefined) { if (typeof t.required !== 'boolean') bad(`expectedToolCalls[${i}].required`, 'must be true or false'); else call.required = t.required; }
      if (t.order !== undefined) { if (!Number.isInteger(t.order) || t.order < 0 || t.order > 100) bad(`expectedToolCalls[${i}].order`, 'must be an integer 0-100'); else call.order = t.order; }
      return name === undefined ? undefined : call;
    }).filter(Boolean);
  }
  if (raw.constraints !== undefined) {
    if (!isObj(raw.constraints)) bad('constraints', 'must be an object');
    else {
      const c = {};
      for (const [k, v] of Object.entries(raw.constraints)) {
        if (['maxChars', 'minChars', 'maxWords'].includes(k)) { if (!Number.isInteger(v) || v < 0 || v > 1e6) bad(`constraints.${k}`, 'must be a non-negative integer'); else c[k] = v; }
        else if (['mustInclude', 'mustNotInclude'].includes(k)) c[k] = strList(v, `constraints.${k}`, { maxItems: 20, maxLen: 200 }) ?? [];
        else if (k === 'format') { if (!CONSTRAINT_FORMATS.includes(v)) bad('constraints.format', `must be one of: ${CONSTRAINT_FORMATS.join(', ')}`); else c.format = v; }
        else bad(`constraints.${k}`, k.toLowerCase().includes('regex') ? 'regular expressions are not supported (they can freeze the evaluator)' : 'unknown constraint');
      }
      out.constraints = c;
    }
  }
  if (raw.metadata !== undefined) {
    if (!isObj(raw.metadata) || JSON.stringify(raw.metadata).length > 4096) bad('metadata', 'must be an object under 4 KB');
    else out.metadata = raw.metadata;
  }
  if (errors.length) return { errors };

  const { value, redactions } = sanitize(Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)), { maxStringLen: LIMITS.maxText });
  if (Buffer.byteLength(JSON.stringify(value)) > LIMITS.maxCaseBytes) return { errors: [{ row: index + 1, path: '', message: `case is larger than ${LIMITS.maxCaseBytes} bytes` }] };
  return { value, redactions };
}

export function normalizeCases(rawCases) {
  const cases = [], errors = [];
  let redactions = 0;
  rawCases.forEach((raw, i) => {
    const r = normalizeCase(raw, i);
    if (r.errors) errors.push(...r.errors); else { cases.push(r.value); redactions += r.redactions; }
  });
  return { cases, errors, redactions };
}
