/**
 * Unit tests for spec-mode-runner.js
 *
 * Covers:
 *   - extractTaggedJson: <SPEC_AGENT> tag parsing (full pair + partial/close-only)
 *   - resolvePromptProvider: env var priority (AI_PROVIDER > EPAM_ORCHESTRATION_PROVIDER > CLAUDE_CMD > default)
 *   - resolvePromptExec: model args injected when AI_MODEL / ORCH_GATE_MODEL set
 *   - buildAssignments: coordinator output → per-story agent map
 *   - captureStorySnapshot: immutable snapshot of story fields
 *   - applySpecChanges: AC update, description update, split story creation
 *   - extractCodeRefs: technicalNotes.files extraction (max 3, non-string filtered)
 *   - splitDepth: createdFrom chain traversal
 */

import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  extractTaggedJson,
  resolvePromptProvider,
  resolvePromptExec,
  buildAssignments,
  captureStorySnapshot,
  applySpecChanges,
  extractCodeRefs,
  splitDepth,
} = require('../../../orchestrations/scripts/spec-mode-runner.js');

// ─── extractTaggedJson ───────────────────────────────────────────────────────

describe('extractTaggedJson', () => {
  it('parses full <SPEC_AGENT>...</SPEC_AGENT> pair', () => {
    const text = '<SPEC_AGENT>{"storyId":"HW-001","agent":"openspec"}</SPEC_AGENT>';
    const result = extractTaggedJson(text, 'SPEC_AGENT');
    expect(result).toEqual({ storyId: 'HW-001', agent: 'openspec' });
  });

  it('parses partial close-tag-only form (SDK single-turn response)', () => {
    const text = '{"storyId":"HW-002","agent":"speckit"}</SPEC_AGENT>';
    const result = extractTaggedJson(text, 'SPEC_AGENT');
    expect(result).toEqual({ storyId: 'HW-002', agent: 'speckit' });
  });

  it('strips markdown code fences before parsing', () => {
    const text = '<SPEC_AGENT>\n```json\n{"storyId":"HW-003"}\n```\n</SPEC_AGENT>';
    const result = extractTaggedJson(text, 'SPEC_AGENT');
    expect(result).toEqual({ storyId: 'HW-003' });
  });

  it('returns null for text with no matching tag', () => {
    expect(extractTaggedJson('no tags here', 'SPEC_AGENT')).toBeNull();
  });

  it('returns null for empty/null input', () => {
    expect(extractTaggedJson('', 'SPEC_AGENT')).toBeNull();
    expect(extractTaggedJson(null, 'SPEC_AGENT')).toBeNull();
    expect(extractTaggedJson(undefined, 'SPEC_AGENT')).toBeNull();
  });

  it('returns null for malformed JSON inside tag', () => {
    const text = '<SPEC_AGENT>{bad json}</SPEC_AGENT>';
    expect(extractTaggedJson(text, 'SPEC_AGENT')).toBeNull();
  });

  it('handles multiline JSON inside tag', () => {
    const payload = { storyId: 'HW-004', acceptanceCriteria: ['a', 'b'] };
    const text = `<SPEC_AGENT>\n${JSON.stringify(payload, null, 2)}\n</SPEC_AGENT>`;
    expect(extractTaggedJson(text, 'SPEC_AGENT')).toEqual(payload);
  });

  it('works with custom tag names (e.g. COORDINATOR)', () => {
    const text = '<COORDINATOR>{"assignments":[]}</COORDINATOR>';
    expect(extractTaggedJson(text, 'COORDINATOR')).toEqual({ assignments: [] });
  });
});

// ─── resolvePromptProvider ───────────────────────────────────────────────────

