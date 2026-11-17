// Evaluator catalogue shared with the Python engine (a test in evaluation-engine keeps the JSON in sync with the registry).
import { readFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync(new URL('./evaluatorCatalog.json', import.meta.url), 'utf8'));
export const CATALOG_LIST = raw.evaluators;
export const CATALOG = Object.fromEntries(raw.evaluators.map((e) => [e.metric, e]));
