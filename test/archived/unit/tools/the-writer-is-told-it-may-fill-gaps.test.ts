/**
 * THE MECHANISM PERMITS IT; THE CONTRACT STILL SAYS IT IS FORBIDDEN.
 *
 * The scope guard now permits a write to a file no other story owns, because the declared
 * manifest cannot be trusted to be complete: it is produced by a model from a ticket, its
 * propagation is recorded in this codebase as non-deterministic, and it carries no per-codeline
 * data to be correct against three repositories. Measured on the live PRD: two declared files do
 * not exist in the target repo, three files the change genuinely needed were absent, and one
 * entry is duplicated.
 *
 * But the writer is still told the opposite. The prompt heading reads:
 *
 *     ## Files to Create/Modify (EXACT ABSOLUTE PATHS — write to these paths exactly)
 *
 * which presents the list as closed. Live 2026-08-10 the writer needed a file outside it, was
 * refused with a message that only listed the permitted paths, and — having no framing for "this
 * is a gap I may fill" — rewrote the ONE file it was allowed to touch 32 times in a single
 * attempt. A permission the agent does not know it has is not a permission.
 *
 * Two things must change together, and this file asserts both:
 *   1. The list is presented as a STARTING POINT, with the real boundary named (ownership).
 *   2. A refusal that does fire says WHICH case it is and what to do, because "another story owns
 *      this" and "I have no ownership data" are different situations with different remedies.
 *
 * NO STACK FACTS. Nothing names a file, extension, directory or language; the rule is about
 * ownership, which is data the PRD already carries.
 *
 * Written BEFORE the implementation.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WriteFileTool } from '../../../src/tools/builtin/WriteFile.js';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const SAVED = { ...process.env };
beforeEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'contract-')); dirs.push(dir);
  mkdirSync(join(dir, 'a'), { recursive: true });
  for (const f of ['a/mine.x', 'a/theirs.x', 'a/nobodys.x']) writeFileSync(join(dir, f), 'x\n');
  return dir;
}
// Wording now lives in the project catalog, not the engine (src/tools/messages.ts). Point at the
// shipped catalog, exactly as the runtime invocation does, so this asserts the words an agent
// really sees rather than words compiled into the tool.
const CATALOG = join(__dirname, '../../../orchestrations/config/agent-messages.json');
const write = (p: string) => {
  process.env.EPAM_AGENT_MESSAGE_CATALOG = CATALOG;
  return new WriteFileTool().execute({ path: p, content: 'c\n' });
};

describe('a refusal explains WHICH case it is', () => {
  it('taking another story\'s file says so, and names the remedy', async () => {
    const dir = project();
    process.env.EPAM_ALLOWED_WRITE_PATHS = join(dir, 'a/mine.x');
    process.env.EPAM_STORY_OWNERSHIP_KNOWN = '1';
    process.env.EPAM_OTHER_STORY_PATHS = join(dir, 'a/theirs.x');
    const r = await write(join(dir, 'a/theirs.x'));
    expect(r.isError).toBe(true);
    expect(
      String(r.content),
      'the message must say the file belongs to another story — "here are the permitted paths" ' +
      'reads as "never", which is what produced a rewrite loop instead of an escalation',
    ).toMatch(/another story|owned by/i);
  });

  it('unknown ownership is reported as unknown, not as a permanent wall', async () => {
    const dir = project();
    process.env.EPAM_ALLOWED_WRITE_PATHS = join(dir, 'a/mine.x');
    delete process.env.EPAM_STORY_OWNERSHIP_KNOWN;
    const r = await write(join(dir, 'a/nobodys.x'));
    expect(r.isError).toBe(true);
    expect(
      String(r.content),
      'the two refusal cases are indistinguishable, so neither the agent nor a human can tell a ' +
      'real conflict from missing data',
    ).toMatch(/could not be determined|not known|unknown/i);
  });

  it('the two refusals are not the same message', async () => {
    const dir = project();
    process.env.EPAM_ALLOWED_WRITE_PATHS = join(dir, 'a/mine.x');
    process.env.EPAM_STORY_OWNERSHIP_KNOWN = '1';
    process.env.EPAM_OTHER_STORY_PATHS = join(dir, 'a/theirs.x');
    const owned = String((await write(join(dir, 'a/theirs.x'))).content);
    delete process.env.EPAM_STORY_OWNERSHIP_KNOWN;
    const unknown = String((await write(join(dir, 'a/nobodys.x'))).content);
    expect(owned).not.toBe(unknown);
  });

  it('a permitted widening still produces no error', async () => {
    const dir = project();
    process.env.EPAM_ALLOWED_WRITE_PATHS = join(dir, 'a/mine.x');
    process.env.EPAM_STORY_OWNERSHIP_KNOWN = '1';
    process.env.EPAM_OTHER_STORY_PATHS = join(dir, 'a/theirs.x');
    expect((await write(join(dir, 'a/nobodys.x'))).isError).not.toBe(true);
  });
});

describe('the prompt presents the declared list as a starting point', () => {
  const heading = () => {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    const i = src.indexOf('## Files to Create/Modify');
    return src.slice(i, i + 700);
  };

  it('it no longer claims the list is exhaustive', () => {
    expect(
      heading(),
      'the heading still tells the writer to write to these paths exactly, so it will not use a ' +
      'permission it has',
    ).not.toContain('write to these paths exactly');
  });

  it('it states that other files may be written when no story owns them', () => {
    expect(heading()).toMatch(/no other story|not owned|owns/i);
  });

  it('it asks the writer to say what it added', () => {
    // A widening the writer does not report is one a reviewer has to discover.
    expect(heading()).toMatch(/say|report|state|name/i);
  });

  it('it names no file, extension or language', () => {
    for (const banned of ['.ts', '.tsx', 'package.json', 'typescript', 'react']) {
      expect(heading().toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });
});
