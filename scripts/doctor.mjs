// "Is my machine ready?" - plain-language checks. Exit code 1 if a required check fails.
import net from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../apps/api/src/config/env.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;
const line = (icon, msg, hint) => console.log(`${icon} ${msg}${hint ? `\n     → ${hint}` : ''}`);
const ok = (m) => line('✅', m);
const bad = (m, h) => { failed++; line('❌', m, h); };
const warn = (m, h) => line('⚠️ ', m, h);
const run = (cmd, args) => { try { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return r.status === 0 ? (r.stdout || r.stderr).trim() : null; } catch { return null; } };

const major = Number(process.versions.node.split('.')[0]);
major >= 20 ? ok(`Node.js ${process.versions.node}`) : bad(`Node.js ${process.versions.node} is too old`, 'Install Node 20 or newer from https://nodejs.org');

const py = [['python3'], ['python'], ['py']].map(([c]) => run(c, ['--version'])).find((v) => v && /Python 3/.test(v)) ?? null;
const pm = py && py.match(/(\d+)\.(\d+)/);
pm && (Number(pm[1]) > 3 || (Number(pm[1]) === 3 && Number(pm[2]) >= 10)) ? ok(py) : bad(py ? `${py} is too old` : 'Python not found', 'Install Python 3.10 or newer from https://python.org');

const dv = run('docker', ['--version']);
dv ? ok(dv) : warn('Docker not found', 'Needed for MongoDB and the one-command setup. Install Docker Desktop: https://docs.docker.com/get-docker/');
if (dv) run('docker', ['compose', 'version']) ? ok('Docker Compose available') : bad('Docker Compose plugin missing', 'Update Docker Desktop (Compose v2 is included).');

const envPath = `${root}.env`;
let cfg = null;
if (!existsSync(envPath)) bad('.env file not found', 'Run: npm run init:env');
else {
  const env = Object.fromEntries(readFileSync(envPath, 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  try { cfg = loadConfig(env); ok('.env is present and valid'); } catch (e) { bad('.env has problems', e.problems?.join('; ') ?? e.message); }
}

const probe = (name, host, port) => new Promise((res) => {
  const s = net.connect({ host, port, timeout: 1500 });
  s.on('connect', () => { s.destroy(); ok(`${name} reachable on ${host}:${port}`); res(); });
  const miss = () => { s.destroy(); warn(`${name} not reachable on ${host}:${port}`, name === 'API' ? 'Start it with: npm run dev:api (or docker compose up -d)' : name === 'Evaluation engine' ? 'Start it with: npm run dev:engine (or docker compose up -d)' : 'Start it with: npm run dev:infra'); res(); };
  s.on('error', miss); s.on('timeout', miss);
});
await probe('MongoDB', '127.0.0.1', 27017);
await probe('Evaluation engine', '127.0.0.1', 8000);
await probe('API', '127.0.0.1', cfg?.port ?? 4000);

console.log(failed ? `\n${failed} required check(s) failed.` : '\nRequired checks passed. (⚠️ items are only needed once you start the services.)');
process.exit(failed ? 1 : 0);
