/**
 * Unit tests for orchestrations/scripts/lib/topology-router.js
 *
 * Covers heuristicTopology — the fallback used when no Anthropic key is
 * available (which is our case with OpenRouter/Qwen).
 *
 * Rules under test:
 *   - 0 or 1 worktree stories → single
 *   - 2–4 worktree stories   → parallel
 *   - 5+ worktree stories    → sequential
 *   - review-agent and qa-engineer roles are excluded from the worktree count
 */
import { createRequire } from 'module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { heuristicTopology } = require(
  '../../../orchestrations/scripts/lib/topology-router.js'
);

// ── helpers ────────────────────────────────────────────────────────────────

const story = (id: string, agentRole = 'typescript-engineer') => ({ id, agentRole });
const review = (id: string) => story(id, 'review-agent');
const qa     = (id: string) => story(id, 'qa-engineer');

// ── topology selection ──────────────────────────────────────────────────────

describe('heuristicTopology', () => {
  it('returns single for empty stories array', () => {
    const result = heuristicTopology([]);
    expect(result.topology).toBe('single');
    expect(result.source).toBe('heuristic');
  });

  it('returns single for 1 worktree story', () => {
    const result = heuristicTopology([story('S-1')]);
    expect(result.topology).toBe('single');
  });

  it('returns parallel for 2 worktree stories', () => {
    const result = heuristicTopology([story('S-1'), story('S-2')]);
    expect(result.topology).toBe('parallel');
  });

  it('returns parallel for 3 worktree stories', () => {
    const result = heuristicTopology([story('S-1'), story('S-2'), story('S-3')]);
    expect(result.topology).toBe('parallel');
  });

  it('returns parallel for 4 worktree stories (boundary)', () => {
    const result = heuristicTopology([story('S-1'), story('S-2'), story('S-3'), story('S-4')]);
    expect(result.topology).toBe('parallel');
  });

  it('returns sequential for 5 worktree stories', () => {
    const stories = Array.from({ length: 5 }, (_, i) => story(`S-${i + 1}`));
    const result = heuristicTopology(stories);
    expect(result.topology).toBe('sequential');
  });

  it('returns sequential for 10 worktree stories', () => {
    const stories = Array.from({ length: 10 }, (_, i) => story(`S-${i + 1}`));
    const result = heuristicTopology(stories);
    expect(result.topology).toBe('sequential');
  });

  // ── role filtering ───────────────────────────────────────────────────────

  it('excludes review-agent from worktree count', () => {
    // 1 impl story + 1 review-agent = 1 worktree story → single
    const result = heuristicTopology([story('S-1'), review('R-1')]);
    expect(result.topology).toBe('single');
  });

  it('excludes qa-engineer from worktree count', () => {
    // 1 impl story + 1 qa-engineer = 1 worktree story → single
    const result = heuristicTopology([story('S-1'), qa('Q-1')]);
    expect(result.topology).toBe('single');
  });

  it('counts only non-excluded roles for threshold', () => {
    // 2 impl stories + 3 review/qa = 2 worktree → parallel
    const result = heuristicTopology([
      story('S-1'), story('S-2'),
      review('R-1'), review('R-2'), qa('Q-1'),
    ]);
    expect(result.topology).toBe('parallel');
  });

  it('returns single when all stories are review-agent', () => {
    const result = heuristicTopology([review('R-1'), review('R-2'), review('R-3')]);
    expect(result.topology).toBe('single');
  });

  it('returns single when all stories are qa-engineer', () => {
    const result = heuristicTopology([qa('Q-1'), qa('Q-2'), qa('Q-3'), qa('Q-4'), qa('Q-5')]);
    expect(result.topology).toBe('single');
  });

  // ── hello-world realistic scenario ───────────────────────────────────────

  it('routes hello-world 6 stories correctly (3 impl + 1 review + 2 qa = 3 worktree → parallel)', () => {
    const stories = [
      story('HW-001', 'typescript-engineer'),
      story('HW-004', 'typescript-engineer'),
      story('HW-005', 'typescript-engineer'),
      review('HW-003'),
      qa('HW-002'),
      qa('HW-006'),
    ];
    const result = heuristicTopology(stories);
    expect(result.topology).toBe('parallel');
  });

  // ── result shape ──────────────────────────────────────────────────────────

  it('always includes topology, reason, and source fields', () => {
    const result = heuristicTopology([story('S-1')]);
    expect(result).toHaveProperty('topology');
    expect(result).toHaveProperty('reason');
    expect(result).toHaveProperty('source', 'heuristic');
  });

  it('reason string mentions the story count for parallel', () => {
    const result = heuristicTopology([story('S-1'), story('S-2'), story('S-3')]);
    expect(result.reason).toContain('3');
  });
});
