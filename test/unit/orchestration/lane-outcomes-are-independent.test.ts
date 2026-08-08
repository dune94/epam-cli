/**
 * ONE LANE'S FAILURE DOES NOT CONDEMN THE OTHERS.
 *
 * Lanes have their own log dir, PRD, worktree, investigator and writer, run in parallel, and
 * the orchestrator states that no lane is upstream of another. Then the result collapsed into
 * a single exit code, so one lane's gate decision failed a run in which the others had cleared.
 *
 * Live 2026-08-07: two lanes reached the writer pause cleanly; the third was blocked by the
 * spec review gate at a quality score of 0.68. The run reported failure, and nothing said
 * which lane, or that two thirds of the work was fine. Reading a log was the only way to tell
 * "one lane was gated" from "the pipeline broke".
 *
 * Independence is safe here because nothing reaches a client remote: work lands on a per-story
 * branch cut from origin/<baseline>, and merging is a human decision per codeline. What must
 * never happen is someone merging two of three WITHOUT KNOWING the third is missing — so the
 * summary carries that, loudly.
 *
 * CORRECTED 2026-08-07, same day: the first version of this took independence one step too
 * far and let the run exit 0 with a lane failed. That is the silent-failure class the pipeline
 * exists to eliminate — every automated caller reads the exit code, and the per-lane summary
 * below it is prose no caller parses. Independence governs WHAT KEEPS RUNNING (a failed lane
 * does not kill a sibling mid-work; EPAM_CASCADE_ABORT_ON_LANE_FAILURE=1 restores the cascade),
 * never the exit status. A run with any failed lane is a failed run, and the summary states
 * which lanes did complete so their work is not thrown away.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

describe('a failed lane always fails the run — independence never touches the exit code', () => {
  it('lane failure sets _overall=1 unconditionally, under no flag', () => {
    const i = ORCH.indexOf('did not complete — its retries and self-heal are exhausted');
    expect(i, 'the lane-failure branch is gone entirely').toBeGreaterThan(-1);
    const branch = ORCH.slice(i, i + 1600);
    expect(branch, 'lane failure no longer marks the run at all').toMatch(/_overall=1/);
    expect(
      branch,
      'the exit code was put back behind a flag — a caller reading exit 0 would be told a failed run succeeded',
    ).not.toMatch(/if \[ "\$\{EPAM_LANE_FAILURE_IS_FATAL[^\n]*\n[^\n]*_overall=1/);
  });

  it('no opt-in flag can suppress the failure exit code', () => {
    expect(ORCH, 'the suppression knob is back').not.toMatch(/EPAM_LANE_FAILURE_IS_FATAL/);
  });
});

describe('every lane outcome is recorded and reported', () => {
  it('each lane records ok or blocked', () => {
    expect(ORCH).toMatch(/_LANE_OUTCOMES=/);
    expect(ORCH).toMatch(/echo ok \|\| echo blocked/);
  });

  it('the summary counts completed and incomplete lanes', () => {
    const i = ORCH.indexOf('Lane outcomes —');
    expect(i, 'no per-lane summary is printed').toBeGreaterThan(-1);
    const block = ORCH.slice(i - 400, i + 900);
    expect(block).toMatch(/completed/);
    expect(block).toMatch(/did not/);
  });

  it('it names each lane rather than only counting them', () => {
    const i = ORCH.indexOf('Lane outcomes —');
    const block = ORCH.slice(i, i + 900);
    expect(block, 'the operator is left diffing timestamps to find which lane').toMatch(/\$\{_lc\}/);
  });
});

describe('a partial outcome is stated, never implied', () => {
  it('a mixed result warns that the story did not land everywhere', () => {
    const i = ORCH.indexOf('did NOT complete on all of them');
    expect(
      i,
      'someone can merge two of three codelines without being told the third is missing',
    ).toBeGreaterThan(-1);
  });

  it('it says where the completed work is and who decides on it', () => {
    const i = ORCH.indexOf('did NOT complete on all of them');
    const block = ORCH.slice(i, i + 600);
    expect(block).toMatch(/per-story branch/);
    expect(block).toMatch(/merging is yours to decide/i);
  });

  it('it states plainly that the run is reported as failed', () => {
    const i = ORCH.indexOf('did NOT complete on all of them');
    expect(
      ORCH.slice(i, i + 600),
      'the summary lists partial success without saying the run failed',
    ).toMatch(/reported as FAILED/);
  });

  it('the warning fires only on a MIXED result, not when every lane failed', () => {
    const i = ORCH.indexOf('did NOT complete on all of them');
    const block = ORCH.slice(i - 400, i);
    expect(
      block,
      'a wholly failed run would claim a partial landing',
    ).toMatch(/_blocked_n:-0\}" != "0" \] && \[ "\$\{_ok_n:-0\}" != "0"/);
  });
});
