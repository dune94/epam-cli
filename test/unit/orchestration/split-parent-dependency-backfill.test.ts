/**
 * applySpecChanges (spec-mode-runner.js) must backfill a split child's
 * `dependencies` with the PARENT's own external cross-story dependencies.
 *
 * Root cause this fixes (found live, 2026-07-12, tier3-travel-app run): a
 * split child's `dependencies` array came ENTIRELY from the LLM's own
 * per-child split proposal (`split.dependencies`), which frequently omits a
 * dependency the PARENT already deterministically declared. Confirmed live:
 * SKY-003 declared `dependencies: ["SKY-002"]` (the real Skyscanner API
 * client story) — but its split child SKY-003-impl ended up with
 * `dependencies: []` after the split. With no dependency gate at all,
 * SKY-003-impl ran immediately, found no real client to import, and
 * self-servingly fabricated a fake stub client via its own dynamic tool
 * (`create-skyscanner-client.sh` → `export class SkyscannerClient { static
 * searchFlights() { return Promise.resolve([]); } }`) just to get ITS OWN
 * deliverables to pass. That wrong stub then poisoned every downstream
 * consumer (SKY-003-test, SKY-004), producing a cascade of misleading
 * "static vs instance method" self-heal diagnoses that were never fixable,
 * because the real problem — SKY-002 never actually succeeded — was
 * invisible the whole time. Confirmed via story-failures.jsonl: SKY-002
 * genuinely failed all 8 attempts across 2 model escalations before
 * SKY-003-impl ever ran, yet nothing blocked SKY-003-impl from proceeding.
 *
 * By contrast, SKY-004 (never split) correctly kept `dependencies:
 * ["SKY-002"]` and WAS correctly blocked ("Dependency SKY-002 NOT satisfied
 * — skipping") — proving the dependency gate itself works; only split
 * children lose the information the gate needs.
 *
 * Fix: merge the parent's own `dependencies` into every split child
 * unconditionally, in addition to whatever the LLM's own split proposal
 * specified. Harmless even where wireSplitSiblingDependencies (a separate,
 * pre-existing fix) already wires a test-only child to its impl sibling —
 * a dependency gate only needs every listed ID completed, so redundant
 * entries never cause a problem, but a silently dropped real dependency
 * does.
 */

import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { applySpecChanges } = require('../../../orchestrations/scripts/spec-mode-runner.js');

