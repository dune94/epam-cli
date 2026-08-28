/**
 * The team-lead reviewer must reason at HIGH effort (found 2026-07-24 while hardening
 * the brownfield ladder). The reviewer already uses the HIGH model ladder
 * (EPAM_MODEL_LADDER_HIGH: glm-5.2 → glm-5.1 → kimi-k3), but it set NO reasoning effort,
 * so it inherited the story's story-point-derived LOW effort. Approving/rejecting a fix
 * is a correctness-critical judgment — LOW effort makes the verdict weak (over-reject a
 * correct minimal fix, or miss a real defect). Force HIGH effort like the detective.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(__dirname, '../../../orchestrations/scripts/team-lead-review.sh'), 'utf8');

describe('team-lead reviewer reasons at HIGH effort', () => {
  it('the review-agent invocation sets EPAM_REASONING_EFFORT to high (env-overridable)', () => {
    expect(src).toMatch(/EPAM_REASONING_EFFORT="\$\{REVIEW_REASONING_EFFORT:-high\}"/);
  });

  it('still uses the HIGH model ladder (unchanged)', () => {
    expect(src).toMatch(/EPAM_MODEL_LADDER_HIGH/);
  });
});
