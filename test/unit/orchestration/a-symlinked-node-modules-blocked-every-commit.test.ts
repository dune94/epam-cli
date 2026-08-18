// A SYMLINKED DEPENDENCY DIRECTORY MADE EVERY COMMIT FAIL, AT THE LAST STEP OF THE RUN.
//
// git_add_client_outputs excludes engine-owned and build directories with two pathspecs each:
//
// ":!<dir>/*"      the top-level copy
// ":!*/<dir>/*"    nested copies
//
// A pathspec whose path crosses a SYMLINK is fatal to git, not merely unmatched:
//
// fatal: pathspec ':(exclude)node_modules/*' is beyond a symbolic link
//
// Live 2026-08-18, both lanes, at the very end of a run that had otherwise succeeded — the
// writer's fix was correct, the tests passed and the type check passed:
//
// [git-add] FAILED in .../mock-b (exit 128): nothing reached the index although 2 path(s) pending
// [post-story] MOCK3-2: work is UNCOMMITTED — the story is not delivered; demoting from implemented
//
// Both repos symlink node_modules to a shared install. Nothing could ever be committed there.
//
// THE EXCLUSION MUST NOT WEAKEN TO FIX THE ERROR. `:!<dir>` alone survives the symlink but stops
// excluding NESTED copies, which would stage a client's vendored tree. One glob form is correct
// on all three counts — top-level contents, nested contents, and a symlinked directory:
//
// ":(exclude,glob)**/<dir>/**"
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib/git-ops.sh');
const PATHS = join(ROOT, 'orchestrations/scripts/lib/engine-paths.sh');

let dir: string;
let repo: string;

const git = (d: string, ...a: string[]) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });

/** Stage through the real function, and report what reached the index. */
function stage(d: string) {
  const r = spawnSync('bash', ['-c',
    `warning() { echo "WARN: $*"; }; error() { echo "ERR: $*"; }; info() { :; }; success() { :; }; log() { :; }
     . "${PATHS}" 2>/dev/null || true
     . "${LIB}"
     git_add_client_outputs "${d}"; echo "RC=$?"`,
  ], { encoding: 'utf8' });
  const staged = git(d, 'diff', '--cached', '--name-only').stdout.split('\n').filter(Boolean);
  return { out: `${r.stdout}${r.stderr}`, staged };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'symlink-nm-'));
  repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'sub', 'node_modules'), { recursive: true });
  // A real dependency install elsewhere, symlinked in — the live shape.
  mkdirSync(join(dir, 'shared-node-modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'shared-node-modules', 'pkg', 'index.js'), 'vendor\n');
  symlinkSync(join(dir, 'shared-node-modules'), join(repo, 'node_modules'));
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const x = 1;\n');
  writeFileSync(join(repo, 'sub', 'node_modules', 'dep.js'), 'vendor\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a symlinked node_modules blocked every commit', () => {
  it('STAGES THE CLIENT WORK — a symlinked dependency dir is not fatal', () => {
    const { out, staged } = stage(repo);
    expect(out, 'the pathspec is still fatal on a symlink').not.toMatch(/beyond a symbolic link/);
    expect(out).toContain('RC=0');
    expect(staged, "the writer's own change never reached the index").toContain('src/app.ts');
  });

  it('STILL EXCLUDES THE SYMLINKED DIRECTORY ITSELF', () => {
    const { staged } = stage(repo);
    expect(staged.filter((p) => p === 'node_modules' || p.startsWith('node_modules/')),
      'a vendored dependency tree was staged into the client repo').toEqual([]);
  });

  it('STILL EXCLUDES A NESTED COPY — the exclusion is not weakened to fix the error', () => {
    const { staged } = stage(repo);
    expect(staged.filter((p) => p.includes('/node_modules/')),
      'a nested vendored tree was staged into the client repo').toEqual([]);
  });

  it('and still excludes engine-owned directories', () => {
    mkdirSync(join(repo, '.epam'), { recursive: true });
    writeFileSync(join(repo, '.epam', 'state.json'), '{}\n');
    const { staged } = stage(repo);
    expect(staged.filter((p) => p.startsWith('.epam/')),
      'engine state was staged into the client repo').toEqual([]);
  });
});