describe('applySpecChanges — split child dependency backfill', () => {
  const makePrd = (stories: object[]) => ({ stories, implementationOrder: {} });

  it('REPRODUCES the exact live defect and proves the fix: a split child inherits the parent\'s own external dependency even when the LLM\'s split proposal omits it', () => {
    const story = {
      id: 'SKY-003',
      title: 'Flight search CLI',
      description: 'desc',
      acceptanceCriteria: ['ac'],
      dependencies: ['SKY-002'], // the parent's real, deterministic dependency
      specification: {},
    };
    const prd = makePrd([story]);
    const newStories: { parentId: string; story: any; phase: string }[] = [];
    const payload = {
      splitStories: [
        {
          id: 'SKY-003-impl',
          title: 'Implement CLI',
          description: 'impl desc',
          acceptanceCriteria: ['ac'],
          // The LLM's own split proposal omits dependencies entirely --
          // exactly the live shape that caused the incident.
        },
        {
          id: 'SKY-003-test',
          title: 'Test CLI',
          description: 'test desc',
          acceptanceCriteria: ['ac'],
          dependencies: ['SKY-003-impl'], // sibling wiring the LLM DID propose
        },
      ],
    };
    applySpecChanges(story, payload, newStories, prd, 'core', 'run1');
    const implChild = newStories.find((ns) => ns.story.id === 'SKY-003-impl')!.story;
    const testChild = newStories.find((ns) => ns.story.id === 'SKY-003-test')!.story;

    expect(implChild.dependencies).toContain('SKY-002');
    // Sibling-proposed dependency must survive the merge, not be replaced.
    expect(testChild.dependencies).toContain('SKY-003-impl');
  });

  it('does not duplicate a dependency the split proposal already declared explicitly', () => {
    const story = { id: 'SKY-003', title: 't', description: 'd', acceptanceCriteria: ['ac'], dependencies: ['SKY-002'], specification: {} };
    const prd = makePrd([story]);
    const newStories: { parentId: string; story: any; phase: string }[] = [];
    const payload = {
      splitStories: [
        { id: 'SKY-003-impl', title: 't', description: 'd', acceptanceCriteria: ['ac'], dependencies: ['SKY-002'] },
      ],
    };
    applySpecChanges(story, payload, newStories, prd, 'core', 'run1');
    const implChild = newStories[0].story;
    expect(implChild.dependencies).toEqual(['SKY-002']);
  });

  it('a parent with no external dependencies produces children with no spuriously-added dependencies', () => {
    const story = { id: 'HW-001', title: 't', description: 'd', acceptanceCriteria: ['ac'], dependencies: [], specification: {} };
    const prd = makePrd([story]);
    const newStories: { parentId: string; story: any; phase: string }[] = [];
    const payload = {
      splitStories: [{ id: 'HW-001a', title: 't', description: 'd', acceptanceCriteria: ['ac'] }],
    };
    applySpecChanges(story, payload, newStories, prd, 'core', 'run1');
    expect(newStories[0].story.dependencies).toEqual([]);
  });

  it('REPRODUCES the second live-relevant defect and proves the fix: a parent declaring its dependency via technicalNotes.dependsOn (not .dependencies) is also backfilled onto the split child', () => {
    // Confirmed via the actual canonical PRD (2026-07-12 audit): SKY-002
    // itself declares its OWN dependency on SKY-001 ONLY via
    // technicalNotes.dependsOn, not .dependencies -- so a split of SKY-002
    // would have been just as vulnerable as SKY-003 was, through this
    // second field path claude.sh's own dependency lookups treat as an
    // equal fallback (`.dependencies // .technicalNotes.dependsOn // []`).
    const story = {
      id: 'SKY-002',
      title: 't',
      description: 'd',
      acceptanceCriteria: ['ac'],
      technicalNotes: { dependsOn: ['SKY-001'] },
      specification: {},
    };
    const prd = makePrd([story]);
    const newStories: { parentId: string; story: any; phase: string }[] = [];
    const payload = {
      splitStories: [{ id: 'SKY-002-impl', title: 't', description: 'd', acceptanceCriteria: ['ac'] }],
    };
    applySpecChanges(story, payload, newStories, prd, 'core', 'run1');
    expect(newStories[0].story.technicalNotes.dependsOn).toContain('SKY-001');
  });

  it('technicalNotes.dependsOn survives even when the split proposal replaces technicalNotes wholesale (e.g. only supplying `files`)', () => {
    const story = {
      id: 'SKY-002',
      title: 't',
      description: 'd',
      acceptanceCriteria: ['ac'],
      technicalNotes: { dependsOn: ['SKY-001'], files: ['src/old.ts'] },
      specification: {},
    };
    const prd = makePrd([story]);
    const newStories: { parentId: string; story: any; phase: string }[] = [];
    const payload = {
      splitStories: [
        {
          id: 'SKY-002-impl',
          title: 't',
          description: 'd',
          acceptanceCriteria: ['ac'],
          // Split proposal supplies its OWN technicalNotes with only `files`
          // -- this replaces the whole object wholesale (existing, already-
          // fixed behavior for `files` ownership), which would ALSO wipe out
          // dependsOn without the backfill running after this replacement.
          technicalNotes: { files: ['src/impl.ts'] },
        },
      ],
    };
    applySpecChanges(story, payload, newStories, prd, 'core', 'run1');
    const implChild = newStories[0].story;
    expect(implChild.technicalNotes.files).toEqual(['src/impl.ts']); // split's own file ownership preserved
    expect(implChild.technicalNotes.dependsOn).toContain('SKY-001'); // but dependsOn still backfilled
  });

  it('does not duplicate a dependsOn entry the split proposal already declared explicitly', () => {
    const story = {
      id: 'SKY-002',
      title: 't',
      description: 'd',
      acceptanceCriteria: ['ac'],
      technicalNotes: { dependsOn: ['SKY-001'] },
      specification: {},
    };
    const prd = makePrd([story]);
    const newStories: { parentId: string; story: any; phase: string }[] = [];
    const payload = {
      splitStories: [
        { id: 'SKY-002-impl', title: 't', description: 'd', acceptanceCriteria: ['ac'], technicalNotes: { dependsOn: ['SKY-001'] } },
      ],
    };
    applySpecChanges(story, payload, newStories, prd, 'core', 'run1');
    expect(newStories[0].story.technicalNotes.dependsOn).toEqual(['SKY-001']);
  });

  it('a parent with no technicalNotes.dependsOn produces children with no spuriously-added dependsOn field', () => {
    const story = { id: 'HW-001', title: 't', description: 'd', acceptanceCriteria: ['ac'], technicalNotes: { files: ['a.ts'] }, specification: {} };
    const prd = makePrd([story]);
    const newStories: { parentId: string; story: any; phase: string }[] = [];
    const payload = {
      splitStories: [{ id: 'HW-001a', title: 't', description: 'd', acceptanceCriteria: ['ac'] }],
    };
    applySpecChanges(story, payload, newStories, prd, 'core', 'run1');
    expect(newStories[0].story.technicalNotes?.dependsOn).toBeUndefined();
  });
});
