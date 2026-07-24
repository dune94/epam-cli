/**
 * capReviewSnapshot() — REAL execution of the actual, unmodified exported
 * function from spec-mode-runner.js.
 *
 * Built 2026-07-23 after AMSD-1820 (real Metrolinx production ticket) showed
 * openspec correctly discovering a real, grounded locationHint (3 real
 * files), applySpecChanges correctly writing it to story.technicalNotes.files
 * — and then that write silently disappearing. Root cause: reviewPrdChange
 * built its BEFORE/AFTER payload with `JSON.stringify(snapshot).slice(0, 1000)`.
 * captureStorySnapshot() serializes acceptanceCriteria FIRST; a real ticket's
 * several detailed ACs routinely push technicalNotes past byte offset 1000
 * (confirmed for this exact story: technicalNotes started at offset 1448).
 * The reviewer then judged a payload it never actually saw technicalNotes in.
 * ANY verdict that triggers spec-mode-runner's revert path restores
 * `beforeSnapshot.technicalNotes` — silently discarding a correct, real
 * discovery. mock1's trivial 4-AC fixture never serializes anywhere near
 * 1000 chars, so this had zero test coverage until now — this is a
 * payload-SIZE bug, not a single/multi-agent one.
 */
import { describe, it, expect } from 'vitest';

const specModeRunner = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { capReviewSnapshot } = specModeRunner;

function longStorySnapshot(acCount: number) {
  return {
    acceptanceCriteria: Array.from({ length: acCount }, (_, i) =>
      `The system displays the promo code discount amount for scenario ${i} in the Mozio email confirmation when a return trip ticket with a promo code is purchased and additional edge-case text pads this out realistically.`
    ),
    description: 'A real, verbose bug description.',
    title: 'A real story title',
    technicalNotes: {
      files: [
        'src/services/submit-reservations/apply-report-discounts.service.ts',
        'src/services/order-staff-notes/generate-staff-notes.mappers.ts',
        'src/clients/mozio/mappers/map-to-sanitized-mozio-dispatch.ts',
      ],
    },
  };
}

describe('capReviewSnapshot — technicalNotes must survive regardless of AC length', () => {
  it('reproduces the exact live failure shape: a real 8-AC story pushes technicalNotes past byte 1000 when uncapped', () => {
    const snap = longStorySnapshot(8);
    const uncappedLength = JSON.stringify(snap).indexOf('technicalNotes');
    expect(uncappedLength).toBeGreaterThan(1000); // proves the OLD .slice(0,1000) bug would have cut it
  });

  it('always includes technicalNotes in the capped output, however many ACs exist', () => {
    for (const count of [1, 8, 9, 20, 100]) {
      const capped = capReviewSnapshot(longStorySnapshot(count));
      expect(capped.technicalNotes).toEqual({
        files: [
          'src/services/submit-reservations/apply-report-discounts.service.ts',
          'src/services/order-staff-notes/generate-staff-notes.mappers.ts',
          'src/clients/mozio/mappers/map-to-sanitized-mozio-dispatch.ts',
        ],
      });
    }
  });

  it('leaves acceptanceCriteria untouched when at or under the cap (8)', () => {
    const snap = longStorySnapshot(8);
    const capped = capReviewSnapshot(snap);
    expect(capped.acceptanceCriteria).toEqual(snap.acceptanceCriteria);
  });

  it('truncates acceptanceCriteria with a visible marker when over the cap', () => {
    const capped = capReviewSnapshot(longStorySnapshot(20));
    expect(capped.acceptanceCriteria).toHaveLength(9); // 8 kept + 1 marker
    expect(capped.acceptanceCriteria[8]).toMatch(/…and 12 more AC\(s\)/);
  });

  it('preserves description and title unchanged', () => {
    const snap = longStorySnapshot(20);
    const capped = capReviewSnapshot(snap);
    expect(capped.description).toBe(snap.description);
    expect(capped.title).toBe(snap.title);
  });

  it('handles a snapshot with no acceptanceCriteria at all (split-delegation placeholder case)', () => {
    const capped = capReviewSnapshot({ acceptanceCriteria: undefined, technicalNotes: { files: ['a.ts'] } });
    expect(capped.acceptanceCriteria).toEqual([]);
    expect(capped.technicalNotes).toEqual({ files: ['a.ts'] });
  });
});
