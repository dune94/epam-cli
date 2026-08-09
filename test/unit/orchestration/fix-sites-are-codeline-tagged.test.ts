/**
 * A FIX SITE BELONGS TO A CODELINE, AND UNTIL NOW IT COULD NOT SAY WHICH.
 *
 * A detective finding is `{file, function, reason, fix, helper, brokenLine, …}` — no codeline
 * anywhere in it. For a story spanning three repositories that is not merely lossy, it is
 * unrepresentable: the array cannot express which repository each site lives in, so:
 *
 *   - the lane merge into canonical was last-writer-wins, exactly as verificationCriteria was
 *     (see lane-merge-aligns-vcs-to-codeline.test.ts). On AMSD-2041 metrolinx merged last and
 *     its sites — newsService.ts, getEventsList.ts, _contentstack_getNewsArticles.ts — became
 *     the whole story's, though gotransit has blogService.ts and upexpress has no equivalent;
 *   - a finding from codeline A entering codeline B's writer manifest is undetectable, because
 *     nothing on the finding says it came from A.
 *
 * Two halves, both tested here: the lane STAMPS its findings as it specs them, and the merge
 * keeps each lane's set under its own key rather than overwriting.
 *
 * The stamp runs where technicalNotes.perCodeline is already derived, from the PRD's own
 * project.outputDirs — no client or codeline name is written into the engine.
 */
import { describe, it, expect } from 'vitest';

const {
  laneCodeline, applySpecChanges,
} = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { mergeLaneIntoCanonical } = require('../../../orchestrations/scripts/lib/story-merge.js');

const LANES = ['gotransit', 'upexpress', 'metrolinx'];

/** A PRD as a lane sees it: outputDir is THIS lane, outputDirs is the whole estate. */
function lanePrd(codeline: string) {
  return {
    project: {
      outputDir: `/estate/${codeline}`,
      outputDirs: LANES.map((cl) => ({ codeline: cl, path: `/estate/${cl}` })),
    },
  };
}

function finding(file: string) {
  return { file, function: 'fetch', reason: 'filters unpublished items', fix: 'pass the draft flag' };
}

describe('laneCodeline — which lane am I', () => {
  it('resolves this lane from the PRD\'s own outputDirs', () => {
    expect(laneCodeline(lanePrd('upexpress'))).toBe('upexpress');
  });

  it('returns null when no lane is derivable, rather than guessing one', () => {
    expect(laneCodeline({ project: { outputDir: '/estate/unknown', outputDirs: [] } })).toBeNull();
    expect(laneCodeline({ project: {} })).toBeNull();
    expect(laneCodeline({})).toBeNull();
    expect(laneCodeline(null)).toBeNull();
  });

  it('an outputDir matching no declared codeline is null, not the first entry', () => {
    const prd = lanePrd('gotransit');
    prd.project.outputDir = '/estate/somewhere-else';
    expect(laneCodeline(prd)).toBeNull();
  });
});

describe('THE DEFECT (half 1): the lane stamps its own fix sites', () => {
  function specced(codeline: string, files: string[]) {
    const story: any = { id: 'SPAN-1', codelines: [...LANES], fixSiteAnalysis: files.map(finding) };
    applySpecChanges(story, {}, [], lanePrd(codeline), 'phase-1', 'run-1');
    return story;
  }

  it('every finding carries the codeline it was found in', () => {
    const story = specced('metrolinx', ['src/services/newsService.ts', 'src/api/getEventsList.ts']);
    expect(story.fixSiteAnalysis.map((f: any) => f.codeline)).toEqual(['metrolinx', 'metrolinx']);
  });

  it('the rest of the finding is untouched', () => {
    const story = specced('gotransit', ['src/services/blogService.ts']);
    expect(story.fixSiteAnalysis[0]).toMatchObject({
      file: 'src/services/blogService.ts', function: 'fetch', reason: 'filters unpublished items',
    });
  });

  it('a finding that already names its codeline is not relabelled', () => {
    const story: any = {
      id: 'SPAN-1', codelines: [...LANES],
      fixSiteAnalysis: [{ ...finding('src/shared/client.ts'), codeline: 'upexpress' }],
    };
    applySpecChanges(story, {}, [], lanePrd('metrolinx'), 'phase-1', 'run-1');
    expect(
      story.fixSiteAnalysis[0].codeline,
      'a cross-codeline finding was relabelled with the lane that merely observed it',
    ).toBe('upexpress');
  });

  it('with no lane derivable nothing is invented', () => {
    const story: any = { id: 'SOLO-1', fixSiteAnalysis: [finding('src/a.ts')] };
    applySpecChanges(story, {}, [], { project: {} }, 'phase-1', 'run-1');
    expect(story.fixSiteAnalysis[0].codeline).toBeUndefined();
  });

  it('a story with no findings is untouched and does not throw', () => {
    const story: any = { id: 'SPAN-1', codelines: [...LANES] };
    expect(() => applySpecChanges(story, {}, [], lanePrd('gotransit'), 'phase-1', 'run-1')).not.toThrow();
    expect(story.fixSiteAnalysis).toBeUndefined();
  });
});

