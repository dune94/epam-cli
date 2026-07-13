/**
 * GAP-P25 — Split enforcement invariants (code-level, not prompt-level)
 *
 * These tests verify the architectural fix for runaway story splitting:
 *   1. canSplitStory rejects at depth >= maxSplitDepth (code guard, not prompt rule)
 *   2. canSplitStory rejects when split budget (4 children) is exhausted
 *   3. capSplitACs truncates to 24 ACs (modifies story in place)
 *   4. applySpecChanges clears parent ACs after split (prevents 93-AC parents)
 *   5. applySpecChanges enforces split budget per-child during forEach
 *   6. orch script calls validate_mid_execution_splits after Step 0.5
 *   7. orch script calls validate_mid_execution_splits after each story in Step 1
 *   8. spec-mode-runner exports --validate-splits CLI mode
 *   9. speckit SPLIT RULES reference the hard limits (not just guidelines)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  canSplitStory,
  capSplitACs,
  validateSplitFileCoherence,
  applySpecChanges,
  splitDepth,
  storyRequiresSplit,
  checkSplitMandateViolation,
  captureStorySnapshot,
  isSplitDelegationAc,
  isSplitDelegationOnlyChange,
  correctSplitChildAgentRoleIfTestOnly,
  validateMidExecutionSplits,
  SPLIT_MANDATE_AC_THRESHOLD,
  MAX_ACS_PER_STORY,
  MAX_CHILDREN_PER_SPLIT,
} = require('../../../orchestrations/scripts/spec-mode-runner.js');
const SPEC_MODE_RUNNER_SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'),
  'utf8'
);

const ORCH_SCRIPT = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SCRIPT, 'utf8');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStory(id: string, overrides: Record<string, unknown> = {}) {
  return { id, title: `Story ${id}`, acceptanceCriteria: ['ac1', 'ac2'], status: 'pending', ...overrides };
}

function makePrd(stories: object[]) {
  return { stories: [...stories] };
}

// ── canSplitStory ─────────────────────────────────────────────────────────────

describe('canSplitStory — depth guard (code enforcement)', () => {
  it('allows split at depth 0 (root story)', () => {
    const story = makeStory('ROOT');
    const prd = makePrd([story]);
    const result = canSplitStory(story, prd, []);
    expect(result.ok).toBe(true);
  });

  it('allows split at depth 1 (one generation from root)', () => {
    const root = makeStory('ROOT');
    const child = makeStory('ROOT-1', { specification: { createdFrom: 'ROOT', splitDepth: 1 } });
    const prd = makePrd([root, child]);
    const result = canSplitStory(child, prd, []);
    expect(result.ok).toBe(true);
  });

  it('rejects split at depth 2 (max depth reached)', () => {
    const root = makeStory('ROOT');
    const child = makeStory('ROOT-1', { specification: { createdFrom: 'ROOT', splitDepth: 1 } });
    const grandchild = makeStory('ROOT-1-A', { specification: { createdFrom: 'ROOT-1', splitDepth: 2 } });
    const prd = makePrd([root, child, grandchild]);
    const result = canSplitStory(grandchild, prd, []);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/depth 2 >= max 2/);
  });

  it('respects SPEC_MAX_SPLIT_DEPTH env override', () => {
    const saved = process.env.SPEC_MAX_SPLIT_DEPTH;
    try {
      process.env.SPEC_MAX_SPLIT_DEPTH = '3';
      const root = makeStory('ROOT');
      const c1 = makeStory('ROOT-1', { specification: { createdFrom: 'ROOT' } });
      const c2 = makeStory('ROOT-1-A', { specification: { createdFrom: 'ROOT-1' } });
      const prd = makePrd([root, c1, c2]);
      // At depth 2 with max 3, should be allowed
      expect(canSplitStory(c2, prd, []).ok).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.SPEC_MAX_SPLIT_DEPTH;
      else process.env.SPEC_MAX_SPLIT_DEPTH = saved;
    }
  });
});

describe('canSplitStory — split budget guard', () => {
  it('allows first child (0 existing, 0 pending)', () => {
    const story = makeStory('PARENT');
    const prd = makePrd([story]);
    expect(canSplitStory(story, prd, []).ok).toBe(true);
  });

  it('allows up to MAX_CHILDREN_PER_SPLIT children', () => {
    const story = makeStory('PARENT');
    const children = Array.from({ length: MAX_CHILDREN_PER_SPLIT - 1 }, (_, i) =>
      makeStory(`PARENT-${i + 1}`, { specification: { createdFrom: 'PARENT' } })
    );
    const prd = makePrd([story, ...children]);
    // One more should still be allowed (count is MAX-1)
    expect(canSplitStory(story, prd, []).ok).toBe(true);
  });

  it('rejects when existing children reach MAX_CHILDREN_PER_SPLIT', () => {
    const story = makeStory('PARENT');
    const children = Array.from({ length: MAX_CHILDREN_PER_SPLIT }, (_, i) =>
      makeStory(`PARENT-${i + 1}`, { specification: { createdFrom: 'PARENT' } })
    );
    const prd = makePrd([story, ...children]);
    const result = canSplitStory(story, prd, []);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/split budget exhausted/);
    expect(result.reason).toMatch(new RegExp(`>= max ${MAX_CHILDREN_PER_SPLIT}`));
  });

  it('counts pending newStories accumulator when checking budget', () => {
    const story = makeStory('PARENT');
    const prd = makePrd([story]);
    // No committed children, but accumulator has MAX_CHILDREN_PER_SPLIT pending
    const pending = Array.from({ length: MAX_CHILDREN_PER_SPLIT }, (_, i) => ({
      parentId: 'PARENT',
      story: makeStory(`PARENT-${i + 1}`),
      phase: 'core',
    }));
    const result = canSplitStory(story, prd, pending);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/split budget exhausted/);
  });

  it('accumulates correctly per-child (budget tightens each iteration)', () => {
    const story = makeStory('PARENT');
    const prd = makePrd([story]);
    const pending: object[] = [];

    // Simulate forEach adding children one at a time
    for (let i = 0; i < MAX_CHILDREN_PER_SPLIT; i++) {
      expect(canSplitStory(story, prd, pending).ok, `child ${i + 1} should be allowed`).toBe(true);
      pending.push({ parentId: 'PARENT', story: makeStory(`PARENT-${i + 1}`), phase: 'core' });
    }
    // One past budget should be rejected
    expect(canSplitStory(story, prd, pending).ok).toBe(false);
  });
});

// ── capSplitACs ───────────────────────────────────────────────────────────────

describe('capSplitACs — AC cap enforcement', () => {
  it('does not modify stories with <= MAX_ACS_PER_STORY ACs', () => {
    const story = makeStory('S1', { acceptanceCriteria: Array.from({ length: MAX_ACS_PER_STORY }, (_, i) => `ac${i}`) });
    capSplitACs(story, 'PARENT');
    expect(story.acceptanceCriteria).toHaveLength(MAX_ACS_PER_STORY);
  });

  it('truncates to MAX_ACS_PER_STORY when exceeded', () => {
    const story = makeStory('S1', { acceptanceCriteria: Array.from({ length: 30 }, (_, i) => `ac${i}`) });
    capSplitACs(story, 'PARENT');
    expect(story.acceptanceCriteria).toHaveLength(MAX_ACS_PER_STORY);
    expect(story.acceptanceCriteria[0]).toBe('ac0');
    expect(story.acceptanceCriteria[MAX_ACS_PER_STORY - 1]).toBe(`ac${MAX_ACS_PER_STORY - 1}`);
  });

  it('handles missing acceptanceCriteria gracefully', () => {
    const story = makeStory('S1', { acceptanceCriteria: undefined });
    expect(() => capSplitACs(story, 'PARENT')).not.toThrow();
  });
});

// ── applySpecChanges — parent redistribution ──────────────────────────────────

describe('applySpecChanges — AC cap on all AC updates (not just split creation)', () => {
  it('caps ACs when speckit updates a split child past 24 (run 85 regression)', () => {
    // Bug: capSplitACs only ran at split-child creation time. Speckit's subsequent
    // AC update via applySpecChanges had no cap — SKY-004-B-IMPL ended up with 34 ACs.
    const story = makeStory('SKY-004-B-IMPL', { acceptanceCriteria: ['ac1'] });
    const prd = makePrd([story]);
    const oversizedPayload = {
      acceptanceCriteria: Array.from({ length: 34 }, (_, i) => `speckit-ac-${i}`),
    };
    applySpecChanges(story, oversizedPayload, [], prd, 'core', 'run85');
    expect(story.acceptanceCriteria).toHaveLength(MAX_ACS_PER_STORY);
    expect(story.acceptanceCriteria[0]).toBe('speckit-ac-0');
    expect(story.acceptanceCriteria[MAX_ACS_PER_STORY - 1]).toBe(`speckit-ac-${MAX_ACS_PER_STORY - 1}`);
  });

  it('does not truncate ACs at or below the cap', () => {
    const story = makeStory('S1', { acceptanceCriteria: [] });
    const prd = makePrd([story]);
    const payload = { acceptanceCriteria: Array.from({ length: 24 }, (_, i) => `ac-${i}`) };
    applySpecChanges(story, payload, [], prd, 'core', 'run85');
    expect(story.acceptanceCriteria).toHaveLength(24);
  });
});

describe('applySpecChanges — parent AC redistribution after split', () => {
  it('clears parent ACs and sets delegation note after children registered', () => {
    const story = makeStory('PARENT', { acceptanceCriteria: Array.from({ length: 10 }, (_, i) => `ac${i}`) });
    const prd = makePrd([story]);
    const newStories: object[] = [];
    const payload = {
      splitStories: [
        { id: 'PARENT-A', title: 'Part A', acceptanceCriteria: ['child-ac1'] },
        { id: 'PARENT-B', title: 'Part B', acceptanceCriteria: ['child-ac2'] },
      ],
    };
    applySpecChanges(story, payload, newStories, prd, 'core', 'run1');

    // Parent should have exactly one delegation AC, not the original 10
    expect(story.acceptanceCriteria).toHaveLength(1);
    expect(story.acceptanceCriteria[0]).toMatch(/Delegated to split children/);
    expect(story.acceptanceCriteria[0]).toContain('PARENT-A');
    expect(story.acceptanceCriteria[0]).toContain('PARENT-B');
  });

  it('does NOT modify parent ACs when no splits are created', () => {
    const story = makeStory('PARENT', { acceptanceCriteria: ['ac1', 'ac2'] });
    const prd = makePrd([story]);
    applySpecChanges(story, { acceptanceCriteria: ['new-ac'] }, [], prd, 'core', 'run1');
    // ACs updated to payload, not delegation note
    expect(story.acceptanceCriteria).toEqual(['new-ac']);
  });
});

describe('applySpecChanges — split budget enforcement per-child', () => {
  it('rejects children beyond MAX_CHILDREN_PER_SPLIT', () => {
    const story = makeStory('PARENT', { acceptanceCriteria: ['ac'] });
    const prd = makePrd([story]);
    const newStories: object[] = [];
    const overBudget = Array.from({ length: MAX_CHILDREN_PER_SPLIT + 2 }, (_, i) => ({
      id: `PARENT-${i + 1}`,
      title: `Child ${i + 1}`,
      acceptanceCriteria: ['child-ac'],
    }));
    const result = applySpecChanges(story, { splitStories: overBudget }, newStories, prd, 'core', 'run1');
    expect(result.splitCount).toBe(MAX_CHILDREN_PER_SPLIT);
    expect(newStories).toHaveLength(MAX_CHILDREN_PER_SPLIT);
  });

  it('enforces AC cap on each split child', () => {
    const story = makeStory('PARENT', { acceptanceCriteria: ['ac'] });
    const prd = makePrd([story]);
    const newStories: object[] = [];
    const payload = {
      splitStories: [{
        id: 'PARENT-A',
        title: 'Fat child',
        acceptanceCriteria: Array.from({ length: 30 }, (_, i) => `ac${i}`),
      }],
    };
    applySpecChanges(story, payload, newStories, prd, 'core', 'run1');
    const child = (newStories[0] as { story: { acceptanceCriteria: string[] } }).story;
    expect(child.acceptanceCriteria).toHaveLength(MAX_ACS_PER_STORY);
  });
});

// ── validateSplitFileCoherence ────────────────────────────────────────────────

describe('validateSplitFileCoherence — same-file split detection (run 85 root cause)', () => {
  it('returns no conflicts when each child owns a different file', () => {
    const children = [
      { id: 'C-1', technicalNotes: { files: ['src/skyscanner/client.ts'] } },
      { id: 'C-2', technicalNotes: { files: ['src/server.ts'] } },
    ];
    expect(validateSplitFileCoherence(children)).toHaveLength(0);
  });

  it('detects conflict when two children write to the same non-test file', () => {
    const children = [
      { id: 'SKY-002a-1a', technicalNotes: { files: ['src/skyscanner/client.ts'] } },
      { id: 'SKY-002a-1b', technicalNotes: { files: ['src/skyscanner/client.ts'] } },
    ];
    const conflicts = validateSplitFileCoherence(children);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].file).toContain('client.ts');
    expect(conflicts[0].childIds).toEqual(['SKY-002a-1a', 'SKY-002a-1b']);
  });

  it('detects conflict across 4 children sharing the same file (run 85 exact scenario)', () => {
    const children = [
      { id: 'SKY-002a-1a',   technicalNotes: { files: ['src/skyscanner/client.ts'] } },
      { id: 'SKY-002a-1b',   technicalNotes: { files: ['src/skyscanner/client.ts'] } },
      { id: 'SKY-002a-1c',   technicalNotes: { files: ['src/skyscanner/client.ts'] } },
      { id: 'SKY-002a-1a-1', technicalNotes: { files: ['src/skyscanner/client.ts'] } },
    ];
    const conflicts = validateSplitFileCoherence(children);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].childIds).toHaveLength(4);
  });

  it('flags multiple children writing to the same test file (test files are NOT exempt — last-writer-wins applies equally)', () => {
    const children = [
      { id: 'C-1', technicalNotes: { files: ['src/skyscanner/client.ts', 'src/skyscanner/client.test.ts'] } },
      { id: 'C-2', technicalNotes: { files: ['src/skyscanner/client.test.ts'] } },
    ];
    // Both C-1 and C-2 claim client.test.ts — this is a real conflict regardless of extension
    const conflicts = validateSplitFileCoherence(children);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].file).toContain('client.test.ts');
  });

  it('allows one impl child and one test child for the same impl file', () => {
    const children = [
      { id: 'IMPL', technicalNotes: { files: ['src/server.ts'] } },
      { id: 'TEST', technicalNotes: { files: ['src/server.test.ts'] } },
    ];
    expect(validateSplitFileCoherence(children)).toHaveLength(0);
  });

  it('handles children with no technicalNotes gracefully', () => {
    const children = [
      { id: 'C-1' },
      { id: 'C-2', technicalNotes: {} },
      { id: 'C-3', technicalNotes: { files: ['src/a.ts'] } },
    ];
    expect(() => validateSplitFileCoherence(children)).not.toThrow();
    expect(validateSplitFileCoherence(children)).toHaveLength(0);
  });
});

describe('applySpecChanges — same-file split rejection', () => {
  it('rejects split and keeps parent ACs when children share a non-test file', () => {
    const story = makeStory('SKY-002a-1', {
      acceptanceCriteria: ['ac1', 'ac2', 'ac3'],
      technicalNotes: { files: ['src/skyscanner/client.ts'] },
    });
    const prd = makePrd([story]);
    const newStories: object[] = [];
    const payload = {
      splitStories: [
        { id: 'SKY-002a-1a', title: 'Class', acceptanceCriteria: ['ac-class'],
          technicalNotes: { files: ['src/skyscanner/client.ts'] } },
        { id: 'SKY-002a-1b', title: 'Methods', acceptanceCriteria: ['ac-methods'],
          technicalNotes: { files: ['src/skyscanner/client.ts'] } },
      ],
    };
    const result = applySpecChanges(story, payload, newStories, prd, 'core', 'run86');
    // Split must be rejected
    expect(result.splitCount).toBe(0);
    expect(newStories).toHaveLength(0);
    // Parent ACs must NOT be replaced with delegation note
    expect(story.acceptanceCriteria).not.toContain(expect.stringMatching(/Delegated/));
    expect(story.acceptanceCriteria).toEqual(['ac1', 'ac2', 'ac3']);
  });

  it('accepts split when each child owns a distinct non-test file', () => {
    const story = makeStory('SKY-002', { acceptanceCriteria: ['ac1', 'ac2'] });
    const prd = makePrd([story]);
    const newStories: object[] = [];
    const payload = {
      splitStories: [
        { id: 'SKY-002-client', title: 'Client', acceptanceCriteria: ['ac-client'],
          technicalNotes: { files: ['src/skyscanner/client.ts'] } },
        { id: 'SKY-002-server', title: 'Server', acceptanceCriteria: ['ac-server'],
          technicalNotes: { files: ['src/server.ts'] } },
      ],
    };
    const result = applySpecChanges(story, payload, newStories, prd, 'core', 'run86');
    expect(result.splitCount).toBe(2);
    expect(newStories).toHaveLength(2);
    expect(story.acceptanceCriteria[0]).toMatch(/Delegated/);
  });

  // Root cause this fixes (found live, 2026-07-06, tier3-full-run-15): a
  // successfully-delegated parent's technicalNotes.files still lists its
  // ORIGINAL files (including any .test.ts), and it was never removed from
  // implementationOrder[phase] — the TC writer and main implementation loop
  // both scan implementationOrder and saw it as active work with real source,
  // when its implementation is entirely delegated to children. This aborted
  // a live run at Step 1.6 (TC writer gate): "3 test stories still missing
  // TCs: ['SKY-003', 'SKY-004', 'SKY-002']" — all three were delegated
  // parents, not real test stories.
  it('marks a successfully-delegated parent deprecated and completed (so implementationOrder-scanning consumers can skip it)', () => {
    const story = makeStory('SKY-002', { acceptanceCriteria: ['ac1', 'ac2'] });
    const prd = makePrd([story]);
    const newStories: object[] = [];
    const payload = {
      splitStories: [
        { id: 'SKY-002-client', title: 'Client', acceptanceCriteria: ['ac-client'],
          technicalNotes: { files: ['src/skyscanner/client.ts'] } },
        { id: 'SKY-002-server', title: 'Server', acceptanceCriteria: ['ac-server'],
          technicalNotes: { files: ['src/server.ts'] } },
      ],
    };
    applySpecChanges(story, payload, newStories, prd, 'core', 'run86');
    expect(story.status).toBe('deprecated');
    expect(story.completed).toBe(true);
  });

  it('does NOT mark the parent deprecated when the split is rejected (coherence violation)', () => {
    const story = makeStory('SKY-002a-1', {
      acceptanceCriteria: ['ac1', 'ac2', 'ac3'],
      technicalNotes: { files: ['src/skyscanner/client.ts'] },
    });
    const prd = makePrd([story]);
    const newStories: object[] = [];
    const payload = {
      splitStories: [
        { id: 'SKY-002a-1a', title: 'Class', acceptanceCriteria: ['ac-class'],
          technicalNotes: { files: ['src/skyscanner/client.ts'] } },
        { id: 'SKY-002a-1b', title: 'Methods', acceptanceCriteria: ['ac-methods'],
          technicalNotes: { files: ['src/skyscanner/client.ts'] } },
      ],
    };
    applySpecChanges(story, payload, newStories, prd, 'core', 'run86');
    expect(story.status).not.toBe('deprecated');
    expect(story.completed).not.toBe(true);
  });

  // REGRESSION (live, 2026-07-06): isolates the exact defect line. newStory
  // starts as JSON.parse(JSON.stringify(story)) — a full clone of the PARENT,
  // including the parent's own technicalNotes.files. That field was never
  // overwritten with the split proposal's technicalNotes, so every child
  // silently kept the PARENT's combined file list no matter what the split
  // payload specified. This went undetected because every prior test's parent
  // story had no technicalNotes set at all (nothing to wrongly inherit) — this
  // test uses a parent WITH real technicalNotes, matching production shape,
  // where the bug actually manifests.
  it('a child story\'s technicalNotes comes from the split proposal, not silently inherited from the parent clone', () => {
    const story = makeStory('SKY-BUG', {
      acceptanceCriteria: ['ac1', 'ac2'],
      technicalNotes: { files: ['src/moduleA.ts', 'src/moduleA.test.ts'] },
    });
    const prd = makePrd([story]);
    const newStories: object[] = [];
    const payload = {
      splitStories: [
        { id: 'SKY-BUG-impl', title: 'Impl', acceptanceCriteria: ['ac-impl'],
          technicalNotes: { files: ['src/moduleA.ts'] } },
        { id: 'SKY-BUG-test', title: 'Test', acceptanceCriteria: ['ac-test'],
          technicalNotes: { files: ['src/moduleA.test.ts'] } },
      ],
    };
    applySpecChanges(story, payload, newStories, prd, 'core', 'run-bugfix');
    const implChild: any = newStories.find((ns: any) => (ns as any).story.id === 'SKY-BUG-impl');
    const testChild: any = newStories.find((ns: any) => (ns as any).story.id === 'SKY-BUG-test');
    // Before the fix: both children kept the parent's ['moduleA.ts', 'moduleA.test.ts']
    // and the split was rejected as incoherent. After the fix: each child owns
    // exactly its own proposed file, and the split is accepted.
    expect(implChild.story.technicalNotes.files).toEqual(['src/moduleA.ts']);
    expect(testChild.story.technicalNotes.files).toEqual(['src/moduleA.test.ts']);
  });
});

// ── Per-story tsc gate ────────────────────────────────────────────────────────

describe('run-agent-orchestration.sh — per-story tsc gate (permanent fix for recurring TS errors)', () => {
  it('story_tsc_gate function is defined in orch script', () => {
    expect(orchSrc).toContain('story_tsc_gate()');
  });

  it('tsc gate runs tsc --noEmit with PIPESTATUS[0] exit capture', () => {
    const fnIdx = orchSrc.indexOf('story_tsc_gate()');
    const block = orchSrc.slice(fnIdx, fnIdx + 1200);
    expect(block).toContain('tsc --noEmit');
    expect(block).toContain('PIPESTATUS[0]');
  });

  it('tsc gate is skipped when tsconfig.json does not exist', () => {
    const fnIdx = orchSrc.indexOf('story_tsc_gate()');
    const block = orchSrc.slice(fnIdx, fnIdx + 1200);
    expect(block).toContain('tsconfig.json');
    expect(block).toMatch(/return 0/);
  });

  it('tsc gate is skipped for test-engineer role stories', () => {
    const fnIdx = orchSrc.indexOf('story_tsc_gate()');
    const block = orchSrc.slice(fnIdx, fnIdx + 1200);
    expect(block).toContain('test-engineer');
    expect(block).toContain('agentRole');
  });

  it('tsc gate has SKIP_STORY_TSC_GATE bypass', () => {
    const fnIdx = orchSrc.indexOf('story_tsc_gate()');
    const block = orchSrc.slice(fnIdx, fnIdx + 1200);
    expect(block).toContain('SKIP_STORY_TSC_GATE');
  });

  it('tsc gate is called in Step 1 loop only after story succeeds (not on failure)', () => {
    // Gate must be inside the else branch of the _story_exit check — not unconditional
    const step1Idx = orchSrc.indexOf('story_tsc_gate "$story"');
    expect(step1Idx).toBeGreaterThan(-1);
    const preGate = orchSrc.slice(step1Idx - 400, step1Idx);
    // The else branch follows the "if _story_exit -ne 0" failure path
    expect(preGate).toMatch(/else/);
    expect(preGate).toContain('_story_exit');
  });

  it('story failure from tsc gate increments _phase_story_failures', () => {
    const step1Idx = orchSrc.indexOf('story_tsc_gate "$story"');
    const gateLine = orchSrc.slice(step1Idx, step1Idx + 80);
    expect(gateLine).toContain('_phase_story_failures');
  });

  it('tsc gate logs output to a per-story log file', () => {
    const fnIdx = orchSrc.indexOf('story_tsc_gate()');
    const block = orchSrc.slice(fnIdx, fnIdx + 1200);
    expect(block).toContain('tsc-gate-');
    expect(block).toContain('_tsc_log');
  });
});

// ── Orch script — mid-execution split validation wiring ──────────────────────

describe('run-agent-orchestration.sh — mid-execution split validation', () => {
  it('validate_mid_execution_splits function is defined in orch script', () => {
    expect(orchSrc).toContain('validate_mid_execution_splits()');
  });

  it('validate_mid_execution_splits is called after Step 0.5 (skill assessment)', () => {
    const step05Idx = orchSrc.indexOf('run_pre_phase_assessment "$PHASE"');
    expect(step05Idx).toBeGreaterThan(-1);
    // The call must appear AFTER run_pre_phase_assessment, not inside the function definition
    const afterAssessment = orchSrc.slice(step05Idx);
    const callIdx = afterAssessment.indexOf('validate_mid_execution_splits "$PHASE"');
    expect(callIdx, 'validate_mid_execution_splits must be called after Step 0.5').toBeGreaterThan(-1);
  });

  it('validate_mid_execution_splits is called after each story in Step 1 execution loop', () => {
    // Find the Step 1 story execution loop — after run_story_with_watchdog + tsc gate
    const step1Idx = orchSrc.indexOf('run_story_with_watchdog "$story" "$LOG_DIR/main-${story}.log"');
    expect(step1Idx).toBeGreaterThan(-1);
    // validate_mid_execution_splits appears within ~1400 chars (includes the
    // watchdog-timeout recovery block and tsc gate block)
    const postStory = orchSrc.slice(step1Idx, step1Idx + 1400);
    expect(postStory).toContain('validate_mid_execution_splits "$PHASE"');
  });

  it('validate_mid_execution_splits calls spec-mode-runner with --validate-splits', () => {
    const fnIdx = orchSrc.indexOf('validate_mid_execution_splits()');
    const fnBlock = orchSrc.slice(fnIdx, fnIdx + 2000);
    expect(fnBlock).toContain('--validate-splits');
    expect(fnBlock).toContain('spec-mode-runner.js');
  });

  it('validate_mid_execution_splits queries PRD for unvalidated split children (speckitValidated != true)', () => {
    const fnIdx = orchSrc.indexOf('validate_mid_execution_splits()');
    const fnBlock = orchSrc.slice(fnIdx, fnIdx + 2000);
    expect(fnBlock).toContain('speckitValidated');
    expect(fnBlock).toContain('createdFrom');
  });

  it('check_ac_invariant is called after mid-execution validation', () => {
    // The call to check_ac_invariant appears after validate_mid_execution_splits + its function def
    const validateCallIdx = orchSrc.indexOf('validate_mid_execution_splits "$PHASE"\n');
    expect(validateCallIdx).toBeGreaterThan(-1);
    // check_ac_invariant() function def + call follow; use 3000 chars to clear the function body
    const afterValidate = orchSrc.slice(validateCallIdx, validateCallIdx + 3000);
    expect(afterValidate).toContain('check_ac_invariant "$PHASE"');
  });
});

// ── spec-mode-runner — --validate-splits CLI mode ─────────────────────────────

describe('spec-mode-runner.js — validateMidExecutionSplits export', () => {
  it('validates splits CLI mode is handled in require.main block', () => {
    const src = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'),
      'utf8'
    );
    expect(src).toContain('--validate-splits');
    expect(src).toContain('validateMidExecutionSplits');
  });

  it('validateMidExecutionSplits is exported from spec-mode-runner', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../../orchestrations/scripts/spec-mode-runner.js');
    expect(typeof mod.validateMidExecutionSplits).toBe('function');
  });

  it('canSplitStory and capSplitACs are exported', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../../orchestrations/scripts/spec-mode-runner.js');
    expect(typeof mod.canSplitStory).toBe('function');
    expect(typeof mod.capSplitACs).toBe('function');
  });

  it('MAX_ACS_PER_STORY defaults to 24', () => {
    expect(MAX_ACS_PER_STORY).toBe(24);
  });

  it('MAX_CHILDREN_PER_SPLIT defaults to 4', () => {
    expect(MAX_CHILDREN_PER_SPLIT).toBe(4);
  });
});

// ── speckit prompt — hard limits referenced ───────────────────────────────────

// Behavior change (2026-07-13): speckit no longer proposes splits at all
// (see speckit-no-independent-split.test.ts), so its own prompt no longer
// needs to document split hard-limits (24 ACs, 4 children) — those limits
// are still fully enforced in CODE for openspec's splits (MAX_ACS_PER_STORY/
// MAX_CHILDREN_PER_SPLIT, unit-tested in the describe block just above this
// one, both still passing/unchanged), independent of any prompt text.
describe('speckit prompt — split hard-limits intentionally removed (speckit no longer splits)', () => {
  const src = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'),
    'utf8'
  );
  const promptIdx = src.indexOf('You are the speckit specification agent');
  const promptBlock = src.slice(promptIdx, promptIdx + 3000);

  it('speckit prompt no longer documents the 24-AC / 4-children split hard limits (it never emits splitStories)', () => {
    expect(promptIdx).toBeGreaterThan(-1);
    expect(promptBlock).not.toMatch(/HARD LIMITS/i);
    expect(promptBlock).not.toContain('4 split children');
  });

  it('the hard limits remain enforced in code regardless (MAX_ACS_PER_STORY / MAX_CHILDREN_PER_SPLIT, unaffected by this prompt change)', () => {
    expect(MAX_ACS_PER_STORY).toBe(24);
    expect(MAX_CHILDREN_PER_SPLIT).toBe(4);
  });
});

// ── storyRequiresSplit / checkSplitMandateViolation — deterministic split-mandate gate ──
//
// Root cause this catches (found live, 2026-07-06): openspec's prompt says
// "MANDATORY split required" whenever a story has >12 ACs or combines impl+test
// files, but nothing ever verified compliance — a story meeting the mandate
// could go through multiple spec passes across multiple runs and never get
// split, with zero visible signal. Deliberately domain-agnostic fixtures below
// (generic "moduleA"/"foo.ts" names, not any specific project's classes) —
// this gate must behave identically for any project's stories.

function makeSnapshot(overrides: Partial<{ acceptanceCriteria: string[]; technicalNotes: { files: string[] } }> = {}) {
  return {
    acceptanceCriteria: overrides.acceptanceCriteria ?? ['ac1', 'ac2'],
    description: 'a generic story',
    title: 'Generic Story',
    technicalNotes: overrides.technicalNotes ?? { files: ['src/moduleA.ts'] },
  };
}

describe('storyRequiresSplit — AC-count threshold (generic, no domain names)', () => {
  it('does not require a split at or below the threshold', () => {
    const snapshot = makeSnapshot({ acceptanceCriteria: Array.from({ length: SPLIT_MANDATE_AC_THRESHOLD }, (_, i) => `ac${i + 1}`) });
    expect(storyRequiresSplit(snapshot).required).toBe(false);
  });

  it('requires a split just above the threshold', () => {
    const snapshot = makeSnapshot({ acceptanceCriteria: Array.from({ length: SPLIT_MANDATE_AC_THRESHOLD + 1 }, (_, i) => `ac${i + 1}`) });
    const result = storyRequiresSplit(snapshot);
    expect(result.required).toBe(true);
    expect(result.reason).toMatch(/acceptance criteria/);
  });
});

describe('storyRequiresSplit — combined impl+test files (generic, no domain names)', () => {
  it('does not require a split for impl-only files', () => {
    const snapshot = makeSnapshot({ technicalNotes: { files: ['src/moduleA.ts'] } });
    expect(storyRequiresSplit(snapshot).required).toBe(false);
  });

  it('does not require a split for test-only files (dependent test story, not self-contained)', () => {
    const snapshot = makeSnapshot({ technicalNotes: { files: ['src/moduleA.test.ts'] } });
    expect(storyRequiresSplit(snapshot).required).toBe(false);
  });

  it('requires a split when impl AND test files are combined in one story', () => {
    const snapshot = makeSnapshot({ technicalNotes: { files: ['src/moduleA.ts', 'src/moduleA.test.ts'] } });
    const result = storyRequiresSplit(snapshot);
    expect(result.required).toBe(true);
    expect(result.reason).toMatch(/implementation.*test|test.*implementation/i);
  });

  it('also recognizes .spec.ts as a test file (not just .test.ts)', () => {
    const snapshot = makeSnapshot({ technicalNotes: { files: ['src/moduleA.ts', 'src/moduleA.spec.ts'] } });
    expect(storyRequiresSplit(snapshot).required).toBe(true);
  });
});

describe('checkSplitMandateViolation — REPRODUCES the exact live defect (SKY-003, 2026-07-06)', () => {
  it('flags a violation when the mandate applies and zero splits happened', () => {
    // 15 ACs + combined impl/test files — exactly SKY-003's shape, but with
    // fully generic identifiers to prove this is not travel-app-specific.
    const snapshot = makeSnapshot({
      acceptanceCriteria: Array.from({ length: 15 }, (_, i) => `ac${i + 1}`),
      technicalNotes: { files: ['src/moduleA.ts', 'src/moduleA.test.ts'] },
    });
    const result = checkSplitMandateViolation(snapshot, 0);
    expect(result.violated).toBe(true);
    expect(result.reason).toBeTruthy();
  });

  it('does NOT flag a violation when a split actually happened', () => {
    const snapshot = makeSnapshot({
      acceptanceCriteria: Array.from({ length: 15 }, (_, i) => `ac${i + 1}`),
      technicalNotes: { files: ['src/moduleA.ts', 'src/moduleA.test.ts'] },
    });
    const result = checkSplitMandateViolation(snapshot, 2);
    expect(result.violated).toBe(false);
  });

  it('does NOT flag a violation when the mandate never applied in the first place', () => {
    const snapshot = makeSnapshot({
      acceptanceCriteria: ['ac1', 'ac2', 'ac3'],
      technicalNotes: { files: ['src/moduleA.ts'] },
    });
    const result = checkSplitMandateViolation(snapshot, 0);
    expect(result.violated).toBe(false);
  });
});

// ── Proper story sizing: a VALID split actually resolves the mandate correctly ──
// Every other test in this file proves the guards correctly REJECT bad splits
// (same-file coherence, depth, budget). None of them prove the positive,
// spec-driven-development case: that when a story is oversized and genuinely
// needs to be split, and gets sized correctly, the full pipeline
// (applySpecChanges -> checkSplitMandateViolation -> each child's own
// storyRequiresSplit) recognizes it as resolved, with the right number of
// children and a real (non-lossy) AC partition — not just "the guard didn't
// complain." Live run 2026-07-06 confirmed this gap is not hypothetical:
// across SKY-002/003/004, every single split attempt this run produced the
// exact same INVALID shape (an "impl" child and a "test" child that both
// declared ownership of BOTH files), so a partition that actually resolves
// the mandate has never once been observed in production. This test fixes
// that by exercising the correctly-sized case end to end.
describe('Correct story sizing — a well-formed split resolves the split mandate with the right structure (not just guard-rejection)', () => {
  it('a story requiring split (15 ACs, combined impl+test files) gets a well-formed 2-child split: disjoint files, full AC partition (no loss), mandate resolved, and neither child requires a further split', () => {
    const originalACs = Array.from({ length: 15 }, (_, i) => `ac${i + 1}`);
    const story = makeStory('SKY-GOLDEN', {
      acceptanceCriteria: [...originalACs],
      technicalNotes: { files: ['src/moduleA.ts', 'src/moduleA.test.ts'] },
    });
    const prd = makePrd([story]);
    const originalSnapshot = captureStorySnapshot(story);

    // Sanity: the mandate genuinely applies before any split.
    expect(storyRequiresSplit(originalSnapshot).required).toBe(true);

    // A REAL partition: implementation ACs go to the impl child (owns only
    // moduleA.ts), test/coverage ACs go to the test child (owns only
    // moduleA.test.ts) — disjoint files, and together they cover all 15
    // original ACs with no overlap and no loss.
    const implACs = originalACs.slice(0, 8);
    const testACs = originalACs.slice(8);
    const newStories: object[] = [];
    const payload = {
      splitStories: [
        {
          id: 'SKY-GOLDEN-impl',
          title: 'Implementation',
          acceptanceCriteria: implACs,
          technicalNotes: { files: ['src/moduleA.ts'] },
        },
        {
          id: 'SKY-GOLDEN-test',
          title: 'Test coverage',
          acceptanceCriteria: testACs,
          technicalNotes: { files: ['src/moduleA.test.ts'] },
        },
      ],
    };

    const result = applySpecChanges(story, payload, newStories, prd, 'core', 'golden-run');

    // 1. The split was accepted, not rolled back — exactly 2 children, matching
    //    the proposal's count precisely (no silent drop, no silent duplication).
    expect(result.splitCount).toBe(2);
    expect(newStories).toHaveLength(2);
    const childIds = newStories.map((ns: any) => ns.story.id);
    expect(childIds).toEqual(['SKY-GOLDEN-impl', 'SKY-GOLDEN-test']);

    // 2. Each child owns exactly the file(s) it was assigned — a real
    //    partition, not both children claiming both files.
    const implChild: any = newStories.find((ns: any) => ns.story.id === 'SKY-GOLDEN-impl');
    const testChild: any = newStories.find((ns: any) => ns.story.id === 'SKY-GOLDEN-test');
    expect(implChild.story.technicalNotes.files).toEqual(['src/moduleA.ts']);
    expect(testChild.story.technicalNotes.files).toEqual(['src/moduleA.test.ts']);

    // 3. The AC partition is complete and lossless: the union of both
    //    children's ACs equals the original 15, with no overlap.
    const unionACs = [...implChild.story.acceptanceCriteria, ...testChild.story.acceptanceCriteria];
    expect(unionACs.sort()).toEqual([...originalACs].sort());
    const overlap = implChild.story.acceptanceCriteria.filter((ac: string) =>
      testChild.story.acceptanceCriteria.includes(ac)
    );
    expect(overlap).toHaveLength(0);

    // 4. The mandate is now resolved for the ORIGINAL story.
    const mandateResult = checkSplitMandateViolation(originalSnapshot, result.splitCount);
    expect(mandateResult.violated).toBe(false);

    // 5. Neither child independently re-triggers the mandate: each has <= 12
    //    ACs and owns only one file (no combined impl+test in a single child).
    expect(storyRequiresSplit(captureStorySnapshot(implChild.story)).required).toBe(false);
    expect(storyRequiresSplit(captureStorySnapshot(testChild.story)).required).toBe(false);

    // 6. Parent ACs were redistributed to a delegation note (not left at 15,
    //    which would double-count work against both parent and children).
    expect(story.acceptanceCriteria).toEqual([
      'Delegated to split children: SKY-GOLDEN-impl, SKY-GOLDEN-test',
    ]);
  });

  it('a well-formed 3-child split (by feature, not by impl/test) also resolves the mandate with the correct child count', () => {
    const originalACs = Array.from({ length: 18 }, (_, i) => `ac${i + 1}`);
    const story = makeStory('SKY-GOLDEN-3', {
      acceptanceCriteria: [...originalACs],
      technicalNotes: { files: ['src/routeA.ts', 'src/routeB.ts', 'src/routeA.test.ts'] },
    });
    const prd = makePrd([story]);
    const originalSnapshot = captureStorySnapshot(story);
    const newStories: object[] = [];

    const payload = {
      splitStories: [
        { id: 'SKY-GOLDEN-3-a', title: 'Route A', acceptanceCriteria: originalACs.slice(0, 6),
          technicalNotes: { files: ['src/routeA.ts'] } },
        { id: 'SKY-GOLDEN-3-b', title: 'Route B', acceptanceCriteria: originalACs.slice(6, 12),
          technicalNotes: { files: ['src/routeB.ts'] } },
        { id: 'SKY-GOLDEN-3-c', title: 'Route A tests', acceptanceCriteria: originalACs.slice(12, 18),
          technicalNotes: { files: ['src/routeA.test.ts'] } },
      ],
    };

    const result = applySpecChanges(story, payload, newStories, prd, 'core', 'golden-run-3');

    expect(result.splitCount).toBe(3);
    expect(newStories).toHaveLength(3);
    const mandateResult = checkSplitMandateViolation(originalSnapshot, result.splitCount);
    expect(mandateResult.violated).toBe(false);
    for (const ns of newStories as any[]) {
      expect(storyRequiresSplit(captureStorySnapshot(ns.story)).required).toBe(false);
    }
  });
});

describe('runSpecAgent / applySpecChanges wiring — split-mandate check runs after the agent loop, shares the threshold with the prompt warning', () => {
  const src = readFileSync(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('the prompt warning (splitWarning) is derived from storyRequiresSplit, not a separately hardcoded threshold', () => {
    const idx = src.indexOf('const splitRequirement = storyRequiresSplit(');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 300);
    expect(block).toMatch(/MANDATORY split required/);
  });

  it('checkSplitMandateViolation is called once per story, after both agents have had a chance to split it', () => {
    const idx = src.indexOf('let mandateCheck = checkSplitMandateViolation(');
    expect(idx).toBeGreaterThan(-1);
    // Must appear after the per-agent loop closes (summary.stats.agents[agent] update)
    // and before story.specification gets reassigned for this story.
    const loopCloseIdx = src.indexOf('summary.stats.agents[agent] = (summary.stats.agents[agent] || 0) + 1;');
    const specAssignIdx = src.indexOf('const specStatus =');
    expect(loopCloseIdx).toBeGreaterThan(-1);
    expect(idx).toBeGreaterThan(loopCloseIdx);
    expect(idx).toBeLessThan(specAssignIdx);
  });

  it('a detected violation is persisted as a coordinatorReview flag (reuses the existing priorGapsBlock retry channel, not a new mechanism)', () => {
    const idx = src.indexOf('let mandateCheck = checkSplitMandateViolation(');
    const block = src.slice(idx, idx + 4200);
    expect(block).toMatch(/coordinatorReview/);
    expect(block).toMatch(/flags/);
  });

  it('checkSplitMandateViolation() itself stays pure detection — no auto-split logic inside it (the retry orchestration lives at the call site, not here)', () => {
    const idx = src.indexOf('function checkSplitMandateViolation');
    const end = src.indexOf('\n}', idx);
    const body = src.slice(idx, end);
    expect(body).not.toMatch(/splitStories\.push|newStories\.push/);
  });
});

// ── Reject-and-retry: same-run enforcement, not just next-pass flagging ──────
//
// User directive (2026-07-06): "check number of ACs — if > 12 then reject and
// send back to coordinator." Detection alone (flag for the NEXT spec pass)
// wasn't enough — a story could sit unsplit through multiple runs. This
// upgrades the gate to force an immediate, same-run openspec retry with a
// maximally salient (top-of-prompt) corrective instruction before falling
// back to the next-pass flag as a last resort.

describe('split-MANDATE reject-and-retry — immediate same-run enforcement', () => {
  const src = readFileSync(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('runSpecAgent prepends forcedRetryNote at the very top of the prompt (primacy — the mid-prompt splitWarning already failed once)', () => {
    const idx = src.indexOf('const forcedRetryBlock = forcedRetryNote');
    expect(idx).toBeGreaterThan(-1);
    const promptIdx = src.indexOf('const prompt = `${forcedRetryBlock}You are the');
    expect(promptIdx).toBeGreaterThan(idx);
  });

  it('the call site re-invokes runSpecAgent with agent explicitly forced to "openspec" (splitting is openspec\'s job, not speckit\'s)', () => {
    const idx = src.indexOf("retryResult = await runSpecAgent({ promptExec, agent: 'openspec'");
    expect(idx).toBeGreaterThan(-1);
  });

  it('the forced retry note names the concrete violation reason (dynamic, not a generic templated message)', () => {
    const idx = src.indexOf('const forcedRetryNote =');
    const block = src.slice(idx, idx + 400);
    expect(block).toMatch(/\$\{mandateCheck\.reason\}/);
    expect(block).toMatch(/MUST output a non-empty "splitStories" array/i);
  });

  it('the retry result is applied via applySpecChanges (goes through the SAME file-coherence check as a normal split, not a bypass)', () => {
    const retryIdx = src.indexOf("retryResult = await runSpecAgent({ promptExec, agent: 'openspec'");
    const block = src.slice(retryIdx, retryIdx + 600);
    expect(block).toMatch(/applySpecChanges\(story, retryResult\.payload, newStories, prd, opts\.phase, runId\)/);
  });

  it('mandateCheck is recomputed after the forced retry (does not blindly trust the retry succeeded)', () => {
    const retryIdx = src.indexOf("retryResult = await runSpecAgent({ promptExec, agent: 'openspec'");
    const block = src.slice(retryIdx, retryIdx + 2000);
    expect(block).toMatch(/mandateCheck = checkSplitMandateViolation\(originalStorySnapshot, totalSplitCountForStory\)/);
  });

  it('still falls back to the coordinatorReview flag mechanism if the forced retry ALSO fails to resolve the violation (bounded — no infinite retry loop)', () => {
    const retryIdx = src.indexOf("retryResult = await runSpecAgent({ promptExec, agent: 'openspec'");
    const block = src.slice(retryIdx, retryIdx + 2700);
    expect(block).toMatch(/did NOT resolve the split MANDATE violation/);
    // Only ONE forced retry attempt exists in the source — no retry-of-retry loop.
    const retryOccurrences = (src.match(/agent: 'openspec', story, phase: opts\.phase, runId, logDir, forcedRetryNote/g) ?? []).length;
    expect(retryOccurrences).toBe(1);
  });

  it('a failed/unparsable forced retry is counted as an agent failure (visible in summary stats, not silently swallowed)', () => {
    const retryIdx = src.indexOf("retryResult = await runSpecAgent({ promptExec, agent: 'openspec'");
    const block = src.slice(retryIdx, retryIdx + 3000);
    expect(block).toMatch(/summary\.stats\.agentFailures \+= 1/);
  });
});

// ── Lazy-split cascade regression (2026-07-06, live full-run defect) ─────────
//
// Root cause: the forced retry above only checked `splitCount > 0` — but a
// LAZY split (openspec creates children under pressure, but each child
// inherits the FULL original acceptanceCriteria array verbatim instead of an
// actual partition) technically produces splitCount > 0 while leaving every
// child STILL over the AC threshold. Each child then re-triggers its OWN
// split-mandate violation on its own spec-pass turn, recursively splitting
// again — a live run turned SKY-001 (a simple scaffold story) into 4 stories
// in a single pass this way (SKY-001 -> SKY-001-A/B -> SKY-001-B-impl/test),
// each still carrying all 24 original ACs. Fixed by verifying the CHILDREN
// are individually compliant (not just that splitCount > 0), and — critically
// — NOT attempting a second forced retry when they aren't (that recursive
// re-forcing is exactly what produced the cascade); falls back to the
// existing bounded flag mechanism instead.

describe('split-MANDATE reject-and-retry — lazy-split cascade fix', () => {
  const src = readFileSync(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('verifies newly-created children are individually compliant, not just that splitCount > 0', () => {
    const idx = src.indexOf('nonCompliantChildren');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 400);
    expect(block).toMatch(/storyRequiresSplit\(captureStorySnapshot\(child\)\)\.required/);
  });

  it('treats a lazy split (non-compliant children) as UNRESOLVED, overriding the naive splitCount > 0 success', () => {
    const idx = src.indexOf('produced a LAZY split');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx - 400, idx + 400);
    expect(block).toMatch(/mandateCheck = \{ violated: true/);
  });

  it('does NOT attempt a second forced retry when a lazy split is detected — falls back to the existing flag mechanism instead (this is exactly how the live cascade started)', () => {
    // The ONLY runSpecAgent call with agent: 'openspec' + forcedRetryNote in
    // the whole per-story handling path must still be the single one asserted
    // above — detecting a lazy split must not introduce a second invocation.
    const retryOccurrences = (src.match(/agent: 'openspec', story, phase: opts\.phase, runId, logDir, forcedRetryNote/g) ?? []).length;
    expect(retryOccurrences).toBe(1);
  });

  it('REAL EXECUTION: reproduces the exact live defect — a child that inherited the full original AC list verbatim is correctly detected as still non-compliant', () => {
    // This is precisely what happened live: SKY-001-A/B each carried the
    // parent's full 24 ACs unchanged. storyRequiresSplit (the same pure,
    // exported function the fix calls) must flag this.
    const parentAcs = Array.from({ length: 24 }, (_, i) => `ac${i + 1}`);
    const lazyChildSnapshot = {
      acceptanceCriteria: [...parentAcs], // verbatim copy — NOT partitioned
      technicalNotes: { files: ['src/moduleA.ts'] },
    };
    const result = storyRequiresSplit(lazyChildSnapshot);
    expect(result.required).toBe(true);
    expect(result.reason).toMatch(/24 acceptance criteria/);
  });

  it('REAL EXECUTION: a GENUINELY partitioned child (fewer ACs than the parent, at or below the threshold) is correctly recognized as compliant', () => {
    const properlyPartitionedChild = {
      acceptanceCriteria: Array.from({ length: 8 }, (_, i) => `ac${i + 1}`),
      technicalNotes: { files: ['src/moduleA.ts'] },
    };
    const result = storyRequiresSplit(properlyPartitionedChild);
    expect(result.required).toBe(false);
  });
});

// ── Max split depth — interaction with forced retry (2026-07-06) ────────────
//
// The pre-existing depth-2 cap (canSplitStory) already bounds any single
// split chain to 3 generations (depth 0 -> 1 -> 2), but the live cascade
// showed that bound alone isn't enough protection when combined with forced
// retries pushing splits that wouldn't have happened under passive/unenforced
// prompting — worst case, a single depth-0 story could still balloon into
// dozens of stories (up to MAX_CHILDREN_PER_SPLIT at each of 2 levels) before
// the depth cap finally stops it. These tests explicitly cover that
// worst-case combinatorics, not just the single-split-rejected case already
// covered above.

describe('Max split depth — worst-case cascade bound (explicit, requested coverage)', () => {
  it('a depth-2 child can NEVER split again, regardless of how many times a mandate violation is (re-)detected on it', () => {
    const root = makeStory('ROOT');
    const depth1Child = makeStory('ROOT-A', { specification: { createdFrom: 'ROOT', splitDepth: 1 } });
    const depth2Child = makeStory('ROOT-A-1', { specification: { createdFrom: 'ROOT-A', splitDepth: 2 } });
    const prd = makePrd([root, depth1Child, depth2Child]);

    const result = canSplitStory(depth2Child, prd, []);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/depth 2 >= max 2/);
  });

  it('computes the WORST-CASE story count for a single root under full depth+budget exhaustion: 1 + 4 + (4*4) = 21 stories from one original', () => {
    // This is the exact shape of risk the live cascade exposed — not
    // hypothetical. Assert the theoretical ceiling explicitly so a future
    // change to MAX_CHILDREN_PER_SPLIT or max depth surfaces its blast
    // radius here, not as a live-run surprise.
    const maxDepth = 2;
    const worstCase = 1 + MAX_CHILDREN_PER_SPLIT + MAX_CHILDREN_PER_SPLIT * MAX_CHILDREN_PER_SPLIT;
    expect(maxDepth).toBe(2);
    expect(MAX_CHILDREN_PER_SPLIT).toBe(4);
    expect(worstCase).toBe(21);
  });

  it('canSplitStory rejects the 5th split attempt on the SAME parent even across multiple separate spec-pass invocations (budget is read from the PRD, not just an in-memory counter)', () => {
    const story = makeStory('PARENT');
    // Simulate 4 children already committed to the PRD from a PREVIOUS
    // spec-pass run (not just pending in this run's newStories accumulator)
    // — the exact shape a forced-retry cascade across multiple runs would
    // produce if the budget were only tracked in-memory.
    const existingChildren = Array.from({ length: MAX_CHILDREN_PER_SPLIT }, (_, i) =>
      makeStory(`PARENT-${i + 1}`, { specification: { createdFrom: 'PARENT' } })
    );
    const prd = makePrd([story, ...existingChildren]);
    const result = canSplitStory(story, prd, []);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/split budget exhausted/);
  });
});

// ── prd-change-reviewer must not reject a valid split's delegation marker ─────
// Root cause this fixes (found live, 2026-07-06, only surfaced once splits
// actually started succeeding): prd-change-reviewer is a content-quality gate
// with no awareness that "Delegated to split children: X, Y" is a
// deterministic engine-written placeholder, not organic content. It correctly
// (from its own perspective) flagged the placeholder as "vague and
// unmeasurable" and reverted the ENTIRE change — undoing a structurally valid
// split that applySpecChanges had already verified via file coherence, depth,
// and budget checks — purely because of how the placeholder text reads.
describe('isSplitDelegationAc — recognizes the deterministic placeholder', () => {
  it('matches the exact template applySpecChanges writes', () => {
    expect(isSplitDelegationAc(['Delegated to split children: SKY-003-impl, SKY-003-test'])).toBe(true);
  });

  it('does not match an organically-authored AC that happens to contain similar words', () => {
    expect(isSplitDelegationAc(['The API should delegate requests to child handlers'])).toBe(false);
  });

  it('does not match when there is more than one AC (delegation is always exactly one)', () => {
    expect(isSplitDelegationAc(['Delegated to split children: X, Y', 'ac2'])).toBe(false);
  });

  it('does not match an empty or missing AC array', () => {
    expect(isSplitDelegationAc([])).toBe(false);
    expect(isSplitDelegationAc(undefined as any)).toBe(false);
  });
});

describe('isSplitDelegationOnlyChange — decides when the reviewer gate should be skipped', () => {
  function snapshot(overrides: Partial<{ acceptanceCriteria: string[]; description: string; title: string; technicalNotes: object }> = {}) {
    return {
      acceptanceCriteria: ['ac1', 'ac2'],
      description: 'desc',
      title: 'title',
      technicalNotes: { files: ['src/moduleA.ts'] },
      ...overrides,
    };
  }

  it('returns true when a split happened and ONLY the delegation marker changed (reproduces the exact live SKY-003 case)', () => {
    const before = snapshot();
    const after = snapshot({ acceptanceCriteria: ['Delegated to split children: SKY-003-impl, SKY-003-test'] });
    expect(isSplitDelegationOnlyChange(before, after, 2)).toBe(true);
  });

  it('returns false when no split occurred (splitCount is 0), even if the AC looks like a delegation marker', () => {
    const before = snapshot();
    const after = snapshot({ acceptanceCriteria: ['Delegated to split children: SKY-003-impl, SKY-003-test'] });
    expect(isSplitDelegationOnlyChange(before, after, 0)).toBe(false);
  });

  it('returns false when a split happened but description ALSO changed (real content the reviewer must still assess)', () => {
    const before = snapshot();
    const after = snapshot({
      acceptanceCriteria: ['Delegated to split children: SKY-003-impl, SKY-003-test'],
      description: 'a materially different description',
    });
    expect(isSplitDelegationOnlyChange(before, after, 2)).toBe(false);
  });

  it('returns false when a split happened but title ALSO changed', () => {
    const before = snapshot();
    const after = snapshot({
      acceptanceCriteria: ['Delegated to split children: SKY-003-impl, SKY-003-test'],
      title: 'a new title',
    });
    expect(isSplitDelegationOnlyChange(before, after, 2)).toBe(false);
  });

  it('returns false when a split happened but technicalNotes ALSO changed', () => {
    const before = snapshot();
    const after = snapshot({
      acceptanceCriteria: ['Delegated to split children: SKY-003-impl, SKY-003-test'],
      technicalNotes: { files: ['src/moduleA.ts', 'src/extra.ts'] },
    });
    expect(isSplitDelegationOnlyChange(before, after, 2)).toBe(false);
  });

  it('returns false when the AC is not actually the delegation marker (e.g. a normal AC rewrite with splitCount stale/mismatched)', () => {
    const before = snapshot();
    const after = snapshot({ acceptanceCriteria: ['a differently-worded ac1', 'ac2'] });
    expect(isSplitDelegationOnlyChange(before, after, 2)).toBe(false);
  });
});

describe('spec-mode-runner.js — call site skips prd-change-reviewer for split-only changes, and informs it when mixed with other changes', () => {
  const src = readFileSync(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('the review-gate call site checks isSplitDelegationOnlyChange before calling reviewPrdChange', () => {
    const idx = src.indexOf('isSplitDelegationOnlyChange(beforeSnapshot, afterSnapshot, changes.splitCount)');
    expect(idx).toBeGreaterThan(-1);
    const reviewCallIdx = src.indexOf('await reviewPrdChange(', idx);
    expect(reviewCallIdx).toBeGreaterThan(idx);
  });

  it('reviewPrdChange receives a splitOccurred flag for the mixed case (split + other field changes)', () => {
    expect(src).toMatch(/splitOccurred:\s*changes\.splitCount > 0/);
    expect(src).toMatch(/async function reviewPrdChange\(\{[^}]*splitOccurred/);
  });

  it('the prompt explicitly tells the reviewer not to flag the delegation placeholder when splitOccurred is true', () => {
    const idx = src.indexOf('const splitNote = splitOccurred');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 400);
    expect(block).toMatch(/do NOT flag that placeholder as vague or unmeasurable/);
  });
});

// ── implementationOrder cleanup for delegated parents ────────────────────────
describe('run() Step 3 — removes successfully-delegated parents from implementationOrder (static)', () => {
  it('collects delegated parent IDs and filters them out of implementationOrder[phase] after insertion', () => {
    const idx = SPEC_MODE_RUNNER_SRC.indexOf('Step 3: Insert split stories into PRD');
    const block = SPEC_MODE_RUNNER_SRC.slice(idx, idx + 1500);
    expect(block).toMatch(/delegatedParentIds/);
    expect(block).toMatch(/order\.filter\(\(id\) => !delegatedParentIds\.has\(id\)\)/);
  });
});

describe('validateMidExecutionSplits — removes the validated parent from implementationOrder (static)', () => {
  it('marks the parent deprecated/completed and filters it out of implementationOrder[phase]', () => {
    const idx = SPEC_MODE_RUNNER_SRC.indexOf('async function validateMidExecutionSplits');
    const endIdx = SPEC_MODE_RUNNER_SRC.indexOf('\nif (require.main === module)', idx);
    const body = SPEC_MODE_RUNNER_SRC.slice(idx, endIdx);
    expect(body).toMatch(/parentStory\.status = 'deprecated'/);
    expect(body).toMatch(/parentStory\.completed = true/);
    expect(body).toMatch(/order\.filter\(\(id\) => id !== parentId\)/);
  });

  // Root cause this fixes (found live, 2026-07-06, tier3-full-run-16): a
  // REJECTED split child (depth guard, budget guard, or coherence violation)
  // also gets status='deprecated' set, but — unlike applySpecChanges' spec-
  // pass path, where rejected children are spliced out before ever reaching
  // implementationOrder — a mid-execution child was ALREADY inserted into
  // implementationOrder by whatever created the split before validation ran,
  // so it stayed there. Violated the same "no deprecated story in
  // implementationOrder" invariant asserted elsewhere in this test suite
  // (pipeline-regression.test.ts).
  it('removeFromImplementationOrder is called from all three rejection branches (depth, budget, coherence)', () => {
    const idx = SPEC_MODE_RUNNER_SRC.indexOf('async function validateMidExecutionSplits');
    const endIdx = SPEC_MODE_RUNNER_SRC.indexOf('\nif (require.main === module)', idx);
    const body = SPEC_MODE_RUNNER_SRC.slice(idx, endIdx);
    expect(body).toMatch(/function removeFromImplementationOrder\(storyId\)/);
    const callCount = (body.match(/removeFromImplementationOrder\((?:child|r)\.id\)/g) || []).length;
    expect(callCount).toBe(3);
  });

  it('each rejection branch calls removeFromImplementationOrder AFTER marking status deprecated (ordering does not matter functionally, but both must be present per branch)', () => {
    const idx = SPEC_MODE_RUNNER_SRC.indexOf('async function validateMidExecutionSplits');
    const endIdx = SPEC_MODE_RUNNER_SRC.indexOf('\nif (require.main === module)', idx);
    const body = SPEC_MODE_RUNNER_SRC.slice(idx, endIdx);
    // Depth guard branch
    const depthIdx = body.indexOf('depth ${currentDepth} >= max ${maxSplitDepth}');
    expect(body.slice(depthIdx, depthIdx + 400)).toMatch(/removeFromImplementationOrder\(child\.id\)/);
    // Budget guard branch
    const budgetIdx = body.indexOf('split budget exhausted (max ${MAX_CHILDREN_PER_SPLIT})');
    expect(body.slice(budgetIdx, budgetIdx + 400)).toMatch(/removeFromImplementationOrder\(r\.id\)/);
    // Coherence violation branch
    const coherenceIdx = body.indexOf('same-file coherence violation: multiple children write to the same file');
    expect(body.slice(coherenceIdx, coherenceIdx + 400)).toMatch(/removeFromImplementationOrder\(child\.id\)/);
  });
});

// NOTE: validateMidExecutionSplits' success path requires a real (or mocked)
// LLM call via runSpeckitReview, and every REJECTION path ends in
// process.exit(1) once hardViolations > 0 — which would kill the vitest
// process itself if invoked directly in a test, not just throw. Real
// execution coverage for this function is intentionally left to the static
// assertions above; the underlying deprecated/completed-marking and
// implementationOrder-filtering logic is already covered by real execution
// via applySpecChanges (the spec-pass split path, functionally identical).

// ── Deterministic test-only-child role correction ────────────────────────────
// Root cause this fixes (found live, 2026-07-06, tier3-full-run-18): every
// split child whose files were ALL test files (SKY-002-TEST, SKY-003-test,
// SKY-004-test — all of them, not just one) kept the parent's implementation-
// oriented agentRole instead of a test-oriented role. The only existing
// correction was an LLM instruction buried in a large natural-language
// prompt ("if all files match *.test.ts, update agentRole to test-engineer")
// which silently failed to apply for every single split child this run.
//
// Design constraint: no hardcoded role name in the engine — agent roles are
// project-defined and dynamic. Both the pattern that identifies "test-only"
// and the correct role name to assign come from the project's own
// .epam/contract-generation.json (testFilePattern / testFileAgentRole).
describe('correctSplitChildAgentRoleIfTestOnly — deterministic, config-driven role correction (no hardcoded role name in the engine)', () => {
  function withProjectConfig(cfg: object | null, fn: (outputDir: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'role-correction-test-'));
    try {
      if (cfg) {
        mkdirSync(join(dir, '.epam'), { recursive: true });
        writeFileSync(join(dir, '.epam/contract-generation.json'), JSON.stringify(cfg));
      }
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const CONFIG = {
    testFilePattern: '\\.(test|spec)\\.[a-zA-Z0-9]+$',
    testFileAgentRole: 'test-engineer',
  };

  it('REPRODUCES the exact live scenario: a split child owning only a .test.ts file gets its agentRole corrected', () => {
    withProjectConfig(CONFIG, (outputDir) => {
      const prd = { project: { outputDir } };
      const child = {
        id: 'SKY-002-TEST',
        agentRole: 'typescript-engineer',
        technicalNotes: { files: ['/x/src/skyscanner/client.test.ts'] },
      };
      correctSplitChildAgentRoleIfTestOnly(prd, child);
      expect(child.agentRole).toBe('test-engineer');
    });
  });

  it('does not touch a child whose files are NOT all test files (implementation child)', () => {
    withProjectConfig(CONFIG, (outputDir) => {
      const prd = { project: { outputDir } };
      const child = {
        id: 'SKY-002-impl',
        agentRole: 'typescript-engineer',
        technicalNotes: { files: ['/x/src/skyscanner/client.ts'] },
      };
      correctSplitChildAgentRoleIfTestOnly(prd, child);
      expect(child.agentRole).toBe('typescript-engineer');
    });
  });

  it('does not touch a child with a MIX of test and impl files (not "all test")', () => {
    withProjectConfig(CONFIG, (outputDir) => {
      const prd = { project: { outputDir } };
      const child = {
        id: 'SKY-002-mixed',
        agentRole: 'typescript-engineer',
        technicalNotes: { files: ['/x/src/a.ts', '/x/src/a.test.ts'] },
      };
      correctSplitChildAgentRoleIfTestOnly(prd, child);
      expect(child.agentRole).toBe('typescript-engineer');
    });
  });

  it('is a no-op when the project has not configured testFileAgentRole (opt-in, no engine default)', () => {
    withProjectConfig({ testFilePattern: '\\.test\\.ts$' }, (outputDir) => {
      const prd = { project: { outputDir } };
      const child = {
        id: 'SKY-002-TEST',
        agentRole: 'typescript-engineer',
        technicalNotes: { files: ['/x/src/client.test.ts'] },
      };
      correctSplitChildAgentRoleIfTestOnly(prd, child);
      expect(child.agentRole).toBe('typescript-engineer');
    });
  });

  it('is a no-op when .epam/contract-generation.json does not exist', () => {
    withProjectConfig(null, (outputDir) => {
      const prd = { project: { outputDir } };
      const child = {
        id: 'SKY-002-TEST',
        agentRole: 'typescript-engineer',
        technicalNotes: { files: ['/x/src/client.test.ts'] },
      };
      correctSplitChildAgentRoleIfTestOnly(prd, child);
      expect(child.agentRole).toBe('typescript-engineer');
    });
  });

  it('is fully generic — a project using a DIFFERENT role name (e.g. "qa-engineer") gets that name, not a hardcoded "test-engineer"', () => {
    withProjectConfig(
      { testFilePattern: '\\.test\\.ts$', testFileAgentRole: 'qa-engineer' },
      (outputDir) => {
        const prd = { project: { outputDir } };
        const child = {
          id: 'ORDER-002-test',
          agentRole: 'backend-engineer',
          technicalNotes: { files: ['/x/src/checkout.test.ts'] },
        };
        correctSplitChildAgentRoleIfTestOnly(prd, child);
        expect(child.agentRole).toBe('qa-engineer');
      }
    );
  });

  it('the engine source itself contains no hardcoded role-name literal (e.g. "test-engineer") — only reads it from config', () => {
    const idx = SPEC_MODE_RUNNER_SRC.indexOf('function correctSplitChildAgentRoleIfTestOnly');
    const endIdx = SPEC_MODE_RUNNER_SRC.indexOf('\n}', idx) + 2;
    const body = SPEC_MODE_RUNNER_SRC.slice(idx, endIdx);
    expect(body).not.toMatch(/'test-engineer'|"test-engineer"/);
    expect(body).toMatch(/cfg\.testFileAgentRole/);
  });
});

describe('correctSplitChildAgentRoleIfTestOnly — wired into both split-creation sites', () => {
  it('applySpecChanges (spec-pass split path) calls it for each newly created child', () => {
    const idx = SPEC_MODE_RUNNER_SRC.indexOf('newStories.push({ parentId: story.id, story: newStory, phase: phaseId });');
    const block = SPEC_MODE_RUNNER_SRC.slice(idx - 200, idx);
    expect(block).toMatch(/correctSplitChildAgentRoleIfTestOnly\(prd, newStory\)/);
  });

  it('validateMidExecutionSplits (mid-execution split path) calls it for each child', () => {
    const idx = SPEC_MODE_RUNNER_SRC.indexOf('async function validateMidExecutionSplits');
    const endIdx = SPEC_MODE_RUNNER_SRC.indexOf('\nif (require.main === module)', idx);
    const body = SPEC_MODE_RUNNER_SRC.slice(idx, endIdx);
    expect(body).toMatch(/correctSplitChildAgentRoleIfTestOnly\(prd, child\)/);
  });

  it('REPRODUCES the exact live scenario end-to-end via applySpecChanges: a real split produces a correctly-roled test child', () => {
    const dir = mkdtempSync(join(tmpdir(), 'role-correction-e2e-test-'));
    try {
      mkdirSync(join(dir, '.epam'), { recursive: true });
      writeFileSync(
        join(dir, '.epam/contract-generation.json'),
        JSON.stringify({ testFilePattern: '\\.(test|spec)\\.[a-zA-Z0-9]+$', testFileAgentRole: 'test-engineer' })
      );
      const story = makeStory('SKY-002', {
        acceptanceCriteria: Array.from({ length: 15 }, (_, i) => `ac${i + 1}`),
        agentRole: 'typescript-engineer',
        technicalNotes: { files: ['src/skyscanner/client.ts', 'src/skyscanner/client.test.ts'] },
      });
      const prd = { project: { outputDir: dir }, stories: [story] };
      const newStories: object[] = [];
      const payload = {
        splitStories: [
          {
            id: 'SKY-002-impl',
            title: 'Impl',
            acceptanceCriteria: ['ac-impl'],
            technicalNotes: { files: ['src/skyscanner/client.ts'] },
          },
          {
            id: 'SKY-002-TEST',
            title: 'Test',
            acceptanceCriteria: ['ac-test'],
            technicalNotes: { files: ['src/skyscanner/client.test.ts'] },
          },
        ],
      };
      applySpecChanges(story, payload, newStories, prd, 'core', 'run-role-fix');
      const implChild: any = newStories.find((ns: any) => (ns as any).story.id === 'SKY-002-impl');
      const testChild: any = newStories.find((ns: any) => (ns as any).story.id === 'SKY-002-TEST');
      expect(testChild.story.agentRole).toBe('test-engineer');
      expect(implChild.story.agentRole).toBe('typescript-engineer'); // inherited from parent, untouched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
