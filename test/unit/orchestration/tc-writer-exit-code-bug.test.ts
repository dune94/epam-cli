/**
 * Regression guard for a live-run defect (tier3 core phase, 2026-07-02):
 * every TC writer invocation failed with "error: unknown option '--cwd'"
 * (epam run has no --cwd flag), yet Step 1.6 reported
 * "TC writer gate PASSED — testCriteria populated" anyway.
 *
 * Two stacked bugs:
 *   1. post-impl-tc-writer.sh passed --cwd to `epam run`, which Commander
 *      rejects as an unknown option — the agent invocation always failed.
 *   2. run-agent-orchestration.sh checked `if CMD | tee file; then` — this
 *      tests tee's exit code (almost always 0), not CMD's. So even once (1)
 *      is fixed, a real failure would still have been silently reported as
 *      a pass.
 *
 * Net effect before the fix: testCriteria were never actually written by
 * this path, but the pipeline always proceeded as if they had been.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const TC_WRITER_SH = join(REPO_ROOT, 'orchestrations/scripts/post-impl-tc-writer.sh');
const RUN_TS = join(REPO_ROOT, 'src/cli/commands/run.ts');

const orchSrc = readFileSync(ORCH_SH, 'utf8');
const tcWriterSrc = readFileSync(TC_WRITER_SH, 'utf8');
const runTsSrc = readFileSync(RUN_TS, 'utf8');

describe('epam run — confirms --cwd was never a real flag (root cause)', () => {
  it('the run command does not declare a --cwd option', () => {
    expect(runTsSrc).not.toMatch(/--cwd/);
  });
});

describe('post-impl-tc-writer.sh — invokes epam run without --cwd', () => {
  it('does not pass --cwd to the epam run invocation', () => {
    const idx = tcWriterSrc.indexOf('"$EPAM_BIN" run "$TC_PROMPT"');
    expect(idx).toBeGreaterThan(-1);
    const block = tcWriterSrc.slice(idx, idx + 50);
    expect(block).not.toMatch(/--cwd/);
  });

  it('changes directory via a subshell (cd "$OUTPUT_DIR" && ...) instead', () => {
    const idx = tcWriterSrc.indexOf('"$EPAM_BIN" run "$TC_PROMPT"');
    const block = tcWriterSrc.slice(Math.max(0, idx - 200), idx);
    expect(block).toMatch(/cd "\$OUTPUT_DIR" &&/);
  });

  it('the cd + epam run invocation is wrapped in a subshell (parentheses) so cwd does not leak', () => {
    const idx = tcWriterSrc.indexOf('cd "$OUTPUT_DIR" &&');
    const before = tcWriterSrc.slice(Math.max(0, idx - 10), idx);
    expect(before).toMatch(/\(\s*$/);
  });

  it('still captures the real exit code via PIPESTATUS[0] after the subshell | tee', () => {
    const idx = tcWriterSrc.indexOf('cd "$OUTPUT_DIR" &&');
    const afterBlock = tcWriterSrc.slice(idx, idx + 400);
    expect(afterBlock).toMatch(/\) 2>&1 \| tee "\$LOG_FILE"/);
    expect(afterBlock).toMatch(/TC_EXIT=\$\{PIPESTATUS\[0\]\}/);
  });

  it('the python3 validator treats a nonzero TC_EXIT as a hard failure regardless of stale TC files', () => {
    const idx = tcWriterSrc.indexOf('if tc_exit != 0:');
    expect(idx).toBeGreaterThan(-1);
    const block = tcWriterSrc.slice(idx, idx + 500);
    expect(block).toMatch(/sys\.exit\(1\)/);
  });

  it('the python3 validator is the last statement in the file (propagates TC_EXIT as the script exit code)', () => {
    const trimmed = tcWriterSrc.trimEnd();
    expect(trimmed.endsWith('PYEOF')).toBe(true);
    const lastPyBlockIdx = tcWriterSrc.lastIndexOf('python3 << PYEOF');
    expect(lastPyBlockIdx).toBeGreaterThan(-1);
    // Nothing meaningful after the heredoc besides its own closing marker
    const afterHeredoc = tcWriterSrc.slice(tcWriterSrc.lastIndexOf('PYEOF') + 5).trim();
    expect(afterHeredoc).toBe('');
  });
});

describe('run-agent-orchestration.sh — Step 1.6 no longer masks the real exit code with tee', () => {
  const idx = orchSrc.indexOf('Step 10: TC writer gate — ${_tc_writer_needed}');
  // Widened 3200 -> 4000 (2026-07-13): the violationTypes derivation +
  // _log_guarded_step_retry call added before the blocked-story handling
  // pushed it further from the anchor.
  const block = orchSrc.slice(idx, idx + 4000);

  it('does NOT use the `if CMD | tee file; then` pattern (checks tee, not CMD)', () => {
    expect(block).not.toMatch(/if bash "\$SCRIPT_DIR\/post-impl-tc-writer\.sh"[\s\S]*?\| tee[\s\S]*?; then/);
  });

  it('captures the real exit code via PIPESTATUS[0] after piping to tee', () => {
    expect(block).toMatch(/\| tee "\$LOG_DIR\/tc-writer-\$\{PHASE\}\.log"/);
    expect(block).toMatch(/_tc_writer_exit=\$\{PIPESTATUS\[0\]\}/);
  });

  // Behavior change (2026-07-13): the pass/fail decision no longer rests on
  // _tc_writer_exit alone — it's a per-story testCriteria.facts check
  // (_tc_batch_still_missing) after up to 3 retry attempts, since a
  // transient writer failure shouldn't hard-abort the whole phase over one
  // story. _tc_writer_exit is still captured (asserted above) and still
  // used for the ONE remaining hard-failure case: the writer corrupting
  // $PRD_FILE itself.
  it('decides pass/fail on a per-story testCriteria check (_tc_batch_still_missing), not _tc_writer_exit alone', () => {
    expect(block).toMatch(/_tc_batch_still_missing=\$\(jq -r --arg phase "\$PHASE"/);
    expect(block).toMatch(/if \[ -z "\$_tc_batch_still_missing" \]; then/);
  });

  it('no longer exits 1 on a genuine per-story writer failure — blocks just that story instead', () => {
    expect(block).toMatch(/\.status = "blocked"/);
    expect(block).toMatch(/blocked-stories\.jsonl/);
  });

  it('still hard-fails (exit 1) if the writer corrupts $PRD_FILE itself (not just a per-story miss)', () => {
    expect(block).toMatch(/if ! jq empty "\$PRD_FILE" 2>\/dev\/null; then/);
    const corruptIdx = block.indexOf('if ! jq empty "$PRD_FILE"');
    const corruptBlock = block.slice(corruptIdx, corruptIdx + 350);
    expect(corruptBlock).toMatch(/exit 1/);
  });
});
