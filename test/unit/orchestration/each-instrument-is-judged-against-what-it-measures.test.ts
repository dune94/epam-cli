/**
 * EVERY INSTRUMENT IS JUDGED AGAINST THE FILES IT MEASURES, AND NO OTHERS.
 *
 * The freshness rule refuses any report older than a file it "is supposed to measure", and takes
 * the OLDER of the two instruments as one deadline for EVERY in-scope file. The intent is right —
 * shell coverage measured last week does not become current because the JS suite ran this morning
 * — but the two instruments measure disjoint sets of files.
 *
 * So a shell file that is newer than lcov.info marks the whole report stale, though lcov.info has
 * never contained a line of shell, and the only way to clear it is a full JS suite run measured in
 * hundreds of seconds. The cost is paid every time anyone touches a shell script, which in this
 * repository is most edits: the loop meant to make coverage cheap becomes the slowest thing in the
 * tree, and the way out is to stop measuring.
 *
 * THE RULE THAT ACTUALLY HOLDS: a shell file is judged against the shell report, a JavaScript file
 * against the JavaScript report. Strictly correct and strictly narrower — no report is served over
 * a file it does not reflect, and none is discarded over a file it was never responsible for.
 *
 * Timestamps are set explicitly rather than inferred from repository state, so the three cases are
 * distinguishable at all: with everything "now", stale and fresh look identical.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { statSync, utimesSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const HANDLER = join(REPO, 'orchestrations/scripts/lib/handlers/stage-coverage.js');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';
const LCOV = join(REPO, 'coverage/lcov.info');
const LCOV_SHELL = join(REPO, 'coverage/lcov.shell.info');
const SCRIPTS = join(REPO, 'orchestrations/scripts');

const S = (n: number) => new Date(Date.now() + n * 1000);

function refused(): { refused: boolean; out: string } {
  const r = spawnSync(NODE20, [HANDLER, '--all'], { encoding: 'utf8', timeout: 240000, cwd: REPO });
  const out = (r.stdout || '') + (r.stderr || '');
  return { refused: /is OLDER than/.test(out), out };
}

/** Set mtimes for a scenario, then restore every one of them exactly. */
function scenario(stamps: Array<[string, Date]>, fn: () => void) {
  const saved = stamps.map(([f]) => [f, statSync(f)] as const);
  try {
    for (const [f, when] of stamps) utimesSync(f, when, when);
    fn();
  } finally {
    for (const [f, st] of saved) utimesSync(f, st.atime, st.mtime);
  }
}

const SH = join(SCRIPTS, readdirSync(SCRIPTS).find((f) => f.endsWith('.sh'))!);
const JS = join(SCRIPTS, readdirSync(SCRIPTS).find((f) => f.endsWith('.js'))!);

describe('each instrument is judged against what it measures', () => {
  it('both instruments and both kinds of in-scope file exist', () => {
    expect(existsSync(LCOV), 'no JS lcov').toBe(true);
    expect(existsSync(LCOV_SHELL), 'no shell lcov').toBe(true);
    expect(existsSync(SH) && existsSync(JS)).toBe(true);
  });

  it('with both reports newer than every source, nothing is refused (non-vacuous baseline)', () => {
    // Without this, "not refused" below could mean the check never ran at all.
    scenario([[LCOV, S(600)], [LCOV_SHELL, S(600)]], () => {
      expect(refused().refused, 'refused even with both reports newer than everything').toBe(false);
    });
  }, 260_000);

  it('THE COST: a shell file newer than the JS report — but older than the SHELL report — is fine', () => {
    scenario([[LCOV, S(0)], [LCOV_SHELL, S(600)], [SH, S(300)]], () => {
      const r = refused();
      expect(r.refused,
        `a shell edit forced a full JS re-measure; lcov.info contains no shell:\n${r.out.slice(0, 300)}`)
        .toBe(false);
    });
  }, 260_000);

  it('a shell file newer than the SHELL report is still refused', () => {
    // Under-refusal is the dangerous direction: a stale shell number is what the gate must never
    // serve. Narrowing the rule must not cost this.
    scenario([[LCOV, S(600)], [LCOV_SHELL, S(0)], [SH, S(300)]], () => {
      expect(refused().refused, 'a shell report older than a shell file was served').toBe(true);
    });
  }, 260_000);

  it('a JavaScript file newer than the JS report is still refused', () => {
    scenario([[LCOV, S(0)], [LCOV_SHELL, S(600)], [JS, S(300)]], () => {
      expect(refused().refused, 'a JS report older than a JS file was served').toBe(true);
    });
  }, 260_000);
});

/**
 * BOTH SUITES LIVE IN ONE FILE ON PURPOSE.
 *
 * They set mtimes on the same two lcov files. Vitest runs separate test FILES in parallel workers,
 * so as two files they raced: one suite restored a timestamp while the other was mid-scenario, and
 * the failure landed on whichever lost. Within one file they run in sequence, and the shared state
 * has exactly one owner at a time.
 */
function askStage(...args: string[]) {
  const r = spawnSync(NODE20, [HANDLER, ...args], { encoding: 'utf8', timeout: 240000, cwd: REPO });
  const out = (r.stdout || '') + (r.stderr || '');
  return { out, stdout: (r.stdout || '').trim(), refused: /is OLDER than/.test(out) };
}
const SHELL_ONLY_STAGE = 'launch';
const HANDLER_JS = join(SCRIPTS, 'lib/handlers',
  readdirSync(join(SCRIPTS, 'lib/handlers')).find((f) => f.endsWith('.js'))!);

describe('a stage is refused only for its own files', () => {
  it('the fixtures exist', () => {
    expect(existsSync(HANDLER_JS) && existsSync(LCOV) && existsSync(LCOV_SHELL)).toBe(true);
    expect(askStage('--stages').stdout.split('\n').map((s) => s.trim()))
      .toContain(SHELL_ONLY_STAGE);
  }, 260_000);

  it('THE COST: a stale JavaScript file does not silence a shell-only stage', () => {
    scenario([[LCOV, S(0)], [LCOV_SHELL, S(600)], [HANDLER_JS, S(300)]], () => {
      const r = askStage(SHELL_ONLY_STAGE);
      expect(r.refused,
        `the ${SHELL_ONLY_STAGE} stage refused over a file it does not contain:\n${r.out.slice(0, 300)}`)
        .toBe(false);
      expect(Number(r.stdout), `no percentage came back: ${r.out.slice(0, 200)}`).not.toBeNaN();
    });
  }, 260_000);

  it('but the stage that DOES contain the stale file is still refused', () => {
    // Under-refusal is the dangerous direction. Narrowing scope must not buy a stale number.
    scenario([[LCOV, S(0)], [LCOV_SHELL, S(600)], [HANDLER_JS, S(300)]], () => {
      const stages = askStage('--stages').stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      const owning = stages.filter((st) => askStage(st).refused);
      expect(owning.length,
        'no stage refused at all, so the stale HANDLER_JS file is vouched for by nobody and noticed by nobody')
        .toBeGreaterThan(0);
    });
  }, 300_000);

  it('PRE-FLIGHT IS UNCHANGED: --all still refuses while anything is unmeasurable', () => {
    scenario([[LCOV, S(0)], [LCOV_SHELL, S(600)], [HANDLER_JS, S(300)]], () => {
      expect(askStage('--all').refused, 'pre-flight would start a run it cannot measure').toBe(true);
    });
  }, 260_000);
});

