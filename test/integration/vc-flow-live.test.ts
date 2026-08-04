/**
 * THE WHOLE VC FLOW, DRIVEN BY THE REAL MODEL.
 *
 * This flow has produced a defect in almost every run this month, and it had no live
 * coverage at all — because the two stages that call an LLM (reviewVcViaSpeckit,
 * regenerateVcViaOpenspec) were not even exported. Only the pure functions around them
 * could be tested, and every defect lived in what the model actually returns.
 *
 * WHY IT GENERATES BUGS. The flow is a machine reading free text:
 *
 *   producer -> findVcMechanism (deterministic)
 *            -> reviewVcViaSpeckit  ........ LLM returns FREE-TEXT FLAG STRINGS
 *            -> partitionFlaggedVc  ........ PARSES those strings for "VC <n>"
 *            -> regenerateVcViaOpenspec .... LLM rewrites from those flags
 *            -> safeFallbackVc ............. two tautologies if nothing survives
 *
 * partitionFlaggedVc can only keep the clean criteria if it can tell WHICH criterion each
 * flag names. The reviewer's prompt declares the format — `["VC 2 prescribes halving — …"]`
 * — but nothing has ever checked that the model obeys it. If it answers "the third
 * criterion…" instead, every flag becomes unattributable, the whole set is condemned, and
 * the story goes to the writer with two criteria that cannot fail. That is a silent,
 * total-loss failure mode sitting on an unverified string format.
 *
 * Live evidence it is real: run 20260804T174832Z, one lane ended at
 * `resolution: fallback` with 2 tautologies, and nothing downstream objected.
 *
 * So this measures, per stage, against the real model:
 *   A  flag FORMAT compliance — the contract partitionFlaggedVc depends on
 *   B  reviewer PRECISION    — does it flag criteria that are already clean?
 *   C  reviewer RECALL       — does it catch genuine mechanism?
 *   D  regeneration CONVERGENCE — does the rewrite actually come back clean?
 *   E  the FULL loop         — how often does it end in fallback?
 *   F  real flags -> real partition — attribution on genuine model output
 *
 * Rates, not single assertions: one sample of an LLM proves nothing, and every earlier
 * defect here hid inside run-to-run variance.
 *
 * COST: ~VC_FLOW_SAMPLES calls per stage (default 3). Opt-in.
 * Run: RUN_LIVE_AGENT_TESTS=1 npx vitest run test/integration/vc-flow-live.test.ts
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const spec = require('../../orchestrations/scripts/spec-mode-runner.js');
const {
  reviewVcViaSpeckit,
  regenerateVcViaOpenspec,
  enforceVerificationCriteria,
  findVcMechanism,
  partitionFlaggedVc,
  safeFallbackVc,
} = spec;

const hasKey = !!(process.env.OPENROUTER_API_KEY || process.env.EPAM_API_KEY_ANTHROPIC);
const optedIn = process.env.RUN_LIVE_AGENT_TESTS === '1';
const N = Number(process.env.VC_FLOW_SAMPLES || '3');

const logDir = mkdtempSync(join(tmpdir(), 'vc-flow-live-'));
process.on('exit', () => { try { rmSync(logDir, { recursive: true, force: true }); } catch { /* */ } });

/** A realistic brownfield story: thin ticket, no ACs — the shape that keeps failing. */
const STORY = {
  id: 'ST-1',
  title: 'Live preview of content from the CMS',
  description:
    'Content editors cannot see their in-progress edits on the site. When an editor changes '
    + 'an entry in the CMS, the site should show that draft content in the preview instead of '
    + 'the published version, without a full page reload.',
  acceptanceCriteria: [] as string[],
  storyKind: 'novel',
};

const FINDINGS = [{
  file: 'src/hooks/useContent.ts',
  function: 'useContent',
  reason: 'the single hook every content read passes through',
}];

/** Criteria a careful author would write: observable, surface-level, no mechanism. */
const CLEAN_VC = [
  'When preview mode is active, the page displays the draft version of the entry rather than the published one.',
  'When preview mode is not active, the page displays the published content exactly as it did before this change.',
  'After an editor changes an entry, the page shows the new value without the user reloading the page.',
  'If the preview content cannot be loaded, the page shows a visible message instead of a blank area.',
];

