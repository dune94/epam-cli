/**
 * The TC writer is a greenfield mechanism. Brownfield proves changes differently.
 *
 * Decision, 2026-07-26, after examining what actually happened on the live
 * codeline: test criteria were NEVER generated for it, because `is_test_story`
 * hardcoded `.test.ts` while every test there is named `.spec.ts`. The tests
 * were written correctly anyway — run 7's covered two of three verification
 * criteria unprompted and was proven RED→GREEN by execution.
 *
 * That is not luck; it is a different and stronger mechanism. A verification
 * criterion states the observable outcome, the repro-test-writer builds a test
 * from it plus the real fix diff and a real example test from the repo, and the
 * bug-reproduction gate EXECUTES that test against the pre-fix and post-fix
 * code. A test criterion is a written intention; RED→GREEN is a demonstration.
 *
 * Adding TCs on top would restate the VCs one model call further from the
 * source and hand the writer a second, overlapping requirement list to drift
 * from — and TCs are generated post-implementation from DECLARED files, which
 * is the prediction-vs-record problem that has bitten this pipeline repeatedly.
 *
 * Greenfield keeps them: there is no bug to reproduce and no baseline to run
 * against, so TCs are what says "done".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

describe('Step 10 runs only for greenfield', () => {
  it('skips the TC writer when brownfield', () => {
    const idx = ORCH.indexOf('"brownfield — VCs + bug-reproduction gate instead"');
    expect(idx, 'brownfield still runs the TC writer').toBeGreaterThan(-1);
    const near = ORCH.slice(Math.max(0, idx - 400), idx + 200);
    expect(near).toMatch(/EPAM_BROWNFIELD.*=.*"1"/);
  });

  it('says WHY it skipped, not just that it did', () => {
    // A silent skip is indistinguishable from a broken step — the failure mode
    // this pipeline has hit most often.
    const idx = ORCH.indexOf('"brownfield — VCs + bug-reproduction gate instead"');
    expect(ORCH.slice(idx, idx + 500))
      .toMatch(/verification criteria|bug-reproduction/i);
  });

  it('still runs the TC writer for greenfield', () => {
    const idx = ORCH.indexOf('"brownfield — VCs + bug-reproduction gate instead"');
    expect(ORCH.slice(idx, idx + 800),
      'the greenfield path was removed along with the brownfield one')
      .toMatch(/_tc_writer_needed/);
  });

  it('the brownfield check precedes the needs-TC check', () => {
    // Otherwise a brownfield run still pays for the query that decides whether
    // TCs are needed at all.
    const skipIdx = ORCH.indexOf('"brownfield — VCs + bug-reproduction gate instead"');
    const needIdx = ORCH.indexOf('elif [ "${_tc_writer_needed:-0}" -gt 0 ]');
    expect(needIdx).toBeGreaterThan(skipIdx);
  });
});
