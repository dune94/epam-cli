/**
 * A HANDLER EITHER READS ITS INPUT OR SAYS IT COULD NOT.
 *
 * lib/handlers/* are shelled out to for decisions, and they are handed whatever the filesystem
 * holds at that moment: a file a dead step never wrote, a half-written one, a log line where JSON
 * was expected. Ten of them threw a raw node stack; eight printed a confident value anyway.
 *
 * roster-size.js is the one that shows why it matters. Its own header: "Guards the skip-the-mint
 * path: skipping the mint with no roster on disk would hand every story to an agent that was never
 * defined." Handed unparseable JSON it printed 0 and exited 0 — so a CORRUPT roster reads exactly
 * like an EMPTY one, and the guard waves the run through.
 *
 * readJsonOrRefuse is the single answer: a parsed value, or a stated refusal and a non-zero exit.
 * Never a stack trace, never a plausible number nobody computed.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const HELPER = join(REPO, 'orchestrations/scripts/lib/handlers/_read-input.js');

/** Call the helper in a child, so the exit code is real rather than mocked. */
function readWith(body: string | null) {
  const work = mkdtempSync(join(tmpdir(), 'readinput-'));
  let file = join(work, 'missing.json');
  if (body !== null) { file = join(work, 'in.json'); writeFileSync(file, body); }
  const r = spawnSync(process.execPath, ['-e', `
    const { readJsonOrRefuse } = require(${JSON.stringify(HELPER)});
    const v = readJsonOrRefuse(${JSON.stringify(file)}, 'the thing under test');
    process.stdout.write(JSON.stringify(v));
  `], { encoding: 'utf8', timeout: 60000 });
  return { code: r.status ?? -1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

describe('a handler input is read or refused', () => {
  it('valid json is returned as-is', () => {
    const r = readWith('{"agents":{"a":{}}}');
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ agents: { a: {} } });
  }, 60_000);

  it('a missing file refuses, names the path, and exits non-zero', () => {
    const r = readWith(null);
    expect(r.code, 'a missing input was treated as readable').not.toBe(0);
    expect(r.stderr, 'the refusal does not name what it could not read')
      .toMatch(/the thing under test/);
    expect(r.stderr, 'it printed a raw stack instead of a diagnosis').not.toMatch(/^\s+at /m);
  }, 60_000);

  it('unparseable content refuses rather than returning a default', () => {
    // The roster-size case: a corrupt file must not read as an empty one.
    const r = readWith('this is a log line, not json');
    expect(r.code, 'unparseable input was accepted').not.toBe(0);
    expect(r.stderr).toMatch(/could not be parsed|not valid JSON/i);
  }, 60_000);

  it('json null refuses — it is not an object to read fields from', () => {
    // Ten handlers threw "Cannot read properties of null" on exactly this.
    const r = readWith('null');
    expect(r.code, 'json null was passed through to be dereferenced').not.toBe(0);
  }, 60_000);

  it('an empty file refuses', () => {
    const r = readWith('');
    expect(r.code, 'an empty file was treated as valid input').not.toBe(0);
  }, 60_000);

  it('the wrong SHAPE is refused, naming what was wanted and what arrived', () => {
    // Valid JSON of the wrong shape is the second half of the class: `{}` where an array was
    // expected produced "results.forEach is not a function" — a node internal, mid-run, with no
    // statement of which file was wrong or what it should have held.
    const work = mkdtempSync(join(tmpdir(), 'shape-'));
    const file = join(work, 'in.json');
    writeFileSync(file, '{}');
    const r = spawnSync(process.execPath, ['-e', `
      const { readJsonOrRefuse } = require(${JSON.stringify(HELPER)});
      readJsonOrRefuse(${JSON.stringify(file)}, 'the AC gate results', { expect: 'array' });
    `], { encoding: 'utf8', timeout: 60000 });
    expect(r.status, 'an object was accepted where an array was declared').not.toBe(0);
    expect(r.stderr, 'the refusal does not say what shape was expected').toMatch(/array/i);
    expect(r.stderr, 'the refusal does not say what actually arrived').toMatch(/object/i);
  }, 60_000);

  it('and the shape it declares is still accepted', () => {
    // The negative half: declaring a shape must not refuse the shape it declared.
    const work = mkdtempSync(join(tmpdir(), 'shape-ok-'));
    const file = join(work, 'in.json');
    writeFileSync(file, '[1,2,3]');
    const r = spawnSync(process.execPath, ['-e', `
      const { readJsonOrRefuse } = require(${JSON.stringify(HELPER)});
      process.stdout.write(String(readJsonOrRefuse(${JSON.stringify(file)}, 'x', { expect: 'array' }).length));
    `], { encoding: 'utf8', timeout: 60000 });
    expect(r.status, r.stderr).toBe(0);
    expect((r.stdout || '').trim()).toBe('3');
  }, 60_000);

  it('and a legitimately empty structure is NOT refused', () => {
    // The negative half: {} and [] are real answers, not failures. Refusing them would break every
    // handler whose input is legitimately empty.
    expect(readWith('{}').code, 'an empty object was refused').toBe(0);
    expect(readWith('[]').code, 'an empty array was refused').toBe(0);
  }, 60_000);
});
