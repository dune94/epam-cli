/**
 * A FRESH RUN READS ITS CODELINES AT THEIR BASELINE — not at whatever an earlier run left checked out.
 *
 * Live AMSD-2974 run 1, 2026-10-09: cx-shared was still on bugfix/AI-AMSD-2974 carrying earlier runs' commits ("story
 * complete", "add bug-reproducing test"); the story branch is only reset before the writer, so the plan and the spec
 * pass read that work as existing code ("make the already-partial toast accessibility work explicit").
 *
 * EXECUTED: lib/codeline-lanes.sh base_fresh_story_branches with the real lib/git-ops.sh ensure_story_branch and
 * lib/plan-scope.js, on real repositories with a bare origin and a run's codeline-facts.json.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });

function codeline(d: string, name: string, base: string) {
  const seed = join(d, `${name}-seed`); spawnSync('git', ['init', '-q', '-b', base, seed]);
  writeFileSync(join(seed, 'a.txt'), 'base\n'); git(seed, 'add', '-A'); git(seed, 'commit', '-qm', 'base');
  const origin = join(d, `${name}.git`); spawnSync('git', ['clone', '-q', '--bare', seed, origin]);
  const cl = join(d, name); spawnSync('git', ['clone', '-q', origin, cl]);
  git(cl, 'checkout', '-q', '-b', 'bugfix/AI-S-1'); writeFileSync(join(cl, 'a.txt'), 'an earlier run\n'); git(cl, 'commit', '-qam', 'earlier run');
  return cl;
}

function estate() {
  const d = mkdtempSync(join(tmpdir(), 'fresh-base-')); dirs.push(d);
  const lib = codeline(d, 'lib', 'master');          // the project declares develop; this one has only master
  const site = codeline(d, 'site', 'develop');
  const cfg = join(d, 'cfg'); mkdirSync(cfg);
  writeFileSync(join(cfg, 'codeline-facts.json'), JSON.stringify({ _what: 'x', lib: { path: lib, facts: [] }, site: { path: site, facts: [] } }));
  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({ project: { outputDirs: [{ codeline: 'lib', path: lib }] }, stories: [{ id: 'S-1', codeline: 'lib' }] }));
  return { d, lib, site, cfg, prd };
}
const base = (e: ReturnType<typeof estate>, env: Record<string, string>) => spawnSync('bash', ['-c', `set -u
log(){ echo "LOG $*"; }; warning(){ echo "WARN $*"; }; info(){ echo "INFO $*"; }; error(){ echo "ERR $*"; }; success(){ echo "OK $*"; }
perimeter_apply(){ :; }
SCRIPT_DIR=${JSON.stringify(SCRIPTS)}; NODE_BIN=${JSON.stringify(process.execPath)}
. ${JSON.stringify(join(SCRIPTS, 'lib/git-ops.sh'))}
. ${JSON.stringify(join(SCRIPTS, 'lib/codeline-lanes.sh'))} 2>/dev/null
base_fresh_story_branches ${JSON.stringify(e.prd)}; echo "RC=$?"`], {
  encoding: 'utf8', env: { ...process.env, EPAM_BROWNFIELD: '1', EPAM_BRANCH_PREFIX: 'bugfix/', JIRA_BASELINE_BRANCH: 'develop', EPAM_PROJECT_CONFIG_DIR: e.cfg, ...env } });
const tip = (cl: string, ref = 'HEAD') => git(cl, 'rev-parse', ref).stdout.trim();

describe('the first leg of a run to reach the lanes bases every codeline the story may be worked in', () => {
  it('the routed codeline and every discovered one: on the story branch at their own baseline, earlier work pinned', () => {
    const e = estate();
    const r = base(e, { ORCH_RUN_ID: 'R-1', EPAM_RESUME_RUN: 'R-1' });   // the lanes are first reached by a resumed leg
    expect(r.stdout, r.stdout + r.stderr).toMatch(/RC=0/);
    expect(tip(e.lib), r.stdout).toBe(tip(e.lib, 'origin/master'));
    expect(tip(e.site), r.stdout).toBe(tip(e.site, 'origin/develop'));
    for (const cl of [e.lib, e.site]) {
      expect(git(cl, 'branch', '--show-current').stdout.trim()).toBe('bugfix/AI-S-1');
      expect(git(cl, 'branch', '--list', 'epam-rescue/*').stdout).toMatch(/epam-rescue\/S-1-/);
    }
    expect(existsSync(join(e.cfg, 'runs/R-1/story-branches-based'))).toBe(true);
  });
});

describe('what it never touches', () => {
  it('a later leg of the same run: this run\'s work is on the branches — not moved', () => {
    const e = estate();
    mkdirSync(join(e.cfg, 'runs/R-1'), { recursive: true }); writeFileSync(join(e.cfg, 'runs/R-1/story-branches-based'), 'x');
    const before = [tip(e.lib), tip(e.site)];
    base(e, { EPAM_RESUME_RUN: 'R-1' });
    expect([tip(e.lib), tip(e.site)]).toEqual(before);
  });
  it('a greenfield run: nothing is moved', () => {
    const e = estate(); const before = tip(e.lib);
    base(e, { EPAM_BROWNFIELD: '0', ORCH_RUN_ID: 'R-2' });
    expect(tip(e.lib)).toBe(before);
  });
});
