/**
 * THE SCOPE GUARD EXISTS TO STOP ONE STORY OVERWRITING ANOTHER'S WORK — NOT TO STOP WORK.
 *
 * EPAM_ALLOWED_WRITE_PATHS is built from the story's declared files plus the detective's fix
 * sites, and WriteFile refuses anything outside that set. Its stated purpose, from the code:
 * "prevents scaffold agents from overwriting core-phase implementations with incompatible stubs".
 *
 * Live 2026-08-10 it did something else. The feature needed a type added to a file the ticket
 * never declared and the detective never listed, so the write was refused in under a millisecond:
 *
 *     write_file  src/interface/contentstack.ts   ok=false   ms=1
 *     write_file  package.json                    ok=false   ms=0
 *
 * The run's own log agreed the file belonged to nobody:
 *
 *     [Escalation] Could not resolve an owning story for .../src/interface/contentstack.ts
 *
 * There was no conflict to prevent. The writer routed around the manifest block by shelling out
 * to the package manager — which is why that file changed anyway — and had no route around the
 * type file. It then rewrote the ONE file it was allowed to touch 32 times in a single attempt
 * (6 distinct content sizes), driving the attempt from 7.1M to 11.7M input tokens.
 *
 * So the guard turned "this file is not on a list" into an unrecoverable dead end, and the cost
 * of the dead end was a thrash loop.
 *
 * THE RULE THAT ACTUALLY MATCHES THE PURPOSE: refuse a write that would take another story's
 * file. Permit a write to a file no other story owns, and RECORD it, so the widening is visible
 * rather than silent. Ownership is data the PRD already carries; nothing here needs to know what
 * kind of file it is.
 *
 * NO STACK FACTS, NO PATH LISTS. Nothing here or in the implementation names a file, an
 * extension, a directory or a language. Ownership comes from the story set; the engine perimeter
 * and the settings guard are untouched, because those refuse writes for reasons that have nothing
 * to do with scope.
 *
 * Written BEFORE the implementation.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WriteFileTool } from '../../../src/tools/builtin/WriteFile.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const SAVED = { ...process.env };
beforeEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'scope-')); dirs.push(dir);
  mkdirSync(join(dir, 'a'), { recursive: true });
  mkdirSync(join(dir, 'b'), { recursive: true });
  for (const f of ['a/mine.x', 'a/also-mine.x', 'b/theirs.x', 'b/unowned.x']) {
    writeFileSync(join(dir, f), 'original\n');
  }
  return dir;
}

const write = (path: string) =>
  new WriteFileTool().execute({ path, content: 'written by the story\n' });

describe('the guard still refuses what it was built to refuse', () => {
  it('a file owned by ANOTHER story is refused', async () => {
    const dir = project();
    process.env.EPAM_ALLOWED_WRITE_PATHS = join(dir, 'a/mine.x');
    process.env.EPAM_STORY_OWNERSHIP_KNOWN = '1';
    process.env.EPAM_OTHER_STORY_PATHS = join(dir, 'b/theirs.x');
    const r = await write(join(dir, 'b/theirs.x'));
    expect(r.isError, 'a story overwrote another story\'s file — the case the guard exists for').toBe(true);
    expect(readFileSync(join(dir, 'b/theirs.x'), 'utf8')).toBe('original\n');
  });

  it('a file inside the story scope is permitted, as before', async () => {
    const dir = project();
    process.env.EPAM_ALLOWED_WRITE_PATHS = join(dir, 'a/mine.x');
    const r = await write(join(dir, 'a/mine.x'));
    expect(r.isError).not.toBe(true);
    expect(readFileSync(join(dir, 'a/mine.x'), 'utf8')).toContain('written by the story');
  });
});

describe('THE DEFECT: an unowned file is necessary work, not theft', () => {
  it('a file no other story owns is PERMITTED', async () => {
    const dir = project();
    process.env.EPAM_ALLOWED_WRITE_PATHS = join(dir, 'a/mine.x');
    process.env.EPAM_STORY_OWNERSHIP_KNOWN = '1';
    process.env.EPAM_OTHER_STORY_PATHS = join(dir, 'b/theirs.x');
    const r = await write(join(dir, 'b/unowned.x'));
    expect(
      r.isError,
      'the write was refused although no story owns the file — this is the dead end that ' +
      'produced 32 rewrites of a single file in one attempt',
    ).not.toBe(true);
    expect(readFileSync(join(dir, 'b/unowned.x'), 'utf8')).toContain('written by the story');
  });

  it('permitting an unowned file is RECORDED, not silent', async () => {
    // A widening nobody can see is how scope quietly stops meaning anything.
    const dir = project();
    const audit = join(dir, 'scope-widened.log');
    process.env.EPAM_ALLOWED_WRITE_PATHS = join(dir, 'a/mine.x');
    process.env.EPAM_STORY_OWNERSHIP_KNOWN = '1';
    process.env.EPAM_OTHER_STORY_PATHS = join(dir, 'b/theirs.x');
    process.env.EPAM_SCOPE_WIDENING_LOG = audit;
    await write(join(dir, 'b/unowned.x'));
    expect(existsSync(audit), 'the widening left no record').toBe(true);
    expect(readFileSync(audit, 'utf8')).toContain('unowned.x');
  });

  it('an in-scope write is NOT recorded as a widening', async () => {
    const dir = project();
    const audit = join(dir, 'scope-widened.log');
    process.env.EPAM_ALLOWED_WRITE_PATHS = join(dir, 'a/mine.x');
    process.env.EPAM_SCOPE_WIDENING_LOG = audit;
    await write(join(dir, 'a/mine.x'));
    expect(
      existsSync(audit) ? readFileSync(audit, 'utf8') : '',
      'ordinary in-scope writes are being logged as widenings, which makes the record useless',
    ).not.toContain('mine.x');
  });
});

describe('absent ownership data must not silently disable the guard', () => {
  it('with no ownership data, an out-of-scope write is still refused', async () => {
    // Unknown ownership is not "owned by nobody". Failing open here would turn the guard off
    // for every caller that forgets to pass the data.
    const dir = project();
    process.env.EPAM_ALLOWED_WRITE_PATHS = join(dir, 'a/mine.x');
    delete process.env.EPAM_OTHER_STORY_PATHS;
    const r = await write(join(dir, 'b/unowned.x'));
    expect(
      r.isError,
      'ownership was unknown and the write was allowed anyway — the guard is now off by default',
    ).toBe(true);
  });

  it('an empty list WITHOUT the computed marker is unknown, and refuses', async () => {
    const dir = project();
    process.env.EPAM_ALLOWED_WRITE_PATHS = join(dir, 'a/mine.x');
    process.env.EPAM_OTHER_STORY_PATHS = '';
    delete process.env.EPAM_STORY_OWNERSHIP_KNOWN;
    const r = await write(join(dir, 'b/unowned.x'));
    expect(r.isError).toBe(true);
  });

  it('an empty list WITH the marker means nobody owns it — a single-story PRD', async () => {
    // The live PRD has exactly one story, so the other-story set is legitimately empty. Reading
    // that as "unknown" would have left the guard refusing and the fix inert on the very run it
    // was written for.
    const dir = project();
    process.env.EPAM_ALLOWED_WRITE_PATHS = join(dir, 'a/mine.x');
    process.env.EPAM_OTHER_STORY_PATHS = '';
    process.env.EPAM_STORY_OWNERSHIP_KNOWN = '1';
    const r = await write(join(dir, 'b/unowned.x'));
    expect(
      r.isError,
      'a single-story PRD could not widen scope, so the fix does nothing on the run it targets',
    ).not.toBe(true);
  });

  it('with no scope set at all, nothing is restricted — today behaviour', async () => {
    const dir = project();
    delete process.env.EPAM_ALLOWED_WRITE_PATHS;
    const r = await write(join(dir, 'b/unowned.x'));
    expect(r.isError).not.toBe(true);
  });
});

describe('no stack facts entered the guard', () => {
  it('the guard names no extension, filename or language', () => {
    const src = readFileSync(join(__dirname, '../../../src/tools/builtin/WriteFile.ts'), 'utf8');
    const code = src.split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
      .join('\n');
    for (const banned of ['.tsx', 'package.json', 'interface/', 'typescript']) {
      expect(code, `'${banned}' is hardcoded in a guard that must be stack-agnostic`).not.toContain(banned);
    }
  });
});
