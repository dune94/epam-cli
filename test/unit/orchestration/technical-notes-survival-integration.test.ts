/**
 * technicalNotes.files survival — REAL execution of the actual, unmodified
 * spec-mode-runner.js functions chained exactly as the real spec pass loop
 * chains them (applySpecChanges → captureStorySnapshot → capReviewSnapshot),
 * reproducing the full openspec-then-speckit sequential flow that hit the
 * live AMSD-1820 bug — without a real LLM call (the bug lives entirely in
 * how already-parsed agent payloads get applied and snapshotted, not in
 * anything the model itself says).
 *
 * Built 2026-07-23 after AMSD-1820 (real Metrolinx ticket): openspec's real
 * locationHint correctly set story.technicalNotes.files, but the
 * prd-change-reviewer's before/after payload — built via a blind
 * `JSON.stringify(snapshot).slice(0, 1000)` — silently dropped technicalNotes
 * whenever acceptanceCriteria (serialized first) was long enough, which real
 * multi-AC tickets routinely are. Any verdict that triggered a revert then
 * restored technicalNotes to its PRE-openspec value (null), discarding a
 * correct discovery. Fixed via capReviewSnapshot (own isolated test:
 * review-snapshot-technicalNotes-truncation.test.ts). THIS test covers the
 * fuller chain: does technicalNotes.files actually survive from openspec's
 * turn, through what the reviewer sees, through speckit's subsequent turn
 * (which never touches locationHint/technicalNotes at all), to the final
 * story state?
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const specModeRunner = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { applySpecChanges, captureStorySnapshot, capReviewSnapshot } = specModeRunner;

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function makeLogDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'spec-survival-'));
  cleanupDirs.push(d);
  return d;
}

const REAL_FILES = [
  'src/services/submit-reservations/apply-report-discounts.service.ts',
  'src/services/order-staff-notes/generate-staff-notes.mappers.ts',
  'src/clients/mozio/mappers/map-to-sanitized-mozio-dispatch.ts',
];

// The exact 8-AC shape from the live AMSD-1820 ticket — long enough that the
// OLD .slice(0, 1000) bug would have cut technicalNotes out of the reviewer's
// view (proven directly in review-snapshot-technicalNotes-truncation.test.ts).
const ORIGINAL_8_ACS = [
  "The system displays the promo code discount amount for the outbound trip in the Mozio email confirmation when a return trip ticket with a promo code is purchased.",
  "The system displays the promo code discount amount for the return trip in the Mozio email confirmation when a return trip ticket with a promo code is purchased.",
  "The promo code discount amount shown for the return trip in the email confirmation matches the discount amount applied to the return trip in the order payload.",
  "The system applies and displays the promo code discount amount for both the outbound and return trips independently when a single promo code covers a round-trip booking.",
  "The system displays a promo code discount amount of zero for the return trip in the email confirmation when the promo code discount does not apply to the return portion, rather than omitting the field entirely.",
  "The system renders the promo code discount amount for the return trip in the email confirmation locale and currency format consistent with the outbound trip display.",
  "The system includes the promo code discount amount for the return trip in the email confirmation HTML template for all supported locales, not just the default locale.",
  "The system does not duplicate or misapply the outbound promo code discount amount to the return trip line item in the email confirmation when only one trip segment is discounted.",
];

function makeStory() {
  return {
    id: 'AMSD-1820',
    title: '[Mozio] - Promo code discount amount not correctly displayed for Return trip tickets',
    description: 'Original bug description.',
    acceptanceCriteria: ORIGINAL_8_ACS,
    technicalNotes: null,
    codeline: 'cdts',
    agentRole: 'typescript-engineer',
  };
}

describe('technicalNotes.files survival across the real openspec → speckit flow', () => {
  it('openspec turn: applySpecChanges sets technicalNotes.files from a real locationHint payload', () => {
    const story = makeStory();
    const logDir = makeLogDir();
    const openspecPayload = {
      acceptanceCriteria: ORIGINAL_8_ACS,
      notes: 'root-cause analysis',
      locationHint: REAL_FILES.map((file) => ({ file, function: 'x', reason: 'why' })),
    };
    applySpecChanges(story, openspecPayload, [], { stories: [story] }, 'core', 'test-run', logDir);
    expect(story.technicalNotes?.files).toEqual(REAL_FILES);
  });

  it('the reviewer prompt payload (capReviewSnapshot) actually contains technicalNotes for this exact 8-AC story shape', () => {
    const story = makeStory();
    const logDir = makeLogDir();
    const beforeSnapshot = captureStorySnapshot(story); // pre-openspec: technicalNotes null

    const openspecPayload = {
      acceptanceCriteria: ORIGINAL_8_ACS,
      notes: 'root-cause analysis',
      locationHint: REAL_FILES.map((file) => ({ file, function: 'x', reason: 'why' })),
    };
    applySpecChanges(story, openspecPayload, [], { stories: [story] }, 'core', 'test-run', logDir);
    const afterSnapshot = captureStorySnapshot(story);

    // This is exactly what reviewPrdChange sends to the reviewer model.
    const beforePrompt = JSON.stringify(capReviewSnapshot(beforeSnapshot));
    const afterPrompt = JSON.stringify(capReviewSnapshot(afterSnapshot));

    // Prove the OLD bug's premise: the naive slice would have missed it.
    expect(JSON.stringify(afterSnapshot).indexOf('technicalNotes')).toBeGreaterThan(1000);
    // Prove the FIX: the actual reviewer-facing payload has it regardless.
    for (const file of REAL_FILES) {
      expect(afterPrompt).toContain(file);
    }
    expect(beforePrompt).toContain('"technicalNotes":null');
  });

  it('speckit turn (no locationHint/technicalNotes in its payload) does not wipe openspec\'s technicalNotes.files', () => {
    const story = makeStory();
    const logDir = makeLogDir();

    // Openspec's turn.
    applySpecChanges(
      story,
      { acceptanceCriteria: ORIGINAL_8_ACS, notes: 'root-cause', locationHint: REAL_FILES.map((file) => ({ file, function: 'x', reason: 'why' })) },
      [], { stories: [story] }, 'core', 'test-run', logDir,
    );
    expect(story.technicalNotes?.files).toEqual(REAL_FILES);

    // Speckit's turn — real shape: rewords/expands ACs, never mentions
    // technicalNotes or locationHint at all (see runSpeckitReview's own
    // prompt schema — it only ever asks for acceptanceCriteria/notes/etc).
    const speckitPayload = {
      acceptanceCriteria: [
        ...ORIGINAL_8_ACS.map((ac) => `Reworded: ${ac}`),
        'Additional edge case ACs added by speckit for multi-promo-code scenarios.',
        'Another hardened AC about zero-discount error handling.',
      ],
      notes: 'hardened for testability',
    };
    applySpecChanges(story, speckitPayload, [], { stories: [story] }, 'core', 'test-run', logDir);

    expect(story.technicalNotes?.files).toEqual(REAL_FILES);
    expect(story.acceptanceCriteria.length).toBeGreaterThan(8); // speckit's AC rewrite did apply
  });

  it('full sequential integration: technicalNotes.files survives openspec → reviewer-view → speckit → final story state', () => {
    const story = makeStory();
    const logDir = makeLogDir();

    // 1. openspec turn.
    const beforeOpenspec = captureStorySnapshot(story);
    applySpecChanges(
      story,
      { acceptanceCriteria: ORIGINAL_8_ACS, notes: 'root-cause', locationHint: REAL_FILES.map((file) => ({ file, function: 'x', reason: 'why' })) },
      [], { stories: [story] }, 'core', 'test-run', logDir,
    );
    const afterOpenspec = captureStorySnapshot(story);

    // 2. What the reviewer actually sees for openspec's turn — must contain
    //    the real files, proving the reviewer's verdict (whatever it is) is
    //    at least an INFORMED one, not one made blind to technicalNotes.
    const reviewerSawFiles = REAL_FILES.every((f) => JSON.stringify(capReviewSnapshot(afterOpenspec)).includes(f));
    expect(reviewerSawFiles).toBe(true);
    expect(capReviewSnapshot(beforeOpenspec).technicalNotes).toBeNull();

    // 3. speckit turn (runs regardless of the reviewer's verdict on openspec,
    //    in the real flow, once accepted).
    applySpecChanges(
      story,
      { acceptanceCriteria: [...ORIGINAL_8_ACS, 'One more hardened AC from speckit.'], notes: 'hardened' },
      [], { stories: [story] }, 'core', 'test-run', logDir,
    );

    // 4. Final state: technicalNotes.files must still be exactly what
    //    openspec discovered — this is the actual end-to-end guarantee the
    //    live bug violated.
    expect(story.technicalNotes?.files).toEqual(REAL_FILES);
  });
});
