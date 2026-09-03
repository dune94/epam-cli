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

  it('returns null for empty/whitespace-only tag content (only match)', () => {
    expect(extractTaggedJson('<SPEC_ASSIGNMENTS>\n</SPEC_ASSIGNMENTS>', 'SPEC_ASSIGNMENTS')).toBeNull();
    expect(extractTaggedJson('<SPEC_ASSIGNMENTS>   </SPEC_ASSIGNMENTS>', 'SPEC_ASSIGNMENTS')).toBeNull();
    expect(extractTaggedJson('<SPEC_ASSIGNMENTS>\n\n\t\n</SPEC_ASSIGNMENTS>', 'SPEC_ASSIGNMENTS')).toBeNull();
  });

  /**
   * SUPERSEDED 2026-08-06. A truncated answer used to be discarded. Live that day, three
   * agents answered in shapes with no closing tag — `<tool_call>{"name":…` cut off mid-reply,
   * a bare tool name followed by the payload, prose then JSON — and each time a correct,
   * complete JSON object was thrown away on punctuation. One of those losses aborted a whole
   * specification pass ("the guard-vocabulary agent returned no usable terms").
   *
   * If the payload is there and parses, it is recovered. Nothing is invented: the object still
   * has to be valid JSON, and the caller still validates it against the tool definition.
   */
  it('recovers a complete payload even when the closing tag never arrived', () => {
    const text = '<SPEC_AGENT>{"storyId":"HW-001"}';
    expect(
      extractTaggedJson(text, 'SPEC_AGENT'),
      'a complete answer was discarded because the model did not close its tag',
    ).toEqual({ storyId: 'HW-001' });
  });

  it('a truncated answer with no complete object is still null', () => {
    expect(extractTaggedJson('<SPEC_AGENT>{"storyId":"HW-0', 'SPEC_AGENT')).toBeNull();
  });

  it('returns last parseable match when model echoes empty template block before real output', () => {
    // Coordinator prompt has empty <SPEC_ASSIGNMENTS></SPEC_ASSIGNMENTS> as template;
    // model echoes it then outputs its real assignments after "# Output"
    const realPayload = [{ storyId: 'HW-003', agents: ['speckit'], priority: 'high' }];
    const text = [
      '<SPEC_ASSIGNMENTS>',
      '</SPEC_ASSIGNMENTS>',
      '',
      '# Output',
      '<SPEC_ASSIGNMENTS>',
      JSON.stringify(realPayload, null, 2),
      '</SPEC_ASSIGNMENTS>',
    ].join('\n');
    expect(extractTaggedJson(text, 'SPEC_ASSIGNMENTS')).toEqual(realPayload);
  });

  it('skips malformed earlier blocks and returns last parseable one', () => {
    const good = { storyId: 'HW-001', agent: 'speckit' };
    const text = [
      '<SPEC_AGENT>{bad json}</SPEC_AGENT>',
      '<SPEC_AGENT></SPEC_AGENT>',
      `<SPEC_AGENT>${JSON.stringify(good)}</SPEC_AGENT>`,
    ].join('\n');
    expect(extractTaggedJson(text, 'SPEC_AGENT')).toEqual(good);
  });

  it('normalizes <_TAG> underscore-prefix variant that OpenRouter emits to distinguish from template echo', () => {
    // OpenRouter outputs empty template block first, then its real content with <_TAG> opening
    const realPayload = [{ storyId: 'HW-001', agents: ['openspec'], priority: 'high' }];
    const text = [
      '<SPEC_ASSIGNMENTS>',
      '</SPEC_ASSIGNMENTS>',
      '',
      '# Output',
      '<_SPEC_ASSIGNMENTS>',
      JSON.stringify(realPayload, null, 2),
      '</SPEC_ASSIGNMENTS>',
    ].join('\n');
    expect(extractTaggedJson(text, 'SPEC_ASSIGNMENTS')).toEqual(realPayload);
  });

  it('normalizes <-TAG> dash-prefix variant', () => {
    const good = [{ storyId: 'HW-002', agents: ['speckit'], priority: 'medium' }];
    const text = `<-SPEC_ASSIGNMENTS>\n${JSON.stringify(good)}\n</SPEC_ASSIGNMENTS>`;
    expect(extractTaggedJson(text, 'SPEC_ASSIGNMENTS')).toEqual(good);
  });

  it('repairs M3-style trailing comma in object', () => {
    // M3 often emits trailing commas that JSON.parse rejects
    const text = '<SPEC_AGENT>{"storyId":"SKY-001","agent":"speckit",}</SPEC_AGENT>';
    const result = extractTaggedJson(text, 'SPEC_AGENT');
    expect(result).not.toBeNull();
    expect(result.storyId).toBe('SKY-001');
  });

  it('repairs M3-style double-closing brace ("}}" at end)', () => {
    const text = '<SPEC_AGENT>{"storyId":"SKY-002","agent":"openspec"}}</SPEC_AGENT>';
    const result = extractTaggedJson(text, 'SPEC_AGENT');
    expect(result).not.toBeNull();
    expect(result.storyId).toBe('SKY-002');
  });

  it('repairs M3-style truncated string (unterminated at token limit)', () => {
    // Simulates M3 being cut off mid-string value
    const text = '<SPEC_AGENT>{"storyId":"SKY-003","description":"Implement the flight search</SPEC_AGENT>';
    const result = extractTaggedJson(text, 'SPEC_AGENT');
    expect(result).not.toBeNull();
    expect(result.storyId).toBe('SKY-003');
  });

  it('repairs raw JSON (no tags) with trailing comma via jsonrepair fallback', () => {
    // Model returned raw JSON without tags — raw fallback path + repair
    const text = '{"storyId":"SKY-004","acceptanceCriteria":["a","b",]}';
    const result = extractTaggedJson(text, 'SPEC_AGENT');
    expect(result).not.toBeNull();
    expect(result.storyId).toBe('SKY-004');
  });

  it('does NOT repair plain text (no JSON shape) — returns null', () => {
    // jsonrepair must not turn arbitrary prose into a JSON string
    expect(extractTaggedJson('no tags here', 'SPEC_AGENT')).toBeNull();
    expect(extractTaggedJson('I cannot execute this task', 'SPEC_AGENT')).toBeNull();
  });
});

