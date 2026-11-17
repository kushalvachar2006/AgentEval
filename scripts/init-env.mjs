// Creates .env from .env.example with fresh random secrets. Never overwrites an existing file.
//   node scripts/init-env.mjs                 -> create .env
//   node scripts/init-env.mjs --add-missing   -> upgrade: append only the settings your existing .env does not have yet
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined; };
const out = arg('--out') ?? `${root}.env`;
const addMissing = process.argv.includes('--add-missing');
const parse = (text) => Object.fromEntries(text.split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

const generated = {
  MONGO_ROOT_PASSWORD: randomBytes(18).toString('hex'),
  ENGINE_TOKEN: randomBytes(18).toString('hex'),
  JWT_SECRET: randomBytes(48).toString('hex'),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
};
const template = readFileSync(`${root}.env.example`, 'utf8');
const fill = (text, secrets) => text.replace(/\{\{(\w+)\}\}/g, (_, k) => { if (!(k in secrets)) throw new Error(`Unknown placeholder ${k}`); return secrets[k]; });

if (existsSync(out)) {
  if (!addMissing) {
    console.error(`✋ ${out} already exists - not overwriting.\n   To add only the NEW settings to it (keeps your passwords), run: npm run init:env -- --add-missing`);
    process.exit(1);
  }
  const have = parse(readFileSync(out, 'utf8'));
  const secrets = { ...generated, ...Object.fromEntries(Object.entries(have).filter(([k]) => k in generated)) }; // reuse existing secrets where present
  const lines = fill(template, secrets).split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='));
  const missing = lines.filter((l) => !(l.slice(0, l.indexOf('=')) in have));
  if (!missing.length) { console.log('✅ Your .env already has every setting. Nothing to add.'); process.exit(0); }
  appendFileSync(out, `\n# --- added by init:env --add-missing ---\n${missing.join('\n')}\n`);
  console.log(`✅ Added ${missing.length} missing setting(s) to ${out}: ${missing.map((l) => l.split('=')[0]).join(', ')}`);
  process.exit(0);
}
writeFileSync(out, fill(template, generated), { mode: 0o600 });
console.log(`✅ Created ${out} with new random secrets (file permissions 600). Keep it private.`);
