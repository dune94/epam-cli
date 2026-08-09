/**
 * RE-READING A FILE YOU ALREADY HAVE IS THE SINGLE BIGGEST TOKEN COST MEASURED.
 *
 * Live 2026-08-09, AMSD-2041, one attempt:
 *
 *     read_file   202 calls, 1.1 MB into context, avg 5.7 KB
 *     src/services/pageService.ts read 53 TIMES
 *
 * That one file is 537 lines and was ALREADY in the prompt, injected verbatim under
 * "## Existing File Contents". Roughly 300 KB of re-reading a file the model was handed.
 *
 * LoopDetector cannot see this and is not wrong not to. It hashes {tool + args}, and the reads
 * differ every time:
 *
 *     {path, startLine:"400"} {path, startLine:"450"} {path, startLine:"320"}
 *     {path, startLine:"390", endLine:"537"} {path} relative {path} absolute {path, encoding}
 *
 * Seven distinct fingerprints for one file. Its contract is "identical call", which it enforces
 * correctly and 15 tests pin. This is a different failure — not "stuck repeating an action" but
 * "re-acquiring context it already has" — so it needs a check that keys on WHAT WAS RETURNED
 * rather than HOW IT WAS ASKED FOR.
 *
 * IT MUST NEVER PERMANENTLY WITHHOLD. Context compaction can genuinely evict earlier content,
 * and an agent that truly no longer has the file must be able to get it. Every notice therefore
 * names an explicit escape hatch, and a file whose CONTENT CHANGED is always returned in full.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReadFileTool } from '../../../src/tools/builtin/ReadFile';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.EPAM_READ_DEDUPE;
});
beforeEach(() => { process.env.EPAM_READ_DEDUPE = '1'; });

function fixture(body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')) {
  const dir = mkdtempSync(join(tmpdir(), 'readdedupe-')); dirs.push(dir);
  const file = join(dir, 'pageService.ts');
  writeFileSync(file, body);
  return { dir, file };
}

const DEDUPED = /already read|already have/i;

describe('opt-in: nothing changes until the engine turns it on', () => {
  it('a repeat read returns full content with the flag unset', async () => {
    delete process.env.EPAM_READ_DEDUPE;
    const { file } = fixture();
    const tool = new ReadFileTool();
    await tool.execute({ path: file });
    const second = await tool.execute({ path: file });
    expect(second.content).toMatch(/line 1/);
    expect(second.content).not.toMatch(DEDUPED);
  });
});

describe('THE DEFECT: the same unchanged file is not sent twice', () => {
  it('the first read returns the real content', async () => {
    const { file } = fixture();
    const r = await new ReadFileTool().execute({ path: file });
    expect(r.content).toMatch(/line 1/);
    expect(r.content).toMatch(/line 40/);
  });

  it('the second read of an unchanged file returns a notice, not the bytes', async () => {
    const { file } = fixture();
    const tool = new ReadFileTool();
    const first = await tool.execute({ path: file });
    const second = await tool.execute({ path: file });
    expect(second.content, 'the file was sent twice').toMatch(DEDUPED);
    expect(second.content.length, 'the notice is not shorter than the content it replaces')
      .toBeLessThan(first.content.length);
  });

  it('a RANGE read after a full read is also deduped — the range was already sent', async () => {
    // The live shape: {path} then {path,startLine:400} then {path,startLine:450}.
    const { file } = fixture();
    const tool = new ReadFileTool();
    await tool.execute({ path: file });
    const r = await tool.execute({ path: file, startLine: 10, endLine: 20 });
    expect(r.content).toMatch(DEDUPED);
  });

  it('a relative and an absolute path to the same file are the same file', async () => {
    // {path:"src/services/pageService.ts"} and the absolute form were 13 reads of one file.
    const { dir, file } = fixture();
    const tool = new ReadFileTool();
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      await tool.execute({ path: file });
      const r = await tool.execute({ path: 'pageService.ts' });
      expect(r.content, 'the same file under two spellings was sent twice').toMatch(DEDUPED);
    } finally { process.chdir(cwd); }
  });

  it('an incidental argument does not defeat it', async () => {
    // {path, encoding:"utf-8"} — a default made explicit — was its own fingerprint.
    const { file } = fixture();
    const tool = new ReadFileTool();
    await tool.execute({ path: file });
    const r = await tool.execute({ path: file, encoding: 'utf-8' });
    expect(r.content).toMatch(DEDUPED);
  });
});

describe('it never permanently withholds', () => {
  it('a file whose content CHANGED is returned in full', async () => {
    const { file } = fixture();
    const tool = new ReadFileTool();
    await tool.execute({ path: file });
    writeFileSync(file, 'completely different content now\n');
    const r = await tool.execute({ path: file });
    expect(r.content, 'a changed file was suppressed — the agent would act on stale content')
      .toMatch(/completely different/);
    expect(r.content).not.toMatch(DEDUPED);
  });

  it('the notice tells the agent how to force a re-read', async () => {
    const { file } = fixture();
    const tool = new ReadFileTool();
    await tool.execute({ path: file });
    const r = await tool.execute({ path: file });
    expect(r.content, 'a dead end — compaction can evict content and the agent must recover')
      .toMatch(/force/i);
  });

  it('and forcing really does return the content', async () => {
    const { file } = fixture();
    const tool = new ReadFileTool();
    await tool.execute({ path: file });
    const r = await tool.execute({ path: file, force: true });
    expect(r.content).toMatch(/line 1/);
    expect(r.content).not.toMatch(DEDUPED);
  });

  it('a deduped read is not an error — it is a successful answer', async () => {
    const { file } = fixture();
    const tool = new ReadFileTool();
    await tool.execute({ path: file });
    const r = await tool.execute({ path: file });
    expect(r.isError ?? false).toBe(false);
  });
});

describe('scope', () => {
  it('a different file is unaffected', async () => {
    const { dir, file } = fixture();
    const other = join(dir, 'other.ts');
    writeFileSync(other, 'export const other = 1;\n');
    const tool = new ReadFileTool();
    await tool.execute({ path: file });
    const r = await tool.execute({ path: other });
    expect(r.content).toMatch(/export const other/);
  });

  it('a new tool instance has no memory — one attempt, one history', async () => {
    // createTools() builds a fresh ReadFileTool per process and one process is one attempt, so
    // instance state gives per-attempt isolation with no reset call, exactly as LoopDetector does.
    const { file } = fixture();
    await new ReadFileTool().execute({ path: file });
    const r = await new ReadFileTool().execute({ path: file });
    expect(r.content).toMatch(/line 1/);
  });

  it('a missing file still reports the real error', async () => {
    const r = await new ReadFileTool().execute({ path: '/nonexistent/nope.ts' });
    expect(r.isError).toBe(true);
  });
});
