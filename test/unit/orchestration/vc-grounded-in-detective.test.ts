/**
 * VC generation must be grounded in the detective's findings.
 *
 * Live metrolinx 2026-07-25 (AMSD-1820) — the first run where every mechanical
 * stage succeeded, so VC quality finally became the binding constraint. The guard
 * flagged:
 *
 *   "VC 3 addresses station names, which is unrelated to the ticket's stated
 *    symptom (promo code amount in return trip email)"
 *
 * Two cycles failed to clear it, so enforceVerificationCriteria fell back to
 * safeFallbackVc: 4 specific criteria replaced by 2 generic ones derived purely
 * from the ticket title. The writer then produced a VALID test (ran, typechecked,
 * committed on attempt 1) which the repro-gate rejected — "the new test(s) FAIL
 * with the fix in place".
 *
 * ROOT CAUSE — ordering, not model quality. runCodeGraphDetective() was called
 * AFTER the VC enforcement block, so in a single pass the VC generator
 * structurally could not see the findings. And regenerateVcViaOpenspec's prompt
 * carried only flags + acceptanceCriteria + description: no locationHint, no file,
 * no function, no prescribed fix.
 *
 * So the model was asked to specify OBSERVABLE behaviour for code it had never
 * been shown, working from ticket prose about return trips. "Station names" is
 * exactly the drift that produces. Meanwhile the detective had already identified
 * apply-report-discounts.service.ts — the very file the fix landed in.
 *
 * The detective's own prompt states the intent: "You run early (during the
 * specification pass) and your output grounds every downstream agent." This is a
 * plumbing gap against stated design, not a deliberate choice.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RUNNER = join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js');
const src = readFileSync(RUNNER, 'utf8');

describe('the detective grounds VC generation', () => {
  it('runs BEFORE the VC enforcement block', () => {
    const detective = src.indexOf('await runCodeGraphDetective(story, logDir)');
    const enforce = src.indexOf('await enforceVerificationCriteria(story, rawVc');
    expect(detective, 'detective call not found').toBeGreaterThan(-1);
    expect(enforce, 'VC enforcement not found').toBeGreaterThan(-1);
    expect(detective,
      'the detective still runs AFTER VC enforcement — the VC generator cannot ' +
      'see the fix site, so it specifies observable behaviour for code it has ' +
      'never been shown')
      .toBeLessThan(enforce);
  });

  it('regeneration receives the fix site, not just ticket prose', () => {
    const i = src.indexOf('async function regenerateVcViaOpenspec');
    expect(i).toBeGreaterThan(-1);
    const fn = src.slice(i, i + 1800);
    expect(fn,
      'the regeneration prompt carries only flags + ACs + description; without the ' +
      'located file/function the model has nothing to anchor an observable check to')
      .toMatch(/locationHint|detective|fix site|findings/i);
  });

  it('passes findings through the enforcement call', () => {
    const i = src.indexOf('await enforceVerificationCriteria(story, rawVc');
    const call = src.slice(i, i + 500);
    expect(call, 'findings are not threaded into the regenerate callback')
      .toMatch(/findings|detective/i);
  });
});
