/**
 * read_file IGNORED THE LINE RANGE AND RETURNED THE WHOLE FILE.
 *
 * Live 2026-08-09. The writer sent startLine on 20+ calls:
 *
 *     {path: ".../pageService.ts", startLine: "400"}
 *     {path: ".../pageService.ts", startLine: "450"}
 *     {path: ".../pageService.ts", startLine: "390", endLine: "537"}
 *
 * read_file has no such parameter. Every one of those returned the ENTIRE 537-line file, ~5.7 KB
 * a time. The agent believed it was paging through a large file 50 lines at a time and was in
 * fact handed all 537 lines on each call — then asked again, because it never received the
 * window it asked for.
 *
 * That is the second, independent contributor to the 1.1 MB of read_file traffic measured in one
 * attempt, and it is why the reads looked like exploration rather than repetition. Content-hash
 * dedupe (committed alongside) stops the same bytes being re-sent; this stops the wrong bytes
 * being sent in the first place.
 *
 * The tool's own sibling already models the contract: codegraph_query's "show" mode takes
 * "<file> [startLine] [endLine]" and caps the window. An agent moving between the two should not
 * have to learn that one honours ranges and the other silently does not.
 *
 * NOTE THE STRING ARGUMENTS. The live calls sent startLine: "400", not 400 — models emit JSON
 * numbers as strings routinely, and a parameter that only works when the type is exactly right
 * is a parameter that mostly does not work.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReadFileTool } from '../../../src/tools/builtin/ReadFile';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A file whose every line names its own number, so a window is checkable exactly. */
function fixture(lines = 537) {
  const dir = mkdtempSync(join(tmpdir(), 'readrange-')); dirs.push(dir);
  const file = join(dir, 'pageService.ts');
  writeFileSync(file, Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  return file;
}
const read = (input: Record<string, unknown>) => new ReadFileTool().execute(input);

describe('the whole file is still the default', () => {
  it('no range returns everything', async () => {
    const r = await read({ path: fixture() });
    expect(r.content).toMatch(/^line 1$/m);
    expect(r.content).toMatch(/^line 537$/m);
  });
});

describe('THE DEFECT: a requested window is the window returned', () => {
  it('startLine skips everything before it', async () => {
    const r = await read({ path: fixture(), startLine: 400 });
    expect(r.content, 'the range was ignored and the whole file came back').not.toMatch(/^line 399$/m);
    expect(r.content).toMatch(/^line 400$/m);
    expect(r.content).toMatch(/^line 537$/m);
  });

  it('endLine stops there', async () => {
    const r = await read({ path: fixture(), startLine: 390, endLine: 400 });
    expect(r.content).toMatch(/^line 390$/m);
    expect(r.content).toMatch(/^line 400$/m);
    expect(r.content).not.toMatch(/^line 401$/m);
    expect(r.content).not.toMatch(/^line 389$/m);
  });

  it('the window is dramatically smaller than the file', async () => {
    const whole = await read({ path: fixture() });
    const window = await read({ path: fixture(), startLine: 400, endLine: 410 });
    expect(window.content.length).toBeLessThan(whole.content.length / 10);
  });

  it('STRING line numbers work — models send "400", not 400', async () => {
    const r = await read({ path: fixture(), startLine: '400', endLine: '410' });
    expect(r.content, 'the live calls all sent strings and every one was ignored')
      .not.toMatch(/^line 399$/m);
    expect(r.content).toMatch(/^line 400$/m);
    expect(r.content).not.toMatch(/^line 411$/m);
  });

  it('says which window it returned, so the agent knows what it did not see', async () => {
    const r = await read({ path: fixture(), startLine: 400, endLine: 410 });
    expect(r.content).toMatch(/400/);
    expect(r.content).toMatch(/537|lines/i);
  });
});

describe('bad ranges are refused, not silently reinterpreted', () => {
  it('a non-numeric line number is an error naming the field', async () => {
    const r = await read({ path: fixture(), startLine: 'four hundred' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/startLine/);
  });

  it('endLine before startLine is refused', async () => {
    const r = await read({ path: fixture(), startLine: 400, endLine: 100 });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/endLine|startLine/);
  });

  it('a startLine past the end of the file says so rather than returning nothing', async () => {
    // Silence here reads as "the file ends before line 9000", which is a false statement about
    // the file rather than about the request.
    const r = await read({ path: fixture(40), startLine: 9000 });
    expect(r.content).toMatch(/40|beyond|past|only/i);
  });

  it('line numbers are 1-based, not 0-based', async () => {
    const r = await read({ path: fixture(10), startLine: 1, endLine: 1 });
    expect(r.content).toMatch(/^line 1$/m);
    expect(r.content).not.toMatch(/^line 2$/m);
  });
});

describe('it composes with the dedupe rather than fighting it', () => {
  it('a windowed read after a full read is still deduped — the content was already sent', async () => {
    process.env.EPAM_READ_DEDUPE = '1';
    try {
      const f = fixture();
      const tool = new ReadFileTool();
      await tool.execute({ path: f });
      const r = await tool.execute({ path: f, startLine: 400 });
      expect(r.content).toMatch(/already read|already have/i);
    } finally { delete process.env.EPAM_READ_DEDUPE; }
  });
});