describe('resolvePromptProvider', () => {
  it('returns AI_PROVIDER when set (highest priority)', () => {
    expect(resolvePromptProvider({ AI_PROVIDER: 'openai', EPAM_ORCHESTRATION_PROVIDER: 'qwen' }))
      .toBe('openai');
  });

  it('falls back to EPAM_ORCHESTRATION_PROVIDER when AI_PROVIDER unset', () => {
    expect(resolvePromptProvider({ EPAM_ORCHESTRATION_PROVIDER: 'qwen' })).toBe('qwen');
  });

  it('detects codex from CLAUDE_CMD ending with "codex"', () => {
    expect(resolvePromptProvider({ CLAUDE_CMD: '/usr/local/bin/codex' })).toBe('codex');
  });

  it('does NOT match codex for partial matches (e.g. "codex-cli")', () => {
    // /codex$/ requires codex at end of string
    const result = resolvePromptProvider({ CLAUDE_CMD: 'codex-cli' });
    expect(result).toBe('claude'); // falls through to default
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolvePromptProvider({})).toBe('claude');
  });

  it('uses qwen when EPAM_ORCHESTRATION_PROVIDER=qwen and no AI_PROVIDER', () => {
    expect(resolvePromptProvider({ EPAM_ORCHESTRATION_PROVIDER: 'qwen', CLAUDE_CMD: 'claude' }))
      .toBe('qwen');
  });
});

// ─── resolvePromptExec ───────────────────────────────────────────────────────

describe('resolvePromptExec', () => {
  it('includes --provider arg', () => {
    const exec = resolvePromptExec('/path/ai-run.sh', { AI_PROVIDER: 'qwen' });
    expect(exec.args).toContain('--provider');
    expect(exec.args).toContain('qwen');
  });

  it('includes --model arg when AI_MODEL is set', () => {
    const exec = resolvePromptExec('/path/ai-run.sh', {
      AI_PROVIDER: 'qwen',
      AI_MODEL: 'qwen/qwen3-coder-30b-a3b-instruct',
    });
    expect(exec.args).toContain('--model');
    expect(exec.args).toContain('qwen/qwen3-coder-30b-a3b-instruct');
  });

  it('falls back to ORCH_GATE_MODEL when AI_MODEL not set', () => {
    const exec = resolvePromptExec('/path/ai-run.sh', {
      AI_PROVIDER: 'qwen',
      ORCH_GATE_MODEL: 'qwen/qwen3-coder-flash',
    });
    expect(exec.args).toContain('--model');
    expect(exec.args).toContain('qwen/qwen3-coder-flash');
  });

  it('omits --model when neither AI_MODEL nor ORCH_GATE_MODEL is set', () => {
    const exec = resolvePromptExec('/path/ai-run.sh', { AI_PROVIDER: 'qwen' });
    expect(exec.args).not.toContain('--model');
  });

  it('AI_MODEL takes priority over ORCH_GATE_MODEL', () => {
    const exec = resolvePromptExec('/path/ai-run.sh', {
      AI_PROVIDER: 'qwen',
      AI_MODEL: 'qwen/qwen3-coder-30b-a3b-instruct',
      ORCH_GATE_MODEL: 'qwen/qwen3-coder-flash',
    });
    const modelIdx = exec.args.indexOf('--model');
    expect(exec.args[modelIdx + 1]).toBe('qwen/qwen3-coder-30b-a3b-instruct');
  });

  it('sets cmd to provided aiRunnerCmd', () => {
    const exec = resolvePromptExec('/custom/path/ai-run.sh', {});
    expect(exec.cmd).toBe('/custom/path/ai-run.sh');
  });
});

// ─── buildAssignments ────────────────────────────────────────────────────────

