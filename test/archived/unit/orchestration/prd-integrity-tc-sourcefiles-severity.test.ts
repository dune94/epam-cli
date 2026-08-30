/**
 * preflight-prd-integrity.sh check #18 — testCriteria.sourceFiles referencing
 * a file that doesn't exist ANYWHERE in the project's declared scope is now
 * a HARD FAILURE, not a warning.
 *
 * Root cause this upgrades (2026-07-09, full pipeline audit following the
 * check #19 fix): unlike check #16 (AC import paths — a "from './x'" mention
 * is often a legitimate cross-story reference, since importing a file you
 * don't own is completely normal), check #18 compares against the UNION of
 * every story's own declared files. A sourceFile matching NOTHING anywhere
 * in the whole project's declared scope is not a normal cross-reference —
 * it's either a hallucinated file the TC writer never actually read, or a
 * stale reference surviving a rename/split. Both silently corrupt test
 * generation (a test written against facts "verified" from a file that was
 * never actually read) if only warned about, not blocked.
 *
 * check #16 is intentionally left as warn() — see
 * prd-integrity-ac-scope-check.test.ts for why a similar-looking upgrade
 * there would reintroduce false positives on legitimate cross-story imports.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/preflight-prd-integrity.sh');
const outputDir = '/tmp/prd-integrity-tc-sourcefiles-fixture-app';

function baseFixture(): any {
  return {
    project: { outputDir },
    stories: [
      {
        id: 'SKY-002-impl',
        status: 'pending',
        completed: false,
        effort: 'medium',
        aiProvider: 'openrouter',
        model: 'moonshotai/kimi-k2',
        acceptanceCriteria: ['a'],
        technicalNotes: { files: [`${outputDir}/src/skyscanner/client.ts`] },
      },
      {
        id: 'SKY-002-test',
        status: 'pending',
        completed: false,
        effort: 'medium',
        aiProvider: 'openrouter',
        model: 'moonshotai/kimi-k2',
        acceptanceCriteria: ['a'],
        technicalNotes: { files: [`${outputDir}/src/skyscanner/client.test.ts`] },
        testCriteria: {
          sourceFiles: [`${outputDir}/src/skyscanner/client.ts`],
          facts: ['fact'],
          mockStrategy: 'none',
          bannedPatterns: [],
        },
      },
    ],
    implementationOrder: { scaffold: [], core: ['SKY-002-impl', 'SKY-002-test'] },
  };
}

function runPreflight(prd: any): { code: number; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prd-integrity-tc-sourcefiles-'));
  const prdPath = join(dir, 'prd.json');
  writeFileSync(prdPath, JSON.stringify(prd));
  try {
    const stdout = execFileSync('bash', [SCRIPT, '--prd', prdPath], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: (e.stdout ?? '').toString() + (e.stderr ?? '').toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('preflight-prd-integrity.sh — check #18 severity upgrade (static)', () => {
  const src = readFileSync(SCRIPT, 'utf8');

  it('check #18 hard-fails (err), not just warns', () => {
    const idx = src.indexOf('# ── 18. testCriteria.sourceFiles');
    const block = src.slice(idx, idx + 1400);
    expect(block).toMatch(/err\(f"testCriteria\.sourceFiles reference files not declared/);
    expect(block).not.toMatch(/warn\(f"testCriteria\.sourceFiles reference files not declared/);
  });

  it('check #16 (AC import paths) deliberately remains a warn(), not upgraded', () => {
    const idx = src.indexOf('# ── 16. No AC prescribes an import path');
    const block = src.slice(idx, idx + 1400);
    expect(block).toMatch(/warn\(f"ACs reference import paths/);
  });
});

describe('preflight-prd-integrity.sh — check #18, REAL execution', () => {
  it('passes on a clean fixture where sourceFiles reference a real, declared file', () => {
    const result = runPreflight(baseFixture());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('All testCriteria.sourceFiles align with known story files');
  });

  it('REPRODUCES the defect and confirms it now hard-fails: sourceFiles references a file that exists nowhere in the project', () => {
    const prd = baseFixture();
    prd.stories[1].testCriteria.sourceFiles.push(`${outputDir}/src/hallucinated-file-that-was-never-read.ts`);

    const result = runPreflight(prd);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/testCriteria\.sourceFiles reference files not declared in any story/);
    expect(result.stdout).toMatch(/hallucinated-file-that-was-never-read\.ts/);
  });

  it('does NOT flag a sourceFile owned by a DIFFERENT story (legitimate cross-story TC grounding)', () => {
    const prd = baseFixture();
    // SKY-002-test's TC legitimately cites a peer/dependency's file it read
    // to verify a fact, not just its own paired impl story.
    prd.stories.push({
      id: 'SKY-003-impl',
      status: 'pending',
      completed: false,
      effort: 'medium',
      aiProvider: 'openrouter',
      model: 'moonshotai/kimi-k2',
      acceptanceCriteria: ['a'],
      technicalNotes: { files: [`${outputDir}/src/cli.ts`] },
    });
    prd.implementationOrder.core.push('SKY-003-impl');
    prd.stories[1].testCriteria.sourceFiles.push(`${outputDir}/src/cli.ts`);

    const result = runPreflight(prd);
    expect(result.code).toBe(0);
  });
});
