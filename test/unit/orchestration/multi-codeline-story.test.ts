/**
 * One story, N executions, joined state — MC-1.
 *
 * AMSD-2041 ([GO, UP, MX] Live Preview of Content in CMS) killed ingest:
 *
 *   [synthesize-prd] No codelines found in classifications.
 *   [ERROR] [jira] Ingestion failed (exit 1).
 *
 * The AC gate offers the classifier a value meaning "spans multiple codelines"
 * (JIRA_SPLIT_CODELINE, default "both") and for a three-brand ticket that is the
 * correct answer. Synthesis then derives the codeline list from the stories
 * themselves while EXCLUDING that value — so with one story, and it marked
 * "both", the list is empty and ingest dies. The vocabulary exists in the gate
 * and had no working consumer.
 *
 * Two decisions shape this, both the user's:
 *
 *  - DO NOT SPLIT. There is a splitAcrossCodelines() that mints `${id}-${cl}`
 *    sub-stories; brownfield leans on verification criteria downstream, and
 *    splitting at ingest widens a surface that then has to be narrowed again.
 *    The story stays whole and gains `codelines[]`.
 *  - The orchestrator ALREADY loops per codeline with PROJECT_ROOT set per
 *    iteration, so a whole story simply participates in N iterations. That is
 *    what keeps ~240 PROJECT_ROOT references, worktrees, git and lint baselines
 *    working untouched — each execution is still single-repo.
 *
 * Because Jira stories inevitably carry FE and BE work together.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SYNTH = join(__dirname, '../../../orchestrations/scripts/synthesize-prd-from-jira.js');
// The synthesizer has no built-in template: a built-in one lent every run another
// project's identity. These tests are about the synthesizer's own logic, so the template
// they supply is deliberately anonymous.
const TEMPLATE = join(__dirname, '../../fixtures/prd/neutral-synthesis-template.json');


const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** One classification, marked as spanning multiple codelines — the AMSD-2041 shape. */
const SPANNING = [{
  jiraKey: 'AMSD-2041',
  storyId: 'AMSD-2041',
  title: '[GO, UP, MX] Live Preview of Content in CMS',
  codeline: 'both',
  issueType: 'Story',
  effort: 'medium',
  verdict: 'enrichable',
  reason: 'auto-elaborated',
  enrichedAcs: ['A content author can preview a draft entry'],
  acceptanceCriteria: ['A content author can preview a draft entry'],
}];

function synthesize(classifications: unknown[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-synth-'));
  dirs.push(dir);
  const cls = join(dir, 'ac-gate.json');
  const out = join(dir, 'prd.json');
  writeFileSync(cls, JSON.stringify(classifications, null, 2));
  const r = execFileSync(process.execPath, [SYNTH, '--classifications', cls, '--out', out, '--template', TEMPLATE], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, JIRA_CODELINES: 'gotransit,upexpress,metrolinx', ...env },
  });
  return {
    stderr: r,
    prd: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null,
  };
}

describe('a story spanning codelines does not kill ingest', () => {
  it('synthesizes rather than exiting 1', () => {
    // The live failure: one story, marked "both", no codeline survives the filter.
    expect(() => synthesize(SPANNING),
      'ingest still dies on a story that spans codelines — the AMSD-2041 failure')
      .not.toThrow();
  });

  it('falls back to the DISCOVERED codelines when no story names one', () => {
    // Discovery had already found the repos and exported JIRA_CODELINES. Deriving
    // the list only from per-story labels throws that away.
    const { prd } = synthesize(SPANNING);
    expect(prd, 'no PRD was produced').toBeTruthy();
  });
});

