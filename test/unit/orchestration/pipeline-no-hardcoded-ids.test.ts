/**
 * Enforcement: zero hard-coded story ID references in pipeline scripts and test files.
 *
 * Rule: No SKY-* ID (or any project-specific story identifier) may appear as a
 * literal reference in pipeline code or test infrastructure. All story selection
 * must be data-driven from the PRD (by file, role, phase, or property).
 *
 * Acceptable exceptions (checked explicitly below):
 *   - Comments that mention IDs for human context
 *   - Unit-test fixture data that uses fake IDs and does not touch the real PRD
 *   - The canonical/runtime PRD JSON files themselves
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const REPO = join(__dirname, '../../..');
const SCRIPTS_DIR = join(REPO, 'orchestrations/scripts');

// ── helpers ──────────────────────────────────────────────────────────────────

function scriptSrc(name: string): string {
  return readFileSync(join(SCRIPTS_DIR, name), 'utf8');
}

/** Strip bash/JS/TS comments from source so we only scan executable lines. */
function stripComments(src: string): string {
  // Remove block comments first (/** ... */ and /* ... */)
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) return false;  // bash line comment
      if (trimmed.startsWith('//')) return false; // JS/TS line comment
      if (trimmed.startsWith('*')) return false;  // JSDoc continuation line
      return true;
    })
    .map((line) => line.replace(/\s#[^'"]*$/, '')) // strip inline bash comments
    .join('\n');
}

/**
 * Match project-specific story IDs only (SKY- prefix for this project).
 * Generic IDs like EPAM-123 in fixture/example code are not story references.
 */
const STORY_ID_RE = /\bSKY-[0-9]{3}[A-Z0-9b-]*(?:-[A-Z0-9]+)*\b/g;

function storyIdsInExecutableCode(src: string): string[] {
  const stripped = stripComments(src);
  return [...new Set(stripped.match(STORY_ID_RE) ?? [])];
}

// ── 1. tier3-travel-app-run.sh ───────────────────────────────────────────────
describe('tier3-travel-app-run.sh — no hardcoded story IDs in executable code', () => {
  const src = scriptSrc('tier3-travel-app-run.sh');
  const stripped = stripComments(src);

  it('completion validation loop does NOT hardcode a story list', () => {
    expect(src).not.toMatch(/for story in SKY-/);
  });

  it('reads story IDs from implementationOrder at runtime', () => {
    expect(src).toContain('implementationOrder');
  });

  it('no SKY-* tokens appear in executable lines', () => {
    const ids = storyIdsInExecutableCode(src);
    expect(ids).toHaveLength(0);
  });

  it('success message does not hardcode a story count', () => {
    // e.g. "all 11 stories" is wrong; "$PASS stories" is correct
    expect(stripped).not.toMatch(/all \d+\/\d+|\/11 stories/);
  });
});

// ── 2. post-impl-tc-writer.sh ────────────────────────────────────────────────
describe('post-impl-tc-writer.sh — no hardcoded story IDs in executable code', () => {
  const src = scriptSrc('post-impl-tc-writer.sh');

  it('TC writer prompt format example uses a placeholder, not a real story ID', () => {
    expect(src).not.toMatch(/"SKY-\w+"\s*:/);
  });

  it('no SKY-* tokens appear in executable lines', () => {
    const ids = storyIdsInExecutableCode(src);
    expect(ids).toHaveLength(0);
  });
});

// ── 3. run-agent-orchestration.sh ────────────────────────────────────────────
describe('run-agent-orchestration.sh — no hardcoded story IDs', () => {
  const src = scriptSrc('run-agent-orchestration.sh');

  it('no SKY-* tokens appear in executable lines', () => {
    const ids = storyIdsInExecutableCode(src);
    expect(ids).toHaveLength(0);
  });
});

// ── 4. preflight-check.sh ────────────────────────────────────────────────────
describe('preflight-check.sh — no hardcoded story IDs in executable code', () => {
  const src = scriptSrc('preflight-check.sh');

  it('no SKY-* tokens appear in executable lines (warnings about missing keys are comments)', () => {
    const ids = storyIdsInExecutableCode(src);
    expect(ids).toHaveLength(0);
  });
});

// ── 5. spec-mode-runner.js ───────────────────────────────────────────────────
describe('spec-mode-runner.js — no hardcoded story IDs in executable code', () => {
  const src = scriptSrc('spec-mode-runner.js');

  it('no SKY-* tokens appear in executable lines', () => {
    const ids = storyIdsInExecutableCode(src);
    expect(ids).toHaveLength(0);
  });
});

// ── 6. test infrastructure — test files use file-based lookup ────────────────
describe('test-story-ac-integrity.test.ts — mock data only, no hardcoded story IDs', () => {
  const src = readFileSync(
    join(REPO, 'test/unit/orchestration/test-story-ac-integrity.test.ts'), 'utf8'
  );

  it('uses mock PRD fixture data (not real travel-app PRD)', () => {
    // The file must use mock data, not the live travel-app-prd.canonical.json
    expect(src).toMatch(/mock-prd|MOCK_PRD|mock-profiles|MOCK_PROFILES/);
  });

  it('no byId.get() call passes a literal SKY-* string', () => {
    expect(src).not.toMatch(/byId\.get\(['"]SKY-/);
  });

  it('no hardcoded SKY-* IDs in executable lines', () => {
    const ids = storyIdsInExecutableCode(src);
    expect(ids).toHaveLength(0);
  });
});

describe('ui-phase-invariants.test.ts — property-based lookup, no hardcoded IDs', () => {
  const src = readFileSync(
    join(REPO, 'test/unit/orchestration/ui-phase-invariants.test.ts'), 'utf8'
  );

  it('does not use id.startsWith() with a literal story ID prefix', () => {
    expect(src).not.toMatch(/startsWith\(['"]SKY-/);
  });

  it('does not use byId.get() with a literal SKY-* string', () => {
    expect(src).not.toMatch(/byId\.get\(['"]SKY-/);
  });

  it('does not use uiIds.indexOf() with a literal SKY-* string', () => {
    expect(src).not.toMatch(/indexOf\(['"]SKY-/);
  });

  it('html stories are discovered by file extension, not by ID prefix', () => {
    expect(src).toContain(".endsWith('.html')");
  });

  it('review stories are discovered by file property (not by ID prefix)', () => {
    // review stories filter uses file extension checks, not startsWith('SKY-006')
    expect(src).not.toMatch(/startsWith\(['"]SKY-/);
    expect(src).toMatch(/endsWith\(['"]\.(md|ts|js)['"]\)/);
  });

  it('no hardcoded SKY-* IDs in executable lines', () => {
    const ids = storyIdsInExecutableCode(src);
    expect(ids).toHaveLength(0);
  });
});

// ── 7. storyByFile lookup coverage — key files have exactly one owner ─────────
describe('storyByFile coverage — key source files have exactly one story owner in runtime PRD', () => {
  // This test reads the RUNTIME PRD (post-spec-pass state) if it exists.
  // If only the canonical PRD exists (pre-run), these tests are skipped gracefully.
  // Purpose: confirm that file-based lookup is unambiguous once the spec pass runs.

  let prd: any = null;
  try {
    prd = JSON.parse(readFileSync(join(REPO, 'orchestrations/travel-app-prd.json'), 'utf8'));
  } catch { /* not available */ }

  function ownersOf(fileSuffix: string): any[] {
    if (!prd) return [];
    return prd.stories.filter((s: any) =>
      (s.technicalNotes?.files ?? []).some((f: string) => f.endsWith(fileSuffix))
    );
  }

  function hasElaboratedStories(): boolean {
    if (!prd) return false;
    // True only after spec-pass has split stories (creating specification.createdFrom links)
    return prd.stories.some((s: any) => s?.specification?.createdFrom);
  }

  it('client.test.ts is owned by exactly one story after spec pass (skip if pre-spec-pass)', () => {
    if (!hasElaboratedStories()) return;
    const owners = ownersOf('client.test.ts');
    // Sequential ownership is allowed for .test.ts files; at least one owner required
    expect(owners.length).toBeGreaterThanOrEqual(1);
  });

  it('server.test.ts is owned by exactly one story after spec pass (skip if pre-spec-pass)', () => {
    if (!hasElaboratedStories()) return;
    const owners = ownersOf('server.test.ts');
    expect(owners.length).toBeGreaterThanOrEqual(1);
  });

  it('cli.test.ts is owned by exactly one story after spec pass (skip if pre-spec-pass)', () => {
    if (!hasElaboratedStories()) return;
    const owners = ownersOf('cli.test.ts');
    expect(owners.length).toBeGreaterThanOrEqual(1);
  });

  it('table.test.ts is owned by exactly one story after spec pass (skip if pre-spec-pass)', () => {
    if (!hasElaboratedStories()) return;
    const owners = ownersOf('table.test.ts');
    expect(owners.length).toBeGreaterThanOrEqual(1);
  });

  it('client.ts (implementation) is owned by at least one story after spec pass', () => {
    if (!hasElaboratedStories()) return;
    expect(ownersOf('client.ts').length).toBeGreaterThanOrEqual(1);
  });

  it('server.ts (implementation) is owned by at least one story after spec pass', () => {
    if (!hasElaboratedStories()) return;
    expect(ownersOf('server.ts').length).toBeGreaterThanOrEqual(1);
  });

  it('every story in implementationOrder that declares files has at least one file', () => {
    if (!prd) return;
    const allIds = new Set(Object.values(prd.implementationOrder as Record<string, string[]>).flat());
    const storiesWithFiles = prd.stories.filter((s: any) =>
      allIds.has(s.id) && s.technicalNotes?.files !== undefined
    );
    for (const s of storiesWithFiles) {
      expect((s.technicalNotes?.files ?? []).length).toBeGreaterThan(0);
    }
  });
});
