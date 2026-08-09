/**
 * AT RUN START, NO STORY BRANCH IS LEGITIMATE YET.
 *
 * The perimeter has two distinct jobs and one function was doing both:
 *
 *   RUN START  — nothing has been authorised to write anywhere. Every client checkout should
 *                be sealed.
 *   WRITE OPEN — ensure_story_branch() has just hard-reset the repo to the baseline, created
 *                this story's branch and provisioned it. THAT is the write window, and it
 *                reopens the repo deliberately.
 *
 * perimeter_apply implements the second: it unlocks whenever the checkout is on a branch other
 * than the baseline. Called at run start it reads a LEFTOVER branch as authorisation.
 *
 * Live 2026-08-09: next.metrolinx.com sat on bugfix/AI-AMSD-2041, left by an earlier run that
 * was killed, which survived the preflight reset. Run start logged "writes permitted, not
 * locking", the repo stayed writable for the whole run, and ContentstackQuote.tsx was rewritten
 * into an incompatible component during the SPEC PASS — in a run that paused before Step 8 and
 * never started a writer. gotransit and upexpress were on the baseline, were sealed, and were
 * untouched.
 *
 * git-ops.sh already carries the note that makes this unambiguous: "a spec-pass agent rewrote
 * ~1050 lines of client source there before any writer ran, and a per-tool allowlist cannot
 * stop that because `bash` bypasses it."
 *
 * perimeter_seal is the run-start operation: lock every real checkout regardless of branch.
 * perimeter_apply is UNCHANGED, so ensure_story_branch still opens the write window exactly as
 * it does today and the writer is unaffected. A linked worktree stays exempt in both, because
 * git's own structure makes it per-story rather than a name anyone can leave behind.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/codeline-write-perimeter.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function repoOn(branch: string, baseline = 'develop') {
  const dir = mkdtempSync(join(tmpdir(), 'seal-')); dirs.push(dir);
  const repo = join(dir, 'codeline');
  mkdirSync(repo, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', baseline);
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(join(repo, 'file.ts'), 'export const a = 1;\n');
  git('add', '.'); git('commit', '-qm', 'init');
  if (branch !== baseline) git('checkout', '-q', '-b', branch);
  return repo;
}

const sh = (script: string, baseline = 'develop') =>
  execFileSync('bash', ['-c',
    `. ${JSON.stringify(LIB)} >/dev/null 2>&1; JIRA_BASELINE_BRANCH=${JSON.stringify(baseline)}; ${script}`,
  ], { encoding: 'utf8' });

/** Is the tracked file writable by its owner? */
const writable = (repo: string) => (statSync(join(repo, 'file.ts')).mode & 0o200) !== 0;

describe('the harness observes a real permission change', () => {
  it('a fresh repo starts writable, and locking changes that', () => {
    const repo = repoOn('develop');
    expect(writable(repo)).toBe(true);
    sh(`perimeter_lock ${JSON.stringify(repo)} >/dev/null`);
    expect(writable(repo), 'the harness cannot see a lock, so every assertion below is vacuous').toBe(false);
  });
});

describe('THE DEFECT: run start seals regardless of branch', () => {
  it('a leftover story branch is sealed', () => {
    const repo = repoOn('bugfix/AI-AMSD-2041');
    sh(`perimeter_seal ${JSON.stringify(repo)} >/dev/null`);
    expect(
      writable(repo),
      'a branch left behind by a killed run left the repo writable for a whole run, and a ' +
      'client source file was rewritten during the spec pass',
    ).toBe(false);
  });

  it('a repo on the baseline is sealed — unchanged behaviour', () => {
    const repo = repoOn('develop');
    sh(`perimeter_seal ${JSON.stringify(repo)} >/dev/null`);
    expect(writable(repo)).toBe(false);
  });

  it('no branch name escapes the seal', () => {
    for (const b of ['feature/x', 'wip', 'release/1.2']) {
      const repo = repoOn(b);
      sh(`perimeter_seal ${JSON.stringify(repo)} >/dev/null`);
      expect(writable(repo), `branch '${b}' escaped the seal`).toBe(false);
    }
  });

  it('a linked worktree is left open — per-story by git structure', () => {
    const main = repoOn('develop');
    const wt = join(main, '..', 'wt');
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'story/1', wt], { encoding: 'utf8' });
    sh(`perimeter_seal ${JSON.stringify(wt)} >/dev/null`);
    expect(writable(wt)).toBe(true);
  });

  it('a non-repository is not touched', () => {
    const d = mkdtempSync(join(tmpdir(), 'plain-')); dirs.push(d);
    writeFileSync(join(d, 'file.ts'), 'x');
    expect(() => sh(`perimeter_seal ${JSON.stringify(d)} >/dev/null`)).not.toThrow();
    expect((statSync(join(d, 'file.ts')).mode & 0o200) !== 0).toBe(true);
  });
});

describe('the write window still opens — the writer must not be stranded', () => {
  it('perimeter_apply reopens a sealed repo once it is on a story branch', () => {
    // This is exactly what ensure_story_branch does after resetting and creating the branch.
    const repo = repoOn('develop');
    sh(`perimeter_seal ${JSON.stringify(repo)} >/dev/null`);
    expect(writable(repo)).toBe(false);
    execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'bugfix/STORY-1'], { encoding: 'utf8' });
    sh(`perimeter_apply ${JSON.stringify(repo)} >/dev/null`);
    expect(writable(repo), 'the writer cannot do its job').toBe(true);
  });

  it('perimeter_apply still seals a repo sitting on the baseline', () => {
    const repo = repoOn('develop');
    sh(`perimeter_apply ${JSON.stringify(repo)} >/dev/null`);
    expect(writable(repo)).toBe(false);
  });
});

describe('every launcher seals at run start, not just one', () => {
  it('the run-start loop uses the seal, not the branch-sensitive apply', () => {
    // The run-start site is the only place that can be reached before any story branch is
    // legitimately created. If a launcher calls perimeter_apply there, it inherits the defect.
    const src = require('node:fs').readFileSync(
      join(__dirname, '../../../orchestrations/scripts/tier3-metrolinx-run.sh'), 'utf8');
    // Anchored on the perimeter section: the launcher has more than one `for _cl_dir` loop,
    // and the preflight-reset loop appears first.
    const from = src.indexOf('codeline-write-perimeter.sh');
    expect(from, 'the launcher no longer sources the perimeter').toBeGreaterThan(-1);
    const loop = src.slice(from, from + 300);
    expect(loop).toMatch(/perimeter_seal/);
    expect(loop, 'run start still authorises writes from a leftover branch').not.toMatch(/perimeter_apply/);
  });
});
