/**
 * VC guard + autonomous regenerate loop — step 2 of the AC/VC/TC design (2026-07-24).
 *
 * A VC must describe WHAT a tester observes, never HOW to implement it. Enforced
 * by BOTH a deterministic mechanism-detector AND speckit's strict flag-only
 * review. On a flag the pipeline resolves autonomously (NO human): regenerate via
 * openspec (ladder-escalating the model per cycle) → re-check → and if it still
 * can't converge, a conservative mechanism-free "symptom-is-fixed" fallback VC.
 * Never halts.
 */
import { describe, it, expect } from 'vitest';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { findVcMechanism, safeFallbackVc, enforceVerificationCriteria } = spec;

const STORY = { id: 'T', title: 'promo amount not shown for return trip', acceptanceCriteria: ['shows discount for return leg'] };

describe('findVcMechanism — deterministic guard', () => {
  it('flags the exact domain-mechanism phrasing that misdirected the fix', () => {
    const flagged = findVcMechanism([
      'Split the discount per segment',
      'The amount is halved (×0.5) for the return leg',
      'Calculate the return discount independently',
      'Add a new outboundDiscount field',
      'For each line item, apply the discount',
    ]);
    expect(flagged.length).toBe(5);
  });
  it('does NOT flag a purely observable VC', () => {
    expect(findVcMechanism([
      'The return-trip promo discount amount is displayed in the Mozio email confirmation.',
      'The outbound discount is unchanged.',
    ])).toEqual([]);
  });
});

describe('safeFallbackVc — conservative, mechanism-free', () => {
  it('is derived from the ticket symptom and passes the guard', () => {
    const fb = safeFallbackVc(STORY);
    expect(fb.length).toBeGreaterThan(0);
    expect(findVcMechanism(fb)).toEqual([]); // the fallback can never itself be mechanism-y
    expect(fb[0]).toMatch(/observed to be correct/);
  });
});

describe('enforceVerificationCriteria — autonomous loop (no human, never halts)', () => {
  it('clean VC → persisted as-is (source: clean), no regenerate', async () => {
    const r = await enforceVerificationCriteria(STORY, ['The return-leg promo discount amount appears in the email.'], {});
    expect(r.source).toBe('clean');
  });

  it('mechanism VC with no regenerator → conservative fallback (never a mechanism VC)', async () => {
    const r = await enforceVerificationCriteria(STORY, ['The discount is halved (×0.5) per leg.'], {});
    expect(r.source).toBe('fallback');
    expect(findVcMechanism(r.vc)).toEqual([]);
  });

  it('mechanism VC + a regenerator that fixes it → regenerated (clean)', async () => {
    const r = await enforceVerificationCriteria(STORY, ['Split the discount per segment.'], {
      regenerateVc: async () => ['The return-leg promo discount amount is shown in the email confirmation.'],
    });
    expect(r.source).toBe('regenerated');
    expect(findVcMechanism(r.vc)).toEqual([]);
  });

  it('speckit flags an otherwise clean VC → regenerate loop resolves it', async () => {
    let cycleSeen = 0;
    const r = await enforceVerificationCriteria(STORY, ['The thing works.'], {
      reviewVc: async (_vc: string[], c: number) => { cycleSeen = c; return c === 1 ? ['too vague, not testable'] : []; },
      regenerateVc: async () => ['The return-leg discount amount is shown as a positive value in the email.'],
    });
    expect(r.source).toBe('regenerated');
    expect(cycleSeen).toBeGreaterThanOrEqual(1);
  });

  it('a regenerator that keeps producing mechanism → still ends in a safe fallback (bounded)', async () => {
    const r = await enforceVerificationCriteria(STORY, ['Split it.'], {
      regenerateVc: async () => ['Still split it per leg.'], // never clean
      maxCycles: 2,
    });
    expect(r.source).toBe('fallback');
    expect(findVcMechanism(r.vc)).toEqual([]);
  });
});

describe('VC enforcement is wired into the brownfield merge block', () => {
  it('calls enforceVerificationCriteria with openspec-regenerate + speckit-review callbacks and persists resolution', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');
    expect(src).toMatch(/await enforceVerificationCriteria\(story, rawVc/);
    expect(src).toMatch(/regenerateVc: \(flags, nextCycle\) => regenerateVcViaOpenspec/);
    expect(src).toMatch(/reviewVc: \(vc, cycle\) => reviewVcViaSpeckit/);
    expect(src).toMatch(/story\.vcResolution = enforced\.source/);
  });
});