// ─── resolvePromptProvider ───────────────────────────────────────────────────

describe('resolvePromptProvider', () => {
  it('returns AI_PROVIDER when set (highest priority)', () => {
    expect(resolvePromptProvider({ AI_PROVIDER: 'openai', EPAM_ORCHESTRATION_PROVIDER: 'openrouter' }))
      .toBe('openai');
  });

  it('falls back to EPAM_ORCHESTRATION_PROVIDER when AI_PROVIDER unset', () => {
    expect(resolvePromptProvider({ EPAM_ORCHESTRATION_PROVIDER: 'openrouter' })).toBe('openrouter');
  });

  it('detects codex from CLAUDE_CMD ending with "codex"', () => {
    expect(resolvePromptProvider({ CLAUDE_CMD: '/usr/local/bin/codex' })).toBe('codex');
  });

  it('does NOT match codex for partial matches (e.g. "codex-cli") and throws', () => {
    expect(() => resolvePromptProvider({ CLAUDE_CMD: 'codex-cli' }))
      .toThrow('No AI provider configured');
  });

  it('throws when nothing is set', () => {
    expect(() => resolvePromptProvider({})).toThrow('No AI provider configured');
  });

  it('uses openrouter when EPAM_ORCHESTRATION_PROVIDER=openrouter and no AI_PROVIDER', () => {
    expect(resolvePromptProvider({ EPAM_ORCHESTRATION_PROVIDER: 'openrouter', CLAUDE_CMD: 'claude' }))
      .toBe('openrouter');
  });
});

// ─── resolvePromptExec ───────────────────────────────────────────────────────

