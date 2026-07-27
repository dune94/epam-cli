/**
 * A dormant repo should not outrank a live one on word counts alone.
 *
 * Live AMSD-2041, 2026-07-27. Codeline discovery selected UPExpress.com for a
 * ticket tagged [GO, UP, MX] about CMS live preview. That repo's last commit was
 * 2025-11-16 — eight months earlier, zero commits in ninety days — while the
 * three sites that actually carry the Contentstack integration were all active:
 *
 *   UPExpress.com        last 2025-11-16     0 commits/90d   <- chosen
 *   next.upexpress.com   last 2026-07-16     5 commits/90d
 *   next.gotransit.com   last 2026-07-23    68 commits/90d
 *   next.metrolinx.com   last 2026-07-21    59 commits/90d
 *
 * The scorer is pure TF-IDF over CodeGraph hits. A legacy codebase is a rich
 * source of matching terms precisely BECAUSE it is the old implementation of the
 * same domain — it will often out-match its replacement. Nothing in the score
 * knows the difference between "this repo is about UP Express" and "this repo is
 * where UP Express is still being built".
 *
 * Recency is the missing discriminator, and it is deterministic: git already
 * knows. It is deliberately a MODIFIER rather than a term — relevance still
 * decides what is in the running, and recency breaks ties and demotes the dead.
 * A repo nobody has touched in a year is not where this quarter's feature lands.
 */

import { describe, it, expect } from 'vitest';
import { crossRepoTermScores, applyRecency } from '../../../orchestrations/scripts/lib/codeline-score.js';

/**
 * A stub CodeGraph. queryFn must return the HITS ARRAY — the scorer takes its
 * .length. Returning a number makes every score NaN, every comparison false, and
 * the ranking silently degrades to input order: a test that passes by accident.
 */
function queryFn(hits: Record<string, Record<string, number>>) {
  return (term: string, repoPath: string) =>
    new Array(hits[repoPath]?.[term] ?? 0).fill({});
}

const REPOS = [
  { path: '/r/UPExpress.com', name: 'UPExpress.com' },
  { path: '/r/next.upexpress.com', name: 'next.upexpress.com' },
];

// The legacy repo genuinely matches MORE — it is the old implementation.
const HITS = {
  '/r/UPExpress.com': { upexpress: 200, preview: 40 },
  '/r/next.upexpress.com': { upexpress: 90, preview: 25 },
};

describe('relevance alone puts the dead repo on top', () => {
  it('reproduces the live ranking', () => {
    const scored = crossRepoTermScores(REPOS, ['upexpress', 'preview'], queryFn(HITS));
    const top = [...scored].sort((a: any, b: any) => b.tier2 - a.tier2)[0];
    expect(top.name, 'the premise of this test no longer holds').toBe('UPExpress.com');
  });
});

describe('recency demotes a repo nobody is working in', () => {
  const AGES = {
    '/r/UPExpress.com': { daysSinceLastCommit: 253, commits90d: 0 },
    '/r/next.upexpress.com': { daysSinceLastCommit: 11, commits90d: 5 },
  };

  it('the active repo wins once recency is applied', () => {
    const scored = applyRecency(
      crossRepoTermScores(REPOS, ['upexpress', 'preview'], queryFn(HITS)), AGES);
    const top = [...scored].sort((a: any, b: any) => b.score - a.score)[0];
    expect(top.name,
      'a repo with zero commits in ninety days still outranks one under active ' +
      'development — this is the AMSD-2041 selection, unfixed')
      .toBe('next.upexpress.com');
  });

  it('does not let recency alone decide — relevance still gates', () => {
    // An active repo about something else entirely must not win on freshness.
    const repos = [...REPOS, { path: '/r/powerbi', name: 'metrolinx.powerbi.com' }];
    const hits = { ...HITS, '/r/powerbi': {} };            // matches nothing
    const ages = { ...AGES, '/r/powerbi': { daysSinceLastCommit: 0, commits90d: 400 } };
    const scored = applyRecency(
      crossRepoTermScores(repos, ['upexpress', 'preview'], queryFn(hits)), ages);
    const top = [...scored].sort((a: any, b: any) => b.score - a.score)[0];
    expect(top.name, 'a busy but irrelevant repo won on commit count alone')
      .not.toBe('metrolinx.powerbi.com');
  });

  it('is inert when git data is unavailable', () => {
    // No history (shallow clone, new repo) must not be read as "dormant" — that
    // would silently demote a legitimate candidate for a missing measurement.
    const scored = crossRepoTermScores(REPOS, ['upexpress'], queryFn(HITS));
    const withNone = applyRecency(scored, {});
    for (const r of withNone as any[]) {
      expect(r.score, `${r.name} was penalised for having no measurement`).toBe(r.tier2);
    }
  });

  it('reports the modifier, so a ranking can be explained', () => {
    const scored = applyRecency(
      crossRepoTermScores(REPOS, ['upexpress'], queryFn(HITS)), AGES) as any[];
    const dead = scored.find(r => r.name === 'UPExpress.com');
    expect(dead.recency, 'nothing records why the score moved').toBeTruthy();
    expect(dead.recency.daysSinceLastCommit).toBe(253);
  });
});
