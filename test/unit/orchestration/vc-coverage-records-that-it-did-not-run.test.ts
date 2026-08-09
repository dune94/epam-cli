/**
 * "NOT CHECKED" MUST BE A RECORDED STATE, NOT A MISSING FILE.
 *
 * Live 2026-08-09, AMSD-2041: "[vc-coverage] no test file in the writer manifest — coverage NOT
 * checked". The warning is deliberate and the code says so. But the else branch writes NOTHING,
 * so vc-coverage-<story>.json is simply absent — and absence cannot be told apart from a check
 * that ran and found everything covered. That is the same shape as the coverage gate returning
 * `complete: null` and claude.sh reading null as pass, which ran fail-open for its entire life.
 *
 * The pipeline already states this rule elsewhere, in the survey sanitiser: "Silence is not a
 * state. Anything offered and unreported is explicitly not_investigated."
 *
 * The artifact is written either way now, so a reader never has to interpret absence. Nothing
 * consumes it today — it is a report — which is precisely why it must say what happened rather
 * than leave a gap for someone to fill in with an assumption.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const src = readFileSync(ORCH, 'utf8');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The real vc-coverage block, lifted out of the orchestrator. */
function coverageBlock(): string {
  const from = src.indexOf('[vc-coverage]');
  expect(from, 'the vc-coverage block is gone').toBeGreaterThan(-1);
  const start = src.lastIndexOf('if [ "${EPAM_BROWNFIELD:-0}" = "1" ]', from);
  const end = src.indexOf('done < <(phase_stories_brownfield_scope', from);
  expect(end).toBeGreaterThan(start);
  const block = src.slice(start, end);
  expect(block.length, 'the bound is wrong — the block is too short').toBeGreaterThan(300);
  return block;
}

/** Runs the else-branch logic against a temp LOG_DIR. */
function runNoTestFile() {
  const dir = mkdtempSync(join(tmpdir(), 'vccov-')); dirs.push(dir);
  const logDir = join(dir, 'logs');
  mkdirSync(logDir, { recursive: true });
  const sh = join(dir, 'run.sh');
  // Only the else branch matters: story_outputs_tests returns nothing.
  const block = coverageBlock()
    .replace('if [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -x "$SCRIPT_DIR/vc-coverage-check.sh" ]; then', 'if true; then')
    .replace('[ -f "$SCRIPT_DIR/lib/story-outputs.sh" ] && . "$SCRIPT_DIR/lib/story-outputs.sh"', 'story_outputs_tests(){ :; }');
  writeFileSync(sh,
    '#!/usr/bin/env bash\nset -u\nwarning(){ echo "[warn] $*"; }\n' +
    `LOG_DIR=${JSON.stringify(logDir)}\nPHASE=core\nPROJECT_ROOT=${JSON.stringify(dir)}\nPRD_FILE=/dev/null\n` +
    'SCRIPT_DIR=/nonexistent\n' +
    // The slice stops before `done`, so the while AND the enclosing if must both be closed.
    `${block}\ndone < <(printf 'S-1\\n')\nfi\n`);
  const out = execFileSync('bash', [sh], { encoding: 'utf8' });
  return { logDir, out };
}

describe('the fixture exercises the else branch', () => {
  it('the warning still fires — the branch under test really ran', () => {
    expect(runNoTestFile().out).toMatch(/coverage NOT checked/);
  });
});

describe('THE DEFECT: the not-checked state is persisted', () => {
  it('an artifact is written even when no test file exists', () => {
    const { logDir } = runNoTestFile();
    expect(
      existsSync(join(logDir, 'vc-coverage-S-1.json')),
      'nothing was written, so absence has to be interpreted — and absence reads the same as ' +
      'a check that ran and found everything covered',
    ).toBe(true);
  });

  it('it says explicitly that the check did not run', () => {
    const { logDir } = runNoTestFile();
    const a = JSON.parse(readFileSync(join(logDir, 'vc-coverage-S-1.json'), 'utf8'));
    expect(a.state).toBe('not_checked');
  });

  it('it says WHY, so the reader is not left guessing', () => {
    const { logDir } = runNoTestFile();
    const a = JSON.parse(readFileSync(join(logDir, 'vc-coverage-S-1.json'), 'utf8'));
    expect(String(a.reason)).toMatch(/test file|manifest/i);
  });

  it('it does not claim coverage it never measured', () => {
    const { logDir } = runNoTestFile();
    const a = JSON.parse(readFileSync(join(logDir, 'vc-coverage-S-1.json'), 'utf8'));
    // A `covered: true` anywhere in a not-checked record would be a fabricated pass.
    expect(JSON.stringify(a)).not.toMatch(/"covered"\s*:\s*true/);
  });

  it('it names the story it is about', () => {
    const { logDir } = runNoTestFile();
    const a = JSON.parse(readFileSync(join(logDir, 'vc-coverage-S-1.json'), 'utf8'));
    expect(a.story).toBe('S-1');
  });
});

describe('the checked path is untouched', () => {
  it('a real check still runs vc-coverage-check.sh with the test file', () => {
    const block = coverageBlock();
    expect(block).toMatch(/vc-coverage-check\.sh/);
    expect(block).toMatch(/--test-file/);
  });

  it('and still writes to the same artifact path', () => {
    expect(coverageBlock()).toMatch(/vc-coverage-\$\{_vc_story\}\.json/);
  });
});
