/**
 * A STAGING FAILURE MUST SAY WHY IT FAILED.
 *
 * Live 2026-08-09, AMSD-2041 on gotransit, third run of the day:
 *
 *     [WARNING] [commit_completed_story] git add failed (exit 1) for AMSD-2041 —
 *               work remains staged/uncommitted
 *     [ERROR]   [post-story] AMSD-2041: work is UNCOMMITTED (commit step exit 1)
 *     [ERROR]   [orch] HALT: codeline 'gotransit' failed after its retries
 *
 * That is the entire record. The deliverable gate had passed (12 files verified), tsc had
 * passed, the writer's work was real — and the run halted with no way to tell what git
 * objected to, because git_add_client_outputs runs
 *
 *     timeout "$_timeout" git -C "$_repo" add -A -- "${_excludes[@]}" 2>/dev/null
 *
 * and throws the diagnosis away. Two fixtures reproducing the plausible causes both returned 0,
 * so the actual reason is simply unknown — the code deleted it.
 *
 * This is the cost of a swallowed stderr, and it is worse than the original bug: a run that
 * fails for a knowable reason and reports "exit 1" forces the next investigation to guess, and
 * guessing is what turned one defect into three runs.
 *
 * git's stderr on this path is genuinely useful and specific — "fatal: .git/index: index file
 * smaller than expected", "The following paths are ignored by one of your .gitignore files" —
 * and it is the difference between a fix and a theory.
 *
 * Note this is NOT about changing the verdict. The index-vs-exit-code logic stays exactly as it
 * is (an ignored-path warning with a populated index is still success). Only the evidence
 * changes: when the call reports failure, it must also report git's own words.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/git-ops.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function repo(opts: { corruptIndex?: boolean; nodeModules?: boolean; edits?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gitwhy-')); dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  git('add', '.'); git('commit', '-qm', 'base');

  if (opts.edits !== false) writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
  if (opts.nodeModules) {
    mkdirSync(join(dir, 'node_modules', 'p'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'p', 'i.js'), 'x\n');
  }
  // Corrupt LAST — an unreadable index makes every git command fail, including setup.
  if (opts.corruptIndex) writeFileSync(join(dir, '.git', 'index'), 'not an index');
  return dir;
}

/** Calls the real function, capturing everything it wrote to stdout and stderr. */
function addOutputs(dir: string) {
  const res = execFileSync('bash', ['-c',
    `. ${JSON.stringify(LIB)} >/dev/null 2>&1
     git_add_client_outputs ${JSON.stringify(dir)} 2>&1; echo "RC=$?"`,
  ], { encoding: 'utf8' });
  return { rc: Number((res.match(/RC=(\d+)/) || [])[1]), out: res };
}

describe('the fixture produces a REAL git failure with a real message', () => {
  it('git itself reports a specific reason for a corrupt index', () => {
    const dir = repo({ corruptIndex: true });
    let out = '';
    try {
      execFileSync('git', ['-C', dir, 'add', '-A'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e: any) { out = String(e.stderr); }
    expect(out, 'the fixture does not actually break git, so the test proves nothing')
      .toMatch(/index file/i);
  });
});

describe('THE DEFECT: when staging fails, the reason reaches the operator', () => {
  it("git's own message is surfaced, not swallowed", () => {
    const { out } = addOutputs(repo({ corruptIndex: true }));
    expect(
      out,
      'the run halts with "exit 1" and no diagnosis — the next investigation has to guess',
    ).toMatch(/index file/i);
  });

  it('the failure is still reported as a failure', () => {
    // Surfacing the reason must not soften the verdict.
    expect(addOutputs(repo({ corruptIndex: true })).rc).not.toBe(0);
  });

  it('the message identifies the repository it failed in', () => {
    // Three lanes run sequentially against three repos; "git add failed" without a path is
    // ambiguous the moment more than one codeline is in play.
    const dir = repo({ corruptIndex: true });
    expect(addOutputs(dir).out).toContain(dir);
  });
});

describe('the verdict logic is unchanged', () => {
  it('an ignored-path warning with work staged is still success', () => {
    const { rc } = addOutputs(repo({ nodeModules: true }));
    expect(rc, 'the ignored-path fix regressed — this is the 323-insertion bug').toBe(0);
  });

  it('a clean tree is still a silent no-op', () => {
    const { rc, out } = addOutputs(repo({ edits: false }));
    expect(rc).toBe(0);
    expect(out.replace(/RC=\d+\s*/, '').trim(), 'noise on the success path').toBe('');
  });

  it('a successful staging says nothing', () => {
    const { rc, out } = addOutputs(repo());
    expect(rc).toBe(0);
    expect(out.replace(/RC=\d+\s*/, '').trim()).toBe('');
  });

  it('a non-repository is still a silent success', () => {
    const d = mkdtempSync(join(tmpdir(), 'notrepo-')); dirs.push(d);
    expect(addOutputs(d).rc).toBe(0);
  });
});
