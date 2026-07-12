/**
 * The Step 1 INLINE TC-writer gate (run-agent-orchestration.sh, runs right
 * before a story starts, inside the main-branch sequential loop) must NOT
 * treat a combo story (owns BOTH impl and test files, implementing both in
 * one turn) as "needs testCriteria before it starts."
 *
 * Root cause this fixes (found live, 2026-07-10, tier3-travel-app run): the
 * inline gate classified "is this a test story" as "ANY declared file ends
 * in .test.ts" — which also matches a combo/unsplit story (e.g. SKY-002,
 * when spec-pass chose not to split it into -impl/-test children this run)
 * that owns both `client.ts` AND `client.test.ts` itself. The gate assumed a
 * SEPARATE impl story had already run and tried to generate TCs by reading
 * source files that don't exist yet (the combo story hasn't even started) —
 * the TC-writer agent correctly wrote null ("source files not found"), and
 * the inline gate hard-aborted the ENTIRE pipeline with "Inline TC writer
 * gate FAILED for SKY-002 — cannot proceed."
 *
 * Fix scope (deliberately narrow — see below for what was NOT changed): only
 * the INLINE gate's "is this a pure test story" check now requires ALL
 * declared files to be test files, not just any. Two things are
 * intentionally left unchanged, because they run AFTER a combo story has
 * already completed (by which point its files genuinely exist and TC
 * generation legitimately helps downstream QA gates):
 *   - The Step 1.6 POST-LOOP gate (runs after every Step 1 story finishes)
 *   - post-impl-tc-writer.sh's own internal is_test_story classification
 *     (a pre-existing fix from 2026-07-02 specifically relies on "any" so a
 *     combo story's IMPL_SOURCE_FILES gets populated correctly once it's
 *     actually invoked post-completion — see tc-writer-impl-source-files.test.ts)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');
const TC_WRITER_SH = join(REPO_ROOT, 'orchestrations/scripts/post-impl-tc-writer.sh');
const tcWriterSrc = readFileSync(TC_WRITER_SH, 'utf8');

describe('TC-writer gating — combo-story scoping (static)', () => {
  it('the Step 1 INLINE gate requires ALL files to be test files, not any', () => {
    const idx = orchSrc.indexOf('_needs_tc=$(jq -r --arg id "$story"');
    const block = orchSrc.slice(idx, idx + 700);
    expect(block).toMatch(/\| map\(endswith\(".test.ts"\)\) \| all\)/);
    expect(block).not.toMatch(/\| map\(endswith\(".test.ts"\)\) \| any\)/);
    expect(block).toMatch(/length > 0/);
  });

  it('the Step 1 INLINE gate also skips deprecated stories (a legitimately-abandoned rejected split child)', () => {
    const idx = orchSrc.indexOf('_needs_tc=$(jq -r --arg id "$story"');
    const block = orchSrc.slice(idx, idx + 700);
    expect(block).toMatch(/select\(\.status != "deprecated"\)/);
  });

  it('the Step 1.6 POST-LOOP gate is deliberately left as "any" — combo stories have already completed by this point', () => {
    const idx = orchSrc.indexOf('_tc_writer_needed=$(jq -r --arg phase "$PHASE"');
    const block = orchSrc.slice(idx, idx + 500);
    expect(block).toMatch(/\| map\(endswith\(".test.ts"\)\) \| any\)/);
    expect(block).not.toMatch(/\| map\(endswith\(".test.ts"\)\) \| all\)/);
  });

  it('post-impl-tc-writer.sh is deliberately left as "any" — its own combo-story fix (2026-07-02) depends on it', () => {
    const matches = [...tcWriterSrc.matchAll(/is_test_story = (.+)/g)];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (const m of matches) {
      expect(m[1]).toBe("any(f.endswith('.test.ts') for f in files)");
    }
  });
});

describe('TC-writer gating — REAL execution: combo story is no longer force-gated by the INLINE (pre-execution) check', () => {
  function extractInlineGateQuery(): string {
    const idx = orchSrc.indexOf('_needs_tc=$(jq -r --arg id "$story"');
    const endIdx = orchSrc.indexOf(')', orchSrc.indexOf("2>/dev/null || echo \"\")", idx));
    return orchSrc.slice(idx, endIdx + 1);
  }

  function checkNeedsTC(storyFiles: string[], facts: unknown[] = [], status = 'pending'): boolean {
    const dir = mkdtempSync(join(tmpdir(), 'tc-combo-gate-'));
    const prdPath = join(dir, 'prd.json');
    writeFileSync(prdPath, JSON.stringify({
      stories: [{ id: 'SKY-002', status, technicalNotes: { files: storyFiles }, testCriteria: { facts } }],
    }));
    const query = extractInlineGateQuery();
    const script = [
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      `story="SKY-002"`,
      query,
      'echo "RESULT=[$_needs_tc]"',
    ].join('\n');
    try {
      const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
      const m = out.match(/RESULT=\[(.*)\]/);
      rmSync(dir, { recursive: true, force: true });
      return !!(m && m[1].trim());
    } catch (e: any) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  it('REPRODUCES the exact live defect and proves the fix: a combo story (impl + test files together) is NOT gated', () => {
    const needsTC = checkNeedsTC(['src/skyscanner/client.ts', 'src/skyscanner/client.test.ts']);
    expect(needsTC).toBe(false);
  });

  it('a PURE test story (split child, only test files) IS still gated — no regression', () => {
    const needsTC = checkNeedsTC(['src/skyscanner/client.test.ts']);
    expect(needsTC).toBe(true);
  });

  it('a pure test story that already has facts is NOT re-gated', () => {
    const needsTC = checkNeedsTC(['src/skyscanner/client.test.ts'], ['some fact']);
    expect(needsTC).toBe(false);
  });

  it('REPRODUCES a SECOND live defect and proves the fix: a story that became deprecated (rejected split child, no valid replacement) is NOT gated', () => {
    // Root cause this fixes (found live, 2026-07-10, tier3-travel-app run):
    // SKY-004-test/-test-1 both got rejected by the split-gate for a
    // same-file coherence violation (both write server.test.ts) and were
    // marked deprecated with no valid replacement. post-impl-tc-writer.sh
    // already defensively skips deprecated stories, so it correctly
    // no-op'd — but this gate never checked status, so it still expected
    // TCs for a story that was CORRECTLY abandoned, tripping the
    // post-condition check (tc-writer-inline-gate-post-condition.test.ts)
    // on a false alarm and hard-aborting the whole pipeline.
    const needsTC = checkNeedsTC(['src/server.test.ts'], [], 'deprecated');
    expect(needsTC).toBe(false);
  });

  it('a pure impl story (no test files at all) is NOT gated', () => {
    const needsTC = checkNeedsTC(['src/skyscanner/client.ts']);
    expect(needsTC).toBe(false);
  });
});
