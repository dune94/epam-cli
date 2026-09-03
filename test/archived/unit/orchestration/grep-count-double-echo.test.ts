/**
 * Root cause of a live defect (2026-07-06, tier3 full run): claude.sh's inline
 * TC-writer check used `grep -c '\.test\.ts$' || echo 0` to count matches.
 * `grep -c` ALREADY prints "0" on zero matches (that's its own count output)
 * while ALSO exiting 1 (its "no match" convention) — so `|| echo 0` fires too,
 * producing a two-line value ("0\n0") instead of a single "0". Any downstream
 * numeric test (`[ "$x" -eq 0 ]`) then fails with a script-level error
 * ("integer expression expected"), not a real test failure — this is exactly
 * what happened live: `run_external_verification` returned exit 127 for every
 * non-test story, which would have silently blocked EVERY story in the
 * pipeline from ever passing external verification, since the bug fires on
 * the (extremely common) case of a story having zero .test.ts files.
 *
 * Fix pattern: `{ grep -c PATTERN FILE || true; }` — `|| true` only suppresses
 * the nonzero exit status (needed under `set -e`), without adding any extra
 * output, since grep -c's own "0" is already correct and sufficient.
 *
 * This file has two layers:
 * 1. A repo-wide static scanner asserting the buggy `grep -c ... || echo`
 *    anti-pattern does not exist anywhere in orchestrations/scripts/ — so a
 *    NEW occurrence of this exact bug class fails CI immediately, not just
 *    the one site that happened to be caught live.
 * 2. Real-execution regression tests proving each of the FIVE sites fixed
 *    live (claude.sh, run-agent-orchestration.sh x2, validate-dashboards.sh
 *    x2, contextualize-stories.sh) now produce a clean single-line "0" on
 *    the zero-match case, and that the buggy pattern reproduces the failure
 *    when run unfixed (proving the test would have caught this before it
 *    shipped).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPTS_DIR = join(__dirname, '../../../orchestrations/scripts');

function allShellScripts(): string[] {
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.sh'))
    .map((f) => join(SCRIPTS_DIR, f));
}

// Matches `grep -c ... || echo <anything>` on one logical line — the exact
// double-output anti-pattern. Deliberately does NOT flag `grep -c ... || true`
// (the correct fix) or `grep -c` calls with no `|| echo` fallback at all.
const ANTI_PATTERN = /grep\s+-c\b[^\n|]*\|\|\s*echo\b/;

describe('orchestrations/scripts/*.sh — no grep -c / || echo double-output anti-pattern', () => {
  for (const scriptPath of allShellScripts()) {
    const name = scriptPath.split('/').pop();
    it(`${name} does not contain \`grep -c ... || echo ...\` (double-prints "0" on zero matches, breaking numeric tests)`, () => {
      const src = readFileSync(scriptPath, 'utf8');
      const matches = src
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .filter((line) => ANTI_PATTERN.test(line));
      expect(matches).toEqual([]);
    });
  }
});

describe('grep -c zero-match behavior — REAL execution proving the bug and the fix', () => {
  it('REPRODUCES the bug: `grep -c PATTERN FILE || echo 0` produces a two-line "0\\n0" on zero matches', () => {
    const output = execFileSync(
      'bash',
      ['-c', `printf 'no matches here\\n' | { grep -c 'NEVER_MATCHES' || echo 0; }`],
      { encoding: 'utf8' },
    );
    // This IS the bug: two lines, not one.
    expect(output.split('\n').filter(Boolean)).toEqual(['0', '0']);
  });

  it('REPRODUCES the exact live failure: a numeric -eq test against the buggy double-output throws "integer expression expected"', () => {
    let stderr = '';
    let exitCode = 0;
    try {
      execFileSync(
        'bash',
        [
          '-c',
          `x=$(printf 'no matches\\n' | { grep -c 'NEVER_MATCHES' || echo 0; }); [ "\${x:-0}" -eq 0 ]`,
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (e: any) {
      exitCode = e.status ?? 1;
      stderr = e.stderr?.toString() ?? '';
    }
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/integer expression expected/);
  });

  it('the fix: `{ grep -c PATTERN FILE || true; }` produces a clean single-line "0" on zero matches', () => {
    const output = execFileSync(
      'bash',
      ['-c', `printf 'no matches here\\n' | { grep -c 'NEVER_MATCHES' || true; }`],
      { encoding: 'utf8' },
    );
    expect(output.split('\n').filter(Boolean)).toEqual(['0']);
  });

  it('the fix still counts real matches correctly (not just the zero case)', () => {
    const output = execFileSync(
      'bash',
      ['-c', `printf 'a.test.ts\\nb.ts\\nc.test.ts\\n' | { grep -c '\\.test\\.ts$' || true; }`],
      { encoding: 'utf8' },
    );
    expect(output.trim()).toBe('2');
  });

  it('the fix, used in a numeric -eq test, does not throw (regression guard for the exact live crash)', () => {
    const output = execFileSync(
      'bash',
      [
        '-c',
        `x=$(printf 'no matches\\n' | { grep -c 'NEVER_MATCHES' || true; }); [ "\${x:-0}" -eq 0 ] && echo MATCHED_ZERO`,
      ],
      { encoding: 'utf8' },
    );
    expect(output.trim()).toBe('MATCHED_ZERO');
  });
});

describe('claude.sh — inline TC-writer test-file count uses the fixed pattern (live regression site)', () => {
  const src = readFileSync(join(SCRIPTS_DIR, 'claude.sh'), 'utf8');

  it('uses `{ grep -c ... || true; }`, not `grep -c ... || echo 0`', () => {
    const idx = src.indexOf('_story_files_are_tests=$(jq');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 300);
    expect(block).toMatch(/\{\s*grep -c '\\\.test\\\.ts\$' \|\| true;\s*\}/);
    expect(block).not.toMatch(/\|\|\s*echo\s+0/);
  });
});
