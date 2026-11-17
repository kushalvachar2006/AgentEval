// One command to run every test that can run on this machine. Skips (and says so) what needs installs/services.
// Works on Windows, macOS and Linux.
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const isWin = process.platform === 'win32';
const pythonOnly = process.argv.includes('--python-only');
const results = [];

// On Windows, npm is npm.cmd and must run through the shell; everything else can be spawned directly.
function run(cmd, args, { cwd = root, env = {} } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', shell: isWin && cmd === 'npm' });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`;
  return { ok: r.status === 0 && !r.error, status: r.status, output };
}

function findPython() {
  for (const cmd of ['python3', 'python', 'py']) {
    const r = run(cmd, ['--version']);
    if (r.ok && /Python 3\.\d+/.test(r.output)) return cmd;
  }
  return null;
}
const py = findPython();

function step(name, cmd, args, { cwd, env, skipIf } = {}) {
  if (skipIf) { results.push([name, 'SKIPPED', skipIf]); return; }
  const r = run(cmd, args, { cwd, env });
  results.push([name, r.ok ? 'PASS' : 'FAIL', r.ok ? '' : r.output.split('\n').slice(-15).join('\n')]);
}

const noPython = py ? null : 'Python 3 not found (install from https://python.org and tick "Add to PATH")';
step('Python SDK tests', py, ['-m', 'unittest', 'discover', '-s', 'tests'], { cwd: path.join(root, 'sdk', 'python'), env: { PYTHONPATH: 'src' }, skipIf: noPython });
step('Evaluation-engine tests', py, ['-m', 'unittest', 'discover', '-s', 'tests'], { cwd: path.join(root, 'evaluation-engine'), env: { PYTHONPATH: 'src' }, skipIf: noPython });

// Cross-language contract: a trace built by the Python SDK must be accepted by the Node server's validator.
{
  const emit = py ? run(py, [path.join('sdk', 'python', 'tests', 'emit_sample_trace.py')]) : null;
  if (!emit) results.push(['SDK trace accepted by server validator', 'SKIPPED', noPython]);
  else if (!emit.ok) results.push(['SDK trace accepted by server validator', 'FAIL', emit.output]);
  else {
    const f = path.join(tmpdir(), 'agenteval-sdk-trace.json');
    writeFileSync(f, emit.output);
    step('SDK trace accepted by server validator', 'node', [path.join('scripts', 'validate-trace-file.mjs'), f]);
  }
}

if (!pythonOnly) {
  step('API unit tests (config, security, services, trace contract)', 'npm', ['--prefix', 'apps/api', 'test']);
  const apiDeps = existsSync(path.join(root, 'apps', 'api', 'node_modules', 'express'));
  step('API integration tests (HTTP)', 'npm', ['--prefix', 'apps/api', 'run', 'test:integration'], { skipIf: apiDeps ? null : 'dependencies not installed (run: npm run install:all)' });
  const webDeps = existsSync(path.join(root, 'apps', 'web', 'node_modules', 'vite'));
  step('Web production build', 'npm', ['--prefix', 'apps/web', 'run', 'build'], { skipIf: webDeps ? null : 'dependencies not installed (run: npm run install:all)' });
}

let fail = 0;
for (const [n, s, d] of results) {
  console.log(`${s === 'PASS' ? '✅' : s === 'SKIPPED' ? '⏭️ ' : '❌'} ${n}: ${s}${s === 'SKIPPED' ? ` - ${d}` : ''}`);
  if (s === 'FAIL') { fail++; console.log(d); }
}
process.exit(fail ? 1 : 0);
