/**
 * CodeGraph must be re-indexed after a local commit, and must NOT be
 * re-indexed when nothing changed.
 *
 * THE BUG (found 2026-08-06, by inspection then confirmed by grep):
 * The index was built exactly once per run by codegraph-preflight-index.sh —
 * BEFORE any writer ran — and nothing ever rebuilt it:
 *   - isCodeGraphIndexed() validates only that the db exists with a valid
 *     SQLite header. Existence-only; never compares age to the working tree.
 *   - ensureIndexed() short-circuits to true for ANY pre-existing index,
 *     however stale, rebuilding only when the db is missing/corrupt.
 *   - No re-index call existed anywhere in the post-write / review path.
 * Yet team-lead-review.sh hands the reviewer `codegraph_query` explicitly to
 * check "does a helper already exist?" — so the reviewer was querying a
 * pre-writer snapshot and could not see the writer's own output.
 *
 * These tests EXECUTE the real script against real temp directories and
 * assert on what it actually does — not on source text, which would pass on
 * a comment or a dead branch.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const REINDEX_SH = join(REPO_ROOT, 'orchestrations/scripts/codegraph-reindex.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * A REAL git repo whose index db is deliberately NEWER than every source file.
 *
 * Must be a real repo: the dirty check asks `git ls-files` what the repository
 * considers source, rather than pruning `node_modules`/`.git` by name. That is
 * what makes it stack-agnostic — the repo's own .gitignore decides, so a Python
 * or Go codeline works with no engine change. A bare mkdir temp dir returns no
 * files and would read as permanently CLEAN, proving nothing.
 */
function repoWithFreshIndex(): string {
  const d = mkdtempSync(join(tmpdir(), 'cg-reindex-'));
  dirs.push(d);
  spawnSync('git', ['init', '-q', d]);
  spawnSync('git', ['-C', d, 'config', 'user.email', 't@t']);
  spawnSync('git', ['-C', d, 'config', 'user.name', 't']);
  mkdirSync(join(d, '.codegraph'), { recursive: true });
  mkdirSync(join(d, 'node_modules'), { recursive: true });
  writeFileSync(join(d, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n');
  spawnSync('git', ['-C', d, 'add', '-A']);
  spawnSync('git', ['-C', d, 'commit', '-qm', 'init']);
  writeFileSync(join(d, '.codegraph', 'codegraph.db'), 'SQLite format 3\0');
  // Force the db to be strictly newer than the sources, without sleeping.
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(d, 'a.ts'), past, past);
  const now = new Date();
  utimesSync(join(d, '.codegraph', 'codegraph.db'), now, now);
  return d;
}

/** Touch a path so it becomes strictly newer than the index db. */
function makeNewerThanIndex(repo: string, rel: string) {
  const p = join(repo, rel);
  writeFileSync(p, 'touched\n');
  const future = new Date(Date.now() + 60_000);
  utimesSync(p, future, future);
}

function run(repo: string, reason = 'test'): string {
  const r = spawnSync('bash', [REINDEX_SH, repo, reason], { encoding: 'utf8', timeout: 60_000 });
  return (r.stdout || '') + (r.stderr || '');
}

describe('codegraph-reindex.sh — dirty check', () => {
  it('SKIPS the rebuild when nothing is newer than the index', () => {
    const out = run(repoWithFreshIndex());
    expect(out).toMatch(/index is CLEAN/);
    expect(out, 'a clean tree paid for a full rebuild').not.toMatch(/reindexed/);
  });

  it('node_modules churn alone does NOT make the index dirty', () => {
    const repo = repoWithFreshIndex();
    makeNewerThanIndex(repo, 'node_modules/junk.js');
    expect(run(repo)).toMatch(/index is CLEAN/);
  });

  it('.git churn alone does NOT make the index dirty — .git moves on every git op', () => {
    const repo = repoWithFreshIndex();
    makeNewerThanIndex(repo, '.git/index');
    expect(
      run(repo),
      'including .git would make the answer permanently "dirty", rebuilding on every single commit',
    ).toMatch(/index is CLEAN/);
  });

  it('THE FIX: a real source write DOES make the index dirty', () => {
    const repo = repoWithFreshIndex();
    makeNewerThanIndex(repo, 'b.ts');
    const out = run(repo);
    expect(out).toMatch(/index is DIRTY/);
    expect(out).toMatch(/b\.ts/);
  });

  it('is extension-agnostic — a non-.ts source file also marks it dirty (no hardcoded stack facts)', () => {
    const repo = repoWithFreshIndex();
    makeNewerThanIndex(repo, 'thing.py');
    expect(run(repo)).toMatch(/index is DIRTY/);
  });

  it('EPAM_CODEGRAPH_REINDEX_FORCE=1 bypasses the dirty check', () => {
    const repo = repoWithFreshIndex();
    const r = spawnSync('bash', [REINDEX_SH, repo, 'forced'], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, EPAM_CODEGRAPH_REINDEX_FORCE: '1' },
    });
    expect((r.stdout || '') + (r.stderr || '')).not.toMatch(/index is CLEAN/);
  });
});

