// THE CHECK WRITTEN TO CATCH AN EMPTY BRIEF FAILED ON THE HANDLER PRODUCING THE RIGHT ANSWER.
//
// preflight-static.sh check 5 exists because tc-story-context.py returned EMPTY for a brownfield
// story: the TC writer was invoked three times per run with an empty brief and wrote nothing, while
// its gate reported PASSED.
//
// The check took `stories[0]`, ran the handler, and called an empty result a failure. But the
// handler SKIPS a story that already has testCriteria.facts — correctly; there is nothing to brief.
// So once AMSD-2041 carried its 21 facts, the check failed on the handler doing exactly the right
// thing, and the pre-flight reported a defect that did not exist.
//
// That is the same shape as the defect it was written to catch, one level up: a check whose scope
// does not match its claim reports the wrong thing in BOTH directions — a false alarm here, and,
// had stories[0] happened to already have facts on the day of the real defect, silence then.
//
// It now asks about a story that actually needs a brief. The selector is a handler so this can be
// exercised directly: a check only ever provable by running the whole pre-flight against whatever
// PRD happens to be on disk is a check nobody can prove.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const SELECTOR = join(SCRIPTS, 'lib/handlers/tc-story-needing-context.js');
const CONTEXT = join(SCRIPTS, 'lib/handlers/tc-story-context.py');
const PREFLIGHT = join(SCRIPTS, 'preflight-static.sh');
const NODE = process.execPath;
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function prdFile(stories: Record<string, unknown>[]): string {
  const d = mkdtempSync(join(tmpdir(), 'tcctx-')); made.push(d);
  const p = join(d, 'prd.json');
  writeFileSync(p, JSON.stringify({
    implementationOrder: { core: stories.map((s) => s.id) },
    stories,
  }));
  return p;
}

function select(prd: string): { out: string; status: number } {
  const r = spawnSync(NODE, [SELECTOR, prd, 'core'], { encoding: 'utf8' });
  return { out: (r.stdout || '').trim(), status: r.status ?? -1 };
}

const story = (over: Record<string, unknown> = {}) => ({
  id: 'S-1',
  status: 'pending',
  storyKind: 'novel',
  agentRole: 'engineer',
  technicalNotes: { files: ['src/a.ts'] },
  verificationCriteria: ['the page renders published content'],
  testCriteria: { facts: [] },
  ...over,
});

describe('the selector answers what the check actually asks', () => {
  it('names a story that still needs criteria', () => {
    expect(select(prdFile([story()])).out).toBe('S-1');
  });

  it('names NOTHING when every story already has criteria — the live case that broke the check', () => {
    const p = prdFile([story({ testCriteria: { facts: ['already written'] } })]);
    expect(select(p).out, 'a story with 21 facts was reported as needing a brief').toBe('');
    expect(select(p).status, 'no-story-needs-criteria is a real state, not an error').toBe(0);
  });

  it('skips a deprecated story rather than briefing one that was abandoned', () => {
    expect(select(prdFile([story({ status: 'deprecated' })])).out).toBe('');
  });

  it('ignores a story outside the phase', () => {
    const d = mkdtempSync(join(tmpdir(), 'tcctx-p-')); made.push(d);
    const p = join(d, 'prd.json');
    writeFileSync(p, JSON.stringify({ implementationOrder: { other: ['S-1'] }, stories: [story()] }));
    expect(select(p).out).toBe('');
  });

  it('an UNREADABLE prd is an error, never a clean skip', () => {
    const d = mkdtempSync(join(tmpdir(), 'tcctx-bad-')); made.push(d);
    const p = join(d, 'prd.json');
    writeFileSync(p, '{ not json');
    const r = spawnSync(NODE, [SELECTOR, p, 'core'], { encoding: 'utf8' });
    expect(r.status, 'a broken PRD read as "nothing needs criteria"').toBe(2);
  });
});

describe('and the handler really does brief that story', () => {
  it('produces a non-empty context for the story the selector names', () => {
    // Both halves together are the check: the selector must find a subject, and the handler must
    // have something to say about it. Either alone passes while the pair is broken.
    const p = prdFile([story()]);
    const outDir = mkdtempSync(join(tmpdir(), 'tcctx-out-')); made.push(outDir);
    mkdirSync(join(outDir, 'work'), { recursive: true });
    const r = spawnSync('python3', [CONTEXT, outDir, p, 'core', 'S-1'], { encoding: 'utf8' });
    expect((r.stdout || '').length,
      'the TC writer would be invoked with an empty brief').toBeGreaterThan(20);
  });

  it('and says nothing about a story that already has criteria', () => {
    const p = prdFile([story({ testCriteria: { facts: ['already written'] } })]);
    const outDir = mkdtempSync(join(tmpdir(), 'tcctx-out2-')); made.push(outDir);
    mkdirSync(join(outDir, 'work'), { recursive: true });
    const r = spawnSync('python3', [CONTEXT, outDir, p, 'core', 'S-1'], { encoding: 'utf8' });
    expect((r.stdout || '').trim()).toBe('');
  });
});

describe('the pre-flight uses the selector rather than stories[0]', () => {
  it('calls the handler', () => {
    expect(readFileSync(PREFLIGHT, 'utf8')).toMatch(/tc-story-needing-context\.js/);
  });

  it('and reports the no-subject case as a SKIP, distinct from a pass', () => {
    const src = readFileSync(PREFLIGHT, 'utf8');
    const i = src.indexOf('tc-story-needing-context.js');
    expect(src.slice(i, i + 800)).toMatch(/skip/);
  });
});
