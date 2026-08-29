/**
 * A RUN THAT NEVER RESUMED MUST NOT SAY IT RESUMED.
 *
 * One hardcoded sentence served two different conditions:
 *
 *   } else if (EPAM_SKIP_AGENT_MINT === '1' || EPAM_ROSTER_ONLY === '1') {
 *       write('[mint-step] mint skipped (EPAM_SKIP_AGENT_MINT=1) — resuming from a checkpoint');
 *
 * So a roster-only run announced a flag it was not given, and a FRESH run announced a
 * checkpoint that did not exist. Seen on the paid run of 2026-08-28, where a start-at-the-
 * beginning run logged "resuming from a checkpoint" three times, and the roster review then
 * declined itself with "reviewed in the run being resumed" — of a run that never existed.
 *
 * The operator ruled that the skip itself is CORRECT: there is nothing minted to review when the
 * mint did not run. The defect is only the false justification. A gate that explains itself with an
 * event that did not happen is worse than a silent one, because the reason gets believed.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
const step = require_(join(__dirname, '../../../orchestrations/scripts/mint-agents-step.js'));

describe('THE REASON GIVEN IS THE REASON THAT APPLIES', () => {
  it('a resume says it is resuming', () => {
    const r = step.mintSkipReason({ EPAM_SKIP_AGENT_MINT: '1', EPAM_RESUME_RUN: '20260828T172102Z' });
    expect(r).toMatch(/resum/i);
    expect(r).toMatch(/20260828T172102Z/);
  });

  it('a skip WITHOUT a resume does not claim a checkpoint', () => {
    const r = step.mintSkipReason({ EPAM_SKIP_AGENT_MINT: '1' });
    expect(r, 'a fresh run announced a checkpoint that does not exist').not.toMatch(/resum|checkpoint/i);
    expect(r).toMatch(/EPAM_SKIP_AGENT_MINT/);
  });

  it('roster-only names ROSTER-ONLY, not a flag it was never given', () => {
    const r = step.mintSkipReason({ EPAM_ROSTER_ONLY: '1' });
    expect(r, 'roster-only announced EPAM_SKIP_AGENT_MINT=1, which was not set')
      .not.toMatch(/EPAM_SKIP_AGENT_MINT/);
    expect(r).toMatch(/roster-only/i);
  });

  it('roster-only during a resume says both, and truthfully', () => {
    const r = step.mintSkipReason({ EPAM_ROSTER_ONLY: '1', EPAM_RESUME_RUN: 'R-9' });
    expect(r).toMatch(/roster-only/i);
    expect(r).toMatch(/R-9/);
  });

  it('says nothing at all when the mint is not being skipped', () => {
    // The caller decides whether to skip; this only explains a skip that is happening.
    expect(step.mintSkipReason({})).toBe('');
  });
});

describe('AND THE ROSTER REVIEW EXPLAINS ITSELF THE SAME WAY', () => {
  it('a roster that was never minted is not "reviewed in the run being resumed"', () => {
    const r = step.rosterReviewSkipReason({ EPAM_ROSTER_ONLY: '1' });
    expect(r, 'the review declined itself by citing a run that never existed')
      .not.toMatch(/run being resumed/i);
    expect(r, 'the real reason is that nothing was minted to review').toMatch(/mint|nothing/i);
  });

  it('a genuine resume may still cite the run it resumed', () => {
    const r = step.rosterReviewSkipReason({ EPAM_SKIP_AGENT_MINT: '1', EPAM_RESUME_RUN: 'R-7' });
    expect(r).toMatch(/R-7/);
  });
});
