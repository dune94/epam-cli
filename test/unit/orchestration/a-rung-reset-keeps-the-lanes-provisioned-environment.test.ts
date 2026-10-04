/**
 * A RUNG RESET KEEPS THE LANE'S PROVISIONED ENVIRONMENT.
 *
 * AMSD-2974 live, 2026-10-03, gate-remediation retry: Step 13 created the cx-shared lane worktree and
 * provision_lane_worktree gave it the codeline's .epam/ declaration and its vendor directory (linked —
 * nothing installed). Three seconds later the first attempt's WorktreeReset ("changed no VERIFIED fix
 * site") ran `git clean -fd` with no `-e .epam` — the other two cleans in the engine both exclude it —
 * and re-provisioned only settings/facts/verification. The worktree lost dependency-check.json, the
 * writer's verification read no vendorDirs ("no vendor dir absent in worktree"), and the project's
 * provisionCommand ran: `npm install` against the client registry, and the run was OOM-killed.
 *
 * EXECUTED: the real provision_lane_worktree and the real _selective_worktree_reset, sourced from the
 * engine's libraries, on a git fixture with a codeline, its lane worktree and a story whose attempt
 * changed no fix site. Asserted on what the writer's verification reads next: the worktree's
 * declaration names a vendor directory, and that directory is there.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const git = (cwd: string, a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'rung-reset-env-')); dirs.push(base);
  const root = join(base, 'codeline');
  mkdirSync(join(root, 'src'), { recursive: true });
  git(base, ['init', '-q', '-b', 'develop', root]);
  git(root, ['config', 'user.email', 't@t.t']); git(root, ['config', 'user.name', 't']);
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  writeFileSync(join(root, 'package.json'), '{"name":"c","version":"1.0.0"}\n');
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  git(root, ['add', '-A']); git(root, ['commit', '-qm', 'baseline']);
  // The codeline's provisioned, untracked state: its declaration and its installed vendor dir.
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(join(root, '.epam'), { recursive: true });
  writeFileSync(join(root, '.epam', 'dependency-check.json'), JSON.stringify({
    manifestFile: 'package.json', vendorDirs: ['node_modules'], provisionCommand: 'touch PROVISIONED',
  }));
  const wt = join(base, 'codeline-wt-primary');
  git(root, ['worktree', 'add', '-q', '-b', 'wt-primary', wt, 'HEAD']);
  // The story: one fix site the attempt did not change — the case that resets.
  const prd = join(base, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'S-1', fixSiteAnalysis: [{ file: 'src/a.ts', changeRequired: true }] }] }));
  return { root, wt, prd };
}

function run(root: string, wt: string, prd: string, script: string) {
  return spawnSync('bash', ['-c', `
SCRIPT_DIR=${JSON.stringify(join(LIB, '..'))}
source ${JSON.stringify(join(LIB, 'common.sh'))}
source ${JSON.stringify(join(LIB, 'git-ops.sh'))}
source ${JSON.stringify(join(LIB, 'codeline-lanes.sh'))}
source ${JSON.stringify(join(LIB, 'worktree-rungs.sh'))}
${script}`], {
    encoding: 'utf8',
    env: { ...process.env, EPAM_BROWNFIELD: '1', JIRA_BASELINE_BRANCH: 'develop', PRD_FILE: prd, MAIN_PRD_FILE: prd,
      NODE_BIN: process.execPath, ROOT: root, WT: wt, PROJECT_ROOT: wt, LOG_DIR: join(wt, '..') },
  });
}

describe('a rung reset keeps the lane\'s provisioned environment', () => {
  it('after WorktreeReset the writer\'s verification still finds the declared vendor directory', () => {
    const { root, wt, prd } = fixture();
    const r = run(root, wt, prd, `
provision_lane_worktree "$ROOT" "$WT"
[ -f "$WT/.epam/dependency-check.json" ] && echo PRE_DECL
[ -d "$WT/node_modules" ] && echo PRE_VENDOR
_selective_worktree_reset S-1`);
    const out = r.stdout + r.stderr;
    // Not vacuous: provisioning did its job, and the reset actually ran (not skipped).
    expect(out, 'provision_lane_worktree did not give the worktree its declaration').toContain('PRE_DECL');
    expect(out, 'provision_lane_worktree did not give the worktree its vendor directory').toContain('PRE_VENDOR');
    expect(out, 'the reset never ran, so this proves nothing').toMatch(/WorktreeReset\[S-1\]: reset to/);

    // What claude.sh reads next to decide whether to provision (external-verification.sh).
    const decl = join(wt, '.epam', 'dependency-check.json');
    expect(existsSync(decl), 'the reset deleted the worktree\'s declaration — the writer will see "no vendor dir" and provision').toBe(true);
    expect(existsSync(join(wt, 'node_modules')) && statSync(join(wt, 'node_modules')).isDirectory(),
      'the reset removed the vendor directory — the writer will run the provisionCommand').toBe(true);
    expect(existsSync(join(wt, 'PROVISIONED'))).toBe(false);
  });
});
