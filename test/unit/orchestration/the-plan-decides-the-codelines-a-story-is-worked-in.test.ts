/**
 * THE PLAN DECIDES THE CODELINES A STORY IS WORKED IN — from every codeline discovery grounded, not from one routing pick.
 *
 * Live AMSD-2974 run 1, 2026-10-09: discovery grounded four codelines (cx-shared and the three sites that consume its
 * toast); the AC gate's classifier (haiku) routed the story to cxshared alone; the detective was then shown one codeline
 * — "No other codeline is in scope for this investigation" — and planned 1 codeline, 0 packages: no consumer, no 7.x
 * back-port. Operator, 2026-10-06: every story is planned once and worked from that plan. The plan, written by the
 * detective that reads the code, is the decision; the router's pick is where it starts.
 *
 * EXECUTED: lib/plan-scope.js — what the detective is shown, and what the story becomes once the plan names codelines —
 * on a run's own codeline-facts.json (discovery's record).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { planScope, adoptPlanCodelines } = require(join(__dirname, '../../../orchestrations/scripts/lib/plan-scope.js'));

const FACTS = {
  _what: 'what each codeline is', _shape: 'codeline names are top-level keys',
  cxshared: { path: '/c/cx-shared', facts: [] },
  gotransit: { path: '/c/next.gotransit.com', facts: [] },
  upexpress: { path: '/c/next.upexpress.com', facts: [] },
  metrolinx: { path: '/c/next.metrolinx.com', facts: [] },
};
const prd = () => ({ project: { outputDirs: [{ codeline: 'cxshared', path: '/c/cx-shared' }] }, stories: [{ id: 'S-1', codeline: 'cxshared' }] });

describe('what the detective is shown', () => {
  it('the story\'s own codeline first, then every codeline discovery grounded, each with its path', () => {
    const p = prd(); const s = planScope(p.stories[0], p, FACTS);
    expect(s.codelines).toEqual(['cxshared', 'gotransit', 'upexpress', 'metrolinx']);
    expect(s.outputDirs.map((d: { codeline: string }) => d.codeline)).toEqual(['cxshared', 'gotransit', 'upexpress', 'metrolinx']);
    expect(s.outputDirs.find((d: { codeline: string }) => d.codeline === 'upexpress').path).toBe('/c/next.upexpress.com');
  });
  it('no discovery record: the story\'s own codelines, as before', () => {
    const p = prd(); expect(planScope(p.stories[0], p, null).codelines).toEqual(['cxshared']);
  });
  it('the record\'s own documentation keys are not codelines', () => {
    const p = prd(); expect(planScope(p.stories[0], p, FACTS).codelines).not.toContain('_what');
  });
});

describe('what the story becomes once the plan names codelines', () => {
  const plan = {
    codelines: [{ codeline: 'cxshared', part: 'fix', order: 1 }, { codeline: 'upexpress', part: 'its own sign-in toast', order: 2 }],
    packages: [{ package: '@m/cx-shared', providedBy: 'cxshared', releaseLines: [], consumers: [{ codeline: 'gotransit', change: 'none' }, { codeline: 'metrolinx', change: 'none' }] }],
  };
  it('every codeline the plan names — parts, provider, consumers — becomes a lane, with its path; the routed one stays first', () => {
    const p = prd(); const s = p.stories[0] as Record<string, unknown>; s.overallPlan = plan;
    const added = adoptPlanCodelines(s, p, FACTS);
    expect(added).toEqual(['upexpress', 'gotransit', 'metrolinx']);
    expect(s.codelines).toEqual(['cxshared', 'upexpress', 'gotransit', 'metrolinx']);
    expect(s.codeline).toBe('cxshared');
    expect(p.project.outputDirs.map((d) => d.codeline)).toEqual(['cxshared', 'upexpress', 'gotransit', 'metrolinx']);
  });
  it('a plan naming only the routed codeline adds nothing', () => {
    const p = prd(); const s = p.stories[0] as Record<string, unknown>;
    s.overallPlan = { codelines: [{ codeline: 'cxshared', part: 'fix', order: 1 }], packages: [] };
    expect(adoptPlanCodelines(s, p, FACTS)).toEqual([]);
    expect(s.codelines).toBeUndefined();
    expect(p.project.outputDirs).toHaveLength(1);
  });
  it('a codeline the plan names that discovery never grounded is not invented (no path, no lane)', () => {
    const p = prd(); const s = p.stories[0] as Record<string, unknown>;
    s.overallPlan = { codelines: [{ codeline: 'cxshared', order: 1 }, { codeline: 'nowhere', order: 2 }], packages: [] };
    expect(adoptPlanCodelines(s, p, FACTS)).toEqual([]);
  });
  it('a lane the story already had is never dropped, even if the plan omits it', () => {
    const p = prd(); p.project.outputDirs.push({ codeline: 'gotransit', path: '/c/next.gotransit.com' });
    const s = p.stories[0] as Record<string, unknown>; s.codelines = ['cxshared', 'gotransit'];
    s.overallPlan = { codelines: [{ codeline: 'cxshared', order: 1 }, { codeline: 'upexpress', order: 2 }], packages: [] };
    expect(adoptPlanCodelines(s, p, FACTS)).toEqual(['upexpress']);
    expect(s.codelines).toEqual(['cxshared', 'gotransit', 'upexpress']);
  });
});