describe('THE DEFECT (half 2): the merge keeps every lane\'s fix sites', () => {
  const SITES: Record<string, string[]> = {
    gotransit: ['src/services/blogService.ts'],
    upexpress: ['src/pages/index.tsx'],
    metrolinx: ['src/services/newsService.ts', 'src/api/getEventsList.ts'],
  };

  function laneResult(cl: string) {
    return {
      stories: [{
        id: 'SPAN-1', codelines: [...LANES], status: 'completed', completed: true,
        fixSiteAnalysis: SITES[cl].map((f) => ({ ...finding(f), codeline: cl })),
      }],
    };
  }

  function mergeAll(order = LANES) {
    const canonical: any = {
      stories: [{ id: 'SPAN-1', codelines: [...LANES], status: 'pending', completed: false }],
    };
    for (const cl of order) mergeLaneIntoCanonical({ canonical, updated: laneResult(cl), codeline: cl });
    return canonical.stories[0];
  }

  it('the last lane does not overwrite the others', () => {
    const flat = mergeAll().fixSiteAnalysis.map((f: any) => f.file);
    expect(flat, "the last lane's sites replaced every other lane's").toContain('src/services/blogService.ts');
    expect(flat).toContain('src/pages/index.tsx');
    expect(flat).toContain('src/services/newsService.ts');
  });

  it('each lane\'s sites are recorded under its own codeline', () => {
    const per = mergeAll().fixSiteAnalysisPerCodeline;
    expect(per.gotransit.map((f: any) => f.file)).toEqual(SITES.gotransit);
    expect(per.metrolinx.map((f: any) => f.file)).toEqual(SITES.metrolinx);
  });

  it('a metrolinx-only path is not attributed to gotransit', () => {
    const per = mergeAll().fixSiteAnalysisPerCodeline;
    expect(per.gotransit.map((f: any) => f.file).join(' ')).not.toMatch(/newsService|getEventsList/);
  });

  it('merge order does not change the result', () => {
    const a = mergeAll([...LANES]);
    const b = mergeAll([...LANES].reverse());
    expect(b.fixSiteAnalysisPerCodeline).toEqual(a.fixSiteAnalysisPerCodeline);
    expect(b.fixSiteAnalysis.length).toBe(a.fixSiteAnalysis.length);
  });

  it('the same site found in two lanes is kept once PER lane, not collapsed across them', () => {
    // A shared vendored file legitimately needs fixing in every codeline.
    const canonical: any = { stories: [{ id: 'SPAN-1', codelines: [...LANES], status: 'pending', completed: false }] };
    for (const cl of LANES) {
      mergeLaneIntoCanonical({
        canonical,
        updated: { stories: [{ id: 'SPAN-1', codelines: [...LANES], status: 'completed', completed: true, fixSiteAnalysis: [{ ...finding('src/lib/content-client.ts'), codeline: cl }] }] },
        codeline: cl,
      });
    }
    const flat = canonical.stories[0].fixSiteAnalysis;
    expect(flat.length, 'three lanes each needing the same file collapsed to one instruction').toBe(3);
    expect(flat.map((f: any) => f.codeline).sort()).toEqual([...LANES].sort());
  });

  it('a lane that found no sites does not erase the sites other lanes found', () => {
    const canonical: any = { stories: [{ id: 'SPAN-1', codelines: [...LANES], status: 'pending', completed: false }] };
    mergeLaneIntoCanonical({ canonical, updated: laneResult('metrolinx'), codeline: 'metrolinx' });
    mergeLaneIntoCanonical({
      canonical,
      updated: { stories: [{ id: 'SPAN-1', codelines: [...LANES], status: 'completed', completed: true, fixSiteAnalysis: [] }] },
      codeline: 'gotransit',
    });
    expect(canonical.stories[0].fixSiteAnalysis.map((f: any) => f.file)).toEqual(SITES.metrolinx);
  });

  it('a single-codeline story keeps its findings exactly as the lane wrote them', () => {
    const canonical: any = { stories: [{ id: 'SOLO-1', codelines: ['gotransit'], status: 'pending', completed: false }] };
    mergeLaneIntoCanonical({
      canonical,
      updated: { stories: [{ id: 'SOLO-1', codelines: ['gotransit'], status: 'completed', completed: true, fixSiteAnalysis: [finding('src/a.ts')] }] },
      codeline: 'gotransit',
    });
    expect(canonical.stories[0].fixSiteAnalysis).toEqual([finding('src/a.ts')]);
  });

  it('junk in a lane\'s findings does not reach the canonical list', () => {
    const canonical: any = { stories: [{ id: 'SPAN-1', codelines: [...LANES], status: 'pending', completed: false }] };
    mergeLaneIntoCanonical({
      canonical,
      updated: { stories: [{ id: 'SPAN-1', codelines: [...LANES], status: 'completed', completed: true, fixSiteAnalysis: [finding('src/a.ts'), null, 'nope', 42] }] },
      codeline: 'gotransit',
    });
    expect(canonical.stories[0].fixSiteAnalysis.length).toBe(1);
  });
});