describe('buildAssignments', () => {
  const stories = [
    { id: 'HW-001', title: 'Story 1' },
    { id: 'HW-002', title: 'Story 2' },
  ];

  it('assigns coordinator-specified agents to matching stories', () => {
    const assignments = [{ storyId: 'HW-001', agents: ['openspec'], notes: 'simple', priority: 'normal' }];
    const map = buildAssignments(assignments, stories, 'run-1');
    expect(map.get('HW-001').agents).toEqual(['openspec']);
  });

  it('assigns default [openspec, speckit] to stories not in coordinator output', () => {
    const map = buildAssignments([], stories, 'run-1');
    expect(map.get('HW-001').agents).toEqual(['openspec', 'speckit']);
    expect(map.get('HW-002').agents).toEqual(['openspec', 'speckit']);
  });

  it('ignores coordinator entries for unknown story IDs', () => {
    const assignments = [{ storyId: 'UNKNOWN-99', agents: ['openspec'] }];
    const map = buildAssignments(assignments, stories, 'run-1');
    expect(map.has('UNKNOWN-99')).toBe(false);
  });

  it('preserves empty agents array when coordinator explicitly passes [] (intentional skip)', () => {
    // Empty agents = coordinator explicitly chose to skip spec for this story
    const assignments = [{ storyId: 'HW-001', agents: [] }];
    const map = buildAssignments(assignments, stories, 'run-1');
    expect(map.get('HW-001').agents).toEqual([]);
  });

  it('handles null/non-array assignments gracefully', () => {
    expect(() => buildAssignments(null, stories, 'run-1')).not.toThrow();
    expect(() => buildAssignments(undefined, stories, 'run-1')).not.toThrow();
  });
});

// ─── captureStorySnapshot ────────────────────────────────────────────────────

describe('captureStorySnapshot', () => {
  it('captures acceptanceCriteria as a new array (immutable)', () => {
    const story = { acceptanceCriteria: ['ac1', 'ac2'], description: 'desc', title: 'title' };
    const snap = captureStorySnapshot(story);
    expect(snap.acceptanceCriteria).toEqual(['ac1', 'ac2']);
    story.acceptanceCriteria.push('ac3');
    expect(snap.acceptanceCriteria).toHaveLength(2); // snapshot not mutated
  });

  it('returns empty array when acceptanceCriteria missing', () => {
    const snap = captureStorySnapshot({ description: 'x', title: 'y' });
    expect(snap.acceptanceCriteria).toEqual([]);
  });

  it('captures description and title', () => {
    const snap = captureStorySnapshot({ description: 'do X', title: 'X story', acceptanceCriteria: [] });
    expect(snap.description).toBe('do X');
    expect(snap.title).toBe('X story');
  });

  it('captures technicalNotes when present', () => {
    const tn = { files: ['src/foo.ts'] };
    const snap = captureStorySnapshot({ acceptanceCriteria: [], description: '', title: '', technicalNotes: tn });
    expect(snap.technicalNotes).toEqual(tn);
  });

  it('sets technicalNotes to null when absent', () => {
    const snap = captureStorySnapshot({ acceptanceCriteria: [], description: '', title: '' });
    expect(snap.technicalNotes).toBeNull();
  });
});

// ─── applySpecChanges ────────────────────────────────────────────────────────

