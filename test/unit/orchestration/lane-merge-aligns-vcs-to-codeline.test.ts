/**
 * VERIFICATION CRITERIA ARE PER CODELINE, AND THE MERGE MUST NOT COLLAPSE THEM.
 *
 * A spanning story is specced once per lane, against that lane's own checkout, and each lane
 * produces the criteria that are observable IN THAT CODELINE. The lanes do not agree and are
 * not meant to: live 2026-08-08 on AMSD-2041, metrolinx produced 8 criteria naming
 * newsService.ts / getEventsList.ts / _contentstack_getNewsArticles.ts, while gotransit has
 * blogService.ts and upexpress has no equivalent surface at all.
 *
 * The merge back into the canonical PRD spread the lane's whole story object over the
 * canonical one (`return {...u, perCodeline, ...}`). Only status/completed were protected.
 * So verificationCriteria was last-writer-wins: whichever lane finished last donated its
 * criteria to the entire story, and the two other codelines were then judged against paths
 * that do not exist in them. The spec reviewer scored that 0.65 with the note that "an
 * implementer sent to GO or UP cannot function" — correctly, because the artifact really did
 * prescribe metrolinx's surfaces to all three.
 *
 * technicalNotes already had the answer: a `perCodeline` map, added when the same defect hit
 * the file manifest. This applies that established shape to the criteria.
 *
 * The canonical flat list becomes the UNION, because canonical describes the whole story and
 * it is verified only when every lane's criteria hold. Each lane's own PRD is untouched — it
 * already carries its own flat list, and that is what the writers and gates read.
 */
import { describe, it, expect } from 'vitest';

const { mergeLaneIntoCanonical } = require('../../../orchestrations/scripts/lib/story-merge.js');

const CODELINES = ['gotransit', 'upexpress', 'metrolinx'];

/** The canonical story before any lane has run. */
function canonicalPrd() {
  return {
    stories: [{
      id: 'SPAN-1',
      codelines: [...CODELINES],
      status: 'pending',
      completed: false,
      verificationCriteria: [],
    }],
  };
}

/** What a lane's own PRD looks like after that lane's spec pass. */
function laneResult(codeline: string, vcs: string[], extra: Record<string, unknown> = {}) {
  return {
    stories: [{
      id: 'SPAN-1',
      codelines: [...CODELINES],
      status: 'completed',
      completed: true,
      completedAt: `2026-08-08T00:00:0${CODELINES.indexOf(codeline)}Z`,
      verificationCriteria: vcs,
      ...extra,
    }],
  };
}

const VC: Record<string, string[]> = {
  gotransit: ['draft items render on the GO listing page'],
  upexpress: ['draft items render on the UP listing page'],
  metrolinx: ['draft items render via newsService', 'getEventsList returns unpublished items'],
};

/** Runs all three lanes in the given order, as the orchestrator does. */
function mergeAllLanes(order: string[] = CODELINES) {
  const canonical = canonicalPrd();
  for (const cl of order) {
    mergeLaneIntoCanonical({ canonical, updated: laneResult(cl, VC[cl]), codeline: cl });
  }
  return canonical.stories[0] as any;
}

describe('the fixture is real', () => {
  it('the lanes genuinely disagree — otherwise this test proves nothing', () => {
    expect(VC.gotransit).not.toEqual(VC.metrolinx);
    expect(new Set(Object.values(VC).flat()).size).toBe(4);
  });
});

describe('THE DEFECT: a lane no longer donates its criteria to the whole story', () => {
  it('the last lane to merge does not overwrite the others', () => {
    const story = mergeAllLanes();
    expect(
      story.verificationCriteria,
      "the last lane's criteria replaced every other lane's — this is the 0.65",
    ).not.toEqual(VC.metrolinx);
  });

  it('every lane\'s criteria are recorded under its own codeline', () => {
    const per = mergeAllLanes().verificationCriteriaPerCodeline;
    expect(per.gotransit).toEqual(VC.gotransit);
    expect(per.upexpress).toEqual(VC.upexpress);
    expect(per.metrolinx).toEqual(VC.metrolinx);
  });

  it('a criterion naming a metrolinx-only surface is not attributed to gotransit', () => {
    const per = mergeAllLanes().verificationCriteriaPerCodeline;
    expect(per.gotransit.join(' ')).not.toMatch(/newsService|getEventsList/);
  });

  it('merge order does not change the result', () => {
    const forward = mergeAllLanes(['gotransit', 'upexpress', 'metrolinx']);
    const reverse = mergeAllLanes(['metrolinx', 'upexpress', 'gotransit']);
    expect(reverse.verificationCriteriaPerCodeline).toEqual(forward.verificationCriteriaPerCodeline);
    expect([...reverse.verificationCriteria].sort()).toEqual([...forward.verificationCriteria].sort());
  });
});

