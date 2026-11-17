// Usage: node scripts/validate-trace-file.mjs <file.json>  - runs the SERVER's validator on a trace file.
import { readFileSync } from 'node:fs';
import { validateTrace } from '../apps/api/src/modules/traces/traceSchema.js';

const r = validateTrace(JSON.parse(readFileSync(process.argv[2], 'utf8')));
if (!r.valid) { console.error(JSON.stringify(r.errors, null, 2)); process.exit(1); }
console.log('server validator accepts the SDK-generated trace');
