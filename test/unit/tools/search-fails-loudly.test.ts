/**
 * A SEARCH THAT COULD NOT RUN MUST NOT REPORT "NO MATCHES".
 *
 * Search.ts tries ripgrep, and falls back to grep in a catch block:
 *
 *     result = await execa('rg', args, { reject: false, timeout: 10000 });
 *   } catch { ...grep... }
 *
 * `reject: false` tells execa NOT to throw on failure — it returns a result object instead. So
 * the catch never fires. A missing, broken or erroring rg yields `stdout: ''`, the fallback is
 * skipped, and the tool returns the string "(no matches found)".
 *
 * To the agent that is indistinguishable from a successful search of a repository that
 * genuinely contains nothing. It is the worst possible failure mode for a tool an agent uses
 * to decide what exists: it does not look, and it reports absence.
 *
 * This is not hypothetical harm. On 2026-08-08 an estate survey reported "all returned zero
 * matches ... no existing live preview infrastructure was found, meaning this is greenfield
 * work" for three codelines holding 243, 102 and 158 matching source files, and that verdict
 * was written into estate-survey.json for the detective to build on.
 *
 * The stub below is a real executable rg on PATH that exits non-zero, so the failure is
 * produced the way a broken install produces it rather than by mocking the module.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SearchTool } from '../../../src/tools/builtin/Search';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const ORIGINAL_PATH = process.env.PATH;
beforeEach(() => { process.env.PATH = ORIGINAL_PATH; });
afterEach(() => { process.env.PATH = ORIGINAL_PATH; });

/** A corpus containing the needle, so a working search must find it. */
function corpus() {
  const dir = mkdtempSync(join(tmpdir(), 'search-corpus-')); dirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'client.ts'), 'export const NEEDLE_TOKEN = 1;\n');
  writeFileSync(join(dir, 'src', 'other.ts'), 'const unrelated = 2;\n');
  return dir;
}

/** Puts a deliberately broken `rg` at the front of PATH. */
function breakRipgrep() {
  const bin = mkdtempSync(join(tmpdir(), 'broken-bin-')); dirs.push(bin);
  const rg = join(bin, 'rg');
  writeFileSync(rg, '#!/usr/bin/env bash\necho "rg: simulated failure" >&2\nexit 2\n');
  chmodSync(rg, 0o755);
  process.env.PATH = `${bin}:${ORIGINAL_PATH}`;
  return bin;
}

const run = (pattern: string, path: string) =>
  new (SearchTool as any)().execute({ pattern, path, caseSensitive: false });

describe('the harness is real — no vacuous pass', () => {
  it('a working search finds the needle', async () => {
    const r = await run('NEEDLE_TOKEN', corpus());
    expect(String(r.content)).toContain('NEEDLE_TOKEN');
    expect(String(r.content)).not.toBe('(no matches found)');
  });

  it('a genuine absence still reports no matches', async () => {
    const r = await run('THIS_STRING_IS_NOWHERE', corpus());
    expect(String(r.content).trim()).toBe('(no matches found)');
  });
});

describe('THE DEFECT: a broken ripgrep must not read as an empty repository', () => {
  it('the needle is still found when rg is broken — grep takes over', async () => {
    const dir = corpus();
    breakRipgrep();
    const r = await run('NEEDLE_TOKEN', dir);
    expect(
      String(r.content),
      'rg failed, the grep fallback never ran, and the tool reported an empty result for a ' +
      'directory that contains the match — an agent cannot tell this from a real absence',
    ).toContain('NEEDLE_TOKEN');
  });

  it('it does not silently claim "no matches found"', async () => {
    const dir = corpus();
    breakRipgrep();
    const r = await run('NEEDLE_TOKEN', dir);
    expect(String(r.content).trim()).not.toBe('(no matches found)');
  });

  it('when NEITHER searcher can run, it is an error — never a clean empty answer', async () => {
    const dir = corpus();
    const bin = mkdtempSync(join(tmpdir(), 'no-search-')); dirs.push(bin);
    for (const name of ['rg', 'grep']) {
      const p = join(bin, name);
      writeFileSync(p, '#!/usr/bin/env bash\necho "broken" >&2\nexit 2\n');
      chmodSync(p, 0o755);
    }
    process.env.PATH = bin;                       // nothing else resolvable
    const r = await run('NEEDLE_TOKEN', dir);
    expect(
      r.isError === true || !/^\(no matches found\)$/.test(String(r.content).trim()),
      'both searchers failed and the tool still answered "no matches found"',
    ).toBe(true);
  });
});