describe('the story stays whole', () => {
  it('does NOT mint per-codeline sub-stories', () => {
    const { prd } = synthesize(SPANNING, { EPAM_MULTI_CODELINE_STORIES: '1' });
    const ids = prd.stories.map((s: any) => s.id);
    expect(ids,
      `splitting was ruled out for brownfield, but sub-stories were created: ${ids.join(', ')}`)
      .toEqual(['AMSD-2041']);
  });

  it('carries every codeline it touches', () => {
    const { prd } = synthesize(SPANNING, { EPAM_MULTI_CODELINE_STORIES: '1' });
    const s = prd.stories[0];
    expect(Array.isArray(s.codelines),
      'the story records no codeline array, so the loop cannot know where it belongs')
      .toBe(true);
    expect([...s.codelines].sort()).toEqual(['gotransit', 'metrolinx', 'upexpress']);
  });

  it('keeps a scalar codeline for single-codeline stories', () => {
    // Every existing project must be unaffected: this is an extension, not a
    // replacement, and the per-codeline loop still reads s.codeline.
    const single = [{ ...SPANNING[0], codeline: 'gotransit' }];
    const { prd } = synthesize(single, { EPAM_MULTI_CODELINE_STORIES: '1' });
    expect(prd.stories[0].codeline).toBe('gotransit');
    expect(prd.stories.length).toBe(1);
  });
});

describe('the per-codeline filter includes a spanning story in every lane', () => {
  const ORCH = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

  it('matches on codelines[] as well as the scalar codeline', () => {
    // The filter PARTITIONS stories across codelines. A story that spans them
    // matches no partition, appears in zero filtered PRDs, and is silently
    // dropped from the run.
    const i = ORCH.indexOf('Build filtered PRD containing only stories for codeline');
    expect(i, 'the per-codeline filter was not found').toBeGreaterThan(-1);
    const block = ORCH.slice(i, i + 1200);
    expect(block,
      'a story spanning codelines is filtered out of every lane and never runs')
      .toMatch(/codelines/);
  });
});

describe('joined state — a spanning story completes only when every lane does', () => {
  // These three used to grep the orchestrator's source for /perCodeline/, which proves
  // nothing: the pattern matches a comment, a dead branch or a deleted call site just as
  // happily as working code. The merge now lives in lib/story-merge.js, so they run it and
  // assert on the PRD it produces. (The full per-codeline contract, including verification
  // criteria, is in lane-merge-aligns-vcs-to-codeline.test.ts.)
  const { mergeLaneIntoCanonical } = require('../../../orchestrations/scripts/lib/story-merge.js');

  const LANES = ['gotransit', 'upexpress'];

  function canonical() {
    return { stories: [{ id: 'SPAN-1', codelines: [...LANES], status: 'pending', completed: false }] };
  }
  function lane(status: string, completed: boolean) {
    return { stories: [{ id: 'SPAN-1', codelines: [...LANES], status, completed, completedAt: '2026-08-08T00:00:00Z' }] };
  }

  it('does not let one lane overwrite another lane\'s result', () => {
    // Whole-object merge was last-writer-wins: a story that FAILED in gotransit and
    // succeeded in upexpress read as whichever lane happened to run last.
    const c = canonical();
    mergeLaneIntoCanonical({ canonical: c, updated: lane('failed', false), codeline: 'gotransit' });
    mergeLaneIntoCanonical({ canonical: c, updated: lane('completed', true), codeline: 'upexpress' });
    expect(
      c.stories[0].completed,
      'a later lane\'s success erased an earlier lane\'s failure',
    ).toBe(false);
    expect((c.stories[0] as any).perCodeline.gotransit.completed).toBe(false);
  });

  it('records the outcome PER codeline', () => {
    const c = canonical();
    for (const cl of LANES) mergeLaneIntoCanonical({ canonical: c, updated: lane('completed', true), codeline: cl });
    expect(Object.keys((c.stories[0] as any).perCodeline).sort()).toEqual([...LANES].sort());
  });

  it('only marks the story complete when no lane is outstanding', () => {
    const c = canonical();
    mergeLaneIntoCanonical({ canonical: c, updated: lane('completed', true), codeline: 'gotransit' });
    expect(c.stories[0].completed, 'one lane of two reported the whole story complete').toBe(false);
    expect(c.stories[0].status).toBe('in-progress');

    mergeLaneIntoCanonical({ canonical: c, updated: lane('completed', true), codeline: 'upexpress' });
    expect(c.stories[0].completed).toBe(true);
  });
});

