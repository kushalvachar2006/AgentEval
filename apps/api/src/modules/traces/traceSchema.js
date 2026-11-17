// Normalized AgentEval trace contract (schemaVersion 1.x). Dependency-free on purpose:
// its behaviour is mirrored by sdk/python/src/agenteval/trace.py and both are
// checked against packages/trace-schema/fixtures.
export const SCHEMA_VERSION = '1.0';
export const DEFAULT_MAX_SPANS = 5000;

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const TRACE_STATUS = new Set(['success', 'error', 'cancelled', 'timeout']);
const SPAN_STATUS = new Set(['success', 'error', 'cancelled']);
const SPAN_TYPES = new Set(['agent', 'chain', 'llm', 'tool', 'retriever', 'other']);
const ENVIRONMENTS = new Set(['production', 'test', 'evaluation']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const isNonNegNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const nonEmptyStr = (v, max = 256) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isIso = (v) => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));

function checkTimes(o, path, errors) {
  const startOk = isIso(o.startedAt);
  const endOk = isIso(o.endedAt);
  if (!startOk) errors.push({ path: `${path}startedAt`, message: 'must be ISO-8601 with timezone' });
  if (!endOk) errors.push({ path: `${path}endedAt`, message: 'must be ISO-8601 with timezone' });
  if (startOk && endOk && Date.parse(o.endedAt) < Date.parse(o.startedAt)) {
    errors.push({ path: `${path}endedAt`, message: 'must not be earlier than startedAt' });
  }
  if (o.durationMs !== undefined && !isNonNegNum(o.durationMs)) {
    errors.push({ path: `${path}durationMs`, message: 'must be a non-negative number' });
  }
}

function checkUsage(u, path, errors) {
  if (u === undefined) return;
  if (!isObj(u)) { errors.push({ path, message: 'must be an object' }); return; }
  for (const k of ['inputTokens', 'outputTokens', 'totalTokens']) {
    if (u[k] !== undefined && !isNonNegInt(u[k])) errors.push({ path: `${path}.${k}`, message: 'must be a non-negative integer' });
  }
  if (u.estimatedCostUsd !== undefined && !isNonNegNum(u.estimatedCostUsd)) {
    errors.push({ path: `${path}.estimatedCostUsd`, message: 'must be a non-negative number' });
  }
}

function checkError(err, status, path, errors) {
  if (err === undefined || err === null) {
    if (status === 'error') errors.push({ path, message: 'required when status is "error"' });
    return;
  }
  if (!isObj(err) || !nonEmptyStr(err.message, 10000)) errors.push({ path: `${path}.message`, message: 'must be a non-empty string' });
}

function checkSpan(s, i, errors) {
  const p = `spans.${i}`;
  if (!isObj(s)) { errors.push({ path: p, message: 'must be an object' }); return; }
  if (!SPAN_ID_RE.test(s.spanId ?? '') || /^0+$/.test(s.spanId)) errors.push({ path: `${p}.spanId`, message: 'must be 16 lowercase hex chars (not all zero)' });
  if (!SPAN_TYPES.has(s.type)) errors.push({ path: `${p}.type`, message: `must be one of ${[...SPAN_TYPES].join(', ')}` });
  if (!nonEmptyStr(s.name)) errors.push({ path: `${p}.name`, message: 'must be a non-empty string' });
  if (!SPAN_STATUS.has(s.status)) errors.push({ path: `${p}.status`, message: `must be one of ${[...SPAN_STATUS].join(', ')}` });
  checkTimes(s, `${p}.`, errors);
  checkError(s.error, s.status, `${p}.error`, errors);
  if (s.type === 'llm') {
    if (!isObj(s.llm)) errors.push({ path: `${p}.llm`, message: 'required for llm spans' });
    else {
      if (!nonEmptyStr(s.llm.model)) errors.push({ path: `${p}.llm.model`, message: 'must be a non-empty string' });
      checkUsage(s.llm.usage, `${p}.llm.usage`, errors);
    }
  }
  if (s.type === 'tool') {
    if (!isObj(s.tool)) errors.push({ path: `${p}.tool`, message: 'required for tool spans' });
    else if (!nonEmptyStr(s.tool.name)) errors.push({ path: `${p}.tool.name`, message: 'must be a non-empty string' });
  }
}

export function validateTrace(t, { maxSpans = DEFAULT_MAX_SPANS } = {}) {
  const errors = [];
  if (!isObj(t)) return { valid: false, errors: [{ path: '', message: 'trace must be an object' }] };

  if (typeof t.schemaVersion !== 'string' || !/^1\.\d+$/.test(t.schemaVersion)) errors.push({ path: 'schemaVersion', message: 'unsupported; this server accepts 1.x' });
  if (!TRACE_ID_RE.test(t.traceId ?? '') || /^0+$/.test(t.traceId)) errors.push({ path: 'traceId', message: 'must be 32 lowercase hex chars (not all zero)' });
  if (!nonEmptyStr(t.agentId, 128)) errors.push({ path: 'agentId', message: 'must be a non-empty string (max 128)' });
  for (const k of ['agentVersion', 'sessionId']) {
    if (t[k] !== undefined && !nonEmptyStr(t[k], 128)) errors.push({ path: k, message: 'must be a non-empty string (max 128)' });
  }
  if (t.environment !== undefined && !ENVIRONMENTS.has(t.environment)) errors.push({ path: 'environment', message: `must be one of ${[...ENVIRONMENTS].join(', ')}` });
  if (!isObj(t.framework) || !nonEmptyStr(t.framework.name, 64)) errors.push({ path: 'framework.name', message: 'must be a non-empty string' });
  if (!TRACE_STATUS.has(t.status)) errors.push({ path: 'status', message: `must be one of ${[...TRACE_STATUS].join(', ')}` });
  if (!('input' in t)) errors.push({ path: 'input', message: 'is required' });
  checkTimes(t, '', errors);
  checkUsage(t.usage, 'usage', errors);
  checkError(t.error, t.status, 'error', errors);

  if (!Array.isArray(t.spans)) {
    errors.push({ path: 'spans', message: 'must be an array' });
  } else if (t.spans.length > maxSpans) {
    errors.push({ path: 'spans', message: `too many spans (max ${maxSpans})` });
  } else {
    t.spans.forEach((s, i) => checkSpan(s, i, errors));
    const byId = new Map();
    t.spans.forEach((s, i) => {
      if (!isObj(s) || typeof s.spanId !== 'string') return;
      if (byId.has(s.spanId)) errors.push({ path: `spans.${i}.spanId`, message: 'duplicate spanId' });
      else byId.set(s.spanId, s);
    });
    t.spans.forEach((s, i) => {
      if (!isObj(s)) return;
      const parent = s.parentSpanId;
      if (parent === null || parent === undefined) return;
      if (!byId.has(parent)) errors.push({ path: `spans.${i}.parentSpanId`, message: 'refers to a span that does not exist' });
    });
    t.spans.forEach((s, i) => {
      if (!isObj(s) || typeof s.spanId !== 'string') return;
      const seen = new Set([s.spanId]);
      let cur = s.parentSpanId;
      while (cur !== null && cur !== undefined && byId.has(cur)) {
        if (seen.has(cur)) { errors.push({ path: `spans.${i}.parentSpanId`, message: 'parent chain contains a cycle' }); break; }
        seen.add(cur);
        cur = byId.get(cur).parentSpanId;
      }
    });
  }
  return { valid: errors.length === 0, errors };
}
