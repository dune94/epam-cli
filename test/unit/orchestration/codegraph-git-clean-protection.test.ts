/**
 * CodeGraph index survival across git clean — the ACTUAL root cause of the
 * live "index keeps disappearing between preflight and point-of-use" bug.
 *
 * Root cause (empirically confirmed 2026-07-23): the CodeGraph index
 * (.codegraph/codegraph.db) is protected from git only by an untracked
 * .codegraph/.gitignore that ignores codegraph.db. But `git clean -fd`
 * removes that .gitignore ITSELF on its first pass (it's untracked and not
 * ignored) — which un-ignores codegraph.db. Then the NEXT `git clean -fd`
 * anywhere in the same brownfield run (this pipeline runs it at run-start
 * reset AND at worktree-merge) deletes the now-unprotected db and the whole
 * .codegraph/ directory. Two passes of a bare `git clean -fd` destroy the
 * entire index.
 *
 * Fix: every brownfield-path `git clean` now passes `-e .codegraph`, which
 * excludes the index directory from cleaning entirely — so it survives any
 * number of passes regardless of the self-nuking .gitignore.
 *
 * These tests replicate the EXACT git operations the pipeline runs, against
 * a real git repo with a real (small) codegraph.db shape, proving both the
 * bug (bare clean destroys it) and the fix (-e .codegraph preserves it).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function codegraphAvailable(): boolean {
  try { execSync('command -v codegraph', { stdio: 'ignore' }); return true; } catch { return false; }
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

// Builds a real git repo with a committed source file and the exact
// .codegraph/{.gitignore, codegraph.db} structure `codegraph init` produces.
function makeRepoWithIndex(): string {
  const repo = mkdtempSync(join(tmpdir(), 'cg-gitclean-'));
  cleanupDirs.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.com');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'tracked.ts'), 'export const x = 1;\n');
  git(repo, 'add', 'tracked.ts');
  git(repo, 'commit', '-qm', 'init');
  mkdirSync(join(repo, '.codegraph'), { recursive: true });
  writeFileSync(join(repo, '.codegraph', '.gitignore'), 'codegraph.db\n');
  // Real SQLite header so isCodeGraphIndexed()-style header checks pass too.
  writeFileSync(join(repo, '.codegraph', 'codegraph.db'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(200)]));
  return repo;
}

const dbPath = (repo: string) => join(repo, '.codegraph', 'codegraph.db');

describe('CodeGraph index survival across git clean (real git, real fixture)', () => {
  it('DEMONSTRATES THE BUG: two passes of a bare `git clean -fd` destroy the whole index', () => {
    const repo = makeRepoWithIndex();
    expect(existsSync(dbPath(repo))).toBe(true);
    git(repo, 'clean', '-fd'); // pass 1: removes .codegraph/.gitignore, db survives (still ignored)
    expect(existsSync(dbPath(repo))).toBe(true);
    git(repo, 'clean', '-fd'); // pass 2: db now un-ignored -> removed, dir removed
    expect(existsSync(dbPath(repo))).toBe(false); // the live failure, reproduced
  });

  it('THE FIX: `git clean -fd -e .codegraph` preserves the index across multiple passes', () => {
    const repo = makeRepoWithIndex();
    writeFileSync(join(repo, 'junk.tmp'), 'untracked junk\n');
    git(repo, 'clean', '-fd', '-e', '.codegraph'); // pass 1
    expect(existsSync(dbPath(repo))).toBe(true);
    expect(existsSync(join(repo, 'junk.tmp'))).toBe(false); // real junk still removed
    git(repo, 'clean', '-fd', '-e', '.codegraph'); // pass 2
    git(repo, 'clean', '-fd', '-e', '.codegraph'); // pass 3 for good measure
    expect(existsSync(dbPath(repo))).toBe(true);
    // .gitignore inside .codegraph is also preserved (whole dir excluded)
    expect(existsSync(join(repo, '.codegraph', '.gitignore'))).toBe(true);
  });

  it('THE FIX also survives the reset+clean sequence brownfield-preflight-reset.sh runs', () => {
    const repo = makeRepoWithIndex();
    const baseline = git(repo, 'rev-parse', 'HEAD').trim();
    // Simulate an in-run dirty commit that the reset discards.
    writeFileSync(join(repo, 'tracked.ts'), 'export const x = 999;\n');
    git(repo, 'commit', '-aqm', 'unverified in-run work');
    // Exact operations from brownfield-preflight-reset.sh (with the fix).
    git(repo, 'reset', '--hard', baseline);
    git(repo, 'clean', '-fd', '-e', '.codegraph');
    expect(existsSync(dbPath(repo))).toBe(true);
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(baseline); // reset still worked
  });

  it('THE DEFINITIVE FIX: ensureIndexed adds .codegraph/ to .git/info/exclude, surviving ALL git clean passes', () => {
    if (!codegraphAvailable()) return;
    const repo = makeRepoWithIndex();
    const cg = require('../../../orchestrations/scripts/lib/codegraph-context.js');
    // Apply the protection (idempotent; runs on both the already-indexed and
    // freshly-indexed paths).
    cg.ensureIndexed(repo);
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toMatch(/^\.codegraph\/?$/m);
    // Now the exact sequence that destroyed the index before — 3 passes of a
    // BARE `git clean -fd` (no -e). With .codegraph/ excluded at the git level,
    // it must survive every pass.
    for (let pass = 1; pass <= 3; pass++) {
      git(repo, 'clean', '-fd');
      expect(existsSync(dbPath(repo)), `db must survive git clean pass ${pass}`).toBe(true);
    }
  }, 30000);

  it('ensureIndexed rebuilds a deleted index on demand (belt-and-suspenders for any deletion the exclude cannot prevent)', () => {
    if (!codegraphAvailable()) return;
    const repo = makeRepoWithIndex();
    const cg = require('../../../orchestrations/scripts/lib/codegraph-context.js');
    // Simulate a non-git deletion (rm) the exclude cannot prevent.
    rmSync(join(repo, '.codegraph'), { recursive: true, force: true });
    expect(cg.isCodeGraphIndexed(repo)).toBe(false);
    expect(cg.ensureIndexed(repo)).toBe(true);
    expect(cg.isCodeGraphIndexed(repo)).toBe(true);
  }, 30000);

  it('the two brownfield git-clean call sites in the pipeline all use -e .codegraph', () => {
    const REPO_ROOT = join(__dirname, '../../../');
    // Only inspect ACTUAL command lines (strip comments and prose), so this
    // meta-check can't be fooled by the word "git clean" appearing in a
    // comment. A brownfield-path command line running `git ... clean -fd`
    // MUST include `-e .codegraph`.
    const commandLines = (src: string) =>
      src.split('\n')
        .map((l) => l.replace(/#.*$/, '').trim())
        .filter((l) => /git\b.*\bclean\b/.test(l));

    const preflightReset = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/brownfield-preflight-reset.sh'), 'utf8');
    for (const line of commandLines(preflightReset)) {
      expect(line, `unprotected git clean in brownfield-preflight-reset.sh: ${line}`).toContain('-e .codegraph');
    }

    // run-agent-orchestration.sh also has greenfield-teardown cleans (those
    // repos are deleted wholesale, no index to protect). Assert specifically
    // that the brownfield merge-step clean IS protected.
    const orch = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
    expect(orch).toMatch(/clean -fd -e \.codegraph/);
  });
});
