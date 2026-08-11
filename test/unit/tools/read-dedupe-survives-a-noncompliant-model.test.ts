/**
 * READ DEDUPE WAS CORRECT AND STILL BROKE A LIVE RUN, BECAUSE THIRTEEN TESTS MODELLED ONLY
 * A COMPLIANT CALLER.
 *
 * The mechanism: ReadFile hashes the file's full text and, on a repeat read, returns a short
 * "you already have this" notice instead of the body. Measured need — 1,725 reads across 282
 * unique files in one run, 84% of them re-reads of content already sitting in the context
 * window, each one re-sent on every subsequent turn.
 *
 * Enabled live, it produced a writer that emitted `<read_file force="true" />` as literal TEXT,
 * wrote nothing, and burned the whole attempt. Every existing test passed throughout, because
 * every fixture drove a model that READ the notice and moved on. The defect lives entirely in
 * how a model REACTS to the notice, so a compliant stub cannot reach it.
 *
 * These fixtures are deliberately non-compliant. Each one models a way a real model got the
 * notice wrong, and asserts the run still makes progress rather than stalling.
 *
 * The flag stays OFF by default until this file is green — the notice is a prompt-visible
 * behaviour change, and a token optimisation that costs a whole attempt is not an optimisation.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReadFileTool } from '../../../src/tools/builtin/ReadFile';

const readFileTool = new ReadFileTool();

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dedupe-'));
  file = join(dir, 'contentstack.ts');
  writeFileSync(file, Array.from({ length: 200 }, (_, i) => `export const s${i} = ${i};`).join('\n'));
  process.env.EPAM_READ_DEDUPE = '1';
});
afterEach(() => {
  delete process.env.EPAM_READ_DEDUPE;
  rmSync(dir, { recursive: true, force: true });
});

const read = (extra: Record<string, unknown> = {}) =>
  readFileTool.execute({ path: file, ...extra } as never);

describe('the dedupe fires at all — otherwise every case below is vacuous', () => {
  it('the first read returns the file body', async () => {
    const r = await read();
    expect(r.content).toContain('export const s0');
    expect(r.content.length).toBeGreaterThan(500);
  });

  it('the second read returns a short notice instead of the body', async () => {
    await read();
    const r = await read();
    expect(r.content).not.toContain('export const s199');
    expect(r.content.length, 'the notice is longer than the file it replaced').toBeLessThan(500);
  });
});

describe('THE LIVE FAILURE: a model that mishandles the notice still makes progress', () => {
  it('a re-read with force returns the real body, not another notice', async () => {
    // The escape hatch has to work, or a model that legitimately needs the file again is stuck.
    await read();
    const r = await read({ force: true });
    expect(r.content, 'force did not restore the body — the model has no way back').toContain('export const s0');
  });

  it('force passed as the STRING "true" is honoured', async () => {
    // Live: the writer emitted force="true" from an XML-ish tool syntax, so it arrived as a
    // string. A strict `=== true` check silently ignored it and returned the notice again,
    // which is what produced the loop.
    await read();
    const r = await read({ force: 'true' });
    expect(
      r.content,
      'a string "true" was ignored, so the model asked again and got the notice again — the loop',
    ).toContain('export const s0');
  });

  it('the notice asks NOTHING of the model', async () => {
    // This test previously asserted the OPPOSITE — that the notice must name `force`. That was
    // wrong, and it is the reason the live failure was reproducible but not prevented: the fixture
    // mandated the very instruction the writer could not execute, emitting `<read_file
    // force="true" />` as literal text until the attempt died. A notice whose escape hatch is a
    // parameter only works for a model that already behaves; the models that need the hatch are
    // exactly the ones that cannot use it.
    await read();
    const r = await read();
    expect(
      r.content.toLowerCase(),
      'the notice instructs the model to emit a parameter — the failure mode this file exists for',
    ).not.toContain('force');
  });

  it('asking AGAIN after the notice returns the body, with no special syntax', async () => {
    // The second request is the escape hatch. Compaction can genuinely evict earlier output, so
    // a repeat ask is evidence the model no longer holds the file — not disobedience.
    await read();
    const notice = await read();
    expect(notice.content, 'first duplicate should be suppressed').not.toContain('export const s0');

    const recovered = await read();
    expect(
      recovered.content,
      'a plain repeat request did not restore the body — the model has no way back that does ' +
      'not depend on it emitting a parameter correctly',
    ).toContain('export const s0');
  });

  it('recovery does not make the file permanently exempt from dedupe', async () => {
    // Serving on the repeat must reset the counter, not disable dedupe for that path — otherwise
    // one recovery turns the largest cost term back on for the rest of the attempt.
    await read();
    await read();            // notice
    await read();            // recovery — body served
    const r = await read();  // next duplicate must be suppressed again
    expect(
      r.content,
      'dedupe stopped applying to this path after one recovery',
    ).not.toContain('export const s0');
  });

  it('the notice is not mistakable for file content', async () => {
    await read();
    const r = await read();
    expect(r.isError).not.toBe(true);
    expect(r.content).toMatch(/already|unchanged|previously/i);
  });

  it('a changed file is served fresh, not deduped against a stale hash', async () => {
    await read();
    writeFileSync(file, 'export const CHANGED = true;\n');
    const r = await read();
    expect(
      r.content,
      'the writer edited the file and was handed the pre-edit notice — it cannot see its own work',
    ).toContain('CHANGED');
  });

  it('a windowed read after a full read is not silently deduped to nothing', async () => {
    await read();
    const r = await read({ startLine: 1, endLine: 3 });
    expect(r.content.length).toBeGreaterThan(0);
  });
});

describe('the flag is off until this file proves the notice is survivable', () => {
  it('dedupe is opt-in, never on by default', async () => {
    delete process.env.EPAM_READ_DEDUPE;
    await read();
    const r = await read();
    expect(
      r.content,
      'the default flipped while the non-compliant cases were still unproven',
    ).toContain('export const s0');
  });
});
