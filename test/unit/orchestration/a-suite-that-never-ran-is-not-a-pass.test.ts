/**
 * A STORY IS JUDGED ON WHAT IT ADDED — AND A SUITE THAT NEVER RAN ADDED NOTHING JUDGEABLE.
 *
 * Two live defects, one decision:
 *
 * 2026-09-22 (REGI-004-B, REGI-004-A): pytest exit 2 is a COLLECTION error — the suite never
 * executed and emitted no FAILED ids. The delta was empty, the caller read an empty delta as "every
 * failure was pre-existing", and a story whose tests never ran was marked complete.
 *
 * 2026-09-24 (REGI-009a attempt 2, paid): the fix for that published the baseline's failure count
 * in BASELINE_KNOWN_FAILURES from inside baseline_new_failures — which every caller runs inside
 * `$(…)`. The subshell took the variable with it; the caller always read 0; a suite whose five
 * failures were ALL in the baseline was declared "did not run to a judgeable result" and the story
 * was failed. The analyst then escalated one of those inherited failures to REGI-007 (+$0.70, +1
 * attempt). The old test here stubbed baseline_new_failures and exported the variable itself — it
 * tested the receiver on a value the sender could never deliver.
 *
 * So the whole decision now lives in ONE place, baseline_new_failures, and travels by exit code
 * and stdout — what survives `$(…)`. This drives the REAL external-verification decision with the
 * REAL baseline_new_failures, the REAL verification plugin, the regintel codeline's own
 * verification declaration, the REAL baseline cache from that run, and the REAL suite output of
 * the regintel codeline at the baseline commit (19439a7: 5 failed, 99 passed).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const REPO_ROOT = join(__dirname, '../../../');
const EV = join(REPO_ROOT, 'orchestrations/scripts/lib/external-verification.sh');
const GATE = join(REPO_ROOT, 'orchestrations/scripts/lib/tsc-baseline-gate.sh');
const FIX = join(REPO_ROOT, 'test/fixtures/regintel/codeline-19439a7');
const SUITE_AT_BASELINE = readFileSync(join(REPO_ROOT, 'test/fixtures/runner-output/pytest-regintel-19439a7.out'), 'utf8');
const BASELINE_SHA = '19439a79e863';
const src = engineSource(EV);

/** The real block: from the non-zero-exit branch to the end of its success arm. */
function decisionBlock(): string {
  const start = src.indexOf('    if [ "$test_exit" -ne 0 ]; then');
  if (start === -1) throw new Error('the non-zero-exit branch moved');
  const ANCHOR = '            return 0\n        fi\n';
  const stop = src.indexOf(ANCHOR, start);
  if (stop === -1) throw new Error('the success arm moved');
  // close the branch the slice opened; everything after the success arm is the failure path,
  // which this test does not execute.
  return src.slice(start, stop + ANCHOR.length) + '\n    fi\n';
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A codeline carrying regintel's verification declaration and a run log dir carrying that run's
 * declared baseline SHA and its cached baseline failure ids — the state a resume keeps. */
function runState(): { root: string; logs: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ev-judge-'));
  dirs.push(dir);
  const root = join(dir, 'codeline'); const logs = join(dir, 'logs');
  mkdirSync(join(root, '.epam'), { recursive: true }); mkdirSync(logs);
  copyFileSync(join(FIX, '.epam/verification.json'), join(root, '.epam/verification.json'));
  writeFileSync(join(logs, 'phase-baseline-sha.txt'), `${BASELINE_SHA}\n`);
  copyFileSync(join(FIX, `baseline-failures-test-${BASELINE_SHA}.txt`), join(logs, `baseline-failures-test-${BASELINE_SHA}.txt`));
  return { root, logs };
}

function judge(opts: { exit: number; output: string; brownfield?: boolean }) {
  const { root, logs } = runState();
  const script = join(root, '..', 'run.sh');
  const outFile = join(root, '..', 'suite.out'); writeFileSync(outFile, opts.output);
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    `. ${JSON.stringify(GATE)}`,
    'story_id=S-1',
    `test_exit=${opts.exit}`,
    'test_cmd="python3 -m pytest"',
    // read from disk: a bash string literal would expand the suite's own `$` and backticks
    `test_output="$(cat ${JSON.stringify(outFile)})"`,
    `output_file=${JSON.stringify(join(logs, 'out.log'))}`,
    `LOG_DIR=${JSON.stringify(logs)}; PROJECT_ROOT=${JSON.stringify(root)}`,
    `AUTOMATION_DIR=${JSON.stringify(join(REPO_ROOT, 'orchestrations'))}`,
    'NODE_BIN=node',
    `export EPAM_BROWNFIELD=${opts.brownfield ? 1 : 0}`,
    // What a PARENT shell might hold from an earlier gate — the decision must not read it.
    'unset BASELINE_KNOWN_FAILURES',
    'warning() { echo "WARN: $*"; }',
    'success() { echo "SUCCESS: $*"; }',
    'log() { :; }; error() { echo "ERROR: $*"; }',
    'evidence_window() { echo 40; }',
    'judge() {',
    decisionBlock(),
    'echo "FELL_THROUGH"',
    '}',
    'judge',
  ].join('\n'));
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
  return { out: (r.stdout || '') + (r.stderr || ''), status: r.status ?? -1 };
}

