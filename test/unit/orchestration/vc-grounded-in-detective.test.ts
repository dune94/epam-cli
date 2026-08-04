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
  /**
   * NOW ASSERTED BY EXECUTION, AND THE BAR IS HIGHER.
   *
   * This used to compare source-string indexes for `await runCodeGraphDetective(story,
   * logDir)` versus `await enforceVerificationCriteria(...)`. It broke the moment the call
   * became injectable (`runDetective`) — while the invariant it protects became STRICTLY
   * STRONGER: the detective now runs before the producer's model call, which is itself
   * before enforcement. A test comparing source offsets asserts where characters sit in a
   * file, not what the program does.
   *
   * The ordering is observed for real in vc-producer-grounding.test.ts, which spawns a stub
   * runner that records whether the detective's marker already existed when the model was
   * invoked. Here we keep the weaker structural guarantee that both stages exist and that
   * enforcement still receives the findings.
   */
  it('the detective\'s findings reach VC enforcement', () => {
    const enforce = src.indexOf('await enforceVerificationCriteria(story, rawVc');
    expect(enforce, 'VC enforcement not found').toBeGreaterThan(-1);
    const block = src.slice(enforce, enforce + 700);
    expect(
      block,
      'enforcement no longer receives the located fix site, so the fallback and the ' +
        'regeneration path both lose their anchor',
    ).toMatch(/findings:\s*detectiveFindings/);
  });

  it('the producer is grounded BEFORE it writes — the detective is not left until after', () => {
    const i = src.indexOf('async function runSpecAgent');
    expect(i).toBeGreaterThan(-1);
    const fn = src.slice(i, src.indexOf('const prompt = `${forcedRetryBlock}', i));
    expect(
      fn,
      'the detective runs AFTER the producer\'s model call again — first-pass VCs are ' +
        'written for code that has never been located. Live 20260804T162414Z: the only ' +
        'lane that reached the grounded (regeneration) path kept all 5 criteria; the two ' +
        'that kept first-pass output went partial, one down to a single criterion.',
    ).toMatch(/await runDetective\(story, logDir\)/);
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
