/**
 * STEP 3.55 IS THE ENFORCER. IT MUST NOT PASS A CHANGE IT COULD NOT TEST.
 *
 * The gate probed `node_modules/.bin/vitest`, then jest, then `npm test` — and on anything else
 * logged "no supported test runner found" and EXITED 0. So on every codeline whose ecosystem is
 * not Node, the HARD gate that blocks a change shipping no working reproducing test passed
 * vacuously and silently.
 *
 * It compounds, because this gate is where the other two steps put their findings. Step 3.54's
 * writer defers to it ("the repro-gate will BLOCK, as designed") and Step 3.545 defers to it
 * explicitly ("the repro-gate remains the enforcer"). On a Rust, Python, Go or Ruby codeline all
 * three deferred to a gate that skipped itself, and every step reported success.
 *
 * "Cannot prove" is not "proved". A codeline that declares no way to run its tests is a real,
 * reportable condition — it is not evidence that the fix ships a working test.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const GATE = join(SCRIPTS, 'brownfield-repro-test-gate.sh');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');
const ECO = join(SCRIPTS, 'lib/handlers/codeline-ecosystem.js');
const NODE = process.execPath;

const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** What command this ecosystem gives for running just these files. */
function fileCommand(repo: string, files: string): string {
  const r = spawnSync(NODE, [ECO, repo, '', files], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout).testFileCommand || ''; } catch { return ''; }
}

let work: string;
function repo(name: string, files: Record<string, string>): string {
  work = work || mkdtempSync(join(tmpdir(), 'repro-gate-'));
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  return dir;
}

describe('the repro gate cannot pass what it cannot run', () => {
  it('the gate names no test runner of its own', () => {
    const body = code(GATE);
    for (const lit of ['vitest', 'jest', 'npm test', 'node_modules/.bin']) {
      expect(body, `the gate still names ${lit} in its own code`).not.toContain(lit);
    }
  });

  it('a codeline with no runnable tests BLOCKS rather than exiting 0', () => {
    const body = code(GATE);
    expect(body, 'the gate still skips itself and reports a pass')
      .not.toMatch(/no supported test runner found[\s\S]{0,80}exit 0/);
    const i = body.indexOf('_rc" = "3"');
    expect(i, 'the no-runner branch is gone').toBeGreaterThan(-1);
    expect(body.slice(i, i + 400), 'an unrunnable codeline is still treated as proved')
      .toMatch(/exit 1/);
  });

  it('resolves a per-file command for a Node repo', () => {
    const dir = repo('node-app', {
      'package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }),
    });
    expect(fileCommand(dir, 'src/a.test.js'), 'a Node repo resolved no way to run one test file')
      .toContain('src/a.test.js');
  });

  it('resolves a per-file command for ecosystems the old probe could never see', () => {
    // The whole defect: these three all fell through to "no supported test runner found".
    const rust = repo('rusty', { 'Cargo.toml': '[package]\nname = "r"\n' });
    expect(fileCommand(rust, 'src/fare_test.rs'), 'a Rust repo still cannot run a test file')
      .toMatch(/cargo test/);

    const py = repo('pyapp', { 'pyproject.toml': '[project]\nname = "p"\n[tool.pytest.ini_options]\n' });
    expect(fileCommand(py, 'tests/test_fare.py'), 'a pytest repo still cannot run a test file')
      .toMatch(/pytest/);

    const go = repo('goapp', { 'go.mod': 'module g\n' });
    expect(fileCommand(go, 'pkg/fare/fare_test.go'), 'a Go repo still cannot run a test file')
      .toMatch(/go test/);
  });

  it('every ecosystem in the registry can say how it runs one file', () => {
    const r = spawnSync(NODE, ['-e',
      'const {allManifests}=require(process.argv[1]);'
      + 'process.stdout.write(allManifests().filter(e=>typeof e.testFileCommand!=="function").map(e=>e.file).join(","))',
      join(SCRIPTS, 'lib/ecosystem-registry.js'),
    ], { encoding: 'utf8' });
    expect(r.stdout.trim(), 'an ecosystem cannot target individual test files, so the gate skips it')
      .toBe('');
  });

  it('no branch name is guessed, and an unresolvable one blocks', () => {
    const body = code(GATE);
    expect(body, 'a branch name is hardcoded again').not.toMatch(/JIRA_BASELINE_BRANCH:-(develop|main|master)/);
    const i = body.indexOf('BASELINE_BRANCH=');
    expect(body.slice(i, i + 800), 'an unresolvable baseline still runs the gate against nothing')
      .toMatch(/exit 1/);
  });

  it('the gate resolves its own handler path', () => {
    // It is executed, not sourced, so it cannot borrow a caller's SCRIPT_DIR — and an unresolved
    // handler path would make every codeline look like "no runner", i.e. blocked for the wrong reason.
    expect(code(GATE), 'SCRIPT_DIR is used but never defined').toMatch(/SCRIPT_DIR="\$\(cd "\$\(dirname/);
  });

  it('BOTH call sites distinguish "could not run" from "failed"', () => {
    // Every other non-zero from the runner means the test failed, which for the PRE-FIX run is
    // exactly what a reproducing test should do. So a bare `if ! run_new_tests` at the baseline
    // turns "I could not execute anything" into "it reproduces the bug" — the same vacuous pass
    // as the old skip, one branch further in.
    //
    // Defence in depth, and stated as such: the command is now resolved ONCE before any revert,
    // so in practice the second call cannot return 3 any more. This holds the distinction in
    // place if that ever changes — a mutation of this branch alone does not currently fail a
    // behavioural test, and pretending otherwise would be worse than saying so.
    const body = code(GATE);
    const guards = body.split('\n').filter((l) => /_rc"? -eq 3|_rc" = "3"|_baseline_rc" -eq 3/.test(l));
    expect(guards.length, 'a call site treats "could not run" the same as "the test failed"')
      .toBeGreaterThanOrEqual(2);
  });

  it('the runner command is resolved before any file is reverted', () => {
    // Step 4 reverts the FIX FILES so the test can run against pre-fix code — and the manifest can
    // be one of them, because a fix may legitimately touch package.json or Cargo.toml. Resolving
    // the command after that reports "cannot run" for a codeline that runs its tests perfectly
    // well. The old code was accidentally immune: it probed node_modules/.bin, which survives a
    // revert. Found by execution, not by reading.
    const body = code(GATE);
    const resolveAt = body.indexOf('_REPRO_TEST_CMD="$(_repro_file_command');
    const revertAt = body.indexOf('checkout "$BASELINE_SHA" --');
    expect(resolveAt, 'the command is no longer resolved up front').toBeGreaterThan(-1);
    expect(revertAt, 'the revert is gone').toBeGreaterThan(-1);
    expect(resolveAt, 'the command is resolved after the revert, so the manifest may be gone')
      .toBeLessThan(revertAt);
  });

  it('a blocked story is recorded on the PRD, not only in the log', () => {
    // A finding that exists only in a log line cannot be inherited: the retry would not know
    // which story failed. Step 3.545 hard-fails on the same condition for the same reason.
    const src = readFileSync(ORCH, 'utf8');
    const i = src.indexOf('reproGate: "failed"');
    expect(i, 'the 3.55 stamp is gone').toBeGreaterThan(-1);
    const block = src.slice(i - 600, i + 500);
    expect(block, 'the stamp failure is still swallowed').not.toMatch(/&& mv "\$_tmp_prd" "\$PRD_FILE" \|\| rm -f/);
    expect(block, 'an unrecorded block no longer stops the run').toMatch(/exit 2/);
  });
});
