/**
 * ONE SCRIPT, TWO ROLES — AND THE ROLE MUST BE NAMED.
 *
 * run-agent-orchestration.sh is both the parent orchestrator and, re-invoked once per codeline
 * with JIRA_CODELINE_RUN=1, each lane. That is deliberate: a lane gets the identical pipeline.
 * The cost is that every per-run resource is allocated twice and every parent-only step needs a
 * guard somebody has to remember to write. Two live defects came from exactly that omission:
 *
 *   - the resume block sat below the dispatch, so every "resume" silently ran a fresh run;
 *   - the control-plane port derived identically in both roles, so the first lane killed the
 *     parent's control plane and took its port.
 *
 * Neither was a hard error. Both were a missing condition at one site out of twelve.
 *
 * So the role is derived in ONE place — orch_role/is_parent/is_lane — and JIRA_CODELINE_RUN is
 * read nowhere else. A new parent-only step then reads `if is_parent; then`, which is a claim a
 * reviewer can check, rather than a bare environment test that looks like configuration.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH_PATH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const ORCH = readFileSync(ORCH_PATH, 'utf8');

/** Source lines only — comments quote the variable by design and are not call sites. */
const codeLines = ORCH.split('\n')
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => !line.trim().startsWith('#'));

describe('the role helpers exist and answer correctly', () => {
  function role(env: Record<string, string>): string {
    const start = ORCH.indexOf('orch_role() {');
    expect(start, 'orch_role is gone — the role is implicit again').toBeGreaterThan(-1);
    const helpers = ORCH.slice(start, ORCH.indexOf("is_lane() { [ \"$(orch_role)\" = 'lane' ]; }") + 60);
    const dir = mkdtempSync(join(tmpdir(), 'orch-role-'));
    try {
      const sh = join(dir, 'r.sh');
      writeFileSync(sh,
        `#!/usr/bin/env bash\n${helpers}\n` +
        `printf '%s ' "$(orch_role)"\n` +
        `if is_parent; then printf 'is_parent '; fi\n` +
        `if is_lane; then printf 'is_lane '; fi\n`);
      return execFileSync('bash', [sh], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('an unset JIRA_CODELINE_RUN is the parent', () => {
    expect(role({ JIRA_CODELINE_RUN: '' })).toBe('parent is_parent');
  });

  it('the lane re-invocation sets it to 1, and that is a lane', () => {
    expect(role({ JIRA_CODELINE_RUN: '1' })).toBe('lane is_lane');
  });

  it('the two roles are mutually exclusive — never both, never neither', () => {
    for (const v of ['', '1', '0', 'yes']) {
      const out = role({ JIRA_CODELINE_RUN: v });
      const both = out.includes('is_parent') && out.includes('is_lane');
      const neither = !out.includes('is_parent') && !out.includes('is_lane');
      expect(both, `JIRA_CODELINE_RUN="${v}" answered as both roles`).toBe(false);
      expect(neither, `JIRA_CODELINE_RUN="${v}" answered as neither role`).toBe(false);
    }
  });
});

describe('the role is derived in exactly one place', () => {
  it('JIRA_CODELINE_RUN is READ only inside orch_role', () => {
    // Setting it is how the parent tells a lane what it is — those sites are the contract.
    // Reading it anywhere else is a role check that bypasses the named helpers, which is the
    // shape both live defects took.
    const reads = codeLines.filter(({ line }) =>
      line.includes('JIRA_CODELINE_RUN') && !/JIRA_CODELINE_RUN=1\s*\\?$/.test(line.trim()));

    expect(
      reads.map(({ line, n }) => `${n}: ${line.trim()}`),
      'a role check bypasses is_parent/is_lane — the guard that was forgotten twice',
    ).toEqual([`${reads[0]?.n}: if [ -n "\${JIRA_CODELINE_RUN:-}" ]; then printf 'lane'; else printf 'parent'; fi`]);
  });

  it('the helpers are defined before anything uses them', () => {
    const defined = codeLines.find(({ line }) => line.startsWith('is_parent()'))!.n;
    const firstUse = codeLines.find(({ line }) => /\b(is_parent|is_lane)\b/.test(line)
      && !line.startsWith('is_parent()') && !line.startsWith('is_lane()'))!.n;
    expect(
      firstUse,
      'a role helper is called before it is defined — bash would treat it as an unknown command',
    ).toBeGreaterThan(defined);
  });
});

describe('the steps that must be parent-only are guarded', () => {
  /** The block of source between an anchor and the end of its enclosing if. */
  const near = (anchor: string, span = 400) => {
    const i = ORCH.indexOf(anchor);
    expect(i, `anchor vanished: ${anchor}`).toBeGreaterThan(-1);
    return ORCH.slice(Math.max(0, i - span), i + span);
  };

  it('resume is parent-only — a lane re-invocation must not restore the parent checkpoint', () => {
    // Anchored on the block's own distinctive call, not on the variable — the variable also
    // appears in the mint's skip condition, which is a different decision entirely.
    expect(near('restore_run_checkpoint "$EPAM_RESUME_RUN"')).toMatch(/is_parent/);
  });

  it('the setsid re-exec is parent-only — a lane must not start its own session', () => {
    expect(near('_ORCH_SETSID_DONE=1')).toMatch(/is_parent/);
  });

  it('the codeline dispatch is parent-only — a lane must not fork more lanes', () => {
    expect(near('_run_jira_pipeline; exit $?')).toMatch(/is_parent/);
  });

  it('the dashboard watcher is lane-skipped — three lanes rebuilt one output directory', () => {
    const fn = ORCH.slice(ORCH.indexOf('start_dashboards_watch()'));
    expect(fn.slice(0, fn.indexOf('\n}'))).toMatch(/is_lane/);
  });
});
