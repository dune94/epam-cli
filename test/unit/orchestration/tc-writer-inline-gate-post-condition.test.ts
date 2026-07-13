/**
 * run-agent-orchestration.sh — Step 1 inline TC-writer gate post-condition
 * check.
 *
 * Root cause originally fixed here (found live, 2026-07-09, tier3-travel-app
 * run): the inline TC-writer gate trusted post-impl-tc-writer.sh's EXIT CODE
 * alone. But that script can legitimately exit 0 as a no-op ("No test
 * stories need TCs in phase ... — skipping") when its own internal
 * implementationOrder[phase]-scoped query doesn't (yet) see the target story
 * — e.g. right after a mid-execution split. Exit 0 does not mean
 * testCriteria was actually written. Live symptom: "SUCCESS TC writer
 * populated testCriteria for SKY-003-test" printed immediately after
 * "[tc-writer] No test stories need TCs in phase 'core' — skipping" — the
 * PRD confirms SKY-003-test never actually got a testCriteria field, and it
 * then ran its first coding attempt with zero grounding.
 *
 * SUPERSEDED (2026-07-13): the original fix hard-failed (`exit 1`) the
 * moment facts were still empty after the exit-code check — but that meant
 * a violation here aborted the ENTIRE pipeline over ONE story, the most
 * severe failure mode of any guarded step in the pipeline. The facts
 * re-check itself (the actual root-cause fix — never trust exit code alone)
 * is still exactly correct and unchanged; only the RESPONSE to a genuine
 * miss changed: retry up to 3 attempts, and on exhaustion mark just that
 * story status="blocked" (skipped by Step 1's live-status re-check) instead
 * of exiting 1. See tc-writer-retry-block.test.ts for the full retry/block
 * contract with real-execution proof — this file now just confirms the
 * facts-recheck itself (the part still true) is wired inside that loop.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

function extractInlineGateBlock(): string {
  const startMarker = 'for _tc_inline_attempt in 1 2 3; do';
  const startIdx = orchSrc.indexOf(startMarker);
  if (startIdx === -1) throw new Error('Could not find inline TC gate start');
  const endMarker = '.status = "blocked"';
  const endIdx = orchSrc.indexOf(endMarker, startIdx);
  if (endIdx === -1) throw new Error('Could not find inline TC gate end');
  return orchSrc.slice(startIdx, endIdx + endMarker.length);
}

describe('run-agent-orchestration.sh — inline TC-writer gate post-condition check (static)', () => {
  const block = extractInlineGateBlock();

  it('re-checks testCriteria.facts length for $story after EVERY retry attempt (not just trusting exit code)', () => {
    expect(block).toMatch(/_tc_inline_facts_len=/);
    expect(block).toMatch(/\.testCriteria\.facts \/\/ \[\]\) \| length/);
    const factsCheckIdx = block.indexOf('_tc_inline_facts_len=');
    const passIdx = block.indexOf('success "  TC writer populated testCriteria for $story');
    expect(factsCheckIdx).toBeLessThan(passIdx);
  });

  it('on exhaustion (still empty after 3 attempts), blocks the story instead of exiting 1', () => {
    expect(block).not.toMatch(/^\s*exit 1\s*$/m);
    expect(block).toMatch(/if \[ "\$\{_tc_inline_facts_len:-0\}" -eq 0 \]; then/);
    expect(block).toMatch(/\.status = "blocked"/);
  });
});
