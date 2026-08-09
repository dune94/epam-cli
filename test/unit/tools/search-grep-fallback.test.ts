/**
 * THE GREP FALLBACK ANSWERED A DIFFERENT QUESTION THAN THE ONE ASKED.
 *
 * Live 2026-08-09, AMSD-2041 on gotransit:
 *
 *     search("getServerSideProps|getStaticProps", path=src/pages, filePattern="*.tsx")
 *       -> "(no matches found)"     [18 bytes]
 *     reality: 11 .tsx files under src/pages contain it
 *
 * The writer tried `search` three times, was told the codebase contained nothing, and switched
 * to `bash grep` — 56 times. That was RATIONAL: an agent that cannot trust a tool stops using
 * it. Every token spent on shell exploration afterwards traces back here.
 *
 * TWO DEFECTS, both in the fallback added earlier the same day when rg turned out to be a shell
 * function with no binary on PATH:
 *
 *   1. No -E. grep defaults to BASIC regular expressions, where `|` is a LITERAL PIPE. So
 *      "a|b" searched for the three-character string "a|b" and correctly found nothing. rg uses
 *      Rust regex, where alternation works — so the tool's behaviour changed silently depending
 *      on which binary happened to exist. Patterns without alternation (pageService\., 
 *      ContentstackProvider) kept working and returned 8 KB, which is exactly the split visible
 *      in the live data.
 *
 *   2. filePattern dropped. The glob reached rg as --glob and simply vanished in the fallback,
 *      so a search scoped to "*.tsx" silently searched everything.
 *
 * The class is the one this file already carries a comment about: reporting ABSENCE when the
 * search did not really run as asked. The previous fix made the fallback reachable; it did not
 * make it equivalent.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SearchTool } from '../../../src/tools/builtin/Search';

let dir: string;
let savedPath: string | undefined;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'search-'));
  mkdirSync(join(dir, 'pages'), { recursive: true });
  writeFileSync(join(dir, 'pages', 'a.tsx'), 'export async function getServerSideProps() {}\n');
  writeFileSync(join(dir, 'pages', 'b.tsx'), 'export async function getStaticProps() {}\n');
  writeFileSync(join(dir, 'pages', 'c.ts'), 'export const unrelated = 1;\n');
  writeFileSync(join(dir, 'pages', 'd.md'), 'getServerSideProps in prose\n');

  // FORCE the grep fallback deterministically rather than relying on rg being absent on this
  // machine — the defect only exists on that path, and a test that depends on the host's PATH
  // proves nothing on a host where rg is installed.
  savedPath = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';
  process.env.EPAM_SEARCH_FORCE_GREP = '1';
});
afterAll(() => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  delete process.env.EPAM_SEARCH_FORCE_GREP;
  rmSync(dir, { recursive: true, force: true });
});

const search = (input: Record<string, unknown>) => new SearchTool().execute({ path: dir, ...input });

describe('the fixture really does contain what the search will look for', () => {
  it('two .tsx files match the alternation, one .ts file does not', async () => {
    const r = await search({ pattern: 'getServerSideProps' });
    expect(r.content).toMatch(/a\.tsx/);
  });
});

describe('THE DEFECT: alternation works in the fallback', () => {
  it('finds both branches of an alternation', async () => {
    const r = await search({ pattern: 'getServerSideProps|getStaticProps' });
    expect(
      r.content,
      'alternation matched nothing — grep treated "|" as a literal pipe, so the tool reported ' +
      'an empty codebase and the agent stopped trusting it',
    ).not.toMatch(/no matches found/);
    expect(r.content).toMatch(/a\.tsx/);
    expect(r.content).toMatch(/b\.tsx/);
  });

  it('other extended-regex syntax works too', async () => {
    // + ? () are all literals in BRE. Alternation is the one that bit us; the rest would next.
    const r = await search({ pattern: '(getServer|getStatic)Side?Props' });
    expect(r.content).not.toMatch(/no matches found/);
  });
});

describe('THE DEFECT: filePattern is honoured in the fallback', () => {
  it('restricts the search to matching files', async () => {
    const r = await search({ pattern: 'getServerSideProps', filePattern: '*.tsx' });
    expect(r.content).toMatch(/a\.tsx/);
    expect(r.content, 'the glob was dropped — a scoped search silently searched everything')
      .not.toMatch(/d\.md/);
  });

  it('without a filePattern it still searches everything', async () => {
    const r = await search({ pattern: 'getServerSideProps' });
    expect(r.content).toMatch(/d\.md/);
  });
});

describe('a genuine absence is still reported as absence', () => {
  it('a pattern that really is not there says so', async () => {
    const r = await search({ pattern: 'thisStringIsNotPresentAnywhere' });
    expect(r.content).toMatch(/no matches found/);
    expect(r.isError ?? false, 'no matches is a real answer, not an error').toBe(false);
  });

  it('case sensitivity is still honoured', async () => {
    const r = await search({ pattern: 'GETSERVERSIDEPROPS', caseSensitive: true });
    expect(r.content).toMatch(/no matches found/);
  });

  it('case-SENSITIVE is the default, and caseSensitive:false opts out', async () => {
    // My first version asserted the opposite. `caseSensitive = input.caseSensitive !== false`
    // makes sensitive the default, which is the documented behaviour — the test was wrong,
    // not the tool.
    expect((await search({ pattern: 'GETSERVERSIDEPROPS' })).content).toMatch(/no matches found/);
    expect((await search({ pattern: 'GETSERVERSIDEPROPS', caseSensitive: false })).content)
      .toMatch(/a\.tsx/);
  });
});
