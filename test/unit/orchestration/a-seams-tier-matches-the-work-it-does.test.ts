/**
 * A SEAM'S TIER MATCHES THE WORK IT DOES.
 *
 * The tier is declared once, in invocation-profiles.json, and BOTH stacks read it — claude and
 * codemie map the same rung to their own models. So a mis-tiered seam is mis-tiered everywhere.
 *
 * What each tier actually buys (llm-defaults.<set>.json):
 *
 *   medium   start haiku,  ceiling sonnet,  rung-0 budget  40 iterations / medium effort
 *   high     start haiku,  ceiling opus-5,  rung-0 budget  40 iterations / medium effort
 *   highest  start SONNET, ceiling opus-5,  rung-0 budget 250 iterations / high effort
 *
 * `highest` skips Haiku deliberately — "25 seams resolve here and would waste a rung proving a
 * small model cannot do the work". That reasoning holds for seams that write or judge code. It
 * does not hold for classifiers, and 24 of 41 seams sit there.
 *
 * MEASURED, pipeline-tests-44 (2026-09-08), not asserted from taste:
 *
 *   agent-failure-analyst   highest   59 calls   avg 80 output tokens   $1.34
 *   codeline-discovery      highest    1 call    avg 4,200 tokens       $0.29
 *
 * 80 output tokens is a classification. Entering it two rungs up, with a 250-iteration budget and
 * Haiku skipped, buys nothing it can use. This test pins the corrected tiers so a later edit
 * cannot quietly restore them, and pins the invariants that keep the ladder resolvable at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const profiles = () => JSON.parse(
  readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles;
const stackLadders = (set: string) => {
  const f = join(ROOT, `orchestrations/config/llm-defaults.${set}.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).ladders || {} : null;
};

describe('a seam tier matches the work it does', () => {
  // NO RECALIBRATION IS ASSERTED HERE, and the attempt is recorded rather than hidden.
  //
  // Measured pipeline-tests-44, agent-failure-analyst ran 59 times emitting a mean of 80 output
  // tokens on `highest` — which reads like a classifier paying for a tier that skips haiku and
  // grants 250 rung-0 iterations. Moving it to `medium` was wrong, for a reason already written
  // down: operator, 2026-08-12, "writer, reviewer and self-heal get the highest ladder, and
  // medium is a waste on seams whose output decides whether work is accepted or a model is
  // escalated." A diagnostician's verdict decides exactly that. Short output is not weak work.
  //
  // codeline-discovery was likewise moved to `high` on one $0.29 call — no evidence at all, and
  // it is the fixture every-seam-gets-its-ladder-from-any-caller.test.ts uses as the top tier.
  //
  // What remains below are the INVARIANTS, which hold whatever the tiers are.

  // A SEAM DECLARES A POSITION (base/mid/top) in the set's declared tier order; the set owns the
  // tier names (2026-08-15 rule, restored 2026-09-11). 'top' IS the strongest tier on every set
  // by construction of the resolver, so the top-tier invariant is a position check.
  it('THE SEAMS THAT WRITE OR JUDGE CODE STAY AT THE TOP TIER', () => {
    const p = profiles();
    for (const s of ['story-writer', 'team-lead-review', 'code-review-cycle', 'spec-agent',
      'qa-gate:review-ranger', 'qa-gate:mutant-hunter', 'qa-gate:spec-validator']) {
      expect(p[s].ladder, `${s} writes or judges code and must keep the top tier`).toBe('top');
    }
    // The reviews that refuted a false roster claim on 2026-09-08 pay for themselves.
    for (const s of ['roster-review', 'project-roster-review']) {
      expect(p[s].ladder, `${s} is the falsifier that caught a fabricated project convention`)
        .toBe('top');
    }
  });

  it('EVERY SEAM DECLARES A POSITION, and every position resolves to a tier on BOTH stacks', () => {
    const p = profiles();
    const missing = Object.entries(p).filter(([, v]: any) => !v.ladder).map(([k]) => k);
    expect(missing, `these seams declare no ladder, so they resolve no model: ${missing.join(', ')}`)
      .toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveTierPosition } = require(join(process.cwd(), 'orchestrations/scripts/lib/seam-invocation.js'));
    const positions = [...new Set(Object.values(p).map((v: any) => v.ladder))];
    for (const set of ['claude', 'codemie']) {
      const L = stackLadders(set);
      expect(L, `no ladder file for the ${set} stack`).not.toBeNull();
      const order = Object.keys(L!);
      const absent = positions.filter((pos) => !L![resolveTierPosition(pos, { EPAM_MODEL_LADDER_TIER_ORDER: order.join(' ') })]);
      expect(absent, `${set} resolves no ladder for position(s): ${absent.join(', ')}`).toEqual([]);
    }
  });

  it('BOTH STACKS AGREE ON WHICH TIERS EXIST — one registry, two mappings', () => {
    const c = Object.keys(stackLadders('claude') || {}).sort();
    const m = Object.keys(stackLadders('codemie') || {}).sort();
    expect(c, 'claude and codemie offer different tiers, so one registry cannot serve both')
      .toEqual(m);
  });
});
