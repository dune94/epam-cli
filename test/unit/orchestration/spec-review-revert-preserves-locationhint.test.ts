/**
 * mergeLocationHintFiles() — REAL execution of the actual, unmodified
 * exported function from spec-mode-runner.js.
 *
 * Built 2026-07-31 after AMSD-2041 (real Metrolinx production ticket)
 * exhausted 8 implementation attempts across 2 inference-ladder rungs and
 * never converged. Root cause traced via orchestrations/logs/lane-metrolinx.log
 * ("prd-change-reviewer REJECTED openspec's changes to AMSD-2041 after 3
 * attempt(s): no details — reverting") and the live PRD
 * (orchestrations/projects/metrolinx/prd.json showed acceptanceCriteria: []
 * and technicalNotes: null for this story).
 *
 * The code-graph-detective HAD correctly traced the fix site (2 real files,
 * exact lines) and openspec's payload.locationHint carried it — but
 * prd-change-reviewer rejected the AC/description rewrite 3/3 tries (a
 * completely separate concern), and run()'s revert path restored
 * story.technicalNotes to its PRE-spec-pass value (null) wholesale,
 * discarding the independently-computed, correctly-grounded file list along
 * with the content it actually objected to. The rich root-cause prose
 * (story.fixSiteAnalysis) is NOT part of this snapshot/revert and survived —
 * so the implementer received a detailed narrative naming exact files, but
 * an empty "Files to Create/Modify" list and no injected file content. Every
 * attempt rediscovered the same two files from scratch via tool calls, and
 * because the inference ladder raises STORY_MAX_ITERATIONS at each rung
 * transition, later attempts were allowed to explore longer before giving
 * up — input tokens climbed 32,541 -> 339,316 across 8 attempts, none of
 * which ever produced a real fix.
 *
 * This is the SAME class of bug as review-snapshot-technicalNotes-truncation
 * (also AMSD-2041's ticket family, found 2026-07-23): "any verdict that
 * triggers spec-mode-runner's revert path restores beforeSnapshot.technicalNotes
 * — silently discarding a correct, real discovery." That fix made sure the
 * reviewer could SEE technicalNotes in its input; it did not stop the revert
 * from discarding it on a fail verdict. This closes that remaining gap.
 */
import { describe, it, expect } from 'vitest';

const specModeRunner = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { mergeLocationHintFiles, applySpecChanges } = specModeRunner;

const AMSD_2041_LOCATION_HINT = [
  {
    file: 'src/context/ContentstackContext.tsx',
    function: 'ContentstackProvider',
    reason: 'useMemo produces a static context value that never updates on live-preview callbacks',
    fix: 'Replace useMemo with useState and register Stack.livePreview(onEntryChange)',
  },
  {
    file: 'src/services/contentstack.ts',
    function: '',
    reason: 'live_preview is configured on the Stack but nothing subscribes to its update events',
    fix: '',
  },
];

describe('mergeLocationHintFiles — the shared merge used before AND after a revert', () => {
  it('merges locationHint file paths into empty/null technicalNotes', () => {
    const merged = mergeLocationHintFiles(null, AMSD_2041_LOCATION_HINT);
    expect(merged.files).toEqual([
      'src/context/ContentstackContext.tsx',
      'src/services/contentstack.ts',
    ]);
  });

  it('is additive — preserves any files already present, deduped', () => {
    const merged = mergeLocationHintFiles(
      { files: ['src/context/ContentstackContext.tsx', 'src/other/pre-existing.ts'] },
      AMSD_2041_LOCATION_HINT
    );
    expect(merged.files).toEqual([
      'src/context/ContentstackContext.tsx',
      'src/other/pre-existing.ts',
      'src/services/contentstack.ts',
    ]);
  });

  it('returns technicalNotes unchanged when locationHint is empty or absent', () => {
    const before = { files: ['a.ts'], dependsOn: ['SOME-ID'] };
    expect(mergeLocationHintFiles(before, [])).toBe(before);
    expect(mergeLocationHintFiles(before, undefined)).toBe(before);
    expect(mergeLocationHintFiles(null, [])).toBeNull();
  });

  it('ignores locationHint entries with no file field', () => {
    const merged = mergeLocationHintFiles(null, [{ file: '' }, { function: 'x' }, { file: 'real.ts' }]);
    expect(merged.files).toEqual(['real.ts']);
  });
});

describe('reproduces AMSD-2041: a content-quality revert must not erase the detective file list', () => {
  it('applySpecChanges populates technicalNotes.files from locationHint (the pre-revert state)', () => {
    const story = { id: 'AMSD-2041', acceptanceCriteria: [], technicalNotes: null };
    const payload = {
      acceptanceCriteria: ['(vague symptom-worded AC the reviewer will reject)'],
      locationHint: AMSD_2041_LOCATION_HINT,
    };
    applySpecChanges(story, payload, [], { stories: [story] }, 'phase1', 'run1', null);
    expect(story.technicalNotes.files).toEqual([
      'src/context/ContentstackContext.tsx',
      'src/services/contentstack.ts',
    ]);
  });

  it('THE BUG (unfixed shape): blindly restoring beforeSnapshot.technicalNotes wholesale discards the file list', () => {
    // This is exactly what run()'s revert path did before the fix — reproduced
    // directly here (not via mergeLocationHintFiles) to document the failure
    // mode this test suite guards against.
    const story = { id: 'AMSD-2041', acceptanceCriteria: [], technicalNotes: null };
    const beforeSnapshot = { acceptanceCriteria: [], description: '', title: '', technicalNotes: null };
    const payload = { acceptanceCriteria: ['bad AC'], locationHint: AMSD_2041_LOCATION_HINT };
    applySpecChanges(story, payload, [], { stories: [story] }, 'phase1', 'run1', null);
    expect(story.technicalNotes.files.length).toBeGreaterThan(0); // the detective's grounding is present...

    // ...and a naive revert (the old code) throws it all away:
    story.technicalNotes = beforeSnapshot.technicalNotes;
    expect(story.technicalNotes).toBeNull(); // this is the AMSD-2041 incident, reproduced
  });

  it('THE FIX: re-merging locationHint after the revert restores the file list regardless of what else reverted', () => {
    const story = { id: 'AMSD-2041', acceptanceCriteria: [], technicalNotes: null };
    const beforeSnapshot = { acceptanceCriteria: [], description: '', title: '', technicalNotes: null };
    const payload = { acceptanceCriteria: ['bad AC'], locationHint: AMSD_2041_LOCATION_HINT };
    applySpecChanges(story, payload, [], { stories: [story] }, 'phase1', 'run1', null);

    // Simulate the full revert run() performs: AC/description/title/technicalNotes
    // all restored to their pre-spec-pass values...
    story.acceptanceCriteria = beforeSnapshot.acceptanceCriteria;
    story.technicalNotes = beforeSnapshot.technicalNotes;
    // ...then the fix's re-merge, using the SAME payload.locationHint the spec
    // pass already computed (independent of whatever content got rejected).
    story.technicalNotes = mergeLocationHintFiles(story.technicalNotes, payload.locationHint);

    expect(story.acceptanceCriteria).toEqual([]); // the rejected AC content stays reverted
    expect(story.technicalNotes.files).toEqual([  // but the grounded file list survives
      'src/context/ContentstackContext.tsx',
      'src/services/contentstack.ts',
    ]);
  });
});
