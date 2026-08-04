/**
 * WHEN ONLY SOME VCs ARE FLAGGED, THE CLEAN ONES MUST SURVIVE.
 *
 * THE LIVE DEFECT (run 20260804T115608Z, all three lanes, story AMSD-2041). The VC
 * enforcement loop is all-or-nothing: if ANY flag remains after VC_MAX_CYCLES, the entire
 * criteria set is discarded and replaced by safeFallbackVc()'s two lines. The persisted
 * warnings show how little it took:
 *
 *   "...using conservative fallback VC. Last flags:
 *      VC 1 cross-compares to 'previously displayed value' — ...
 *    | VC 3 cross-compares displayed value to 'current values' (internal source) — ..."
 *
 *   "...Last flags: VC 3 references internal CMS structure ('fields only present in draft
 *    entries') ..."
 *
 * The second case flagged ONE criterion out of six. Five observable, well-formed,
 * detective-grounded criteria were thrown away to punish the sixth, and the writer received
 * two tautologies — "the behavior is observed to be correct" and "no regression" — which
 * verify nothing and cannot fail. gotransit went into the writer phase with 2 boilerplate
 * VCs while sibling lanes carried 8 and 4 genuine ones.
 *
 * This is the same failure shape as the review that could not block: a guard that fires
 * correctly and then destroys the work it was guarding.
 *
 * THE MAPPING IS DERIVED FROM THE PROMPT, NOT INVENTED. reviewVcViaSpeckit's prompt
 * declares the reviewer's output format verbatim:
 *
 *   Output ONLY a JSON array of short flag strings, e.g.
 *   ["VC 2 prescribes halving — restate as observable outcome"]
 *
 * so "VC <n>" is the contract, and n is 1-based because the same prompt numbers the
 * criteria `${i + 1}. ${v}`. The deterministic guard's flags carry the criterion text in
 * quotes instead, so both are attributable. A flag that matches NEITHER form is
 * unattributable, and the conservative reading is that it condemns the whole set.
 *
 * Nothing here names a project, codeline or vendor.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { partitionFlaggedVc, enforceVerificationCriteria, safeFallbackVc, findVcMechanism } = spec;

const STORY = { id: 'ST-1', title: 'A capability described in the ticket' };

/** Six criteria of the same shape the live run produced. */
const SIX = [
  'When preview mode is active, the page displays the draft version of the entry.',
  'When preview mode is not active, the page displays published content as before.',
  'The page reflects an edit made in the editor without a full reload.',
  'An error while loading preview content shows a visible fallback, not a blank page.',
  'The behavior is identical across every brand the ticket names.',
  'All supported content types render in preview mode.',
];

describe('partitionFlaggedVc — attributes a flag to the criterion it names', () => {
  it('splits on the reviewer\'s DECLARED "VC <n>" format, 1-based as the prompt numbers them', () => {
    const { clean, flagged } = partitionFlaggedVc(SIX, [
      'VC 3 references internal CMS structure — restate as an observable outcome',
    ]);
    expect(flagged).toEqual([SIX[2]]);
    expect(clean).toHaveLength(5);
    expect(clean).not.toContain(SIX[2]);
  });

  it('attributes MULTIPLE flags, and a criterion flagged twice is removed once', () => {
    const { clean, flagged } = partitionFlaggedVc(SIX, [
      'VC 1 cross-compares to a previously displayed value',
      'VC 3 references an internal source',
      'VC 3 also prescribes how the update happens',
    ]);
    expect(clean).toHaveLength(4);
    expect(flagged).toHaveLength(2);
    expect(clean).not.toContain(SIX[0]);
    expect(clean).not.toContain(SIX[2]);
  });

  it('attributes the deterministic guard\'s form, which quotes the criterion instead', () => {
    // findVcMechanism's flags are rendered as: reason + ': "<criterion, first 80 chars>"'
    const mech = `prescribes splitting (an implementation, not an observable outcome): "${SIX[4].slice(0, 80)}"`;
    const { clean, flagged } = partitionFlaggedVc(SIX, [mech]);
    expect(flagged).toEqual([SIX[4]]);
    expect(clean).toHaveLength(5);
  });

  it('an UNATTRIBUTABLE flag condemns the whole set — the conservative reading', () => {
    const { clean, unattributable } = partitionFlaggedVc(SIX, [
      'the criteria as a whole do not cover the acceptance criterion',
    ]);
    expect(unattributable, 'a flag naming no criterion must be reported, never ignored').toBe(true);
    expect(clean, 'nothing may be retained on a set-level objection').toHaveLength(0);
  });

  it('an out-of-range index is unattributable, not silently dropped', () => {
    const { unattributable } = partitionFlaggedVc(SIX, ['VC 99 is wrong']);
    expect(unattributable).toBe(true);
  });

  it('no flags at all leaves every criterion clean', () => {
    const { clean, flagged, unattributable } = partitionFlaggedVc(SIX, []);
    expect(clean).toEqual(SIX);
    expect(flagged).toHaveLength(0);
    expect(unattributable).toBe(false);
  });
});

