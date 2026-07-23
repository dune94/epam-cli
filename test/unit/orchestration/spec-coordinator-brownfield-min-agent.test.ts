/**
 * buildAssignments() brownfield minimum-agent guarantee — REAL execution of
 * the actual, unmodified exported function from spec-mode-runner.js.
 *
 * Built 2026-07-23 after mock1 showed the spec coordinator legitimately
 * returning agents:[] for a story with clear, complete ACs ("Trivial string
 * change... Ready for direct implementation"). That's a reasonable call on
 * elaboration/hardening — but the brownfield archaeology block (locationHint
 * discovery, which is what populates technicalNotes.files) only exists
 * inside the openspec/speckit per-agent prompt. agents:[] meant it never ran
 * for ANY well-formed story, brownfield or not — so implementation proceeded
 * with zero file/location grounding. Fix: in brownfield mode (EPAM_BROWNFIELD=1),
 * buildAssignments() now forces at least one agent (speckit) when the
 * coordinator returns an empty list, so archaeology always gets a chance to
 * run regardless of AC quality.
 */
import { describe, it, expect, afterEach } from 'vitest';

const specModeRunner = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { buildAssignments } = specModeRunner;

const ORIGINAL_BROWNFIELD = process.env.EPAM_BROWNFIELD;
afterEach(() => {
  if (ORIGINAL_BROWNFIELD === undefined) delete process.env.EPAM_BROWNFIELD;
  else process.env.EPAM_BROWNFIELD = ORIGINAL_BROWNFIELD;
});

const STORIES = [{ id: 'MOCK-HW-1' }];

describe('buildAssignments — brownfield minimum-agent guarantee', () => {
  it('forces speckit when the coordinator returns agents:[] in brownfield mode', () => {
    process.env.EPAM_BROWNFIELD = '1';
    const assignments = [{ storyId: 'MOCK-HW-1', agents: [], notes: 'Trivial change, no elaboration needed.' }];
    const map = buildAssignments(assignments, STORIES, 'run1');
    expect(map.get('MOCK-HW-1').agents).toEqual(['speckit']);
  });

  it('does NOT force an agent in greenfield mode (EPAM_BROWNFIELD unset) — preserves existing behavior', () => {
    delete process.env.EPAM_BROWNFIELD;
    const assignments = [{ storyId: 'MOCK-HW-1', agents: [], notes: 'Trivial change, no elaboration needed.' }];
    const map = buildAssignments(assignments, STORIES, 'run1');
    expect(map.get('MOCK-HW-1').agents).toEqual([]);
  });

  it('does NOT override a real, non-empty coordinator decision in brownfield mode', () => {
    process.env.EPAM_BROWNFIELD = '1';
    const assignments = [{ storyId: 'MOCK-HW-1', agents: ['openspec'], notes: 'Needs elaboration.' }];
    const map = buildAssignments(assignments, STORIES, 'run1');
    expect(map.get('MOCK-HW-1').agents).toEqual(['openspec']);
  });

  it('preserves the both-agents case unchanged in brownfield mode', () => {
    process.env.EPAM_BROWNFIELD = '1';
    const assignments = [{ storyId: 'MOCK-HW-1', agents: ['openspec', 'speckit'], notes: 'Complex.' }];
    const map = buildAssignments(assignments, STORIES, 'run1');
    expect(map.get('MOCK-HW-1').agents).toEqual(['openspec', 'speckit']);
  });

  it('still falls back to both agents when the coordinator omits a story entirely (unrelated to this fix)', () => {
    process.env.EPAM_BROWNFIELD = '1';
    const map = buildAssignments([], STORIES, 'run1');
    expect(map.get('MOCK-HW-1').agents).toEqual(['openspec', 'speckit']);
  });

  it('is deterministic across repeated calls', () => {
    process.env.EPAM_BROWNFIELD = '1';
    const assignments = [{ storyId: 'MOCK-HW-1', agents: [], notes: '' }];
    for (let i = 0; i < 5; i++) {
      const map = buildAssignments(assignments, STORIES, 'run1');
      expect(map.get('MOCK-HW-1').agents).toEqual(['speckit']);
    }
  });
});
