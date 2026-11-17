// Per-agent production monitoring policy: what share of production traces is evaluated, and the cost caps.
// Pure (no I/O). Production evaluation uses REFERENCE-FREE evaluators only: nothing here needs a test case.
import { check } from '../../lib/validate.js';

// hallucination/groundedness check the answer against tool/retrieval output recorded IN the trace; relevance and operational need nothing;
// tool_usage judges executed calls without an expected list; instruction_adherence only runs when the policy defines constraints.
export const PROD_EVALUATORS = ['hallucination', 'groundedness', 'relevance', 'tool_usage', 'instruction_adherence', 'operational'];
export const DEFAULT_EVALUATORS = ['hallucination', 'groundedness', 'relevance', 'tool_usage', 'operational'];
export const JUDGE_CALLS_PER_TRACE = 8;

export const DEFAULT_POLICY = Object.freeze({
  enabled: false, sampleRate: 0, alwaysEvaluateErrors: true,
  dailyTraceBudget: null, dailyJudgeBudget: null, useJudge: false,
  evaluators: DEFAULT_EVALUATORS, constraints: null,
});

const INT_CONSTRAINTS = ['maxChars', 'minChars', 'maxWords'];
const FORMATS = ['json', 'single_line', 'bullet_list'];

function cleanConstraints(c, raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) { c.fail('constraints', 'must be an object'); return null; }
  const out = {};
  for (const k of Object.keys(raw)) {
    if (INT_CONSTRAINTS.includes(k)) {
      if (Number.isInteger(raw[k]) && raw[k] >= 0 && raw[k] <= 1_000_000) out[k] = raw[k]; else c.fail(`constraints.${k}`, 'must be an integer from 0 to 1000000');
    } else if (k === 'mustInclude' || k === 'mustNotInclude') {
      if (Array.isArray(raw[k]) && raw[k].length <= 20 && raw[k].every((s) => typeof s === 'string' && s.length > 0 && s.length <= 200)) out[k] = raw[k];
      else c.fail(`constraints.${k}`, 'must be a list of up to 20 non-empty strings (max 200 characters each)');
    } else if (k === 'format') {
      if (FORMATS.includes(raw[k])) out[k] = raw[k]; else c.fail('constraints.format', `must be one of: ${FORMATS.join(', ')}`);
    } else c.fail(`constraints.${k}`, 'is not a supported constraint');
  }
  return Object.keys(out).length ? out : null;
}

const budgetOf = (c, v, path) => {
  if (v === undefined || v === null || v === '') return null;
  if (!Number.isInteger(v) || v < 0 || v > 100_000_000) { c.fail(path, 'must be a whole number from 0 to 100000000, or empty for no limit'); return null; }
  return v;
};

// Full replacement semantics: the PUT body describes the whole policy; missing fields take defaults.
export function validatePolicy(body) {
  const c = check();
  if (body === null || typeof body !== 'object' || Array.isArray(body)) { c.fail('body', 'must be an object'); c.done(); }
  const enabled = body.enabled === undefined ? false : body.enabled;
  if (typeof enabled !== 'boolean') c.fail('enabled', 'must be true or false');
  let sampleRate = body.sampleRate === undefined ? 0 : body.sampleRate;
  if (typeof sampleRate !== 'number' || !(sampleRate >= 0 && sampleRate <= 1)) { c.fail('sampleRate', 'must be a number from 0 to 1 (0.1 = evaluate 10% of production traces)'); sampleRate = 0; }
  const alwaysEvaluateErrors = body.alwaysEvaluateErrors === undefined ? true : body.alwaysEvaluateErrors;
  if (typeof alwaysEvaluateErrors !== 'boolean') c.fail('alwaysEvaluateErrors', 'must be true or false');
  const dailyTraceBudget = budgetOf(c, body.dailyTraceBudget, 'dailyTraceBudget');
  const dailyJudgeBudget = budgetOf(c, body.dailyJudgeBudget, 'dailyJudgeBudget');
  const useJudge = body.useJudge === undefined ? false : body.useJudge;
  if (typeof useJudge !== 'boolean') c.fail('useJudge', 'must be true or false');
  if (useJudge === true && !(dailyJudgeBudget > 0)) c.fail('dailyJudgeBudget', 'is required (at least 1) when useJudge is true, so AI-judge cost always has a daily cap');
  let evaluators = body.evaluators === undefined ? [...DEFAULT_EVALUATORS] : body.evaluators;
  if (!Array.isArray(evaluators) || evaluators.length < 1 || evaluators.length > PROD_EVALUATORS.length || new Set(evaluators).size !== evaluators.length || !evaluators.every((m) => PROD_EVALUATORS.includes(m))) {
    c.fail('evaluators', `must be a non-empty list of distinct names from: ${PROD_EVALUATORS.join(', ')}`); evaluators = [...DEFAULT_EVALUATORS];
  }
  const constraints = cleanConstraints(c, body.constraints);
  if (evaluators.includes('instruction_adherence') && !constraints) c.fail('constraints', 'are required when the instruction_adherence evaluator is selected');
  c.done();
  return { enabled, sampleRate, alwaysEvaluateErrors, dailyTraceBudget, dailyJudgeBudget, useJudge, evaluators, constraints };
}

export const effectivePolicy = (stored) => ({ ...DEFAULT_POLICY, ...(stored ?? {}) });
export const dayKey = (d) => d.toISOString().slice(0, 10);
