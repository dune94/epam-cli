/**
 * STAGING SUCCEEDED AND THE EXIT CODE SAID IT FAILED.
 *
 * Live 2026-08-09, AMSD-2041 on gotransit. The writer installed the live-preview SDK, so
 * `npm install` created a top-level node_modules — which is gitignored. Then:
 *
 *     git add -A -- (exclusion pathspecs for node_modules, build, .next, engine dirs)
 *     The following paths are ignored by one of your .gitignore files:
 *     node_modules
 *     hint: Use -f if you really want to add them.
 *     exit=1
 *
 * Every real change staged correctly. Git exits 1 purely because an ignored path was NAMED,
 * even though naming it is what the exclusion pathspec is for. git_add_client_outputs returns
 * git's raw code, commit_completed_story returns 1, and the story is demoted — so a story whose
 * 323 insertions were sitting correctly in the index was reported as undelivered, the phase
 * aborted, and the remaining two codelines never ran.
 *
 * The function's own comment predicted this class and did not handle it: git add with
 * exclusion pathspecs "returns non-zero in ordinary situations (e.g. a repo with no HEAD)".
 *
 * THE FIX IS TO ASK THE INDEX, NOT THE EXIT CODE. After staging, whether work is staged is a
 * fact that can be read: `git diff --cached --name-only`. A non-zero exit with a populated index
 * is a warning; a non-zero exit with an empty index — when there WERE changes to stage — is a
 * real failure. The no-fallback rule is untouched: nothing re-stages without the exclusions, and
 * the unconditional reset of engine-owned paths still runs.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/git-ops.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A repo shaped like the live one: gitignored node_modules present, real edits pending. */
function repo(opts: { nodeModules?: boolean; edits?: boolean; engineDir?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gitadd-')); dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  git('add', '.'); git('commit', '-qm', 'init');

  if (opts.nodeModules !== false) {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports=1;\n');
  }
  if (opts.edits !== false) {
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n');
  }
  if (opts.engineDir) {
    mkdirSync(join(dir, '.epam'), { recursive: true });
    writeFileSync(join(dir, '.epam', 'settings.json'), '{}\n');
  }
  return dir;
}

/** Calls the real function; returns its exit code and what ended up staged. */
function addOutputs(dir: string) {
  const out = execFileSync('bash', ['-c',
    `. ${JSON.stringify(LIB)} >/dev/null 2>&1
     git_add_client_outputs ${JSON.stringify(dir)}; echo "RC=$?"
     git -C ${JSON.stringify(dir)} diff --cached --name-only 2>/dev/null || true`,
  ], { encoding: 'utf8' });
  const rc = Number((out.match(/RC=(\d+)/) || [])[1]);
  const staged = out.split('\n').filter((l) => l && !l.startsWith('RC=')).sort();
  return { rc, staged };
}

describe('the fixture reproduces the live condition', () => {
  it('a gitignored node_modules exists alongside real edits', () => {
    const { staged } = addOutputs(repo());
    expect(staged).toContain('src/a.ts');
    expect(staged).toContain('package.json');
  });
});

describe('THE DEFECT: an ignored-path warning is not a staging failure', () => {
  it('the call succeeds when the work is staged', () => {
    const { rc, staged } = addOutputs(repo());
    expect(staged.length, 'nothing staged — the fixture is wrong').toBeGreaterThan(0);
    expect(
      rc,
      'staging succeeded and the exit code said it failed, so the story was demoted and the ' +
      'phase aborted with 323 insertions correctly sitting in the index',
    ).toBe(0);
  });

  it('the real changes are all staged', () => {
    expect(addOutputs(repo()).staged).toEqual(['package.json', 'src/a.ts']);
  });

  it('node_modules is still not staged — the exclusion is not weakened', () => {
    expect(addOutputs(repo()).staged.some((p) => p.startsWith('node_modules'))).toBe(false);
  });

  it('engine-owned paths are still kept out', () => {
    expect(addOutputs(repo({ engineDir: true })).staged.some((p) => p.startsWith('.epam'))).toBe(false);
  });
});

describe('a genuine failure is still a failure', () => {
  it('nothing to stage and nothing staged is not an error', () => {
    // A clean tree: git exits 0, index empty, and that is a correct no-op.
    const { rc, staged } = addOutputs(repo({ edits: false }));
    expect(staged).toEqual([]);
    expect(rc).toBe(0);
  });

  it('a path that is not a repository returns success without touching anything', () => {
    const d = mkdtempSync(join(tmpdir(), 'notrepo-')); dirs.push(d);
    expect(addOutputs(d).rc).toBe(0);
  });

  it('an unreadable repo reports failure rather than silent success', () => {
    // Corrupt the index so git genuinely cannot stage: the index must end up empty AND
    // the call must report it, or a real breakage would read as a clean commit.
    const dir = repo();
    writeFileSync(join(dir, '.git', 'index'), 'not an index');
    const { rc, staged } = addOutputs(dir);
    expect(staged).toEqual([]);
    expect(rc, 'a repo that cannot stage anything reported success').not.toBe(0);
  });
});
