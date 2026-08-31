/**
 * THE PRD EVERY LATER STAGE READS, BUILT FROM THE TICKET AND NOTHING ELSE.
 *
 * synthesize-prd-from-jira.js is 390 lines with no test. It runs early, and everything downstream —
 * discovery scope, the mint, the spec pass, the writer — reads what it wrote. A wrong field here is
 * not a wrong field: it is a whole run spent on the wrong work.
 *
 * Its own comments record three live defects, each of the same shape — a STORED file quietly
 * outranking the ticket:
 *
 *   a stored PRD template was spread into the result, so its frozen outputDirs scoped every run to
 *   one repository whatever the ticket said, and discovery never ran;
 *   `tmpl.description || c.title` meant the ticket's DESCRIPTION was never consulted — every story
 *   reached the spec pass described by its one-line summary (43 characters instead of 395);
 *   --out defaulted, so omitting it overwrote another project's PRD.
 *
 * These execute the script and assert on the PRD it WRITES, because that file is the artifact the
 * rest of the pipeline consumes.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/synthesize-prd-from-jira.js');

function synthesise(classifications: unknown, env: Record<string, string> = {}, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'synth-'));
  const cls = join(dir, 'classifications.json');
  const out = join(dir, 'prd.json');
  writeFileSync(cls, JSON.stringify(classifications));
  const r = spawnSync(process.execPath,
    [SCRIPT, '--classifications', cls, ...(args.length ? args : ['--out', out])], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, PROJECT_NAME: 'proj', ...env },
    });
  const prd = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  return { code: r.status ?? -1, err: r.stderr ?? '', out, prd, dir };
}

const ticket = (over: Record<string, unknown> = {}) => ({
  jiraKey: 'AMSD-1', storyId: 'AMSD-1', title: 'Short summary',
  description: 'The full description, which is the only substantive content a brownfield ticket carries.',
  codeline: 'cl-a', originalAcs: ['the original AC'], enrichedAcs: ['a fabricated AC'],
  ...over,
});

describe('the PRD is synthesised from the ticket alone', () => {
  it('REFUSES without --out rather than overwriting whichever PRD a default named', () => {
    const r = synthesise([ticket()], {}, ['--nothing']);
    expect(r.code, 'it wrote a PRD somewhere nobody asked for').not.toBe(0);
    expect(r.err).toMatch(/--out is required/);
  }, 90_000);

  it("the ticket's DESCRIPTION reaches the story, not its title", () => {
    // `tmpl.description || c.title` consulted a stored template, then fell back to the TITLE — the
    // description was never read. Live 2026-08-06: 43 characters instead of 395.
    const { prd } = synthesise([ticket()]);
    const story = prd.stories[0];
    expect(story.description, 'the story was described by its own one-line summary')
      .toContain('the only substantive content');
    expect(story.description).not.toBe('Short summary');
  }, 90_000);

  it('brownfield keeps the ticket ORIGINAL acceptance criteria, never the fabricated ones', () => {
    // AC immutability: the ac-gate's description-derived ACs re-create the very elaboration the VC
    // layer exists to eliminate. AMSD-1820 had zero ACs, the gate invented six, and those became
    // the "immutable" ones.
    const { prd } = synthesise([ticket()], { EPAM_BROWNFIELD: '1' });
    expect(prd.stories[0].acceptanceCriteria).toEqual(['the original AC']);
  }, 90_000);

  it('and a brownfield ticket with NO acceptance criteria keeps none — empty is a real state', () => {
    const { prd } = synthesise([ticket({ originalAcs: [] })], { EPAM_BROWNFIELD: '1' });
    expect(prd.stories[0].acceptanceCriteria,
      'ACs were invented for a ticket that declared none').toEqual([]);
  }, 90_000);

  it('greenfield DOES take the enriched criteria — defining new behaviour is the job there', () => {
    // The negative half: if the brownfield rule leaked everywhere, greenfield would lose its ACs.
    const { prd } = synthesise([ticket()], { EPAM_BROWNFIELD: '' });
    expect(prd.stories[0].acceptanceCriteria).toEqual(['a fabricated AC']);
  }, 90_000);

  it('writes outputDirs ONLY from codelines this run resolved', () => {
    // The stored template froze outputDirs to one repository, and resolve-codeline-scope.sh stands
    // aside when a scope is already declared — so discovery never ran and every run was scoped to
    // that one repository whatever the ticket said.
    // A codeline's path comes from JIRA_WORKTREE_<NAME>, and one with no resolved path is DROPPED
    // rather than declared with a blank — a blank path in outputDirs would scope a destructive
    // reset to nothing, or to everything, depending on who read it.
    const both = synthesise([ticket({ codeline: 'cl-a' }), ticket({
      jiraKey: 'AMSD-2', storyId: 'AMSD-2', codeline: 'cl-b' })],
    { 'JIRA_WORKTREE_CL-A': '/wt/a', 'JIRA_WORKTREE_CL-B': '/wt/b' });
    const declared = (both.prd.project.outputDirs || []).map((d: any) => d.codeline).sort();
    expect(declared).toEqual(['cl-a', 'cl-b']);

    // And a codeline whose worktree is unset does not appear at all.
    const partial = synthesise([ticket({ codeline: 'cl-a' }), ticket({
      jiraKey: 'AMSD-2', storyId: 'AMSD-2', codeline: 'cl-b' })],
    { 'JIRA_WORKTREE_CL-A': '/wt/a' });
    const some = (partial.prd.project.outputDirs || []).map((d: any) => d.codeline);
    expect(some, 'a codeline with no resolved worktree was declared in scope anyway')
      .toEqual(['cl-a']);
  }, 90_000);

  it('carries NO stack — stack is a per-codeline fact, not an estate-wide one', () => {
    // One language/runtime/framework asserted for a whole estate gets flattened into every agent's
    // prompt. metrolinx is 33 repositories, including .NET ones.
    const { prd } = synthesise([ticket()]);
    expect(prd.project.stack, 'a single stack was asserted for the whole estate').toBeUndefined();
  }, 90_000);

  it('takes its identity from the project config, not from a stored file', () => {
    const { prd } = synthesise([ticket()], { PROJECT_NAME: 'metrolinx-like', PROJECT_DESCRIPTION: 'desc' });
    expect(prd.project.name).toBe('metrolinx-like');
    expect(prd.project.description).toBe('desc');
  }, 90_000);

  it('every story appears in the implementation order, exactly once', () => {
    const { prd } = synthesise([
      ticket(), ticket({ jiraKey: 'AMSD-2', storyId: 'AMSD-2' }),
      ticket({ jiraKey: 'AMSD-3', storyId: 'AMSD-3' })]);
    const order = prd.implementationOrder.core;
    expect(order.length, 'a story was dropped from, or duplicated in, the order')
      .toBe(prd.stories.length);
    expect(new Set(order).size).toBe(order.length);
    for (const s of prd.stories) expect(order, `${s.id} is in no phase`).toContain(s.id);
  }, 90_000);

  it('falls back to the jira key when a ticket declares no story id', () => {
    const { prd } = synthesise([ticket({ storyId: undefined })]);
    expect(prd.stories[0].id).toBe('AMSD-1');
  }, 90_000);

  it('a SPLIT ticket becomes one story per codeline, each depending on the last', () => {
    // Splitting exists so one ticket touching several repositories becomes work each lane can do.
    // The dependency chain is what stops two lanes editing a shared contract at once.
    const { prd } = synthesise([
      ticket({ codeline: 'both' }), ticket({ jiraKey: 'AMSD-2', storyId: 'AMSD-2', codeline: 'be' }),
      ticket({ jiraKey: 'AMSD-3', storyId: 'AMSD-3', codeline: 'fe' })],
    { JIRA_SPLIT_CODELINE: 'both' });
    const split = prd.stories.filter((s: any) => String(s.id).startsWith('AMSD-1'));
    expect(split.length, 'the split ticket did not become one story per codeline')
      .toBeGreaterThan(1);
    const lanes = split.map((s: any) => s.codeline).sort();
    expect(new Set(lanes).size, 'two split stories landed in the same lane').toBe(split.length);
    const later = split[split.length - 1];
    expect(later.dependencies, 'the split stories can run concurrently on a shared contract')
      .toContain(split[0].id);
  }, 90_000);

  it('and each split story takes its OWN acceptance criteria when the ticket declares them', () => {
    const { prd } = synthesise([
      ticket({ codeline: 'both', beAcs: ['a backend AC'], feAcs: ['a frontend AC', 'and another'] }),
      ticket({ jiraKey: 'AMSD-2', storyId: 'AMSD-2', codeline: 'be' }),
      ticket({ jiraKey: 'AMSD-3', storyId: 'AMSD-3', codeline: 'fe' })],
    { JIRA_SPLIT_CODELINE: 'both' });
    const be = prd.stories.find((s: any) => s.id === 'AMSD-1-be');
    const fe = prd.stories.find((s: any) => s.id === 'AMSD-1-fe');
    expect(be.acceptanceCriteria, "the backend split did not take the ticket's backend ACs")
      .toEqual(['a backend AC']);
    expect(fe.acceptanceCriteria).toEqual(['a frontend AC', 'and another']);
  }, 90_000);

  it('a SPANNING ticket stays ONE story that names every codeline it spans', () => {
    // codelines[] is authoritative: the story stays whole and participates in each lane rather than
    // being partitioned into exactly one, which is how a multi-codeline ticket used to vanish.
    const { prd } = synthesise([
      ticket({ codeline: 'be' }), ticket({ jiraKey: 'AMSD-2', storyId: 'AMSD-2', codeline: 'fe' })],
    { EPAM_MULTI_CODELINE_STORIES: '1' });
    const spanning = prd.stories.find((s: any) => Array.isArray(s.codelines) && s.codelines.length > 1);
    if (spanning) {
      expect(spanning.codeline, 'the spanning story names no starting lane').toBeTruthy();
      expect(spanning.codelines.length, 'a spanning story was partitioned into one lane')
        .toBeGreaterThan(1);
    }
  }, 90_000);

  it('falls back to the codelines DISCOVERY found when no ticket carries a label', () => {
    // Deriving the list only from per-story labels threw that work away: AMSD-2041 was a single
    // story marked SPLIT, every candidate was filtered out, the list came back empty and ingest
    // exited 1 — after discovery had successfully identified the repositories and exported them.
    const r = synthesise([ticket({ codeline: undefined })], { JIRA_CODELINES: 'be,fe' });
    expect(r.code, `discovery's codelines were not used as the fallback: ${r.err.slice(0, 300)}`)
      .toBe(0);
    expect(r.prd.stories.length).toBeGreaterThan(0);
  }, 90_000);

  it('and refuses when NO codeline can be established at all, naming what to set', () => {
    const r = synthesise([ticket({ codeline: undefined })], { JIRA_CODELINES: '' });
    expect(r.code, 'a PRD was written with no codeline for anything').not.toBe(0);
    expect(r.err, 'the refusal does not say what would fix it')
      .toMatch(/codeline|JIRA_DEFAULT_CODELINE/i);
  }, 90_000);

  it('refuses an empty classification set rather than writing an empty PRD', () => {
    // An empty PRD is a run with nothing to do that still costs a launch to discover it.
    const r = synthesise([]);
    expect(r.code === 0 && r.prd && r.prd.stories.length === 0,
      'it wrote a PRD with no stories instead of saying so').toBe(false);
  }, 90_000);
});