const PASS = /only pre-existing baseline test failures — none introduced/;

describe('a story is judged on what it added', () => {
  it('the fixture is the real suite: five failures, all in the baseline', () => {
    const ids = readFileSync(join(FIX, `baseline-failures-test-${BASELINE_SHA}.txt`), 'utf8').split('\n').filter(Boolean);
    expect(ids).toHaveLength(5);
    for (const id of ids) expect(SUITE_AT_BASELINE).toContain(`FAILED ${id}`);
  });

  it('BROWNFIELD — REGI-009a attempt 2: a suite whose failures are ALL pre-existing passes the story', () => {
    const { out } = judge({ exit: 1, output: SUITE_AT_BASELINE, brownfield: true });
    expect(out, `an inherited failure was charged to the story:\n${out}`).toMatch(PASS);
    expect(out).not.toMatch(/judgeable|FELL_THROUGH/);
  });

  it('GREENFIELD — the same suite FAILS the story: nothing in a greenfield codeline is pre-existing', () => {
    // Operator, 2026-09-25: "Green field is not no failures on old ones that is brownfield." The
    // live regintel run passed REGI-009a and REGI-010-A on "only pre-existing baseline failures"
    // with 5 tests failing. Every test in a greenfield codeline was written by the run itself.
    const { out } = judge({ exit: 1, output: SUITE_AT_BASELINE, brownfield: false });
    expect(out, `a greenfield story passed with failing tests:\n${out}`).not.toMatch(PASS);
    expect(out).toContain('FELL_THROUGH');
  });

  it('a genuinely new failure fails the story, and the writer is shown only that one', () => {
    const output = SUITE_AT_BASELINE.replace(
      /^(=+ 5 failed)/m,
      'FAILED tests/test_new_story.py::test_it_works - AssertionError\n$1',
    );
    const { out } = judge({ exit: 1, output, brownfield: true });
    expect(out).not.toMatch(PASS);
    expect(out).toContain('FELL_THROUGH');
  });

  it('a collection error (pytest exit 2, no failure records) is not a pass — even with a baseline that has failures', () => {
    const { out } = judge({
      exit: 2,
      output: "ImportError while loading conftest\nE   ModuleNotFoundError: No module named 'dial'\n",
      brownfield: true,
    });
    expect(out, 'a suite that never executed was reported as having only pre-existing failures').not.toMatch(PASS);
    expect(out).toContain('FELL_THROUGH');
  });

  it('a red exit with no output at all is not a pass', () => {
    const { out } = judge({ exit: 1, output: '', brownfield: true });
    expect(out).not.toMatch(PASS);
    expect(out).toContain('FELL_THROUGH');
  });
});

describe('baseline_new_failures answers the whole question through what survives $(…)', () => {
  function delta(output: string) {
    const { root, logs } = runState();
    const f = join(logs, 'cur.out'); writeFileSync(f, output);
    const r = spawnSync('bash', ['-c', [
      `. ${JSON.stringify(GATE)}`,
      `AUTOMATION_DIR=${JSON.stringify(join(REPO_ROOT, 'orchestrations'))}`,
      'export EPAM_BROWNFIELD=1',
      `rc=0; d=$(baseline_new_failures ${JSON.stringify(root)} node ${JSON.stringify(logs)} test ${JSON.stringify(f)}) || rc=$?`,
      'printf "RC=%s\\n%s" "$rc" "$d"',
    ].join('\n')], { encoding: 'utf8', timeout: 30000 });
    return r.stdout;
  }
  it('all pre-existing: rc 0, nothing printed', () => expect(delta(SUITE_AT_BASELINE)).toBe('RC=0\n'));
  it('no failure records from a red check: rc 1, and it says why', () => {
    const out = delta("ImportError while loading conftest\n");
    expect(out).toMatch(/^RC=1\n/);
    expect(out).toContain('ImportError while loading conftest');
  });
});
