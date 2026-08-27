/**
 * A CHECK THAT PASSES ON STALE DATA AND FAILS ON GOOD DATA IS REPORTING BACKWARDS.
 *
 * preflight-static.sh asks whether the TC writer would be briefed with anything. It selected any
 * story lacking testCriteria.facts — which, before the specification pass, is EVERY story. So on a
 * correctly reset PRD it always selected one, always found no context, and reported
 * "EMPTY — the TC writer would be given nothing" about a stage that had not run.
 *
 * Live 2026-08-27: it PASSED at run 14's launch because the PRD still held the previous run's
 * output, and FAILED afterwards on a PRD that pre-run-reset had correctly cleaned. Health on stale
 * data, a defect on good data.
 *
 * Verification criteria are the evidence a TC briefing is built FROM, and the spec pass produces
 * them. Absent, there is nothing to brief and the honest answer is "not yet" — present, with the
 * context still empty, the original defect stands and must still fail. This asserts BOTH, because
 * narrowing a check without proving it still fires is how a check gets quietly disabled.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { storyNeedingContext } = require(
  join(REPO_ROOT, 'orchestrations/scripts/lib/handlers/tc-story-needing-context.js'));

const prd = (extra: any) => ({
  implementationOrder: { core: ['S1'] },
  stories: [{ id: 'S1', status: 'active', ...extra }],
});

describe('the TC context check fires on a defect, not on a clean PRD', () => {
  it('selects nothing before the spec pass has produced criteria', () => {
    // The false alarm: a run has not reached the stage that creates the evidence.
    expect(storyNeedingContext(prd({}), 'core')).toBeNull();
  });

  it('STILL selects a story whose criteria exist but whose briefing would be empty', () => {
    // The real defect the check was written for. If this ever returns null the check is disabled.
    const s = storyNeedingContext(prd({ verificationCriteria: ['vc1'] }), 'core');
    expect(s, 'the check no longer fires on the defect it exists to catch').toBeTruthy();
    expect(s.id).toBe('S1');
  });

  it('selects nothing once the facts have been written', () => {
    expect(storyNeedingContext(
      prd({ verificationCriteria: ['vc1'], testCriteria: { facts: ['f'] } }), 'core')).toBeNull();
  });

  it('never selects a deprecated story', () => {
    expect(storyNeedingContext(
      prd({ status: 'deprecated', verificationCriteria: ['vc1'] }), 'core')).toBeNull();
  });
});
