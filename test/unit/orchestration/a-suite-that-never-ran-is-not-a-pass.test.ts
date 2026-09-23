/**
 * A VERIFICATION THAT COULD NOT RUN IS NOT A VERIFICATION THAT PASSED.
 *
 * Found in the regintel run, 2026-09-22 (twice — REGI-004-B and REGI-004-A):
 *
 *   Running external verification: pytest tests/test_classifier.py
 *   [WARNING] External verification failed for REGI-004-B (exit 2)
 *   [SUCCESS] External verification … only pre-existing baseline test failures — none introduced
 *   [SUCCESS] Story REGI-004-B marked as completed
 *
 * pytest exit 2 is a COLLECTION/USAGE error: the suite never executed, so it emitted no parseable
 * FAILED ids. baseline_new_failures then found an empty delta and returned 0, and the caller reads
 * an empty delta as "every failure was pre-existing" — so a story whose tests never ran was marked
 * complete. "Nothing failed" and "nothing ran" were indistinguishable.
 *
 * This executes the REAL decision, extracted from lib/external-verification.sh by marker, driven
 * with the real shapes: a suite that errored without running, a suite whose failures are all
 * pre-existing, and a suite with a genuinely new failure.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const REPO_ROOT = join(__dirname, '../../../');
const EV = join(REPO_ROOT, 'orchestrations/scripts/lib/external-verification.sh');
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

function decide(opts: { exit: number; output: string; deltaRc: number; delta?: string; baselineKnown?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'ev-decide-'));
  dirs.push(dir);
  const script = join(dir, 'run.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'story_id=S-1',
    `test_exit=${opts.exit}`,
    `test_cmd="pytest"`,
    `test_output=${JSON.stringify(opts.output)}`,
    `output_file=${JSON.stringify(join(dir, 'out.log'))}`,
    `LOG_DIR=${JSON.stringify(dir)}; PROJECT_ROOT=${JSON.stringify(dir)}`,
    'warning() { echo "WARN: $*"; }',
    'success() { echo "SUCCESS: $*"; }',
    'log() { :; }; error() { echo "ERROR: $*"; }',
    'evidence_window() { echo 40; }',
    // what the baseline actually knows about, published by baseline_new_failures
    `export BASELINE_KNOWN_FAILURES=${opts.baselineKnown ?? 0}`,
    // the real delta helper's contract: rc 0 = no NEW failures, rc 1 = these are new
    `baseline_new_failures() { ${opts.delta ? `printf '%s' ${JSON.stringify(opts.delta)}; ` : ''}return ${opts.deltaRc}; }`,
    decisionBlock(),
    'echo "FELL_THROUGH"',
  ].join('\n'));
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 15000 });
  return { out: (r.stdout || '') + (r.stderr || ''), status: r.status ?? -1 };
}

describe('a suite that never ran is not a pass', () => {
  it('REPRODUCES the live defect: a collection error with no parseable failures must NOT be called "only pre-existing"', () => {
    // pytest exit 2, the exact shape: an import error during collection, no FAILED lines at all.
    const { out } = decide({
      exit: 2,
      output: 'ImportError while loading conftest\nE   ModuleNotFoundError: No module named \'dial\'\n',
      deltaRc: 0,
    });
    expect(out, 'a suite that never executed was reported as having only pre-existing failures')
      .not.toMatch(/only pre-existing baseline test failures/);
  });

  it('a suite that RAN and whose failures are all pre-existing still passes', () => {
    const { out } = decide({
      exit: 1,
      output: '5 failed, 99 passed, 1 skipped\nFAILED tests/test_costs.py::test_duplicate_records_cost_zero - AssertionError\n',
      deltaRc: 0,
      baselineKnown: 5,   // the baseline holds those five — that is what makes them inheritable
    });
    expect(out, 'the baseline-diff pass was lost — every inherited failure would now block')
      .toMatch(/only pre-existing baseline test failures/);
  });

  it('a genuinely new failure still fails', () => {
    const { out } = decide({
      exit: 1,
      output: '1 failed, 99 passed\nFAILED tests/test_new.py::test_thing - AssertionError\n',
      deltaRc: 1,
      delta: 'FAILED tests/test_new.py::test_thing - AssertionError',
    });
    expect(out).not.toMatch(/only pre-existing baseline test failures/);
  });
});
