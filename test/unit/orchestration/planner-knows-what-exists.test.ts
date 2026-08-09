/**
 * THE PLANNER WAS NEVER TOLD THE REPOSITORY ALREADY EXISTS.
 *
 * Live 2026-08-09, AMSD-2041. The writer's plan was ten steps of "Create
 * src/services/contentstack.ts", "Create src/services/pageService.ts", "Create src/pages/_app.tsx"
 * — every one of those files already exists, and their full contents were injected into the same
 * prompt under "## Existing File Contents". The writer received both halves of a contradiction:
 *
 *     CRITICAL — these files already exist. Their real content is injected below.
 *     1. Create src/services/contentstack.ts ...
 *
 * It wrote nothing that attempt.
 *
 * The cause is in run_planning_phase's prompt. The planner is given the story title, the
 * acceptance criteria, dependency contracts, and a bare path list under the heading "Files to
 * Create/Modify". It is never told which of those paths exist, and it cannot know that
 * pageService.ts already has 537 lines in it. Given that heading and that list, "Create
 * src/services/pageService.ts" is the reasonable output.
 *
 * THE FIX IS FACTUAL, NOT LEXICAL. An earlier draft of this check scanned plan steps for
 * create-ish verbs, which lib/guard-vocabulary.js forbids in terms this project has already paid
 * to learn: "a deterministic guard may be deterministic in ENFORCEMENT and REPRODUCIBILITY. Its
 * CONTENT may never be hardcoded — not in engine code, not in config, not as a 'generic' list
 * somebody promises to maintain." A verb list catches the incident it was built from and turns
 * "unchecked" into "checked".
 *
 * So nothing here matches words. The filesystem is asked which declared paths exist, and the
 * planner is told. Existence is a fact, derived per story, naming no domain and no vocabulary.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Lifts the shipped helper and runs it against a real directory. */
function classify(declared: string[], existing: Record<string, number>) {
  const src = require('node:fs').readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf('_classify_declared_paths() {');
  expect(start, '_classify_declared_paths not found in claude.sh').toBeGreaterThan(-1);
  const fn = src.slice(start, src.indexOf('\n}\n', start) + 3);

  const root = mkdtempSync(join(tmpdir(), 'planpaths-')); dirs.push(root);
  for (const [rel, lines] of Object.entries(existing)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  }
  // The path list is passed as a real ARGV entry, not interpolated into the script text.
  // JSON.stringify('a\nb') yields a quoted string containing a literal backslash-n, so bash
  // received ONE argument named "src/a.ts\\nsrc/new.ts" — a path that cannot exist — and the
  // helper correctly reported it as new. The harness was lying to the function under test.
  return execFileSync('bash', ['-c',
    `PROJECT_ROOT=${JSON.stringify(root)}
${fn}
     _classify_declared_paths "$1"`,
    'classify',
    declared.join('\n'),
  ], { encoding: 'utf8' });
}

describe('the planner is told which declared paths already exist', () => {
  it('an existing file is listed as existing, with its size', () => {
    const out = classify(['src/a.ts'], { 'src/a.ts': 537 });
    expect(out).toMatch(/src\/a\.ts/);
    expect(out, 'the planner cannot tell a 537-line file from an empty path').toMatch(/537/);
  });

  it('a file that does not exist is listed separately', () => {
    const out = classify(['src/a.ts', 'src/new.ts'], { 'src/a.ts': 10 });
    const existingBlock = out.slice(0, out.search(/DO NOT EXIST/i));
    const newBlock = out.slice(out.search(/DO NOT EXIST/i));
    expect(existingBlock).toMatch(/src\/a\.ts/);
    expect(newBlock).toMatch(/src\/new\.ts/);
    expect(newBlock).not.toMatch(/src\/a\.ts/);
  });

  it('when everything exists it says so explicitly, rather than leaving a blank heading', () => {
    // A blank list under "files you may create" reads as "unknown", and the planner fills the
    // gap the way it did live.
    const out = classify(['src/a.ts'], { 'src/a.ts': 5 });
    expect(out).toMatch(/none/i);
  });

  it('when nothing exists yet — a genuine greenfield story — creation is still expressible', () => {
    // The correction must not make "create" unsayable: a new file has to be creatable.
    const out = classify(['src/new.ts'], {});
    const newBlock = out.slice(out.search(/DO NOT EXIST/i));
    expect(newBlock).toMatch(/src\/new\.ts/);
  });

  it('no declared paths at all produces no false claims', () => {
    const out = classify([], {});
    expect(out).toMatch(/none/i);
  });

  it('it matches no words — only the filesystem decides', () => {
    // The same path is classified purely on existence, whatever the story or the story's prose.
    const asExisting = classify(['src/x.ts'], { 'src/x.ts': 1 });
    const asNew = classify(['src/x.ts'], {});
    expect(asExisting.search(/DO NOT EXIST[\s\S]*src\/x\.ts/i)).toBe(-1);
    expect(asNew.search(/DO NOT EXIST[\s\S]*src\/x\.ts/i)).toBeGreaterThan(-1);
  });
});

describe('the planner prompt uses it', () => {
  const sh = () => require('node:fs').readFileSync(CLAUDE_SH, 'utf8');

  it('run_planning_phase calls the classifier', () => {
    const src = sh();
    const fn = src.slice(src.indexOf('run_planning_phase() {'), src.indexOf('\n}\n', src.indexOf('run_planning_phase() {')));
    expect(fn, 'the planner still gets a bare path list').toMatch(/_classify_declared_paths/);
  });

  it('the old ambiguous heading is gone', () => {
    const src = sh();
    const fn = src.slice(src.indexOf('run_planning_phase() {'), src.indexOf('\n}\n', src.indexOf('run_planning_phase() {')));
    expect(fn, '"Files to Create/Modify" invites the wrong verb for a file that exists')
      .not.toMatch(/Files to Create\/Modify/);
  });
});
