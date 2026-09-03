/**
 * THE CASSETTE STORE — recorded model turns on disk, so a rehearsal costs nothing.
 *
 * Its own header: every bug that killed a run that month was plumbing — an unbound variable, a
 * function used and never imported, an env var handed the wrong directory. None needed a model to
 * find, and all of them cost real tokens to find, because the only way to exercise the pipeline end
 * to end was to run it against paid APIs.
 *
 * So the store's correctness is what makes a £0 rehearsal possible. Its failure mode is silent by
 * construction: a seam whose turns cannot be found replays as "no recorded answer", which looks
 * exactly like a seam that legitimately said nothing.
 *
 * The filename encoding matters more than it looks. A seam name is not a safe filename — the
 * encode/decode pair must round-trip, or a recorded seam becomes unfindable and the rehearsal
 * silently skips it.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const store = require(join(S, 'lib/cassette-store.js'));

const cassette = () => mkdtempSync(join(tmpdir(), 'cassette-'));

describe('a seam name survives becoming a filename', () => {
  it.each([
    'team-lead-review',
    'spec-agent-openspec',
    'prd-change-reviewer',
    'impl-failure-analyst',
  ])('%s round-trips exactly', (seam) => {
    // A seam that does not round-trip becomes unfindable, and the rehearsal skips it in silence.
    const encoded = store.safeSeamFile(seam);
    expect(store.decodeSeamFile(encoded), `${seam} did not survive the round trip`).toBe(seam);
  });

  it('a name with characters a filename cannot carry still round-trips', () => {
    for (const seam of ['a/b', 'a:b', 'a b', 'a..b', '../escape']) {
      expect(store.decodeSeamFile(store.safeSeamFile(seam)),
        `${seam} did not survive the round trip`).toBe(seam);
    }
  });

  it('and the encoded name cannot escape the cassette directory', () => {
    // Traversal needs a SEPARATOR. The encoding escapes those, so '../../etc/passwd' becomes one
    // filename component that happens to contain dots — it cannot address a parent directory.
    const encoded = store.safeSeamFile('../../etc/passwd');
    expect(encoded, 'an encoded seam name still contains a path separator').not.toMatch(/[/\\]/);
    expect(store.decodeSeamFile(encoded), 'the escaped name does not round-trip')
      .toBe('../../etc/passwd');
  });
});

describe('turns are written and read back as the same turns', () => {
  it('a seam written is a seam found', () => {
    const dir = cassette();
    store.writeSeam(dir, 'team-lead-review', [
      { text: 'the first answer', toolCalls: [] },
      { text: 'the second answer', toolCalls: [] }]);
    expect(store.seamsIn(dir), 'the written seam is not listed').toContain('team-lead-review');
    const turns = store.turnsFor(dir, 'team-lead-review');
    expect(turns, 'the turns did not come back').toHaveLength(2);
    expect(turns[0].text).toBe('the first answer');
  });

  it('a seam that was never recorded returns NULL, not an empty list', () => {
    // The distinction the whole rehearsal rests on: null means "this seam was never recorded", and
    // an empty list would mean "it was recorded and said nothing". A replay must be able to tell a
    // silent turn from an absent one, or it substitutes silence for a missing recording.
    const dir = cassette();
    expect(store.turnsFor(dir, 'never-recorded'),
      'an unrecorded seam is indistinguishable from one that answered nothing').toBeNull();
    expect(store.seamsIn(dir)).toEqual([]);
  });

  it('a cassette directory that does not exist is REFUSED, and the reason names it', () => {
    // A rehearsal pointed at nothing must not quietly become a rehearsal of nothing.
    let msg = '';
    try { store.seamsIn('/no/such/cassette'); } catch (e) { msg = String((e as Error).message); }
    expect(msg, 'a missing cassette directory was treated as an empty one').not.toBe('');
    expect(msg, 'the refusal does not name the directory it looked in').toContain('/no/such/cassette');
  });

  it('several seams do not overwrite each other', () => {
    const dir = cassette();
    store.writeSeam(dir, 'seam-a', [{ text: 'A' }]);
    store.writeSeam(dir, 'seam-b', [{ text: 'B' }]);
    expect(store.seamsIn(dir).sort()).toEqual(['seam-a', 'seam-b']);
    expect(store.turnsFor(dir, 'seam-a')[0].text).toBe('A');
    expect(store.turnsFor(dir, 'seam-b')[0].text).toBe('B');
  });

  it('a turn carrying tool calls keeps them — a replay without them is a different answer', () => {
    const dir = cassette();
    store.writeSeam(dir, 'seam-a', [{ text: 'x', toolCalls: [{ name: 'read_file', args: { p: 'a' } }] }]);
    const [turn] = store.turnsFor(dir, 'seam-a');
    expect(JSON.stringify(turn.toolCalls), 'the tool calls were dropped on the way to disk')
      .toContain('read_file');
  });
});

describe('the manifest says what the cassette is', () => {
  it('a written manifest reads back', () => {
    const dir = cassette();
    store.writeManifest(dir, { session: 'sess-1', recordedAt: '2026-08-31T00:00:00Z' });
    const m = store.loadManifest(dir);
    expect(m.session, 'the manifest lost the session it came from').toBe('sess-1');
  });

  it('a MISSING manifest is REFUSED — provenance is not optional', () => {
    // Returning an empty object would let a replay proceed against a cassette nobody can trace to a
    // run, and a rehearsal whose provenance is unknown proves nothing about the run it imitates.
    let msg = '';
    try { store.loadManifest(cassette()); } catch (e) { msg = String((e as Error).message); }
    expect(msg, 'a cassette with no manifest was treated as a described one').toMatch(/manifest/i);
  });

  it('a CORRUPT manifest is refused too, and says which file', () => {
    const dir = cassette();
    writeFileSync(join(dir, 'manifest.json'), '{ not json');
    let msg = '';
    try { store.loadManifest(dir); } catch (e) { msg = String((e as Error).message); }
    expect(msg, 'a corrupt manifest was read as a valid one').toMatch(/manifest/i);
    expect(msg, 'the refusal does not name the file').toContain(dir);
  });
});