describe('resolvePromptExec', () => {
  it('includes --provider arg', () => {
    const exec = resolvePromptExec('/path/ai-run.sh', { AI_PROVIDER: 'openrouter' });
    expect(exec.args).toContain('--provider');
    expect(exec.args).toContain('openrouter');
  });

  it('includes --model arg when AI_MODEL is set', () => {
    const exec = resolvePromptExec('/path/ai-run.sh', {
      AI_PROVIDER: 'openrouter',
      AI_MODEL: 'openrouter/model3-coder-30b-a3b-instruct',
    });
    expect(exec.args).toContain('--model');
    expect(exec.args).toContain('openrouter/model3-coder-30b-a3b-instruct');
  });

  it('falls back to ORCH_GATE_MODEL when AI_MODEL not set', () => {
    const exec = resolvePromptExec('/path/ai-run.sh', {
      AI_PROVIDER: 'openrouter',
      ORCH_GATE_MODEL: 'openrouter/model3-coder-flash',
    });
    expect(exec.args).toContain('--model');
    expect(exec.args).toContain('openrouter/model3-coder-flash');
  });

  it('omits --model when neither AI_MODEL nor ORCH_GATE_MODEL is set', () => {
    const exec = resolvePromptExec('/path/ai-run.sh', { AI_PROVIDER: 'openrouter' });
    expect(exec.args).not.toContain('--model');
  });

  it('AI_MODEL takes priority over ORCH_GATE_MODEL', () => {
    const exec = resolvePromptExec('/path/ai-run.sh', {
      AI_PROVIDER: 'openrouter',
      AI_MODEL: 'openrouter/model3-coder-30b-a3b-instruct',
      ORCH_GATE_MODEL: 'openrouter/model3-coder-flash',
    });
    const modelIdx = exec.args.indexOf('--model');
    expect(exec.args[modelIdx + 1]).toBe('openrouter/model3-coder-30b-a3b-instruct');
  });

  it('sets cmd to provided aiRunnerCmd', () => {
    const exec = resolvePromptExec('/custom/path/ai-run.sh', { AI_PROVIDER: 'openrouter' });
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

  // locationHint → technicalNotes.files (live bug, 2026-07-22): the brownfield
  // openspec prompt explicitly asks the model for a CodeGraph/Semble-grounded
  // "locationHint" (the file(s)/function(s) that actually handle the story's
  // behavior), but nothing ever read that field back out of the response —
  // it was requested and silently discarded on every single call. Without it
  // reaching technicalNotes.files, the planning/execution prompts show an
  // empty "Files to Create/Modify" section, so the story agent has to search
  // the codebase itself and often runs out of turn budget before writing
  // anything real. Confirmed live: AMSD-1820 ran dry mid-search and the only
  // file that changed was CodeGraph's own incidental index write.
  describe('locationHint propagation to technicalNotes.files', () => {
    it('extracts file paths from locationHint and writes them into technicalNotes.files', () => {
      const story = baseStory();
      const prd = makePrd([story]);
      const payload = {
        locationHint: [
          { file: 'src/services/apply-report-discounts.service.ts', function: 'applyReportDiscountsService', reason: 'handles discount propagation' },
        ],
      };
      applySpecChanges(story, payload, [], prd, 'phase1', 'run1');
      expect((story as any).technicalNotes.files).toEqual(['src/services/apply-report-discounts.service.ts']);
    });

    it('collects multiple file paths from a multi-entry locationHint, deduplicated', () => {
      const story = baseStory();
      const prd = makePrd([story]);
      const payload = {
        locationHint: [
          { file: 'src/a.ts', function: 'fnA', reason: 'r1' },
          { file: 'src/b.ts', function: 'fnB', reason: 'r2' },
          { file: 'src/a.ts', function: 'fnA2', reason: 'r3' }, // duplicate file, different function
        ],
      };
      applySpecChanges(story, payload, [], prd, 'phase1', 'run1');
      expect((story as any).technicalNotes.files.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('merges into an EXISTING technicalNotes.files rather than clobbering it', () => {
      const story = baseStory();
      (story as any).technicalNotes = { files: ['src/existing.ts'], someOtherField: 'preserved' };
      const prd = makePrd([story]);
      const payload = {
        locationHint: [{ file: 'src/discovered.ts', function: 'fn', reason: 'r' }],
      };
      applySpecChanges(story, payload, [], prd, 'phase1', 'run1');
      expect((story as any).technicalNotes.files.sort()).toEqual(['src/discovered.ts', 'src/existing.ts']);
      expect((story as any).technicalNotes.someOtherField).toBe('preserved');
    });

    it('merges locationHint files on top of a technicalNotes object present in the SAME payload', () => {
      const story = baseStory();
      const prd = makePrd([story]);
      const payload = {
        technicalNotes: { files: ['src/from-technical-notes.ts'] },
        locationHint: [{ file: 'src/from-location-hint.ts', function: 'fn', reason: 'r' }],
      };
      applySpecChanges(story, payload, [], prd, 'phase1', 'run1');
      expect((story as any).technicalNotes.files.sort()).toEqual(['src/from-location-hint.ts', 'src/from-technical-notes.ts']);
    });

    it('is a no-op when locationHint is an empty array (model found nothing relevant)', () => {
      const story = baseStory();
      const prd = makePrd([story]);
      applySpecChanges(story, { locationHint: [] }, [], prd, 'phase1', 'run1');
      expect((story as any).technicalNotes).toBeUndefined();
    });

    it('is a no-op when locationHint is absent entirely (non-brownfield / non-openspec passes)', () => {
      const story = baseStory();
      const prd = makePrd([story]);
      applySpecChanges(story, { acceptanceCriteria: ['ac'] }, [], prd, 'phase1', 'run1');
      expect((story as any).technicalNotes).toBeUndefined();
    });

    it('ignores malformed locationHint entries (missing/non-string file) without crashing', () => {
      const story = baseStory();
      const prd = makePrd([story]);
      const payload = {
        locationHint: [
          { function: 'fnNoFile', reason: 'no file key at all' },
          { file: '', function: 'fnEmptyFile', reason: 'empty string file' },
          { file: 42, function: 'fnNumericFile', reason: 'wrong type' },
          null,
          { file: 'src/valid.ts', function: 'fnValid', reason: 'the only real one' },
        ],
      };
      expect(() => applySpecChanges(story, payload as any, [], prd, 'phase1', 'run1')).not.toThrow();
      expect((story as any).technicalNotes.files).toEqual(['src/valid.ts']);
    });
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
