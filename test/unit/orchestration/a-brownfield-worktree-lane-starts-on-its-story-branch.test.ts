/**
 * A BROWNFIELD WORKTREE LANE STARTS ON ITS STORY BRANCH, CUT FROM ITS OWN CODELINE'S BASELINE.
 *
 * 2026-10-02, AMSD-2974: Step 13 cuts the lane's worktree from the checkout's HEAD and Step 17 merges
 * the lane back into the checkout's CURRENT branch. In brownfield that branch must be the story's own
 * (AI-<story>, from the codeline's baseline) — the main lane's ensure_story_branch, which the worktree
 * lane never called. And the baseline is the codeline's own: cx-shared has master, not the project's
 * declared develop.
 *
 * EXECUTED: the real blocks of run-agent-orchestration.sh (the lane's baseline, and the story-branch
 * step before Step 13) against real git repositories; ensure_story_branch is the real one.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
// The main file itself: these blocks are top-level code in it, never moved into a module.
const src = require('node:fs').readFileSync(join(SCRIPTS, 'run-agent-orchestration.sh'), 'utf8');
const lines = src.split('\n');
const block = (startMark: string, endMark: string) => {
  const s = lines.findIndex((l) => l.includes(startMark));
  const e = lines.findIndex((l, i) => i > s && l.includes(endMark));
  expect(s, `block not found: ${startMark}`).toBeGreaterThan(-1);
  expect(e, `block end not found: ${endMark}`).toBeGreaterThan(s);
  return lines.slice(s, e).join('\n');
};
const laneBaselineBlock = block('# THE LANE\'S OWN BASELINE', '# END THE LANE\'S OWN BASELINE');
const storyBranchBlock = block('# A BROWNFIELD WORKTREE LANE STARTS ON ITS STORY BRANCH', '# END A BROWNFIELD WORKTREE LANE');

const work = mkdtempSync(join(tmpdir(), 'bf-wt-branch-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env }).trim();

function codeline(name: string, branches: string[], onBranch?: string) {
  const origin = join(work, `${name}-origin`);
  execFileSync('git', ['init', '-q', '-b', branches[0], origin], { env });
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'base');
  for (const b of branches.slice(1)) git(origin, 'branch', b);
  const clone = join(work, name);
  execFileSync('git', ['clone', '-q', origin, clone], { env });
  if (onBranch) { git(clone, 'checkout', '-q', '-b', onBranch); git(clone, 'commit', '-q', '--allow-empty', '-m', 'old story'); }
  return clone;
}

function run(root: string, script: string, extra: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', `log(){ :; }; info(){ :; }; warning(){ echo "WARN $*" >&2; }; error(){ echo "ERR $*" >&2; }; success(){ :; }
source ${JSON.stringify(join(SCRIPTS, 'lib/git-ops.sh'))}
source ${JSON.stringify(join(SCRIPTS, 'lib/codeline-lanes.sh'))}
PROJECT_ROOT=${JSON.stringify(root)}
${script}`], { encoding: 'utf8', env: { ...env, JIRA_CODELINE_RUN: '1', EPAM_BROWNFIELD: '1', ...extra } });
  return r;
}

describe('the lane\'s own baseline', () => {
  it('a codeline without the declared branch uses its own default', () => {
    const lib = codeline('lib', ['master']);
    const r = run(lib, `${laneBaselineBlock}\necho "BL=$JIRA_BASELINE_BRANCH"`, { JIRA_BASELINE_BRANCH: 'develop' });
    expect(r.stdout).toContain('BL=master');
  });
  it('a codeline with the declared branch keeps it', () => {
    const site = codeline('site', ['develop', 'master'], 'bugfix/old');
    const r = run(site, `${laneBaselineBlock}\necho "BL=$JIRA_BASELINE_BRANCH"`, { JIRA_BASELINE_BRANCH: 'develop' });
    expect(r.stdout).toContain('BL=develop');
  });
  it('greenfield is untouched', () => {
    const lib = codeline('gf', ['master']);
    const r = run(lib, `${laneBaselineBlock}\necho "BL=$JIRA_BASELINE_BRANCH"`, { JIRA_BASELINE_BRANCH: 'develop', EPAM_BROWNFIELD: '0' });
    expect(r.stdout).toContain('BL=develop');
  });
});

describe('the story branch before Step 13', () => {
  it('the checkout leaves its old story branch for AI-<story> at the baseline, keeping the old commit', () => {
    const site = codeline('site2', ['develop', 'master'], 'bugfix/AI-OLD');
    const oldTip = git(site, 'rev-parse', 'HEAD');
    const base = git(site, 'rev-parse', 'origin/develop');
    const r = run(site, `need_worktrees=true\nprimary_stories="S-9"\nindependent_stories=""\n${storyBranchBlock}`, { JIRA_BASELINE_BRANCH: 'develop' });
    expect(git(site, 'branch', '--show-current'), r.stderr).toBe('AI-S-9');
    expect(git(site, 'rev-parse', 'HEAD')).toBe(base);
    expect(git(site, 'rev-parse', 'bugfix/AI-OLD')).toBe(oldTip);
  });
  it('greenfield: nothing changes', () => {
    const gf = codeline('gf2', ['main'], 'feature/x');
    run(gf, `need_worktrees=true\nprimary_stories="S-9"\nindependent_stories=""\n${storyBranchBlock}`, { EPAM_BROWNFIELD: '0' });
    expect(git(gf, 'branch', '--show-current')).toBe('feature/x');
  });
});

describe('Step 13, whole: story branch, worktree from it, provisioned from the codeline', () => {
  it('the lane worktree is on the story\'s base and carries the codeline\'s provisioned state', () => {
    const site = codeline('site3', ['develop', 'master'], 'bugfix/AI-OLD3');
    const { mkdirSync, writeFileSync, lstatSync, existsSync } = require('node:fs');
    // As a real codeline: node_modules is ignored; the vendor declaration is the project's.
    writeFileSync(join(site, '.git', 'info', 'exclude'), 'node_modules\n');
    mkdirSync(join(site, 'node_modules'));
    const projDir = join(work, 'project3'); mkdirSync(projDir);
    writeFileSync(join(projDir, 'dependency-check.json'), JSON.stringify({ vendorDirs: ['node_modules'] }));
    const step13 = block('# A BROWNFIELD WORKTREE LANE STARTS ON ITS STORY BRANCH', '# Step 3: Launch parallel agents');
    const stub = join(work, 'claude-stub.sh');
    writeFileSync(stub, `#!/bin/bash\nlog(){ :; }; info(){ :; }; warning(){ :; }; error(){ echo "ERR $*" >&2; }; success(){ :; }\nsource ${JSON.stringify(join(SCRIPTS, 'lib/git-ops.sh'))}\n[ "$1" = "--setup-worktrees" ] && { setup_worktrees; exit $?; }\n`);
    require('node:fs').chmodSync(stub, 0o755);
    const r = spawnSync('bash', ['-c', `log(){ :; }; info(){ :; }; warning(){ echo "WARN $*" >&2; }; error(){ echo "ERR $*" >&2; }; success(){ :; }; step_emit(){ :; }
source ${JSON.stringify(join(SCRIPTS, 'lib/git-ops.sh'))}
source ${JSON.stringify(join(SCRIPTS, 'lib/codeline-lanes.sh'))}
PROJECT_ROOT=${JSON.stringify(site)}; CLAUDE_SH=${JSON.stringify(stub)}
need_worktrees=true; primary_stories="S-7"; independent_stories=""
${step13}`], { encoding: 'utf8', env: { ...env, PROJECT_ROOT: site, EPAM_BROWNFIELD: '1', JIRA_BASELINE_BRANCH: 'develop', EPAM_PROJECT_CONFIG_DIR: projDir } });
    const wt = join(work, 'site3-wt-primary');
    expect(existsSync(wt), r.stderr).toBe(true);
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(git(site, 'rev-parse', 'origin/develop'));
    expect(git(site, 'branch', '--show-current')).toBe('AI-S-7');
    expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(true);

  });
});

describe('pause 2 holds for a worktree lane — the writer never starts unattended', () => {
  it('with EPAM_PAUSE_BEFORE_WRITER=1 and no main-lane stories, the run stops before Step 13', () => {
    const blk = block('# A BROWNFIELD WORKTREE LANE STARTS ON ITS STORY BRANCH', '# END A BROWNFIELD WORKTREE LANE');
    const r = spawnSync('bash', ['-c', `log(){ :; }; info(){ :; }; warning(){ :; }; error(){ :; }; success(){ :; }; step_emit(){ :; }
spec_review_gate(){ echo SPEC_REVIEW; return 0; }
save_run_checkpoint(){ echo "CHECKPOINT $2"; }
should_pause_before_writer(){ [ "\${EPAM_PAUSE_BEFORE_WRITER:-}" = "1" ]; }
record_run_pause(){ echo "PAUSE $1"; }
ensure_story_branch(){ echo "BRANCH $2"; }
${(() => { const ls = require('node:fs').readFileSync(join(SCRIPTS, 'run-agent-orchestration.sh'), 'utf8').split('\n'); const s = ls.findIndex((l: string) => l.startsWith('before_the_writer() {')); const e = ls.findIndex((l: string, i: number) => i > s && l === '}'); return s >= 0 ? ls.slice(s, e + 1).join('\n') : ''; })()}
PHASE=core; PRD_FILE=/dev/null; ORCH_RUN_ID=R1
need_worktrees=true; primary_stories="S-1"; independent_stories=""; non_review_main=""
${blk}
echo REACHED_STEP_13`], { encoding: 'utf8', env: { ...env, EPAM_BROWNFIELD: '1', EPAM_PAUSE_BEFORE_WRITER: '1' } });
    expect(r.stdout).toContain('SPEC_REVIEW');
    expect(r.stdout).toContain('CHECKPOINT pre-writer');
    expect(r.stdout).toContain('PAUSE pre-writer');
    expect(r.stdout).not.toContain('REACHED_STEP_13');
  });
});
