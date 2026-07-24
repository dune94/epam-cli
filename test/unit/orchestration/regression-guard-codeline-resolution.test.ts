/**
 * B14 — Step 5's codeline resolution contained a FATAL bad substitution.
 *
 * `${!JIRA_WORKTREE_${_cl_upper}:-}` is not valid bash: nested expansion inside an
 * indirect reference is a "bad substitution", which aborts the script outright
 * rather than evaluating to empty. It was dead code (immediately overwritten by the
 * correct two-step form) and reachable ONLY when JIRA_DEFAULT_CODELINE is set — no
 * project set it, so it lay dormant until mock2 started setting it on 2026-07-24,
 * which would have killed every mock2 run at Step 5 with a confusing shell error.
 *
 * Guarded here because it is invisible to `bash -n` (a runtime expansion error, not
 * a syntax error) and only fires on one config path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ORCH_RAW = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
// Strip comment lines: the fix DOCUMENTS the broken form in a comment, and a
// code-scanning assertion must scan code, not prose about the code.
const ORCH = ORCH_RAW.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

describe('B14 — regression-guard codeline resolution', () => {
  it('contains no nested-expansion indirect reference anywhere', () => {
    // Matches ${!FOO_${BAR}} — fatal at runtime, invisible to bash -n.
    expect(ORCH).not.toMatch(/\$\{!\w+_\$\{/);
  });

  it('uses the two-step nameref form for worktree lookup', () => {
    expect(ORCH).toMatch(/_wtvar="JIRA_WORKTREE_\$\{_cl_upper\}"/);
    expect(ORCH).toMatch(/_cl_path="\$\{!_wtvar:?-?\}"/);
  });

  it('the two-step form tolerates an UNSET worktree var instead of aborting', () => {
    // set -u must not turn "codeline has no worktree yet" into a hard failure.
    const out = execFileSync('bash', ['-c',
      'set -u; _cl_upper=NOPE; _wtvar="JIRA_WORKTREE_${_cl_upper}"; _cl_path="${!_wtvar:-}"; echo "ok=[$_cl_path]"'],
      { encoding: 'utf8' });
    expect(out).toContain('ok=[]');
  });

  it('the OLD form really was fatal (proves this test guards something real)', () => {
    let failed = false;
    try {
      execFileSync('bash', ['-c',
        '_cl_upper=MOCK; JIRA_WORKTREE_MOCK=/tmp/x; _p="${!JIRA_WORKTREE_${_cl_upper}:-}"; echo "$_p"'],
        { encoding: 'utf8', stdio: 'pipe' });
    } catch { failed = true; }
    expect(failed, 'the old nested-indirect form should abort bash').toBe(true);
  });
});
