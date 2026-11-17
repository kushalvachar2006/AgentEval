// Starts the Python evaluation engine for local development (reads ENGINE_TOKEN from .env). Works on Windows, macOS, Linux.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const envFile = path.join(root, '.env');
if (!existsSync(envFile)) { console.error('No .env file. Run: npm run init:env'); process.exit(1); }
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
if (!env.ENGINE_TOKEN) { console.error('ENGINE_TOKEN is missing from .env. Run: npm run init:env -- --add-missing'); process.exit(1); }

const python = ['python3', 'python', 'py'].find((c) => { const r = spawnSync(c, ['--version'], { encoding: 'utf8' }); return r.status === 0 && /Python 3\.\d+/.test(`${r.stdout}${r.stderr}`); });
if (!python) { console.error('Python 3 not found. Install it from https://python.org (tick "Add to PATH").'); process.exit(1); }

const child = spawn(python, ['-m', 'agenteval_engine.server'], {
  cwd: path.join(root, 'evaluation-engine'), stdio: 'inherit',
  env: { ...process.env, PYTHONPATH: 'src', ENGINE_TOKEN: env.ENGINE_TOKEN, ENGINE_HOST: '127.0.0.1', ENGINE_PORT: '8000', ENGINE_ALLOW_PRIVATE_JUDGE_URLS: env.ALLOW_PRIVATE_ENDPOINTS === 'true' ? 'true' : 'false' },
});
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
