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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  canSplitStory,
  capSplitACs,
  validateSplitFileCoherence,
  applySpecChanges,
  splitDepth,
  MAX_ACS_PER_STORY,
  MAX_CHILDREN_PER_SPLIT,
} = require('../../../orchestrations/scripts/spec-mode-runner.js');

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

  it('allows multiple children writing to the same test file (test files are exempt)', () => {
    const children = [
      { id: 'C-1', technicalNotes: { files: ['src/skyscanner/client.ts', 'src/skyscanner/client.test.ts'] } },
      { id: 'C-2', technicalNotes: { files: ['src/skyscanner/client.test.ts'] } },
    ];
    // Only client.ts would conflict, but C-2 doesn't write to it
    expect(validateSplitFileCoherence(children)).toHaveLength(0);
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
    // Find the Step 1 story execution loop
    const step1Idx = orchSrc.indexOf('run_story_with_watchdog "$story" "$LOG_DIR/main-${story}.log"');
    expect(step1Idx).toBeGreaterThan(-1);
    const postStory = orchSrc.slice(step1Idx, step1Idx + 500);
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

describe('speckit SPLIT RULES — hard limits documented in prompt', () => {
  it('speckit prompt references 24-AC hard limit', () => {
    const src = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'),
      'utf8'
    );
    // Find the speckit prompt section
    const promptIdx = src.indexOf('You are the speckit specification agent');
    expect(promptIdx).toBeGreaterThan(-1);
    const promptBlock = src.slice(promptIdx, promptIdx + 3000);
    expect(promptBlock).toContain('24 ACs');
    expect(promptBlock).toMatch(/HARD LIMITS|hard limits/i);
  });

  it('speckit prompt references max 4 children', () => {
    const src = readFileSync(
      join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'),
      'utf8'
    );
    const promptIdx = src.indexOf('You are the speckit specification agent');
    const promptBlock = src.slice(promptIdx, promptIdx + 3000);
    expect(promptBlock).toContain('4 split children');
  });
});
