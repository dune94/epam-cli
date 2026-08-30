/**
 * REPRODUCTION — written before any fix, to establish whether the defect is real.
 *
 * There are two independent answers in this codebase to "which models may a story be assigned":
 *
 *   lib/handlers/ladder-models.js   resolves the ACTIVE SET's ladder. Correct: it excludes
 *                                   MiniMax-M3 for both the claude and mockserver sets (verified
 *                                   in a-story-model-must-be-on-its-ladder.test.ts).
 *
 *   buildKnownValidModels()         reads EPAM_MODEL_LADDER_* from the ENVIRONMENT, and is what
 *                                   the assignment pass actually consults.
 *
 * If those variables are not exported into the process doing the assigning, the known set is
 * empty, and isValidModelString then falls back to `model === currentModel` — so whatever the
 * story already carries is accepted, however foreign to the active set.
 *
 * That would explain an observation from 2026-08-30 that fd72da1 was supposed to have closed: a
 * mockserver rehearsal, whose set declares a Claude ladder, ran its writer on
 * `provider=minimax model=MiniMax-M3`.
 *
 * If these assertions pass, the defect is NOT real and no fix should be written on this theory.
 */
import { describe, it, expect } from 'vitest';

const spec = require('../../orchestrations/scripts/spec-mode-runner.js');

/** The permitted set, as the assignment pass computes it, under a given environment. */
function known(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('EPAM_MODEL_LADDER')) { saved[k] = process.env[k]; delete process.env[k]; }
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return spec.buildKnownValidModels('', '');
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
}

describe('an off-ladder model is not accepted', () => {
  it('with the ladder exported, the permitted set is populated — the control', () => {
    const set = known({
      EPAM_MODEL_LADDER_TIER_ORDER: 'medium high',
      EPAM_MODEL_LADDER_MEDIUM_START: 'claude-haiku-4-5-20251001',
      EPAM_MODEL_LADDER_MEDIUM: 'claude-haiku-4-5-20251001=claude-sonnet-5',
    });
    expect(set.size, 'nothing was read from the exported ladder').toBeGreaterThan(0);
    expect(set.has('claude-sonnet-5')).toBe(true);
  });

  it('with NO ladder exported, the set is still populated — from the active set', () => {
    // WAS THE REPRODUCTION, NOW THE GUARD. Before the fix this returned an empty set, and
    // isValidModelString's only remaining rule is `model === currentModel` — so a story already
    // carrying a foreign model kept it. The permitted set is now read from
    // lib/handlers/ladder-models.js, the same answer pre-flight already trusts.
    const set = known({});
    expect(set.size, 'the permitted set is empty again: the assignment is bounded by nothing')
      .toBeGreaterThan(0);
  });

  it('and a foreign model is refused even when the story already carries it', () => {
    // The precise shape of the live failure: MiniMax-M3 as BOTH the proposed and the current
    // model, on a stack whose ladder never mentions it.
    const set = known({});
    expect(spec.isValidModelString('MiniMax-M3', 'MiniMax-M3', set),
      'a story keeps a model its own ladder does not declare').toBe(false);
  });

  it('and the same model IS refused once the ladder is actually exported', () => {
    const set = known({
      EPAM_MODEL_LADDER_TIER_ORDER: 'medium',
      EPAM_MODEL_LADDER_MEDIUM_START: 'claude-haiku-4-5-20251001',
      EPAM_MODEL_LADDER_MEDIUM: 'claude-haiku-4-5-20251001=claude-sonnet-5',
    });
    // Not the current model this time: a genuine reassignment to something off-ladder.
    expect(spec.isValidModelString('MiniMax-M3', 'claude-sonnet-5', set)).toBe(false);
  });
});