describe('the canonical flat list is the union — canonical describes the whole story', () => {
  it('every lane\'s criteria survive into the flat list', () => {
    const flat = mergeAllLanes().verificationCriteria;
    for (const vc of Object.values(VC).flat()) expect(flat).toContain(vc);
  });

  it('a criterion produced by two lanes appears once', () => {
    const canonical = canonicalPrd();
    const shared = 'draft items are visible to editors';
    for (const cl of CODELINES) {
      mergeLaneIntoCanonical({ canonical, updated: laneResult(cl, [shared]), codeline: cl });
    }
    expect(canonical.stories[0].verificationCriteria).toEqual([shared]);
  });

  it('the flat list stays a plain string array — every downstream consumer reads it as one', () => {
    const flat = mergeAllLanes().verificationCriteria;
    expect(Array.isArray(flat)).toBe(true);
    for (const v of flat) expect(typeof v).toBe('string');
  });
});

describe('behaviour that already worked is preserved', () => {
  it('a single-codeline story still merges wholesale', () => {
    const canonical = {
      stories: [{ id: 'SOLO-1', codelines: ['gotransit'], status: 'pending', completed: false }],
    };
    mergeLaneIntoCanonical({
      canonical,
      updated: { stories: [{ id: 'SOLO-1', codelines: ['gotransit'], status: 'completed', completed: true, verificationCriteria: ['x'] }] },
      codeline: 'gotransit',
    });
    expect(canonical.stories[0].completed).toBe(true);
    expect(canonical.stories[0].verificationCriteria).toEqual(['x']);
  });

  it('a spanning story is complete only when no lane is outstanding', () => {
    const canonical = canonicalPrd();
    mergeLaneIntoCanonical({ canonical, updated: laneResult('gotransit', VC.gotransit), codeline: 'gotransit' });
    expect(canonical.stories[0].completed, 'one lane done reported the story complete').toBe(false);
    expect(canonical.stories[0].status).toBe('in-progress');

    mergeLaneIntoCanonical({ canonical, updated: laneResult('upexpress', VC.upexpress), codeline: 'upexpress' });
    expect(canonical.stories[0].completed).toBe(false);

    mergeLaneIntoCanonical({ canonical, updated: laneResult('metrolinx', VC.metrolinx), codeline: 'metrolinx' });
    expect(canonical.stories[0].completed).toBe(true);
    expect(canonical.stories[0].status).toBe('completed');
  });

  it('a lane that failed keeps the story incomplete even if the others passed', () => {
    const canonical = canonicalPrd();
    mergeLaneIntoCanonical({ canonical, updated: laneResult('gotransit', VC.gotransit), codeline: 'gotransit' });
    mergeLaneIntoCanonical({ canonical, updated: laneResult('upexpress', VC.upexpress), codeline: 'upexpress' });
    const failed = laneResult('metrolinx', VC.metrolinx);
    failed.stories[0].completed = false;
    failed.stories[0].status = 'failed';
    mergeLaneIntoCanonical({ canonical, updated: failed, codeline: 'metrolinx' });
    expect(canonical.stories[0].completed).toBe(false);
  });

  it('per-lane status records still accumulate', () => {
    const per = mergeAllLanes().perCodeline;
    expect(Object.keys(per).sort()).toEqual([...CODELINES].sort());
    expect(per.gotransit.completed).toBe(true);
  });

  it('a story created during the run is appended to canonical', () => {
    const canonical = canonicalPrd();
    mergeLaneIntoCanonical({
      canonical,
      updated: { stories: [{ id: 'SPAN-1-impl', codelines: ['metrolinx'], status: 'completed', completed: true }] },
      codeline: 'metrolinx',
    });
    expect(canonical.stories.map((s: any) => s.id)).toContain('SPAN-1-impl');
  });

  it('a story absent from the lane PRD is left untouched', () => {
    const canonical = canonicalPrd();
    canonical.stories.push({ id: 'OTHER-1', codelines: ['gotransit'], status: 'pending', completed: false, verificationCriteria: ['keep me'] });
    mergeLaneIntoCanonical({ canonical, updated: laneResult('metrolinx', VC.metrolinx), codeline: 'metrolinx' });
    const other = canonical.stories.find((s: any) => s.id === 'OTHER-1') as any;
    expect(other.status).toBe('pending');
    expect(other.verificationCriteria).toEqual(['keep me']);
  });
});

describe('degenerate lane output does not destroy recorded criteria', () => {
  it('a lane that produced no criteria does not blank the union', () => {
    const canonical = canonicalPrd();
    mergeLaneIntoCanonical({ canonical, updated: laneResult('metrolinx', VC.metrolinx), codeline: 'metrolinx' });
    mergeLaneIntoCanonical({ canonical, updated: laneResult('gotransit', []), codeline: 'gotransit' });
    expect(
      canonical.stories[0].verificationCriteria,
      'an empty lane erased the criteria the other lanes had already produced',
    ).toEqual(VC.metrolinx);
  });

  it('a lane with no verificationCriteria key at all is tolerated', () => {
    const canonical = canonicalPrd();
    const bare = laneResult('gotransit', []);
    delete (bare.stories[0] as any).verificationCriteria;
    expect(() => mergeLaneIntoCanonical({ canonical, updated: bare, codeline: 'gotransit' })).not.toThrow();
  });

  it('non-string criteria are dropped rather than written into the flat list', () => {
    const canonical = canonicalPrd();
    const junk = laneResult('gotransit', ['real one', null as any, 42 as any, '  ']);
    mergeLaneIntoCanonical({ canonical, updated: junk, codeline: 'gotransit' });
    expect(canonical.stories[0].verificationCriteria).toEqual(['real one']);
  });
});