describe('enforceVerificationCriteria retains the clean criteria instead of discarding all', () => {
  /** A reviewer that always flags criterion 3 — the live gotransit case, exactly. */
  const alwaysFlagsThird = async () => ['VC 3 references internal CMS structure — restate it'];

  it('THE LIVE DEFECT: one flagged criterion out of six no longer costs all six', async () => {
    const r = await enforceVerificationCriteria(STORY, SIX, {
      reviewVc: alwaysFlagsThird,
      regenerateVc: async () => null, // regeneration cannot converge, as it could not live
      maxCycles: 2,
    });
    expect(
      r.vc,
      'the loop fell back to boilerplate despite five clean criteria — the writer would ' +
        'receive two tautologies that cannot fail',
    ).not.toEqual(safeFallbackVc(STORY));
    expect(r.vc).toHaveLength(5);
    expect(r.vc).not.toContain(SIX[2]);
    expect(r.source).toBe('partial');
  });

  it('the retained criteria are the ORIGINAL text, not regenerated or paraphrased', async () => {
    const r = await enforceVerificationCriteria(STORY, SIX, {
      reviewVc: alwaysFlagsThird, regenerateVc: async () => null, maxCycles: 2,
    });
    for (const c of r.vc) expect(SIX).toContain(c);
  });

  it('what is retained is itself mechanism-free — retention must not smuggle a flagged VC through', async () => {
    const r = await enforceVerificationCriteria(STORY, SIX, {
      reviewVc: alwaysFlagsThird, regenerateVc: async () => null, maxCycles: 2,
    });
    expect(findVcMechanism(r.vc)).toEqual([]);
  });

  /**
   * SUPERSEDED BY MEASUREMENT, deliberately. This asserted that a blanket LLM
   * condemnation ends in the two-tautology fallback. Six live loops on criteria the
   * deterministic guard certifies clean showed the reviewer flagging 3 of 4 in one run —
   * so "everything flagged" is a signal the REVIEW is an outlier, not that the criteria
   * are worthless. Handing the writer two tautologies on an outlier review is the worse
   * outcome. The set is now kept and the dispute recorded.
   *
   * The intent behind the original test — retention must not become a way to keep
   * criteria the guard rejected — is preserved in the mechanism tests below and in
   * 'when EVERY criterion is genuine mechanism, it still falls back'.
   */
  it('EVERY criterion flagged by the LLM keeps the guard-certified work, and says so', async () => {
    const flagsAll = async () => SIX.map((_, i) => `VC ${i + 1} prescribes an implementation`);
    const r = await enforceVerificationCriteria(STORY, SIX, {
      reviewVc: flagsAll, regenerateVc: async () => null, maxCycles: 2,
    });
    expect(r.source).toBe('disputed');
    expect(r.vc, 'the tautology fallback is worse than a disputed real criterion')
      .not.toEqual(safeFallbackVc(STORY));
    expect(findVcMechanism(r.vc), 'but nothing the guard rejected may survive').toEqual([]);
  });

  it('a SET-LEVEL objection is not partitioned away — nothing is silently dropped', async () => {
    // An unattributable flag names no criterion, so no criterion may be singled out. It no
    // longer means "discard everything": the guard-certified set is kept and disputed.
    const r = await enforceVerificationCriteria(STORY, SIX, {
      reviewVc: async () => ['the criteria do not cover the acceptance criterion'],
      regenerateVc: async () => null,
      maxCycles: 2,
    });
    expect(r.source).toBe('disputed');
    expect(r.vc).toEqual(SIX);
    expect(r.flags.length, 'the objection must reach a human').toBeGreaterThan(0);
  });

  it('retention respects VC_MIN_RETAINED — too few survivors is DISPUTED, not a thin set', async () => {
    const prev = process.env.VC_MIN_RETAINED;
    process.env.VC_MIN_RETAINED = '4';
    try {
      // flag three of six → only 3 survive, below the floor of 4
      const r = await enforceVerificationCriteria(STORY, SIX, {
        reviewVc: async () => ['VC 1 bad', 'VC 2 bad', 'VC 3 bad'],
        regenerateVc: async () => null,
        maxCycles: 2,
      });
      // Below the floor the guard-certified set is kept and disputed — never reduced to
      // tautologies, which is the outcome the floor exists to prevent.
      expect(r.source).toBe('disputed');
      expect(r.vc.length, 'a thin set is exactly what the floor must prevent')
        .toBeGreaterThanOrEqual(4);
    } finally {
      if (prev === undefined) delete process.env.VC_MIN_RETAINED;
      else process.env.VC_MIN_RETAINED = prev;
    }
  });

  it('a CLEAN set is still reported clean — the happy path is untouched', async () => {
    const r = await enforceVerificationCriteria(STORY, SIX, {
      reviewVc: async () => [], regenerateVc: async () => null, maxCycles: 2,
    });
    expect(r.source).toBe('clean');
    expect(r.vc).toEqual(SIX);
  });

  it('a successful REGENERATION is still reported regenerated, not partial', async () => {
    let cycle = 0;
    const r = await enforceVerificationCriteria(STORY, SIX, {
      reviewVc: async () => (++cycle === 1 ? ['VC 3 bad'] : []),
      regenerateVc: async () => SIX.slice(0, 4),
      maxCycles: 3,
    });
    expect(r.source).toBe('regenerated');
  });

  it('the partial outcome carries the flags, so the retention is auditable', async () => {
    const r = await enforceVerificationCriteria(STORY, SIX, {
      reviewVc: alwaysFlagsThird, regenerateVc: async () => null, maxCycles: 2,
    });
    expect(r.flags.length, 'a silent partition would hide which criterion was dropped')
      .toBeGreaterThan(0);
  });
});