/**
 * MC-2 — the detective must be able to see across the codeline boundary.
 *
 * Run 9 named map-to-sanitized-mozio-dispatch.ts — the function that DISPLAYS
 * the discount — instead of the service that COMPUTES it. That happened inside
 * ONE repository, with full CodeGraph access. A repo boundary makes the same
 * failure structural rather than merely likely:
 *
 *   backend changes a response shape → frontend breaks.
 *   A detective seeing only the FE finds "we read x.total and it is undefined"
 *   and prescribes a defensive null-check — real, plausible, verbatim-quotable,
 *   and papering over the cause. A detective seeing only the BE finds nothing
 *   wrong at all. Both investigations "succeed", the repro gate goes green on
 *   the FE test, review approves, and the bug survives.
 *
 * The mechanism to cross that boundary already exists and the detective is
 * simply not on it: completed codelines publish their exported API surface to
 * .contracts/<storyId>.md, and claude.sh injects a dependency's contract into
 * STORY agents. spec-mode-runner.js touches .contracts only to estimate token
 * size for split decisions.
 *
 * The detective does not need N repositories in context. It needs the
 * neighbouring SURFACE.
 */
describe('MC-2: the detective can see the neighbouring codeline', () => {
  const SPEC = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('reads published contracts for something other than counting tokens', () => {
    const uses = [...SPEC.matchAll(/\.contracts/g)].length;
    expect(uses, 'the detective never touches .contracts at all').toBeGreaterThan(0);
    const tokenOnly = /estimateStoryTokens\(\w+, _contractDir\)/.test(SPEC) && uses === 1;
    expect(tokenOnly,
      '.contracts is referenced ONLY to estimate prompt size — the artefact built ' +
      'for crossing codeline boundaries is invisible to the agent whose job is ' +
      'finding causes across them')
      .toBe(false);
  });

  it('injects the neighbouring surface into the detective prompt', () => {
    expect(SPEC, 'no contract text reaches the detective')
      .toMatch(/contract/i);
  });

  it('tells the detective the cause may be outside this repository', () => {
    // Without this it will always find A cause here, because there is always
    // some line here that consumes the wrong value.
    expect(SPEC,
      'nothing warns that a symptom in this repo can have its cause in another, ' +
      'so a defensive fix at the boundary looks like a correct diagnosis')
      .toMatch(/another codeline|other codeline|outside this repo|upstream codeline/i);
  });
});

/**
 * A spanning story must not report success on partial coverage.
 *
 * Lane failures already set _overall and stop the loop. The gap is quieter: a
 * story naming three codelines whose third lane never ran — filtered out, or a
 * lane that produced no work — leaves perCodeline with two entries and nothing
 * checks the count against codelines[]. Every lane "succeeded", the pipeline
 * reports complete, and a third of the work never happened.
 *
 * That is the shape this codebase keeps producing: a check that passes because
 * it examined fewer things than it should have.
 */
describe('partial coverage is a failure, not a pass', () => {
  const ORCH = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

  it('verifies every declared codeline actually produced a result', () => {
    expect(ORCH,
      'nothing compares a spanning story\'s codelines[] against the lanes that ' +
      'actually ran, so silent partial coverage reports as success')
      .toMatch(/codelines[\s\S]{0,400}(perCodeline|lane)[\s\S]{0,400}(missing|incomplete|never ran)/i);
  });

  it('fails the run loudly rather than logging and continuing', () => {
    const i = ORCH.search(/spanning story[\s\S]{0,200}(incomplete|missing)/i);
    expect(i, 'no partial-coverage check exists').toBeGreaterThan(-1);
    expect(ORCH.slice(i, i + 600),
      'partial coverage is reported but does not affect the run outcome')
      .toMatch(/_overall=1|error /);
  });
});
