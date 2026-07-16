/**
 * tsc gate — retry-in-loop fix.
 *
 * Root cause (run 20260702T091456): SKY-001-A completed implementation
 * (loop reported success), but story_tsc_gate() in run-agent-orchestration.sh
 * only runs AFTER the retry loop exits. A tsconfig moduleResolution mismatch
 * ("bundler" with module: "CommonJS") was caught there, with zero retries
 * left — the phase aborted immediately instead of giving the InferenceLadder
 * a chance to self-heal.
 *
 * Fix: run_tsc_verification() runs INSIDE claude.sh's implement_story retry
 * loop, at the same invoke_success gate as run_external_verification. A tsc
 * failure now sets VERIFICATION_FAILURE (the same channel run_external_
 * verification uses), which feeds the failure analyst and the retry prompt,
 * and increments retry_count so the InferenceLadder can escalate model/effort.
 *
 * The external story_tsc_gate() in run-agent-orchestration.sh is kept as a
 * defensive last-resort check — by the time it runs, tsc failures should
 * already have been caught and retried (or genuinely exhausted) inside the loop.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const ORCH_SH   = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const orchSrc   = readFileSync(ORCH_SH, 'utf8');

describe('claude.sh — run_tsc_verification exists and mirrors the external gate guards', () => {
  it('defines run_tsc_verification as a shell function', () => {
    expect(claudeSrc).toMatch(/run_tsc_verification\s*\(\)/);
  });

  const fnIdx = claudeSrc.indexOf('run_tsc_verification()');
  const fnBlock = claudeSrc.slice(fnIdx, fnIdx + 2200);

  it('respects SKIP_STORY_TSC_GATE (same skip flag as the external gate)', () => {
    expect(fnBlock).toMatch(/SKIP_STORY_TSC_GATE/);
  });

  it('skips when tsconfig.json does not exist yet', () => {
    expect(fnBlock).toMatch(/! -f "\$PROJECT_ROOT\/tsconfig\.json"/);
  });

  it('skips when src/ has no .ts files (scaffold-only state)', () => {
    expect(fnBlock).toMatch(/find.*src.*-name.*\.ts.*grep.*node_modules.*wc -l/s);
    expect(fnBlock).toMatch(/_ts_count.*-eq 0/);
  });

  it('does NOT blanket-skip test-engineer role stories (fixed 2026-07-12 — see tsc-gate-test-engineer-blindspot.test.ts)', () => {
    // A .test.ts file is compiled/type-checked by tsc exactly like any other
    // .ts file; a live run showed every syntax-class error observed was in a
    // .test.ts file written by a test-engineer story — precisely the case
    // this skip used to disable the check for.
    expect(fnBlock).not.toMatch(/test-engineer.*return 0/is);
  });

  it('runs tsc --noEmit against PROJECT_ROOT', () => {
    expect(fnBlock).toMatch(/tsc --noEmit/);
  });

  it('does NOT use tee (would mask the real exit code inside a retryable function)', () => {
    expect(fnBlock).not.toMatch(/tsc --noEmit[^\n]*\|\s*tee/);
  });
});

describe('claude.sh — tsc verification sets VERIFICATION_FAILURE (same channel as run_external_verification)', () => {
  const fnIdx = claudeSrc.indexOf('run_tsc_verification()');
  const fnBlock = claudeSrc.slice(fnIdx, fnIdx + 2200);

  it('sets VERIFICATION_FAILURE on tsc failure', () => {
    expect(fnBlock).toMatch(/VERIFICATION_FAILURE=\$\(printf/);
  });

  it('includes the tsc output in the VERIFICATION_FAILURE message (bounded to 4000 chars)', () => {
    expect(fnBlock).toMatch(/_tsc_output:0:4000/);
  });

  it('appends the failure section to output_file (same as external verification)', () => {
    expect(fnBlock).toMatch(/>> "\$output_file"/);
  });

  it('returns 1 on tsc failure so the caller can flip invoke_success', () => {
    expect(fnBlock).toMatch(/return 1/);
  });
});

describe('claude.sh — run_tsc_verification is wired into the invoke_success gate chain', () => {
  it('is called BEFORE run_external_verification, before the success branch (reordered 2026-07-12)', () => {
    // A cheap, near-instant tsc/syntax check should never run AFTER an
    // often-multi-minute external test command already paid for a doomed
    // run — see tsc-gate-test-engineer-blindspot.test.ts for the live
    // incident (5 syntax errors, each needing a full npm test + FailureAnalyst
    // LLM call to discover) this reordering fixes.
    const extIdx = claudeSrc.indexOf('! run_external_verification "$story_id" "$output_file"');
    const tscIdx = claudeSrc.indexOf('! run_tsc_verification "$story_id" "$output_file"');
    const successIdx = claudeSrc.indexOf('if [ "$invoke_success" = true ]; then', tscIdx);
    expect(extIdx).toBeGreaterThan(-1);
    expect(tscIdx).toBeLessThan(extIdx);
    expect(successIdx).toBeGreaterThan(extIdx);
  });

  it('is gated by invoke_success = true (short-circuits when a prior check already failed)', () => {
    const tscIdx = claudeSrc.indexOf('! run_tsc_verification "$story_id" "$output_file"');
    const line = claudeSrc.slice(claudeSrc.lastIndexOf('\n', tscIdx), tscIdx + 60);
    expect(line).toMatch(/\[ "\$invoke_success" = true \] &&/);
  });

  it('flips invoke_success to false on tsc failure (feeds the same retry path as any other failure)', () => {
    const tscIdx = claudeSrc.indexOf('! run_tsc_verification "$story_id" "$output_file"');
    const block = claudeSrc.slice(tscIdx, tscIdx + 250);
    expect(block).toMatch(/invoke_success=false/);
  });

  it('a failed tsc verification therefore reaches the same retry_count increment as other failures', () => {
    // The invoke_success=false path falls through to the existing else-branch
    // that increments retry_count and re-enters the InferenceLadder — verify
    // that branch still exists downstream of the tsc check.
    const tscIdx = claudeSrc.indexOf('! run_tsc_verification "$story_id" "$output_file"');
    const rest = claudeSrc.slice(tscIdx);
    expect(rest).toMatch(/retry_count=\$\(\(retry_count \+ 1\)\)/);
  });
});

describe('external story_tsc_gate remains as a defensive last-resort only, now shared by every lane', () => {
  // Relocated (2026-07-14): story_tsc_gate() now lives in
  // lib/story-guards.sh, a single shared implementation sourced by both
  // run-agent-orchestration.sh (main lane) and claude.sh (worktree lanes) —
  // this outer safety net used to only cover the main lane.
  const GUARDS_LIB = join(__dirname, '../../../orchestrations/scripts/lib/story-guards.sh');
  const guardsSrc = readFileSync(GUARDS_LIB, 'utf8');

  it('story_tsc_gate() still exists (kept as outer safety net)', () => {
    expect(guardsSrc).toMatch(/story_tsc_gate\s*\(\)/);
  });

  it('run-agent-orchestration.sh sources the shared lib', () => {
    expect(orchSrc).toContain('source "$SCRIPT_DIR/lib/story-guards.sh"');
  });

  it('claude.sh also sources it and calls it for worktree lanes (parity fix)', () => {
    expect(claudeSrc).toContain('source "$SCRIPT_DIR/lib/story-guards.sh"');
    expect(claudeSrc).toContain('story_tsc_gate "$story_id"');
  });

  it('by design, a real tsc failure should already be caught inside claude.sh before reaching here', () => {
    // Structural marker: no code change needed here, this test just documents
    // that the external gate is now a secondary check, not the primary one.
    const fnIdx = guardsSrc.indexOf('story_tsc_gate()');
    expect(fnIdx).toBeGreaterThan(-1);
  });
});
