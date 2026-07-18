/**
 * Verifies EPAM_VENDOR_GUARD_ENABLED=0 (default) disables the vendor lock
 * and integrity check, while EPAM_VENDOR_GUARD_ENABLED=1 re-enables them.
 *
 * Root cause: vendor-guard was blocking legitimate npm installs (e.g. cors)
 * during story runs on local machines, causing story failures even when
 * the installation itself was correct. Default is now off; opt-in for CI.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');

describe('claude.sh — EPAM_VENDOR_GUARD_ENABLED flag', () => {
  it('_vendor_lock is gated behind EPAM_VENDOR_GUARD_ENABLED=1 check', () => {
    // Find the call site — must be inside an if block checking the flag
    const lockIdx = src.indexOf('_vendor_lock "$PROJECT_ROOT"');
    expect(lockIdx).toBeGreaterThan(-1);
    // The 200 chars before the call should contain the guard
    const before = src.slice(Math.max(0, lockIdx - 200), lockIdx);
    expect(before).toMatch(/EPAM_VENDOR_GUARD_ENABLED.*=.*1/);
    expect(before).toMatch(/if \[/);
  });

  it('run_vendor_integrity_check is gated behind EPAM_VENDOR_GUARD_ENABLED=1 check', () => {
    const checkIdx = src.indexOf('run_vendor_integrity_check "$PROJECT_ROOT"');
    expect(checkIdx).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, checkIdx - 100), checkIdx);
    expect(before).toMatch(/EPAM_VENDOR_GUARD_ENABLED.*=.*1/);
    expect(before).toMatch(/if \[/);
  });

  it('_vendor_unlock is NOT gated — always restores write perms regardless of flag', () => {
    // unlock must always run (even when guard is off) to handle the case
    // where a previous run left dirs locked; gating it would strand read-only dirs
    const unlockIdx = src.indexOf('_vendor_unlock "$PROJECT_ROOT"');
    expect(unlockIdx).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, unlockIdx - 80), unlockIdx);
    // Must NOT be inside a vendor-guard enabled check
    expect(before).not.toMatch(/EPAM_VENDOR_GUARD_ENABLED/);
  });

  it('default is 0 (disabled) — the guard expression uses :-0', () => {
    // Both lock and check use ${EPAM_VENDOR_GUARD_ENABLED:-0}
    const matches = [...src.matchAll(/EPAM_VENDOR_GUARD_ENABLED:-0/g)];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('comment documents the local-machine rationale and CI use-case', () => {
    const commentIdx = src.indexOf('EPAM_VENDOR_GUARD_ENABLED defaults to 0');
    expect(commentIdx).toBeGreaterThan(-1);
    const block = src.slice(commentIdx, commentIdx + 300);
    expect(block).toMatch(/local machine/i);
    expect(block).toMatch(/CI/);
  });
});
