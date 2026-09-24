/**
 * AN ESCALATION WORKTREE NEVER DELETES WHAT IT FINDS — AND THE LOG NAMES THE BRANCH IT USED.
 *
 * Two defects in _escalation_worktree, both found by reading the live escalation log:
 *
 *   [Escalation] REGI-002 works in its own worktree /…-esc-REGI-002 (branch esc)
 *
 * 1. THE BRANCH IS NOT NAMED. The function sets and exports _ESC_BRANCH, but every caller reads it
 *    through `_esc_wt="$(_escalation_worktree …)"` — a command substitution, which is a SUBSHELL.
 *    The export dies with it, so `${_ESC_BRANCH:-esc}` always fell through to its default. The
 *    operator could not tell which branch held an escalation's work, which is the one thing the
 *    "nothing is discarded" line exists to tell them.
 *
 * 2. `[ -d "$_path" ] && rm -rf "$_path"` DELETES AN AGENT'S WORK. The path is only rm'd when it is
 *    NOT a registered worktree — and that is precisely the state a worktree lands in when its
 *    registration is pruned (`git worktree prune`, a re-clone, a teardown that swept .git) while
 *    the directory, with a non-converged fix in it, is still on disk. The engine must never remove
 *    an agent's code: it is moved aside, under a name that says what it was, and the operator can
 *    still read it.
 *
 * Driven through the REAL function over a REAL git repo. Nothing about the naming rule is restated
 * here — the branch the test expects is read from the function's own helper.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const LADDER = join(ROOT, 'orchestrations/scripts/lib/model-ladder.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function repoWith(sibling: string) {
  const dir = mkdtempSync(join(tmpdir(), 'esc-wt-')); dirs.push(dir);
  const repo = join(dir, 'codeline');
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(join(repo, 'seed.py'), 'x = 1\n');
  git('add', '-A'); git('commit', '-qm', 'seed');
  return { dir, repo, path: `${repo}-esc-${sibling}` };
}

/** The real functions, lifted from the engine and run — no reimplementation of the naming rule. */
function fns() {
  return [
    shellFunction(LADDER, '_escalation_branch'),
    shellFunction(LADDER, '_escalation_worktree'),
  ].join('\n');
}

function run(repo: string, script: string) {
  const r = spawnSync('bash', ['-c', `
set -u
log(){ printf '%s\\n' "$*"; }
warning(){ printf 'WARN %s\\n' "$*"; }
PROJECT_ROOT="${repo}"
${fns()}
${script}
`], { encoding: 'utf8' });
  return { out: r.stdout || '', err: r.stderr || '', status: r.status };
}

describe('an escalation worktree never deletes what it finds', () => {
  it('the caller can name the branch the work is on — through a subshell', () => {
    const { repo } = repoWith('REGI-002');
    // Exactly how the caller gets it: command substitution.
    const r = run(repo, `
_wt="$(_escalation_worktree REGI-002)"
log "worktree=$_wt branch=$(_escalation_branch REGI-002)"
`);
    expect(r.status, r.err).toBe(0);
    expect(r.out).toContain('branch=esc/REGI-002');
    expect(r.out, 'the fallback that hid the real name').not.toContain('branch=esc\n');
  });

  it('the branch the caller names is the branch the worktree is actually on', () => {
    const { repo } = repoWith('REGI-002');
    const r = run(repo, `
_wt="$(_escalation_worktree REGI-002)"
log "declared=$(_escalation_branch REGI-002)"
log "actual=$(git -C "$_wt" rev-parse --abbrev-ref HEAD)"
`);
    const declared = /declared=(\S+)/.exec(r.out)?.[1];
    const actual = /actual=(\S+)/.exec(r.out)?.[1];
    expect(declared, r.out + r.err).toBeTruthy();
    expect(actual).toBe(declared);
  });

  it('a directory that is NOT a registered worktree keeps its files — the engine removes no code', () => {
    const { repo, path } = repoWith('REGI-002');
    // The live shape: a worktree whose registration is gone, its non-converged fix still on disk.
    mkdirSync(join(path, 'regintel'), { recursive: true });
    writeFileSync(join(path, 'regintel', 'ingest.py'), 'THE ESCALATED FIX\n');

    const r = run(repo, `_wt="$(_escalation_worktree REGI-002)"; log "wt=$_wt"`);
    expect(r.status, r.err).toBe(0);

    const kept = readdirSync(dirname(path))
      .filter(n => n.startsWith(basename(path)) && n !== basename(path))
      .map(n => join(dirname(path), n, 'regintel', 'ingest.py'))
      .filter(existsSync);
    const stillThere = existsSync(join(path, 'regintel', 'ingest.py')) ? [join(path, 'regintel', 'ingest.py')] : [];
    const found = [...kept, ...stillThere];
    expect(found.length, 'the escalated fix was deleted — see the live rm -rf').toBeGreaterThan(0);
    expect(readFileSync(found[0], 'utf8')).toContain('THE ESCALATED FIX');
  });

  it('and it still produces a usable worktree at the expected path', () => {
    const { repo, path } = repoWith('REGI-002');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'stale.py'), 'old\n');
    const r = run(repo, `_wt="$(_escalation_worktree REGI-002)"; log "wt=$_wt"; [ -d "$_wt/.git" ] || [ -f "$_wt/.git" ] && log "isworktree"`);
    expect(r.out).toContain(`wt=${path}`);
    expect(r.out).toContain('isworktree');
  });
});
