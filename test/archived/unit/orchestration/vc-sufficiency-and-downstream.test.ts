/**
 * Step 3 (detective sufficiency gate) + Step 4 (thread VC downstream) of the
 * AC/VC/TC design (2026-07-24).
 *
 * Step 3: the detective IS the sufficiency signal — no fix site + thin context
 *   (sparse ACs + short description) → fail early, "insufficient context" (no
 *   human halt), before a doomed implementation.
 * Step 4: verificationCriteria is threaded to every downstream consumer — the
 *   implementation prompt, the reviewer, and the TC writer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const spec = require(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'));
const { isThinContext } = spec;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const specSrc = read('orchestrations/scripts/spec-mode-runner.js');
const orchSrc = read('orchestrations/scripts/run-agent-orchestration.sh');
const claudeSrc = read('orchestrations/scripts/claude.sh');
const reviewSrc = read('orchestrations/scripts/team-lead-review.sh');
const tcSrc = read('orchestrations/scripts/post-impl-tc-writer.sh');

describe('step 3 — isThinContext', () => {
  it('is thin when there is no meaningful AC AND a short description', () => {
    expect(isThinContext({ acceptanceCriteria: [], description: 'promo bug' })).toBe(true);
    expect(isThinContext({ acceptanceCriteria: ['x'], description: '' })).toBe(true);
  });
  it('is NOT thin when the description carries the context (sparse-AC edge case)', () => {
    const desc = 'When a return-trip ticket has a promo code, the discount amount is not shown for the return leg in the Mozio confirmation email; it should display for both legs.';
    expect(isThinContext({ acceptanceCriteria: [], description: desc })).toBe(false);
  });
  it('is NOT thin when there is a meaningful acceptance criterion', () => {
    expect(isThinContext({ acceptanceCriteria: ['The return-trip promo discount is displayed in the email.'], description: '' })).toBe(false);
  });
});

describe('step 3 — sufficiency gate wiring', () => {
  it('spec pass flags insufficientContext when no fix site AND thin context', () => {
    expect(specSrc).toMatch(/if \(!hasFixSite && isThinContext\(story\)\)/);
    expect(specSrc).toMatch(/story\.specification\.insufficientContext = true/);
    expect(specSrc).toMatch(/INSUFFICIENT CONTEXT for/);
  });
  it('orchestration hard-blocks (exit 2) on an insufficientContext story — always on', () => {
    expect(orchSrc).toMatch(/insufficientContext == true/);
    expect(orchSrc).toMatch(/INSUFFICIENT CONTEXT —/);
    expect(orchSrc).toMatch(/exit 2/);
  });
});

describe('step 4 — VC threaded downstream', () => {
  it('implementation prompt injects the Verification Criteria', () => {
    expect(claudeSrc).toMatch(/verification_criteria=\$\(echo "\$story_json" \| jq -r '\(.verificationCriteria/);
    expect(claudeSrc).toMatch(/Verification Criteria \(what a tester will CONFIRM/);
  });
  it('reviewer judges the diff against the Verification Criteria', () => {
    expect(reviewSrc).toMatch(/STORY_VC=\$\(jq -r/);
    expect(reviewSrc).toMatch(/\.verificationCriteria/);
    expect(reviewSrc).toMatch(/VERIFICATION CRITERIA \(the observable checks this change MUST satisfy/);
  });
  it('TC writer derives test facts primarily from the Verification Criteria', () => {
    expect(tcSrc).toMatch(/verificationCriteria/);
    expect(tcSrc).toMatch(/derive the test facts primarily from these/);
  });
});
