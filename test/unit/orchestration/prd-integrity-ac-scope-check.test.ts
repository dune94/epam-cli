/**
 * preflight-prd-integrity.sh check #19 — no AC may claim a file exists
 * outside the story's own declared scope.
 *
 * Root cause this catches (found live, 2026-07-09, tier3-travel-app run):
 * the existing check #16 only matches "from './x'" IMPORT syntax in AC
 * text — it missed a spec-pass elaboration that wrote a NATURAL-LANGUAGE AC
 * on SKY-001 ("/…/skyscanner-app/src/server.ts file exists and is a valid
 * TypeScript file") referencing server.ts, a file that belongs to a
 * DIFFERENT story (SKY-004) and was never in SKY-001's own
 * technicalNotes.files. The implementation (correctly scope-guarded) never
 * created server.ts, so the AC went permanently unmet and the
 * spec-validator testing gate failed the whole phase — with nothing
 * indicating the root cause was an elaboration defect, not an
 * implementation gap.
 *
 * A prior, broader version of this check also flagged a LEGITIMATE pattern
 * as a false positive: an AC on SKY-004 read "...imported from the SKY-002
 * type export (e.g. src/skyscanner/client.ts) and not redeclared inline" —
 * a cross-story import-consistency reference, not a claim that SKY-004 must
 * create client.ts itself. The check only fires on an EXISTENCE claim
 * ("<path> exists" / "<path> file exists"), not any mention of a path.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/preflight-prd-integrity.sh');
const outputDir = '/tmp/prd-integrity-ac-scope-fixture-app';

function baseFixture(): any {
  return {
    project: { outputDir },
    stories: [
      {
        id: 'SKY-001',
        status: 'pending',
        completed: false,
        effort: 'medium',
        aiProvider: 'qwen',
        model: 'moonshotai/kimi-k2',
        acceptanceCriteria: [`${outputDir}/package.json exists`],
        technicalNotes: { files: [`${outputDir}/package.json`] },
      },
      {
        id: 'SKY-004',
        status: 'pending',
        completed: false,
        effort: 'medium',
        aiProvider: 'qwen',
        model: 'moonshotai/kimi-k2',
        acceptanceCriteria: [`${outputDir}/src/server.ts exists`],
        technicalNotes: { files: [`${outputDir}/src/server.ts`] },
      },
    ],
    implementationOrder: { scaffold: ['SKY-001'], core: ['SKY-004'] },
  };
}

function runPreflight(prd: any): { code: number; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prd-integrity-ac-scope-'));
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

describe('preflight-prd-integrity.sh — check #19, REAL execution', () => {
  it('passes on a clean fixture where every AC only claims files in its own story scope', () => {
    const result = runPreflight(baseFixture());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No AC references a file path outside its own story's declared scope");
  });

  it('REPRODUCES the exact live bug: an AC claims a file exists that belongs to a different story', () => {
    const prd = baseFixture();
    // SKY-001 (scope: package.json only) gets an AC claiming server.ts
    // exists — server.ts is SKY-004's file, not SKY-001's.
    prd.stories[0].acceptanceCriteria.push(`${outputDir}/src/server.ts file exists and is a valid TypeScript file`);

    const result = runPreflight(prd);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/SKY-001: AC references 'src\/server\.ts'/);
  });

  it('does NOT flag a legitimate cross-story reference used for import-consistency, not an existence claim', () => {
    const prd = baseFixture();
    // Mirrors the real false positive found live: SKY-004 legitimately
    // mentions SKY-002's file for type-consistency, without claiming
    // ownership or that SKY-004 must create it.
    prd.stories.push({
      id: 'SKY-002',
      status: 'pending',
      completed: false,
      effort: 'medium',
      aiProvider: 'qwen',
      model: 'moonshotai/kimi-k2',
      acceptanceCriteria: [`${outputDir}/src/skyscanner/client.ts exists`],
      technicalNotes: { files: [`${outputDir}/src/skyscanner/client.ts`] },
    });
    prd.stories[1].acceptanceCriteria.push(
      'The FlightResult type used in src/server.ts is imported from the SKY-002 type export (e.g. src/skyscanner/client.ts) and not redeclared inline'
    );
    prd.implementationOrder.core.push('SKY-002');

    const result = runPreflight(prd);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/references file paths outside/);
  });

  it('does NOT flag a file the story owns itself, even with "exists" phrasing', () => {
    const prd = baseFixture();
    // SKY-004 already owns server.ts — asserting it exists is fine.
    const result = runPreflight(prd);
    expect(result.code).toBe(0);
  });
});