describe('the partition is derived from the prompt, not invented', () => {
  const SRC = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('the reviewer prompt really does declare the "VC <n>" flag format this parses', () => {
    expect(
      SRC,
      'if the prompt no longer declares this format, the parser is guessing — and a ' +
        'validator that restates a contract drifts away from it',
    ).toMatch(/JSON array of short flag strings.*\n?.*\["VC 2/);
  });

  it('the reviewer prompt numbers the criteria 1-based, matching the parser', () => {
    expect(SRC).toMatch(/vc\.map\(\(v, i\) => `\$\{i \+ 1\}\. \$\{v\}`\)/);
  });

  it('names no project, codeline or vendor', () => {
    const fn = SRC.slice(SRC.indexOf('function partitionFlaggedVc'));
    expect(fn.slice(0, 2000)).not.toMatch(/metrolinx|gotransit|upexpress|contentstack/i);
  });
});

/**
 * THE DECISION MUST REACH DISK. A dropped criterion is the pipeline deciding something
 * will not be verified. Recorded only in a console warning, it dies with the console —
 * and "generated but not persisted" is the defect class this project treats as a
 * violation outright.
 */
describe('the retention decision is persisted, not just logged', () => {
  const SRC = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('the call site records the resolution on the story, so it lands in the PRD', () => {
    expect(SRC).toMatch(/story\.vcResolution = enforced\.source/);
  });

  it('the DROPPED criteria are recorded on the story too', () => {
    expect(
      SRC,
      'without this, which criterion was discarded is knowable only from a console line',
    ).toMatch(/story\.vcDropped = enforced\.dropped/);
  });

  it('a partial resolution does NOT mark vcSource as fallback — it is not boilerplate', () => {
    // vcSource drives downstream trust in the criteria; only the true fallback is boilerplate.
    expect(SRC).toMatch(/enforced\.source === 'fallback'\s*\n?\s*\?\s*'fallback'/);
  });

  it('enforceVerificationCriteria returns `dropped` for the call site to persist', async () => {
    const r = await enforceVerificationCriteria(STORY, SIX, {
      reviewVc: async () => ['VC 3 references internal structure'],
      regenerateVc: async () => null,
      maxCycles: 2,
    });
    expect(r.dropped).toEqual([SIX[2]]);
  });
});

/**
 * AN OUTLIER REVIEW MUST NOT DELETE WORK THE DETERMINISTIC GUARD CERTIFIED.
 *
 * MEASURED LIVE, 2026-08-04, six full enforcement loops on four criteria that
 * findVcMechanism certifies clean:
 *
 *   regenerated(4), partial(2), regenerated(2), regenerated(4), partial(1), partial(3)
 *
 * Run 5 kept ONE criterion. The LLM reviewer flagged three of four, including "When
 * preview mode is active, the page displays the draft version of the entry" — textbook
 * observable, no mechanism, no internal structure. The old floor (VC_MIN_RETAINED=1)
 * accepted a single survivor as success and the story would have gone to the writer with
 * one criterion.
 *
 * THE PRINCIPLE. findVcMechanism is deterministic and authoritative: a criterion it flags
 * IS mechanism and is always dropped. The LLM reviewer adds judgement the regex cannot,
 * so its flags are ADVISORY. When acting on them would take the set below a usable floor,
 * the disagreement is more likely the reviewer's error than the author's — a review that
 * condemns most of a set is an outlier, and deleting real work on an outlier is the
 * failure mode measured above.
 *
 * So: apply deterministic drops always; apply advisory drops only while the set stays
 * above the floor; otherwise keep what the guard certified and record the dispute.
 *
 * CONFIGURABLE: VC_MIN_RETAINED (absolute, default 2), VC_MIN_RETAINED_FRACTION (0.5).
 */
describe('an outlier LLM review cannot strip a deterministically-clean set', () => {
  const FOUR = [
    'When preview mode is active, the page displays the draft version of the entry.',
    'When preview mode is not active, the page displays the published content as before.',
    'After an editor changes an entry, the page shows the new value without a reload.',
    'If preview content cannot be loaded, the page shows a visible message.',
  ];

  it('the fixture is deterministically clean (guard against a vacuous pass)', () => {
    expect(findVcMechanism(FOUR)).toEqual([]);
  });

  it('THE LIVE DEFECT: a reviewer flagging 3 of 4 does NOT leave one criterion', async () => {
    const r = await enforceVerificationCriteria(STORY, FOUR, {
      reviewVc: async () => ['VC 1 too vague', 'VC 2 too vague', 'VC 4 too vague'],
      regenerateVc: async () => null,
      maxCycles: 2,
    });
    expect(
      r.vc.length,
      `kept ${r.vc.length} of 4 criteria the deterministic guard certified clean. Measured ` +
        'live: 1 of 6 runs ended exactly here.',
    ).toBeGreaterThan(1);
    expect(r.vc, 'and it must not be the tautology fallback either')
      .not.toEqual(safeFallbackVc(STORY));
  });

  it('records the dispute rather than hiding it', async () => {
    const r = await enforceVerificationCriteria(STORY, FOUR, {
      reviewVc: async () => ['VC 1 too vague', 'VC 2 too vague', 'VC 4 too vague'],
      regenerateVc: async () => null,
      maxCycles: 2,
    });
    expect(r.source).toBe('disputed');
    expect(r.flags.length, 'the reviewer\'s objections must survive for a human to read')
      .toBeGreaterThan(0);
  });

  it('a MECHANISM flag is still authoritative — the guard is never overruled', async () => {
    const withMech = [...FOUR, 'The discount is halved (×0.5) per leg.'];
    const r = await enforceVerificationCriteria(STORY, withMech, {
      reviewVc: async () => [],
      regenerateVc: async () => null,
      maxCycles: 2,
    });
    expect(
      r.vc,
      'a criterion the deterministic guard rejected survived. Advisory treatment applies ' +
        'to the LLM reviewer ONLY.',
    ).not.toContain('The discount is halved (×0.5) per leg.');
    expect(findVcMechanism(r.vc)).toEqual([]);
  });

  it('a MODEST advisory drop is still honoured — this is not "ignore the reviewer"', async () => {
    const r = await enforceVerificationCriteria(STORY, FOUR, {
      reviewVc: async () => ['VC 3 references an internal payload'],
      regenerateVc: async () => null,
      maxCycles: 2,
    });
    expect(r.source).toBe('partial');
    expect(r.vc).toHaveLength(3);
    expect(r.vc).not.toContain(FOUR[2]);
  });

  it('the floor is CONFIGURABLE by fraction, without touching the engine', async () => {
    const prev = process.env.VC_MIN_RETAINED_FRACTION;
    process.env.VC_MIN_RETAINED_FRACTION = '0.9';   // demand 4 of 4 survive
    try {
      const r = await enforceVerificationCriteria(STORY, FOUR, {
        reviewVc: async () => ['VC 3 references an internal payload'],
        regenerateVc: async () => null,
        maxCycles: 2,
      });
      expect(r.source, 'a 3-of-4 retention should fall below a 0.9 floor').toBe('disputed');
    } finally {
      if (prev === undefined) delete process.env.VC_MIN_RETAINED_FRACTION;
      else process.env.VC_MIN_RETAINED_FRACTION = prev;
    }
  });

  it('everything flagged AND nothing deterministically wrong still keeps the work', async () => {
    const r = await enforceVerificationCriteria(STORY, FOUR, {
      reviewVc: async () => FOUR.map((_, i) => `VC ${i + 1} is unsatisfactory`),
      regenerateVc: async () => null,
      maxCycles: 2,
    });
    expect(
      r.source,
      'a blanket condemnation is the strongest signal of an unreliable review, not a ' +
        'reason to hand the writer two tautologies',
    ).toBe('disputed');
    expect(r.vc).toEqual(FOUR);
  });

  it('when EVERY criterion is genuine mechanism, it still falls back', async () => {
    const allBad = ['The value is halved (×0.5).', 'Each leg is calculated independently.'];
    const r = await enforceVerificationCriteria(STORY, allBad, {
      reviewVc: async () => [], regenerateVc: async () => null, maxCycles: 2,
    });
    expect(r.source).toBe('fallback');
  });
});