/** Criteria that genuinely break the rules — mechanism, internals, test harness. */
const DIRTY_VC = [
  'The useContent hook\'s getContentByKey function is called with the preview flag set to true.',
  'The Contentstack SDK is mocked and emits a content-update event for a known content key.',
  'A websocket connection is opened to the preview service during initialisation.',
  'The preview value equals the value stored in the CMS draft entry.',
];

const isAttributable = (flag: string) => /\bVC\s*#?\s*\d+/i.test(String(flag));

describe.skipIf(!hasKey || !optedIn)('VC flow — every LLM stage, real model', () => {
  // ── A. The format the partition depends on ──────────────────────────────────
  describe('A. reviewer flags are machine-attributable', () => {
    const samples: string[][] = [];

    it(`collects ${N} real reviews of a mechanism-laden set`, async () => {
      for (let i = 0; i < N; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const flags = await reviewVcViaSpeckit({ story: STORY, vc: DIRTY_VC, cycle: 1, logDir });
        expect(Array.isArray(flags), `sample ${i + 1} did not return an array`).toBe(true);
        samples.push(flags);
      }
      expect(samples).toHaveLength(N);
    }, 900_000);

    it('EVERY flag names its criterion in the declared "VC <n>" form', () => {
      const all = samples.flat();
      expect(all.length, 'the reviewer flagged nothing at all in a deliberately dirty set — ' +
        'that is a recall failure, checked separately in C').toBeGreaterThan(0);
      const bad = all.filter((f) => !isAttributable(f));
      expect(
        bad.length,
        `${bad.length}/${all.length} flags name no criterion. partitionFlaggedVc cannot ` +
          'attribute those, so it condemns the WHOLE set and the story falls back to two ' +
          `tautologies. Offending flags:\n${bad.slice(0, 5).map((f) => `  - ${f}`).join('\n')}`,
      ).toBe(0);
    });

    it('the indices the reviewer cites are IN RANGE for the set it was given', () => {
      const out = samples.flat()
        .map((f) => Number((String(f).match(/\bVC\s*#?\s*(\d+)/i) || [])[1]))
        .filter((n) => !Number.isNaN(n))
        .filter((n) => n < 1 || n > DIRTY_VC.length);
      expect(
        out.length,
        `the reviewer cited criterion numbers outside 1..${DIRTY_VC.length}: ${out.join(', ')}. ` +
          'An out-of-range index is unattributable and condemns the whole set.',
      ).toBe(0);
    });
  });

  // ── B. Precision: does it flag work that is already fine? ────────────────────
  describe('B. reviewer precision on a genuinely clean set', () => {
    const flagCounts: number[] = [];

    it(`reviews a clean set ${N} times`, async () => {
      for (let i = 0; i < N; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const flags = await reviewVcViaSpeckit({ story: STORY, vc: CLEAN_VC, cycle: 1, logDir });
        flagCounts.push((flags || []).length);
      }
      expect(flagCounts).toHaveLength(N);
    }, 900_000);

    it('does not condemn a majority of clean criteria', () => {
      const worst = Math.max(...flagCounts);
      expect(
        worst,
        `worst sample flagged ${worst}/${CLEAN_VC.length} observable criteria (all samples: ` +
          `${flagCounts.join(', ')}). Over-flagging is what drives regeneration, then partial ` +
          'retention, then fallback — the path that ends in two tautologies.',
      ).toBeLessThan(CLEAN_VC.length);
    });

    it('the deterministic guard agrees the clean set is clean (fixture sanity)', () => {
      expect(
        findVcMechanism(CLEAN_VC),
        'the fixture itself breaks the rules, so B measures nothing',
      ).toEqual([]);
    });
  });

  // ── C. Recall: does it catch real mechanism? ─────────────────────────────────
  describe('C. reviewer recall on genuine mechanism', () => {
    it('flags a set that plainly violates the rules', async () => {
      const flags = await reviewVcViaSpeckit({ story: STORY, vc: DIRTY_VC, cycle: 1, logDir });
      expect(
        (flags || []).length,
        'a criterion asserting an internal function is called, a mocked SDK, a websocket ' +
          'and a value-equality cross-check drew NO objection — the reviewer is not reading ' +
          'its own rules',
      ).toBeGreaterThan(0);
    }, 300_000);
  });

  // ── D. Does regeneration actually converge? ──────────────────────────────────
  describe('D. regeneration returns usable, mechanism-free criteria', () => {
    it('rewrites flagged criteria into clean ones', async () => {
      const flags = [
        'VC 1 references the useContent hook — restate as an observable page outcome',
        'VC 2 prescribes mocking the SDK — restate as what the user sees',
      ];
      const out = await regenerateVcViaOpenspec({
        story: STORY, flags, cycle: 2, logDir, findings: FINDINGS,
      });
      expect(out, 'regeneration returned null — the loop then keeps the flagged set and ' +
        'burns its remaining cycle for nothing').not.toBeNull();
      expect(Array.isArray(out) && out.length, 'regeneration returned an empty set').toBeTruthy();
      expect(
        findVcMechanism(out),
        `the rewrite still breaks the deterministic rules:\n${JSON.stringify(out, null, 2)}`,
      ).toEqual([]);
    }, 300_000);
  });

  // ── E. The whole loop, with real review and real regeneration ────────────────
  describe('E. the full enforcement loop', () => {
    const outcomes: Array<{ source: string; count: number }> = [];

    it(`runs the real loop ${N} times end to end`, async () => {
      for (let i = 0; i < N; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await enforceVerificationCriteria(STORY, CLEAN_VC.slice(), {
          regenerateVc: (flags: string[], nextCycle: number) => regenerateVcViaOpenspec({
            story: STORY, flags, cycle: nextCycle, logDir, findings: FINDINGS,
          }),
          reviewVc: (vc: string[], cycle: number) => reviewVcViaSpeckit({
            story: STORY, vc, cycle, logDir,
          }),
          findings: FINDINGS,
        });
        outcomes.push({ source: r.source, count: (r.vc || []).length });
      }
      expect(outcomes).toHaveLength(N);
    }, 1_800_000);

    it('NEVER ends in the two-tautology fallback for a sound input', () => {
      const fell = outcomes.filter((o) => o.source === 'fallback');
      expect(
        fell.length,
        `${fell.length}/${outcomes.length} runs fell back to safeFallbackVc on criteria that ` +
          `are observable and mechanism-free. Outcomes: ` +
          `${outcomes.map((o) => `${o.source}(${o.count})`).join(', ')}. Live 20260804T174832Z ` +
          'a lane did exactly this and reached the writer with two criteria that cannot fail.',
      ).toBe(0);
    });

    it('keeps a usable number of criteria every time', () => {
      const thin = outcomes.filter((o) => o.count < 2);
      expect(
        thin.length,
        `a run kept fewer than 2 criteria: ${outcomes.map((o) => `${o.source}(${o.count})`).join(', ')}`,
      ).toBe(0);
    });

    it('what it keeps is mechanism-free (the guard is not bypassed by retention)', async () => {
      const r = await enforceVerificationCriteria(STORY, CLEAN_VC.slice(), {
        regenerateVc: (flags: string[], nextCycle: number) => regenerateVcViaOpenspec({
          story: STORY, flags, cycle: nextCycle, logDir, findings: FINDINGS,
        }),
        reviewVc: (vc: string[], cycle: number) => reviewVcViaSpeckit({
          story: STORY, vc, cycle, logDir,
        }),
        findings: FINDINGS,
      });
      expect(findVcMechanism(r.vc)).toEqual([]);
      expect(r.vc).not.toEqual(safeFallbackVc(STORY));
    }, 600_000);
  });

  // ── F. Real flags through the real partition ─────────────────────────────────
  describe('F. attribution works on genuine model output', () => {
    it('a real review of a partly-dirty set partitions without condemning everything', async () => {
      const mixed = [CLEAN_VC[0], DIRTY_VC[0], CLEAN_VC[1], CLEAN_VC[2]];
      const flags = await reviewVcViaSpeckit({ story: STORY, vc: mixed, cycle: 1, logDir });
      expect((flags || []).length, 'nothing flagged in a set containing a plain violation')
        .toBeGreaterThan(0);

      const { clean, unattributable } = partitionFlaggedVc(mixed, flags);
      expect(
        unattributable,
        `the reviewer's real flags could not be attributed, so the entire set is condemned ` +
          `and the story falls back to tautologies. Flags:\n${(flags || []).map((f: string) => `  - ${f}`).join('\n')}`,
      ).toBe(false);
      expect(
        clean.length,
        'every criterion was dropped from a set that was mostly clean',
      ).toBeGreaterThan(0);
    }, 300_000);
  });
});

describe.skipIf(hasKey && optedIn)('VC flow live test is opt-in', () => {
  it('is skipped without RUN_LIVE_AGENT_TESTS=1 and an API key', () => {
    expect(true).toBe(true);
  });
});
