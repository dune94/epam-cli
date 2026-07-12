/**
 * run-agent-orchestration.sh — Step 1 inline TC-writer gate post-condition
 * check.
 *
 * Root cause this fixes (found live, 2026-07-09, tier3-travel-app run): the
 * inline TC-writer gate trusted post-impl-tc-writer.sh's EXIT CODE alone.
 * But that script can legitimately exit 0 as a no-op ("No test stories need
 * TCs in phase ... — skipping") when its own internal
 * implementationOrder[phase]-scoped query doesn't (yet) see the target story
 * — e.g. right after a mid-execution split (see
 * tc-writer-target-story-not-in-implementation-order.test.ts for that half
 * of the fix). Exit 0 does not mean testCriteria was actually written.
 *
 * Live symptom: "SUCCESS TC writer populated testCriteria for SKY-003-test"
 * printed immediately after "[tc-writer] No test stories need TCs in phase
 * 'core' — skipping" — the PRD confirms SKY-003-test never actually got a
 * testCriteria field, and it then ran its first coding attempt with zero
 * grounding.
 *
 * Fix: after the exit-code check, re-read testCriteria.facts length for
 * $story from the PRD and hard-fail with a clear diagnostic if still empty,
 * instead of unconditionally printing success.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractInlineGateBlock(): string {
  const startMarker = '_inline_tc_exit=${PIPESTATUS[0]}';
  const startIdx = orchSrc.indexOf(startMarker);
  if (startIdx === -1) throw new Error('Could not find inline TC gate start');
  const endMarker = 'success "  TC writer populated testCriteria for $story"';
  const endIdx = orchSrc.indexOf(endMarker, startIdx);
  if (endIdx === -1) throw new Error('Could not find inline TC gate end');
  return orchSrc.slice(startIdx, endIdx + endMarker.length);
}

describe('run-agent-orchestration.sh — inline TC-writer gate post-condition check (static)', () => {
  const block = extractInlineGateBlock();

  it('re-checks testCriteria.facts length for $story after the exit-code check, before declaring success', () => {
    expect(block).toMatch(/_post_tc_facts_len=/);
    expect(block).toMatch(/\.testCriteria\.facts \/\/ \[\]\) \| length/);
    const factsCheckIdx = block.indexOf('_post_tc_facts_len=');
    const successIdx = block.indexOf('success "  TC writer populated testCriteria for $story"');
    expect(factsCheckIdx).toBeLessThan(successIdx);
  });

  it('hard-fails with a clear diagnostic (not a silent continue) when facts are still empty', () => {
    const idx = block.indexOf('_post_tc_facts_len=');
    const nextBlock = block.slice(idx, idx + 700);
    expect(nextBlock).toMatch(/if \[ "\$\{_post_tc_facts_len:-0\}" -eq 0 \]/);
    expect(nextBlock).toMatch(/error .*still has no testCriteria\.facts/);
    expect(nextBlock).toMatch(/exit 1/);
  });
});

describe('run-agent-orchestration.sh — inline TC-writer gate post-condition, REAL execution', () => {
  function run(factsLength: number): { exitCode: number; stdout: string } {
    const block = extractInlineGateBlock();
    const dir = mkdtempSync(join(tmpdir(), 'tc-gate-postcondition-'));
    const prdPath = join(dir, 'prd.json');
    const facts = Array.from({ length: factsLength }, (_, i) => `fact ${i}`);
    writeFileSync(
      prdPath,
      JSON.stringify({ stories: [{ id: 'SKY-003-test', testCriteria: { facts } }] })
    );
    const script = [
      'error() { echo "ERROR: $*"; }',
      'success() { echo "SUCCESS: $*"; }',
      `PRD_FILE=${JSON.stringify(prdPath)}`,
      'story="SKY-003-test"',
      'LOG_DIR="/tmp"',
      'PHASE="core"',
      '_inline_tc_exit=0', // simulates post-impl-tc-writer.sh exiting 0 (success OR silent no-op)
      'run_gate() {',
      block,
      '}',
      'run_gate',
    ].join('\n');
    try {
      const stdout = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
      return { exitCode: 0, stdout };
    } catch (e: any) {
      return { exitCode: e.status ?? -1, stdout: (e.stdout ?? '').toString() + (e.stderr ?? '').toString() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('REPRODUCES the exact live defect and proves the fix: exit 0 with EMPTY testCriteria.facts now hard-fails instead of reporting success', () => {
    const { exitCode, stdout } = run(0);
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/still has no testCriteria\.facts/);
    expect(stdout).not.toMatch(/SUCCESS:\s+TC writer populated testCriteria/);
  });

  it('a genuinely populated testCriteria.facts still reports success (no regression)', () => {
    const { exitCode, stdout } = run(3);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/SUCCESS:\s+TC writer populated testCriteria for SKY-003-test/);
  });
});