describe('applySpecChanges', () => {
  const makePrd = (stories: object[]) => ({ stories, implementationOrder: {} });
  const baseStory = () => ({
    id: 'HW-001',
    title: 'Old title',
    description: 'Old desc',
    acceptanceCriteria: ['old-ac'],
    specification: {},
  });

  it('updates acceptanceCriteria when payload differs', () => {
    const story = baseStory();
    const prd = makePrd([story]);
    const payload = { acceptanceCriteria: ['new-ac-1', 'new-ac-2'] };
    const result = applySpecChanges(story, payload, [], prd, 'phase1', 'run1');
    expect(story.acceptanceCriteria).toEqual(['new-ac-1', 'new-ac-2']);
    expect(result.acceptanceChanged).toBe(true);
  });

  it('does not mark acceptanceChanged when AC is identical', () => {
    const story = baseStory();
    const prd = makePrd([story]);
    const payload = { acceptanceCriteria: ['old-ac'] };
    const result = applySpecChanges(story, payload, [], prd, 'phase1', 'run1');
    expect(result.acceptanceChanged).toBe(false);
  });

  it('updates description when payload provides one', () => {
    const story = baseStory();
    const prd = makePrd([story]);
    applySpecChanges(story, { description: 'New desc' }, [], prd, 'phase1', 'run1');
    expect(story.description).toBe('New desc');
  });

  it('does not overwrite description when payload is empty string', () => {
    const story = baseStory();
    const prd = makePrd([story]);
    applySpecChanges(story, { description: '  ' }, [], prd, 'phase1', 'run1');
    expect(story.description).toBe('Old desc');
  });

  it('appends split stories to newStories array and returns correct splitCount', () => {
    const story = baseStory();
    const prd = makePrd([story]);
    const newStories: object[] = [];
    const payload = {
      splitStories: [
        { id: 'HW-001a', title: 'Part A', description: 'desc A', acceptanceCriteria: ['ac'] },
        { id: 'HW-001b', title: 'Part B', description: 'desc B', acceptanceCriteria: ['ac'] },
      ],
    };
    const result = applySpecChanges(story, payload, newStories, prd, 'phase1', 'run1');
    expect(result.splitCount).toBe(2);
    expect(newStories).toHaveLength(2);
  });

  it('does not split when splitStories is empty', () => {
    const story = baseStory();
    const prd = makePrd([story]);
    const result = applySpecChanges(story, { splitStories: [] }, [], prd, 'phase1', 'run1');
    expect(result.splitCount).toBe(0);
  });
});

// ─── extractCodeRefs ─────────────────────────────────────────────────────────

describe('extractCodeRefs', () => {
  it('returns files from technicalNotes.files', () => {
    const story = { technicalNotes: { files: ['src/a.ts', 'src/b.ts'] } };
    expect(extractCodeRefs(story)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('limits to 3 files', () => {
    const story = { technicalNotes: { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] } };
    expect(extractCodeRefs(story)).toHaveLength(3);
  });

  it('filters out non-string entries', () => {
    const story = { technicalNotes: { files: ['a.ts', null, 123, 'b.ts'] } };
    expect(extractCodeRefs(story)).toEqual(['a.ts', 'b.ts']);
  });

  it('returns empty array when technicalNotes missing', () => {
    expect(extractCodeRefs({})).toEqual([]);
    expect(extractCodeRefs({ technicalNotes: {} })).toEqual([]);
  });

  it('trims whitespace from file paths', () => {
    const story = { technicalNotes: { files: ['  src/a.ts  '] } };
    expect(extractCodeRefs(story)).toEqual(['src/a.ts']);
  });
});

// ─── splitDepth ──────────────────────────────────────────────────────────────

describe('splitDepth', () => {
  it('returns 0 for a root story with no createdFrom', () => {
    const story = { id: 'HW-001', specification: {} };
    const prd = { stories: [story] };
    expect(splitDepth(story, prd)).toBe(0);
  });

  it('returns 1 for a first-level split story', () => {
    const parent = { id: 'HW-001', specification: {} };
    const child = { id: 'HW-001a', specification: { createdFrom: 'HW-001' } };
    const prd = { stories: [parent, child] };
    expect(splitDepth(child, prd)).toBe(1);
  });

  it('returns 2 for a second-level split', () => {
    const root = { id: 'HW-001', specification: {} };
    const level1 = { id: 'HW-001a', specification: { createdFrom: 'HW-001' } };
    const level2 = { id: 'HW-001a1', specification: { createdFrom: 'HW-001a' } };
    const prd = { stories: [root, level1, level2] };
    expect(splitDepth(level2, prd)).toBe(2);
  });

  it('guards against circular createdFrom chains', () => {
    const a = { id: 'HW-A', specification: { createdFrom: 'HW-B' } };
    const b = { id: 'HW-B', specification: { createdFrom: 'HW-A' } };
    const prd = { stories: [a, b] };
    // Should not infinite-loop; visited set terminates the walk
    expect(() => splitDepth(a, prd)).not.toThrow();
  });
});
