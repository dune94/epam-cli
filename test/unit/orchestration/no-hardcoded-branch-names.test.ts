/**
 * A GIT BRANCH NAME IS A PROJECT FACT, NOT A CONSTANT.
 *
 * `JIRA_BASELINE_BRANCH` is configuration and exists for exactly this. Where code writes
 * the branch literally instead, a client whose trunk is `develop`, `trunk` or `release/*`
 * breaks — silently, at whatever step happens to run that line.
 *
 * This guard runs the SAME pattern the inventory tool uses
 * (orchestrations/scripts/hardcoding-audit.sh, category 2), so the audit and the test can
 * never disagree about what counts. The pattern is deliberately narrow: it matches a value
 * used AS a branch — `origin/<x>`, `checkout <x>`, a `*BRANCH*` variable assigned a literal
 * — and NOT the lane that happens to be called "main". A first, coarse sweep counted 76
 * "branch names" here; hand-checking showed almost all were `agentGroup == "main"` and the
 * monitor's lane argument. The real number was 3.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const AUDIT = join(__dirname, '../../../orchestrations/scripts/hardcoding-audit.sh');

function auditCategory(n: number) {
  const r = spawnSync('bash', [AUDIT, '--verify', String(n)], { encoding: 'utf8', timeout: 60000 });
  return (r.stdout || '')
    .split('\n')
    .filter((l) => /^[a-z].*:\d+:/.test(l.trim()) || /^(orchestrations|src)\//.test(l.trim()))
    .map((l) => l.trim());
}

describe('no git branch name is hardcoded in pipeline code', () => {
  it('the audit tool is runnable — otherwise this guard is vacuous', () => {
    const r = spawnSync('bash', [AUDIT], { encoding: 'utf8', timeout: 60000 });
    expect(r.status, `audit failed to run:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/git branch literals/);
  });

  it('finds a real hit for a category that still has them — the pattern works', () => {
    // Truncations (category 6) are known to exist; if this returns nothing the harness is broken and
    // the branch assertion below would pass for the wrong reason.
    expect(auditCategory(6).length).toBeGreaterThan(0);
  });

  it('THE RULE: zero branch literals', () => {
    const hits = auditCategory(2);
    expect(
      hits,
      'a branch name belongs in JIRA_BASELINE_BRANCH or is derivable from the repository ' +
        `(git symbolic-ref refs/remotes/origin/HEAD). Sites:\n${hits.join('\n')}`,
    ).toEqual([]);
  });
});
