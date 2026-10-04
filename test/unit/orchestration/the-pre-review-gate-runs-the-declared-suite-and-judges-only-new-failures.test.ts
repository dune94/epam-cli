/**
 * THE PRE-REVIEW GATE RUNS THE DECLARED SUITE AND JUDGES ONLY NEW FAILURES.
 *
 * AMSD-2974 live, 2026-10-04: the cx-shared writer, repro gate and Step 3.545 all passed and the
 * team-lead review APPROVED; then Step 19 ran the ecosystem's detected `npm test` (bare jest, a
 * worker per core) instead of the project's declared `npm run test -- --maxWorkers=1`, reached
 * 5.2 GB and was OOM-killed. And had it finished, it failed on ANY red suite: cx-shared's
 * DatePicker failures, already failing on the baseline, would have blocked a correct change.
 *
 * pre_review_suite is the step's suite run, from the definitions every other suite run uses: the
 * declared command through _run_project_verification, and baseline_new_failures on red.
 * EXECUTED on git fixtures whose package declares a decoy test script that must never run.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations');
const LIB = join(ORCH, 'scripts/lib');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (repo: string, a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();

function codeline(introduce: boolean) {
  const base = mkdtempSync(join(tmpdir(), 'pre-review-')); dirs.push(base);
  const repo = join(base, 'repo'); const logs = join(base, 'logs'); mkdirSync(logs);
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(base, ['init', '-q', '-b', 'develop', repo]);
  git(repo, ['config', 'user.email', 't@t.t']); git(repo, ['config', 'user.name', 't']);
  // The package's own test script is a decoy: the gate must run the declaration, never this.
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'c', scripts: { test: 'node decoy.js' } }));
  writeFileSync(join(repo, 'decoy.js'), `require('fs').writeFileSync(${JSON.stringify(join(base, 'decoy-ran'))}, 'x');\n`);
  writeFileSync(join(repo, 'src', 'hello.js'), "module.exports = 'hello world';\n");
  writeFileSync(join(repo, 'suite.js'), [
    "const fs = require('fs');",
    "console.log('FAIL src/legacy.spec.js');",
    "if (fs.readFileSync('src/hello.js', 'utf8').includes('BROKEN')) console.log('FAIL src/greeting.spec.js');",
    'process.exit(1);',
  ].join('\n') + '\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'baseline']);
  writeFileSync(join(logs, 'phase-baseline-sha.txt'), git(repo, ['rev-parse', 'HEAD']) + '\n');
  git(repo, ['checkout', '-q', '-b', 'AI-MOCK-1']);
  writeFileSync(join(repo, 'src', 'hello.js'), introduce ? "module.exports = 'BROKEN';\n" : "module.exports = 'hello dolly';\n");
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'fix']);
  mkdirSync(join(repo, '.epam'), { recursive: true });
  writeFileSync(join(repo, '.epam', 'verification.json'), JSON.stringify({ test: { command: 'node suite.js', failurePattern: '^FAIL\\s+(\\S+)' } }));
  return { base, repo, logs };
}

function gate(repo: string, logs: string) {
  const out = join(logs, 'pre-review.log');
  const r = spawnSync('bash', ['-c', `
log(){ echo "LOG $*"; }; warning(){ echo "WARN $*"; }; info(){ :; }; error(){ echo "ERR $*"; }; success(){ echo "OK $*"; }
SCRIPT_DIR=${JSON.stringify(join(ORCH, 'scripts'))}
source ${JSON.stringify(join(LIB, 'pre-review-gate.sh'))}
pre_review_suite ${JSON.stringify(repo)} ${JSON.stringify(logs)} ${JSON.stringify(out)}`],
  { encoding: 'utf8', env: { ...process.env, EPAM_BROWNFIELD: '1', NODE_BIN: process.execPath, AUTOMATION_DIR: ORCH } });
  return r;
}

describe('the pre-review gate', () => {
  it('passes a suite whose only failure was already failing at the baseline', () => {
    const { base, repo, logs } = codeline(false);
    const r = gate(repo, logs);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/already failing at the baseline/);
    expect(existsSync(join(base, 'decoy-ran')), 'the gate ran the package\'s own test script, not the declaration').toBe(false);
  });

  it('fails a suite with a failure the fix introduced, and names it', () => {
    const { repo, logs } = codeline(true);
    const r = gate(repo, logs);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/greeting\.spec\.js/);
  });
});