describe('codegraph-reindex.sh — never blocks the pipeline', () => {
  it('exits 0 for a missing repo path', () => {
    const r = spawnSync('bash', [REINDEX_SH, '/no/such/repo', 'test'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  it('exits 0 when no repo path is given at all', () => {
    const r = spawnSync('bash', [REINDEX_SH], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  it('exits 0, and does nothing, for a repo that has no index to refresh', () => {
    const d = mkdtempSync(join(tmpdir(), 'cg-noindex-'));
    dirs.push(d);
    writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n');
    const r = spawnSync('bash', [REINDEX_SH, d, 'test'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect((r.stdout || '') + (r.stderr || '')).toMatch(/no existing index/);
  });

  it('honours the EPAM_CODEGRAPH_REINDEX_ENABLED=0 opt-out', () => {
    const r = spawnSync('bash', [REINDEX_SH, repoWithFreshIndex(), 'test'], {
      encoding: 'utf8',
      env: { ...process.env, EPAM_CODEGRAPH_REINDEX_ENABLED: '0' },
    });
    expect(r.status).toBe(0);
    expect((r.stdout || '') + (r.stderr || '')).toMatch(/disabled via EPAM_CODEGRAPH_REINDEX_ENABLED/);
  });
});

describe('the reindex is wired to every local-commit site that writes reviewable code', () => {
  const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

  it('commit_completed_story (the writer\'s own commit) triggers it', () => {
    expect(read('orchestrations/scripts/lib/git-ops.sh')).toMatch(/codegraph-reindex\.sh/);
  });

  it('the repro-test-writer\'s commit triggers it', () => {
    expect(read('orchestrations/scripts/brownfield-repro-test-writer.sh')).toMatch(/codegraph-reindex\.sh/);
  });

  it('the invalidated-test updater\'s commit triggers it', () => {
    expect(read('orchestrations/scripts/update-invalidated-tests.sh')).toMatch(/codegraph-reindex\.sh/);
  });

  /**
   * REGRESSION GUARD. The first cut of this change inserted the hook between
   * `_commit_output=$(git ... commit ...)` and `_commit_rc=$?`, so $? captured
   * the REINDEX's exit code instead of the commit's — silently turning every
   * failed commit into a "success". Caught before it shipped; this keeps it
   * caught. The hook must never sit between a command and its $? capture.
   */
  it('never sits between a git commit and its $? capture', () => {
    for (const f of [
      'orchestrations/scripts/lib/git-ops.sh',
      'orchestrations/scripts/brownfield-repro-test-writer.sh',
      'orchestrations/scripts/update-invalidated-tests.sh',
    ]) {
      const lines = read(f).split('\n');
      lines.forEach((line, i) => {
        if (!/_commit_rc=\$\?/.test(line)) return;
        // Walk back to the nearest non-blank, non-comment line — it must be
        // the git commit itself, never the reindex hook.
        let j = i - 1;
        while (j >= 0 && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j--;
        expect(
          lines[j],
          `${f}:${i + 1} — something was inserted between the commit and its $? capture`,
        ).not.toMatch(/codegraph-reindex/);
      });
    }
  });
});
