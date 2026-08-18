/**
 * THE DETECTIVE PUBLISHES ITS PLAN ONCE, AND WHAT IT PUBLISHES IS WHAT THE PROMPT SAYS.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * The plan reaches consumers through the published-inputs store instead of each consumer reading
 * story.fixSiteAnalysis and inventing its own wording. The two things that can go wrong here are
 * both silent, so both are tested:
 *
 *   THE PUBLISHED TEXT DRIFTS FROM WHAT THE PROMPT SHOWS. If publication rendered the plan a
 *   second way, this refactor would have created the very duplication it removes. So the published
 *   bytes are compared against the producer's own renderer — the one the writer prompt uses.
 *
 *   A STALE PLAN OUTLIVES THE INVESTIGATION THAT PRODUCED IT. The detective re-runs; a story whose
 *   sites were all withdrawn must stop having a published plan, not keep the old one. Live on
 *   2026-08-13 a re-run degraded every site on three codelines to changeRequired:false and
 *   reported success — if the previous plan had survived that, every consumer would still be
 *   acting on it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { publishFixPlans } = require(join(ROOT, 'orchestrations/scripts/lib/producers/fix-plan.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderFixPlan } = require(join(ROOT, 'orchestrations/scripts/lib/producers/fix-plan.js'));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const io = require(join(ROOT, 'orchestrations/scripts/lib/agent-io.js'));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function store(): { env: Record<string, string>; prd: (p: unknown) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'publish-plan-')); dirs.push(dir);
  return {
    env: { AGENT_IO_DIR: join(dir, 'io') },
    prd: (p: unknown) => {
      const f = join(dir, 'prd.json');
      writeFileSync(f, JSON.stringify(p, null, 2));
      return f;
    },
  };
}

const site = (over: Record<string, unknown> = {}) => ({
  file: 'src/service.ts', function: 'loadPage', reason: 'memoised', fix: 'bust the cache', ...over,
});

describe('THE PLAN REACHES THE STORE', () => {
  it('a story with sites has its plan published, attributed to the detective', () => {
    const s = store();
    publishFixPlans({ stories: [{ id: 'S-1', fixSiteAnalysis: [site()] }] }, s.env);
    const out = io.collect('S-1', ['fix-plan'], s.env);
    expect(out).toContain('memoised');
    expect(out, 'the plan arrived with no idea who produced it').toMatch(/detective/i);
  });

  it('the published text is the producer own rendering, not a second one', () => {
    // If these ever differ, the refactor has produced the duplication it exists to remove.
    const s = store();
    const sites = [site({ deliveryRole: 'produces' }), site({ fixVerified: false, helper: 'h' })];
    publishFixPlans({ stories: [{ id: 'S-1', fixSiteAnalysis: sites }] }, s.env);
    const collected = io.collect('S-1', ['fix-plan'], s.env);
    expect(collected, 'the published plan is worded differently from the one in the prompt')
      .toContain(renderFixPlan(sites));
  });

  it('every story in the PRD is published, not just the first', () => {
    const s = store();
    publishFixPlans({
      stories: [
        { id: 'S-1', fixSiteAnalysis: [site({ reason: 'FIRST-STORY' })] },
        { id: 'S-2', fixSiteAnalysis: [site({ reason: 'SECOND-STORY' })] },
      ],
    }, s.env);
    expect(io.collect('S-1', ['fix-plan'], s.env)).toContain('FIRST-STORY');
    expect(io.collect('S-2', ['fix-plan'], s.env)).toContain('SECOND-STORY');
  });

  it('one story never receives another story plan', () => {
    const s = store();
    publishFixPlans({
      stories: [
        { id: 'S-1', fixSiteAnalysis: [site({ reason: 'FIRST-STORY' })] },
        { id: 'S-2', fixSiteAnalysis: [site({ reason: 'SECOND-STORY' })] },
      ],
    }, s.env);
    expect(io.collect('S-2', ['fix-plan'], s.env)).not.toContain('FIRST-STORY');
  });
});

describe('A PLAN NEVER OUTLIVES THE INVESTIGATION THAT PRODUCED IT', () => {
  it('a re-run that finds nothing CLEARS the previous plan', () => {
    // The 2026-08-13 failure mode: a re-run withdrew every site and reported success. If the old
    // plan survived, every consumer would go on acting on a plan the detective had retracted.
    const s = store();
    publishFixPlans({ stories: [{ id: 'S-1', fixSiteAnalysis: [site({ reason: 'OLD-PLAN' })] }] }, s.env);
    expect(io.collect('S-1', ['fix-plan'], s.env)).toContain('OLD-PLAN');

    publishFixPlans({ stories: [{ id: 'S-1', fixSiteAnalysis: [] }] }, s.env);
    expect(io.collect('S-1', ['fix-plan'], s.env).trim(),
      'a retracted plan was still being served').toBe('');
  });

  it('a re-run that finds something else REPLACES the plan', () => {
    const s = store();
    publishFixPlans({ stories: [{ id: 'S-1', fixSiteAnalysis: [site({ reason: 'OLD-PLAN' })] }] }, s.env);
    publishFixPlans({ stories: [{ id: 'S-1', fixSiteAnalysis: [site({ reason: 'NEW-PLAN' })] }] }, s.env);
    const out = io.collect('S-1', ['fix-plan'], s.env);
    expect(out).toContain('NEW-PLAN');
    expect(out, 'two answers to the same question were served at once').not.toContain('OLD-PLAN');
  });

  it('a story that never had a plan publishes nothing, and is not an error', () => {
    const s = store();
    expect(() => publishFixPlans({ stories: [{ id: 'S-1' }] }, s.env)).not.toThrow();
    expect(io.collect('S-1', ['fix-plan'], s.env).trim()).toBe('');
  });

  it('an empty or malformed PRD publishes nothing rather than throwing', () => {
    const s = store();
    expect(() => publishFixPlans({}, s.env)).not.toThrow();
    expect(() => publishFixPlans(null, s.env)).not.toThrow();
  });
});

describe('IT REPORTS WHAT IT DID', () => {
  it('the count of stories published is returned, so a caller can log it', () => {
    // A publication step that says nothing is one nobody notices has stopped working.
    const s = store();
    const n = publishFixPlans({
      stories: [{ id: 'S-1', fixSiteAnalysis: [site()] }, { id: 'S-2', fixSiteAnalysis: [] }],
    }, s.env);
    expect(n).toBe(1);
  });
});

describe('THE SHELL CALL SITE WORKS THE SAME WAY', () => {
  it('the CLI publishes from a PRD on disk', () => {
    // run-agent-orchestration.sh calls this after the spec pass; it must not need a JS host.
    const s = store();
    const prd = s.prd({ stories: [{ id: 'S-1', fixSiteAnalysis: [site({ reason: 'FROM-CLI' })] }] });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require('node:child_process');
    execFileSync(process.execPath,
      [join(ROOT, 'orchestrations/scripts/lib/producers/fix-plan.js'), '--publish', prd],
      { encoding: 'utf8', env: { ...process.env, ...s.env } });
    expect(io.collect('S-1', ['fix-plan'], s.env)).toContain('FROM-CLI');
  });
});
