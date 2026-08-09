/**
 * THE FALLBACK SEARCHED 75,693 FILES rg WOULD HAVE SKIPPED.
 *
 * Live 2026-08-09, one call in the writer's run:
 *
 *     23:03:49.559  search(pattern, path=<repo root>)
 *     23:03:59.584  ok=false — "the search could not be run"
 *
 * Exactly 10.025s: the tool's own timeout. `grep -r` does not respect .gitignore, so a repo-root
 * search walks node_modules — 1.3 GB, 75,693 files in this codeline — while rg skips it. The
 * writer lost the call, re-scoped to src/, and moved on; the cost was bounded but the tool was
 * answering a different question than rg would have.
 *
 * Third inequivalence found in this one fallback, after the missing -E (alternation searched for
 * a literal pipe) and the dropped --include. Each time the fix made the fallback RUN; none made
 * it EQUIVALENT.
 *
 * NO EXCLUDE LIST. Hardcoding node_modules/dist/.next would be a list to maintain and would
 * drift from whatever a given repo actually ignores — the failure mode lib/guard-vocabulary.js
 * exists to stop. `git grep` derives it from the repository itself: it honours .gitignore
 * exactly as rg does, with --untracked so a file the writer just created is still found. At the
 * repo root of the live codeline it is 31ms against grep's 285ms, and the gap only widens as
 * node_modules grows.
 *
 * Outside a git work tree there is nothing to derive from, so plain grep -r remains the last
 * resort.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SearchTool } from '../../../src/tools/builtin/Search';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  delete process.env.EPAM_SEARCH_FORCE_GREP;
});
beforeAll(() => { process.env.EPAM_SEARCH_FORCE_GREP = '1'; });

/** A repo shaped like the live one: gitignored vendor dir holding the same needle. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'gitsearch-')); dirs.push(dir);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  mkdirSync(join(dir, 'src', 'pages'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  writeFileSync(join(dir, 'src', 'pages', 'a.tsx'), 'export async function getServerSideProps() {}\n');
  writeFileSync(join(dir, 'src', 'pages', 'b.tsx'), 'export async function getStaticProps() {}\n');
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'getServerSideProps in a dependency\n');
  git('init', '-q');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  git('add', '.'); git('commit', '-qm', 'base');
  return dir;
}
const search = (dir: string, input: Record<string, unknown>) =>
  new SearchTool().execute({ path: dir, ...input });

describe('the fixture reproduces the live shape', () => {
  it('the same needle exists in tracked source AND in a gitignored dependency', () => {
    const d = repo();
    expect(execFileSync('grep', ['-rl', 'getServerSideProps', d], { encoding: 'utf8' }))
      .toMatch(/node_modules/);
  });
});

describe('THE DEFECT: a gitignored dependency is not searched', () => {
  it('finds the tracked source', async () => {
    const r = await search(repo(), { pattern: 'getServerSideProps|getStaticProps' });
    expect(r.content).toMatch(/a\.tsx/);
    expect(r.content).toMatch(/b\.tsx/);
  });

  it('does NOT return hits from node_modules', async () => {
    const r = await search(repo(), { pattern: 'getServerSideProps' });
    expect(r.content, 'the search walked the dependency tree — the 10s timeout came from this')
      .not.toMatch(/node_modules/);
  });

  it('a file the writer JUST created is still found', async () => {
    // git grep defaults to tracked files only; --untracked is what keeps a brand-new file
    // visible. Without it this fix would hide the writer's own work from it.
    const d = repo();
    writeFileSync(join(d, 'src', 'brand-new.ts'), 'export const needleHere = 1;\n');
    const r = await search(d, { pattern: 'needleHere' });
    expect(r.content, 'a newly written file was invisible to search').toMatch(/brand-new\.ts/);
  });

  it('alternation still works — the earlier fix is not lost', async () => {
    const r = await search(repo(), { pattern: 'getServerSideProps|getStaticProps' });
    expect(r.content).not.toMatch(/no matches found/);
  });

  it('filePattern still scopes the search', async () => {
    const d = repo();
    writeFileSync(join(d, 'src', 'pages', 'c.md'), 'getServerSideProps in prose\n');
    const r = await search(d, { pattern: 'getServerSideProps', filePattern: '*.tsx' });
    expect(r.content).toMatch(/a\.tsx/);
    expect(r.content).not.toMatch(/c\.md/);
  });

  it('case sensitivity is preserved', async () => {
    const d = repo();
    expect((await search(d, { pattern: 'GETSERVERSIDEPROPS', caseSensitive: true })).content)
      .toMatch(/no matches found/);
    expect((await search(d, { pattern: 'GETSERVERSIDEPROPS', caseSensitive: false })).content)
      .toMatch(/a\.tsx/);
  });

  it('a genuine absence is still absence', async () => {
    const r = await search(repo(), { pattern: 'definitelyNotPresentAnywhere' });
    expect(r.content).toMatch(/no matches found/);
    expect(r.isError ?? false).toBe(false);
  });
});

describe('outside a git work tree there is nothing to derive from', () => {
  it('plain recursive search still works', async () => {
    const d = mkdtempSync(join(tmpdir(), 'nogit-')); dirs.push(d);
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'src', 'a.ts'), 'export const findMe = 1;\n');
    const r = await search(d, { pattern: 'findMe' });
    expect(r.content, 'a non-git directory became unsearchable').toMatch(/a\.ts/);
  });
});
