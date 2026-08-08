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
 * A project needing all-or-nothing sets EPAM_LANE_FAILURE_IS_FATAL=1.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

describe('a lane that fails no longer fails the run by default', () => {
  it('the unconditional _overall=1 on lane failure is gone', () => {
    const i = ORCH.indexOf('did not complete — its retries and self-heal are exhausted');
    expect(i, 'the lane-failure branch is gone entirely').toBeGreaterThan(-1);
    const branch = ORCH.slice(i, i + 1200);
    // _overall=1 must be reachable ONLY under the explicit opt-in
    const overallIdx = branch.indexOf('_overall=1');
    const fatalIdx = branch.indexOf('EPAM_LANE_FAILURE_IS_FATAL');
    expect(overallIdx, 'lane failure no longer marks the run at all').toBeGreaterThan(-1);
    expect(
      fatalIdx,
      'a failed lane still fails the run unconditionally',
    ).toBeLessThan(overallIdx);
  });

  it('all-or-nothing remains available as an explicit project choice', () => {
    expect(ORCH).toMatch(/EPAM_LANE_FAILURE_IS_FATAL:-0/);
    expect(ORCH).toMatch(/one lane failing fails the run/i);
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

  it('it points at the all-or-nothing switch for projects that need it', () => {
    const i = ORCH.indexOf('did NOT complete on all of them');
    expect(ORCH.slice(i, i + 600)).toMatch(/EPAM_LANE_FAILURE_IS_FATAL=1/);
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
