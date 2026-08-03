/**
 * codemie-claude.sh's use of setup_worktrees()/cleanup_worktrees() —
 * previously a full duplicate copy of these functions (found during the
 * 2026-08-02 git-surface audit to have silently drifted from claude.sh's
 * own, already-fixed copy — see worktree-setup-cleanup.test.ts's history).
 *
 * As of the git-ops consolidation (2026-08-02), both functions live ONLY in
 * lib/git-ops.sh — a single source of truth sourced by claude.sh,
 * codemie-claude.sh, and run-agent-orchestration.sh (per the same "all
 * lanes must have the same flow, no deviations" principle already applied
 * to lib/story-guards.sh). The functions' actual logic is therefore
 * exercised only once, by worktree-setup-cleanup.test.ts against
 * lib/git-ops.sh; this file just confirms the WIRING — that codemie-claude.sh
 * sources the shared lib and still calls both functions at its known call
 * sites — so a future edit can't silently reintroduce a local duplicate or
 * drop the source line without a test catching it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPT = join(REPO_ROOT, 'orchestrations/scripts/codemie-claude.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('codemie-claude.sh — git-ops.sh wiring', () => {
  it('sources lib/git-ops.sh', () => {
    expect(src).toMatch(/source\s+"\$SCRIPT_DIR\/lib\/git-ops\.sh"/);
  });

  it('does NOT define its own setup_worktrees()/cleanup_worktrees() (no local duplicate reintroduced)', () => {
    expect(src).not.toMatch(/^setup_worktrees\(\)\s*\{/m);
    expect(src).not.toMatch(/^cleanup_worktrees\(\)\s*\{/m);
  });

  it('still calls setup_worktrees() and cleanup_worktrees() at its known call sites', () => {
    // No local `setup_worktrees() {` definition exists (asserted above), so
    // any remaining occurrence of the bare name is a real call site.
    expect(src).toMatch(/^\s*setup_worktrees\s*$/m);
    expect(src).toMatch(/^\s*cleanup_worktrees\s*$/m);
  });
});
