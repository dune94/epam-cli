/**
 * Codeline Tier-2 scoring: cross-repo term exclusivity, not intra-repo BM25.
 *
 * Root-caused live on the AMSD-1820 run (2026-07-24). Two defects in the old
 * `scoreRepos` Tier 2 (`bm25Sum` of `queryCodeGraph(query, repo, 20)`):
 *
 *   1. CAP SATURATION — every candidate repo returned exactly 20 hits, so summing
 *      a capped top-20 degenerates to "average BM25 of your top 20". It cannot
 *      express "50 hits on the key term here, 0 there".
 *   2. BM25 IS NOT COMPARABLE ACROSS REPOS — BM25's IDF is computed within each
 *      repo's own index, so a term that is rare *inside* an irrelevant repo scores
 *      high *in that repo*. An intra-corpus relevance measure was being used as an
 *      inter-corpus ranking.
 *
 * Measured consequence: querying `mozio` alone gave 50+ hits in azure.commerce.cdts
 * and 0 in c365, yet Tier 2 ranked c365 HIGHER (140 vs 128) — the deterministic
 * evidence argued for the WRONG repo. Only Tier-1 text + LLM prose rescued it.
 *
 * The fix scores on document frequency ACROSS THE REPO SET: a term in 1 of N repos
 * is a huge discriminator; a term in all N is worth ~nothing.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { crossRepoTermScores } = require_(
  '../../../orchestrations/scripts/lib/codeline-score.js'
);

// Real shape observed live: 31 repos, these are the top candidates.
const REPOS = [
  { name: 'azure.commerce.cdts', path: '/m/azure.commerce.cdts' },
  { name: 'c365', path: '/m/c365' },
  { name: 'secure.gotransit.com', path: '/m/secure.gotransit.com' },
  { name: 'next.gotransit.com', path: '/m/next.gotransit.com' },
];
// Pad to the real repo-set size so IDF reflects a realistic corpus.
for (let i = 0; i < 27; i++) REPOS.push({ name: `filler${i}`, path: `/m/filler${i}` });

/** Fake CodeGraph query: returns `n` result objects for (term, repo). */
function makeQueryFn(table: Record<string, Record<string, number>>) {
  return (term: string, repoPath: string, limit: number) => {
    const n = Math.min(table[term]?.[repoPath] ?? 0, limit);
    return Array.from({ length: n }, (_, i) => ({ node: { id: `${term}:${i}` }, score: 50 }));
  };
}

describe('Tier-2 scoring — cross-repo term exclusivity', () => {
  it('the globally-rare term decides: cdts must beat c365, reversing the live inversion', () => {
    // Real live measurements: `mozio` 50+ in cdts, 0 in c365. Generic tokens flood
    // every repo equally — those are what drowned the decisive term before.
    const everywhere = Object.fromEntries(REPOS.map(r => [r.path, 20]));
    const table = {
      mozio: { '/m/azure.commerce.cdts': 50 },              // 1 repo only
      promo: { '/m/azure.commerce.cdts': 15, '/m/c365': 2 },
      email: everywhere,
      amount: everywhere,
      confirmation: everywhere,
      displayed: everywhere,
      expected: everywhere,
    };
    const scored = crossRepoTermScores(REPOS, Object.keys(table), makeQueryFn(table));
    const byName = Object.fromEntries(scored.map((s: any) => [s.name, s.tier2]));

    expect(byName['azure.commerce.cdts']).toBeGreaterThan(byName['c365']);
    // Not a 3-point coin flip — the exclusive term must dominate decisively.
    expect(byName['azure.commerce.cdts']).toBeGreaterThan(byName['c365'] * 1.5);
  });

  it('a term in 1 of N repos outweighs a term in all N (real IDF, not intra-repo BM25)', () => {
    const everywhere = Object.fromEntries(REPOS.map(r => [r.path, 20]));
    const rare = crossRepoTermScores(
      REPOS, ['mozio'], makeQueryFn({ mozio: { '/m/c365': 20 } })
    ).find((s: any) => s.name === 'c365')!.tier2;
    const generic = crossRepoTermScores(
      REPOS, ['email'], makeQueryFn({ email: everywhere })
    ).find((s: any) => s.name === 'c365')!.tier2;

    expect(rare).toBeGreaterThan(generic * 2);
  });

  it('no cap saturation: 50 hits must score strictly higher than 20 hits', () => {
    // The old code capped at 20, so 50-vs-20 was indistinguishable.
    const table = { mozio: { '/m/azure.commerce.cdts': 50, '/m/c365': 20 } };
    const scored = crossRepoTermScores(REPOS, ['mozio'], makeQueryFn(table));
    const a = scored.find((s: any) => s.name === 'azure.commerce.cdts')!.tier2;
    const b = scored.find((s: any) => s.name === 'c365')!.tier2;
    expect(a).toBeGreaterThan(b);
  });

  it('a repo with zero hits on every term scores zero', () => {
    const scored = crossRepoTermScores(
      REPOS, ['mozio'], makeQueryFn({ mozio: { '/m/azure.commerce.cdts': 50 } })
    );
    expect(scored.find((s: any) => s.name === 'c365')!.tier2).toBe(0);
  });

  it('reports a per-term breakdown so a ranking can be explained, not just trusted', () => {
    const table = { mozio: { '/m/azure.commerce.cdts': 50 } };
    const scored = crossRepoTermScores(REPOS, ['mozio'], makeQueryFn(table));
    const cdts = scored.find((s: any) => s.name === 'azure.commerce.cdts')!;
    expect(cdts.breakdown.mozio.hits).toBe(50);
    expect(cdts.breakdown.mozio.repoFrequency).toBe(1);   // 1 of 31 repos
  });

  it('queries well past the old 20 cap so high-frequency evidence survives', () => {
    const seen: number[] = [];
    const q = (_t: string, _p: string, limit: number) => { seen.push(limit); return []; };
    crossRepoTermScores(REPOS, ['mozio'], q);
    expect(Math.min(...seen)).toBeGreaterThan(20);
  });
});
