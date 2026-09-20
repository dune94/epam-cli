/**
 * A WORKTREE IS A GIT TREE.
 *
 * In a git worktree, `.git` is a FILE (a gitdir pointer), not a directory. Thirty-nine engine
 * sites tested `[ -d "$ROOT/.git" ]` and silently returned "not a repository" for every lane
 * that runs in a worktree: no commit (git_add_client_outputs staged nothing, the story was
 * marked completed with its work uncommitted, and Step 17 found "no new commits"), no attempt
 * snapshot, no review diff, no deliverable diff, no baseline reset. regintel £0 rehearsal #19
 * (2026-09-20) was the first rehearsal to reach a worktree lane and found it.
 *
 * The class is closed, not the site: no engine script tests `.git` as a directory any more,
 * and the commit path is executed inside a real worktree.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' }).trim();

function worktree() {
  const d = mkdtempSync(join(tmpdir(), 'wt-is-git-')); dirs.push(d);
  const main = join(d, 'build'); mkdirSync(main);
  git(main, 'init', '-q'); git(main, 'commit', '-q', '--allow-empty', '-m', 'base');
  const wt = join(d, 'build-wt-primary');
  git(main, 'worktree', 'add', '-q', '-b', 'wt-primary', wt);
  dirs.push(wt);
  return { d, main, wt };
}

describe('the commit path inside a worktree', () => {
  it('git_add_client_outputs stages the lane\'s work', () => {
    const { wt } = worktree();
    mkdirSync(join(wt, 'regintel')); writeFileSync(join(wt, 'regintel/api.py'), 'app = None\n');
    const r = spawnSync('bash', ['-c', `source ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/git-ops.sh'))} 2>/dev/null; NODE_BIN=$(command -v node); git_add_client_outputs ${JSON.stringify(wt)} 60; echo RC=$?`], { encoding: 'utf8' });
    expect(r.stdout, r.stderr).toMatch(/RC=0/);
    expect(git(wt, 'diff', '--cached', '--name-only')).toContain('regintel/api.py');
  });
  it('commit_completed_story commits on the lane branch, so the merge has something to merge', () => {
    const { wt } = worktree();
    mkdirSync(join(wt, 'regintel')); writeFileSync(join(wt, 'regintel/api.py'), 'app = None\n');
    const logs = join(wt, '..', 'logs'); mkdirSync(logs);
    const r = spawnSync('bash', ['-c', [
      `source ${JSON.stringify(join(ROOT, 'orchestrations/scripts/lib/git-ops.sh'))} 2>/dev/null`,
      `log(){ echo "LOG: $*"; }; warning(){ echo "WARN: $*"; }; error(){ echo "ERR: $*"; }; success(){ echo "OK: $*"; }; info(){ :; }`,
      `NODE_BIN=$(command -v node); SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}; LOG_DIR=${JSON.stringify(logs)}`,
      `GIT_WORK_ROOT=${JSON.stringify(wt)}; PROJECT_ROOT=${JSON.stringify(wt)}; record_story_changes(){ :; }`,
      'commit_completed_story REGI-007; echo RC=$?',
    ].join('\n')], { encoding: 'utf8' });
    expect(r.stdout, r.stdout + r.stderr).toMatch(/Committed 1 file\(s\) for REGI-007/);
    expect(git(wt, 'log', '--oneline', '-1')).toMatch(/REGI-007: story complete/);
    expect(git(wt, 'rev-list', '--count', 'master..wt-primary')).toBe('1');
  });
});

describe('the class is closed: no engine script tests .git as a directory', () => {
  it('no `-d ".../.git"` remains under orchestrations/scripts', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) { if (!/node_modules|\.inlined|tools\/split-maps/.test(p)) walk(p); continue; }
        if (!/\.sh$/.test(n)) continue;
        const src = readFileSync(p, 'utf8').split('\n');
        src.forEach((l, i) => { if (/-d\s+"?\$\{?[A-Za-z_:-]+\}?\/\.git"?\s*\]/.test(l) && !/^\s*#/.test(l)) offenders.push(`${p.replace(ROOT + '/', '')}:${i + 1}`); });
      }
    };
    walk(join(ROOT, 'orchestrations/scripts'));
    expect(offenders, `.git tested as a directory (a worktree's .git is a file):\n${offenders.join('\n')}`).toEqual([]);
  });
});
