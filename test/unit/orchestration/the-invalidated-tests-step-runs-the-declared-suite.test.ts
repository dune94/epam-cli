/**
 * THE INVALIDATED-TESTS STEP RUNS THE PROJECT'S DECLARED SUITE — NOT A RUNNER IT PICKS BY NAME.
 *
 * AMSD-2974 writer run, 2026-10-03: update-invalidated-tests.sh chose a runner by probing
 * node_modules/.bin/vitest, then jest, then `npm test` — stack names in mainline code — and ran the
 * whole suite with it. That ignored the project's declared command (one worker, its clock pin), so
 * jest sized its pool from all 16 cores: 16 processes, 5.6 GB, the run OOM-killed after the writer
 * had merged. The step now runs the suite through the one definition every other suite run uses
 * (_run_project_verification <root> test → the verification plugin's testCommandFor).
 *
 * EXECUTED: the real run_suite, sliced from update-invalidated-tests.sh, with the real
 * lib/tsc-baseline-gate.sh and plugin, on a codeline carrying a decoy jest binary.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations');
const SCRIPT = join(ORCH, 'scripts/update-invalidated-tests.sh');
const lines = readFileSync(SCRIPT, 'utf8').split('\n');
const s = lines.findIndex((l) => /^run_suite\(\)\s*\{/.test(l));
const e = lines.findIndex((l, i) => i > s && l === '}');
// The whole "Run the suite" section — run_suite plus the bound and libraries it relies on, as the
// script loads them.
const m = lines.findIndex((l, i) => i < s && /^# ── Run the suite/.test(l));
const fn = lines.slice(m, e + 1).join('\n');

const work = mkdtempSync(join(tmpdir(), 'invalidated-suite-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function codeline(name: string, declared: object | null, suiteExit = 0) {
  const root = join(work, name); mkdirSync(join(root, '.epam'), { recursive: true }); mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  // The decoy: a runner found by name. It must never be the one that runs.
  writeFileSync(join(root, 'node_modules/.bin/jest'), `#!/bin/bash\necho DECOY > ${JSON.stringify(join(root, 'decoy-ran'))}\n`);
  chmodSync(join(root, 'node_modules/.bin/jest'), 0o755);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
  writeFileSync(join(root, 'suite.js'), `require('fs').writeFileSync(${JSON.stringify(join(root, 'declared-ran'))}, 'yes'); process.exit(${suiteExit});\n`);
  if (declared) writeFileSync(join(root, '.epam/verification.json'), JSON.stringify(declared));
  return root;
}

function runSuite(root: string) {
  return spawnSync('bash', ['-c', `log(){ echo "LOG $*"; }
SCRIPT_DIR=${JSON.stringify(join(ORCH, 'scripts'))}; PROJECT_ROOT=${JSON.stringify(root)}
source ${JSON.stringify(join(ORCH, 'scripts/lib/tsc-baseline-gate.sh'))} 2>/dev/null
${fn}
out="$(run_suite)"; echo "rc=$?"`], { encoding: 'utf8', env: { ...process.env, AUTOMATION_DIR: ORCH, NODE_BIN: process.execPath } });
}

describe('the invalidated-tests step runs the declared suite', () => {
  it('the function under test was found', () => { expect(m).toBeGreaterThan(-1); expect(s).toBeGreaterThan(m); expect(e).toBeGreaterThan(s); });

  it('a declared suite command is what runs — the runner found by name never does', () => {
    const root = codeline('declared', { test: { command: 'node suite.js' } });
    const r = runSuite(root);
    expect(existsSync(join(root, 'declared-ran')), r.stdout + r.stderr).toBe(true);
    expect(existsSync(join(root, 'decoy-ran')), 'the step ran a runner it picked by name').toBe(false);
    expect(r.stdout).toContain('rc=0');
  });

  it('a red declared suite is reported red (non-zero, not "nothing to do")', () => {
    const root = codeline('red', { test: { command: 'node suite.js' } }, 1);
    const r = runSuite(root);
    expect(r.stdout).not.toContain('rc=0');
    expect(r.stdout).not.toContain('rc=3');
  });

  it('a codeline that declares no suite is "nothing to run" (3) — never a runner guessed by name', () => {
    const root = codeline('none', null);
    const r = runSuite(root);
    expect(r.stdout).toContain('rc=3');
    expect(existsSync(join(root, 'decoy-ran'))).toBe(false);
  });
});
