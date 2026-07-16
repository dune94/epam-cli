/**
 * Speckit no longer has independent split authority (2026-07-13, user
 * request, following a live collision).
 *
 * Root cause: speckit's prompt used to say "MANDATORY split conditions —
 * your independent obligation, do not defer to openspec" — a safety net for
 * the case where openspec fails to split a story that needed it. But
 * checkSplitMandateViolation() already covers that exact case
 * deterministically (a code-level AC-count check that forces OPENSPEC
 * itself to retry, not an LLM's "independent obligation"). Speckit's
 * redundant authority caused two independently-split, competing child sets
 * for the SAME parent (different IDs, same files) to be produced in the
 * same spec-pass turn — the same-file coherence checker correctly rejected
 * BOTH, and the story fell back to running unsplit and oversized. This hit
 * SKY-002 (2026-07-10) and SKY-003 (2026-07-13) live.
 *
 * Fix: openspec is now the sole split authority. Speckit's prompt no longer
 * grants it independent split judgment, and — since a prompt instruction is
 * not enforcement — a deterministic, code-level check unconditionally drops
 * any splitStories speckit still emits, regardless of whether openspec
 * already split the parent or not.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const SPEC_RUNNER = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');
const src = readFileSync(SPEC_RUNNER, 'utf8');

// Anchor-based extraction (start of this function to start of the NEXT
// top-level function), not brace-counting -- runSpeckitReview's prompt
// template contains embedded `${JSON.stringify({...}, null, 2)}` object
// literals whose own closing `}` sits at column 0, identical in shape to a
// naive `indexOf('\n}')` search's target and truncating extraction mid-body
// (the same class of issue this session hit repeatedly with bash heredocs).
function extractFunctionBody(name: string): string {
  const defRe = new RegExp(`^async function ${name}\\(`, 'm');
  const defMatch = defRe.exec(src);
  if (!defMatch) throw new Error(`No function definition found for ${name}()`);
  const start = defMatch.index;
  const nextFnMatch = /^(async )?function \w+\(/m.exec(src.slice(start + 10));
  const end = nextFnMatch ? start + 10 + nextFnMatch.index : src.length;
  return src.slice(start, end);
}

describe('speckit prompt — no independent split authority (static)', () => {
  const fnBody = extractFunctionBody('runSpeckitReview');

  it('no longer contains the old "MANDATORY split conditions / independent obligation" language', () => {
    expect(fnBody).not.toMatch(/MANDATORY split conditions/);
    expect(fnBody).not.toMatch(/independent obligation/);
    expect(fnBody).not.toMatch(/you MUST propose them yourself/);
  });

  it('explicitly states splitting is openspec\'s decision alone', () => {
    expect(fnBody).toMatch(/[Ss]plitting is openspec's decision alone/);
  });

  it('instructs speckit to always omit splitStories in its own output schema', () => {
    const schemaIdx = fnBody.indexOf('Produce your refined output');
    const schemaBlock = fnBody.slice(schemaIdx, schemaIdx + 800);
    expect(schemaBlock).toMatch(/"splitStories":\s*ALWAYS omit/);
  });

  it('the deterministic HARD LIMITS section (openspec-only concerns: depth/budget/coherence) is gone from speckit\'s own prompt', () => {
    // These are still enforced in code for openspec's splits (applySpecChanges) —
    // this only checks they're no longer PROSE INSTRUCTIONS in speckit's prompt,
    // since speckit no longer needs them (it never emits splitStories at all).
    expect(fnBody).not.toMatch(/Each split child MUST have ≤24 ACs/);
    expect(fnBody).not.toMatch(/Each parent may have at most 4 split children/);
  });
});

describe('per-story loop — deterministic guard drops any splitStories speckit emits (static)', () => {
  const guardIdx = src.indexOf("agent === 'speckit' && Array.isArray(payload.splitStories)");

  it('the guard exists', () => {
    expect(guardIdx).toBeGreaterThan(-1);
  });

  it('the guard is unconditional — not gated on whether openspec already split this parent', () => {
    const guardBlock = src.slice(guardIdx, guardIdx + 400);
    expect(guardBlock).toMatch(/delete payload\.splitStories/);
    // Must NOT reintroduce a conditional check like "newStories.some(...parentId === story.id)"
    // gating the delete -- the fix is deliberately unconditional (speckit never splits, period).
    expect(guardBlock).not.toMatch(/alreadySplitByOpenspec/);
  });

  it('the guard runs BEFORE applySpecChanges is called, so a dropped splitStories can never reach it', () => {
    const applyIdx = src.indexOf('let changes = applySpecChanges(story, payload, newStories, prd, opts.phase, runId, logDir);');
    expect(applyIdx).toBeGreaterThan(guardIdx);
  });

  it('checkSplitMandateViolation\'s forced-retry (the real backstop) is untouched and still targets openspec only', () => {
    const mandateIdx = src.indexOf('let mandateCheck = checkSplitMandateViolation');
    expect(mandateIdx).toBeGreaterThan(-1);
    const mandateBlock = src.slice(mandateIdx, mandateIdx + 1100);
    expect(mandateBlock).toMatch(/agent:\s*'openspec'/);
  });
});

describe('per-story loop — REAL execution: the deterministic guard actually strips speckit\'s splitStories', () => {
  // Reproduces the exact live collision shape: openspec already created
  // SKY-003-impl/SKY-003-test (present in newStories), then speckit's own
  // agentResult carries a COMPETING splitStories proposal with different IDs
  // (SKY-003-impl-1/SKY-003-test-1, matching the exact live incident).
  function extractGuardSnippet(): string {
    const startMarker = "if (agent === 'speckit' && Array.isArray(payload.splitStories) && payload.splitStories.length) {";
    const startIdx = src.indexOf(startMarker);
    const endIdx = src.indexOf('\n      }', startIdx) + '\n      }'.length;
    return src.slice(startIdx, endIdx);
  }

  function runGuard(agent: string, splitStories: any[] | undefined): { payload: any; warned: boolean } {
    const payload: any = { acceptanceCriteria: ['a'], notes: '' };
    if (splitStories !== undefined) payload.splitStories = splitStories;

    const warnings: string[] = [];
    // eslint-disable-next-line no-new-func
    const fn = new Function(
      'agent', 'payload', 'newStories', 'story', 'console',
      `${extractGuardSnippet()}\nreturn payload;`,
    );
    const newStories = [
      { parentId: 'SKY-003', story: { id: 'SKY-003-impl' } },
      { parentId: 'SKY-003', story: { id: 'SKY-003-test' } },
    ];
    const story = { id: 'SKY-003' };
    const stubConsole = { warn: (...a: any[]) => warnings.push(a.join(' ')) };
    fn(agent, payload, newStories, story, stubConsole);
    return { payload, warned: warnings.length > 0 };
  }

  it('REPRODUCES the exact live collision and proves the fix: speckit\'s competing splitStories (different IDs than openspec\'s already-created children) get dropped', () => {
    const { payload, warned } = runGuard('speckit', [
      { id: 'SKY-003-impl-1', acceptanceCriteria: ['x'] },
      { id: 'SKY-003-test-1', acceptanceCriteria: ['y'] },
    ]);
    expect(payload.splitStories).toBeUndefined();
    expect(warned).toBe(true);
  });

  it('also drops speckit\'s splitStories even when openspec has NOT split anything yet (unconditional rule)', () => {
    const { payload } = runGuard('speckit', [{ id: 'SKY-999-impl', acceptanceCriteria: ['z'] }]);
    expect(payload.splitStories).toBeUndefined();
  });

  it('does NOT touch openspec\'s own splitStories', () => {
    const { payload, warned } = runGuard('openspec', [{ id: 'SKY-003-impl', acceptanceCriteria: ['x'] }]);
    expect(payload.splitStories).toEqual([{ id: 'SKY-003-impl', acceptanceCriteria: ['x'] }]);
    expect(warned).toBe(false);
  });

  it('is a no-op when speckit emits no splitStories at all (the now-expected, common case)', () => {
    const { payload, warned } = runGuard('speckit', undefined);
    expect(payload.splitStories).toBeUndefined();
    expect(warned).toBe(false);
  });
});
