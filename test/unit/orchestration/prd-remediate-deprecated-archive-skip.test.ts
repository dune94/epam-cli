/**
 * prd-remediate.sh's stale-spec check must not flag DEPRECATED, archived
 * split-collision leftovers as "stale contamination" — they're permanently
 * out of implementationOrder and will never run again.
 *
 * Root cause this fixes (found live, 2026-07-11, tier3-travel-app relaunch):
 * a cross-stage split collision (openspec elaboration + speckit verification
 * both splitting the same parent, see the parent-vanishing fix from
 * 2026-07-06) leaves the REJECTED children archived in stories[] with
 * status="deprecated", completed=false, and their own leftover
 * 'specification' block from the rejected split attempt. This happened to
 * SKY-001 during the scaffold phase — SKY-001-impl/-test/-impl-1/-test-1
 * were all deprecated and removed from implementationOrder.scaffold (which
 * correctly retained only ["SKY-001"]), but the stale-spec check scanned
 * ALL of stories[] unconditionally (no implementationOrder/deprecated
 * filter) and wrongly flagged the 4 dead archive rows as prior-run
 * contamination, hard-aborting the pipeline before the 'core' phase could
 * even start — on an otherwise completely healthy run.
 *
 * Fix: exclude status === 'deprecated' stories from the stale-spec scan.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const PRD_REMEDIATE_SH = join(REPO_ROOT, 'orchestrations/scripts/prd-remediate.sh');
const prdRemediateSrc = readFileSync(PRD_REMEDIATE_SH, 'utf8');

describe('prd-remediate.sh — stale-spec check excludes deprecated archive rows (static)', () => {
  it("the stale-spec python scan filters out status == 'deprecated'", () => {
    const idx = prdRemediateSrc.indexOf('_stale_spec=$(python3');
    expect(idx).toBeGreaterThan(-1);
    const block = prdRemediateSrc.slice(idx, idx + 400);
    expect(block).toMatch(/s\.get\('status'\)\s*!=\s*'deprecated'/);
  });
});

describe('prd-remediate.sh — stale-spec check excludes deprecated archive rows (REAL execution)', () => {
  function buildPrd(dir: string): string {
    const prdPath = join(dir, 'prd.json');
    const prd = {
      implementationOrder: { core: ['SKY-002', 'SKY-003', 'SKY-004'] },
      stories: [
        { id: 'SKY-002', status: 'pending', completed: false, agentRole: 'typescript-engineer',
          acceptanceCriteria: ['AC 1'], technicalNotes: { files: ['src/skyscanner/client.ts'] } },
        { id: 'SKY-003', status: 'pending', completed: false, agentRole: 'typescript-engineer',
          acceptanceCriteria: ['AC 1'], technicalNotes: { files: ['src/cli.ts'] } },
        { id: 'SKY-004', status: 'pending', completed: false, agentRole: 'typescript-engineer',
          acceptanceCriteria: ['AC 1'], technicalNotes: { files: ['src/server.ts'] } },
        // Archived split-collision leftovers -- deprecated, out of
        // implementationOrder entirely, but still carrying a leftover
        // specification block from the rejected split attempt.
        { id: 'SKY-001-impl', status: 'deprecated', completed: false,
          specification: { createdFrom: 'SKY-001' } },
        { id: 'SKY-001-test', status: 'deprecated', completed: false,
          specification: { createdFrom: 'SKY-001' } },
        { id: 'SKY-001-impl-1', status: 'deprecated', completed: false,
          specification: { createdFrom: 'SKY-001' } },
        { id: 'SKY-001-test-1', status: 'deprecated', completed: false,
          specification: { createdFrom: 'SKY-001' } },
      ],
    };
    writeFileSync(prdPath, JSON.stringify(prd, null, 2));
    return prdPath;
  }

  function run(prdPath: string): { exitCode: number; output: string } {
    try {
      const output = execFileSync(
        'bash',
        [PRD_REMEDIATE_SH, '--prd', prdPath, '--phase', 'core'],
        { encoding: 'utf8' },
      );
      return { exitCode: 0, output };
    } catch (e: any) {
      return { exitCode: e.status ?? -1, output: (e.stdout ?? '').toString() + (e.stderr ?? '').toString() };
    }
  }

  it('REPRODUCES the exact live defect on unfixed code: deprecated archive rows with a leftover specification block wrongly abort remediation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-remediate-deprecated-archive-'));
    try {
      const prdPath = buildPrd(dir);
      const { exitCode, output } = run(prdPath);
      // This assertion is expected to PASS on the FIXED code (exit 0) and
      // FAIL on unfixed code (non-zero, "pre-baked 'specification'" message
      // naming the 4 deprecated SKY-001-* rows) -- verified via git stash.
      expect(exitCode).toBe(0);
      expect(output).not.toMatch(/pre-baked 'specification' blocks/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a genuinely PENDING (non-deprecated) story with a leftover specification block still fails the check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-remediate-genuine-non-deprecated-'));
    try {
      const prdPath = buildPrd(dir);
      const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
      // A real prior-run-contamination shape: pending, not deprecated, but
      // already carrying a specification block it shouldn't have yet.
      prd.stories[0].specification = { testCriteria: { facts: ['stale'] } };
      writeFileSync(prdPath, JSON.stringify(prd, null, 2));
      const { exitCode, output } = run(prdPath);
      expect(exitCode).not.toBe(0);
      expect(output).toMatch(/pre-baked 'specification' blocks on base stories/);
      expect(output).toMatch(/SKY-002/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
