// ─────────────────────────────────────────────────────────────────────────────
// codeline-score.js — Tier-2 relevance scoring for codeline discovery.
//
// Extracted from codeline-discovery.js as a pure, injectable module so the
// scoring can be unit-tested against known repo/term distributions instead of
// only being asserted on as source text.
//
// WHY THIS REPLACES THE OLD BM25-SUM (root-caused live on AMSD-1820, 2026-07-24)
//
// The old Tier 2 did: `sum of BM25 scores from queryCodeGraph(joinedQuery, repo, 20)`.
// Two independent defects made that rank the WRONG repo first:
//
//   1. CAP SATURATION. The query was capped at 20 results and the sum taken over
//      those 20. Every candidate repo returned exactly 20 hits, so the score
//      collapsed to "average BM25 of your top 20" — structurally unable to
//      express "50 hits on the decisive term here, 0 there". (Switching from
//      result-count to BM25-sum, as an earlier fix did, only relocated the
//      saturation; it did not remove it.)
//
//   2. BM25 IS NOT COMPARABLE ACROSS REPOS. BM25's IDF is computed *within each
//      repo's own index*. A token that happens to be rare inside an irrelevant
//      repo scores high in that repo, regardless of being globally generic. That
//      is an intra-corpus relevance measure used as an inter-corpus ranking — a
//      category error. Generic tokens (email, amount, confirmation) flooded the
//      single joined query and drowned the one globally-rare token.
//
// Measured: querying `mozio` alone gave 50+ hits in azure.commerce.cdts and 0 in
// c365, yet the old Tier 2 scored c365 higher (140 vs 128). Only Tier-1 text and
// the LLM's prose reasoning rescued the selection — a 3-point margin out of 147.
//
// THE FIX: score on document frequency ACROSS THE REPO SET. Query each term
// separately, count how many repos contain it, and weight by real cross-repo IDF.
// A term in 1 of 31 repos is a decisive discriminator; a term in 31 of 31 is
// worth ~nothing. This also makes the hand-maintained DOMAIN_STOPWORDS list
// redundant in principle — generic terms now self-neutralise via their own
// document frequency rather than needing to be enumerated by hand.
// ─────────────────────────────────────────────────────────────────────────────

// Query far past the old cap: for a genuinely rare term the raw hit COUNT is
// itself the landslide signal (50 vs 0), so the ceiling must not truncate it.
const DEFAULT_TERM_QUERY_LIMIT = 200;

/**
 * Score each repo by cross-repo term exclusivity.
 *
 * @param {Array<{name:string,path:string}>} repos  candidate repos
 * @param {string[]} terms                          high-specificity query terms
 * @param {(term:string, repoPath:string, limit:number)=>Array} queryFn
 *        CodeGraph query, injected for testability
 * @param {{limit?:number}} [opts]
 * @returns {Array} repos with `tier2` (number) and `breakdown` (per-term detail)
 */
function crossRepoTermScores(repos, terms, queryFn, opts = {}) {
  const limit = opts.limit || DEFAULT_TERM_QUERY_LIMIT;
  const N = repos.length;

  // Querying every term against every repo is terms x repos process spawns
  // (~190ms each): 7 terms over 31 repos is ~40s, versus ~6s for the old single
  // joined query. Correctness wins over speed here — the joined query is what let
  // generic tokens drown the discriminating one — but cap the term count so this
  // stays bounded no matter how verbose a ticket is. Terms arrive already ordered
  // most-specific-first, so truncation drops the least useful ones.
  const maxTerms = opts.maxTerms || Number(process.env.CODELINE_SCORE_MAX_TERMS || 7);
  if (terms.length > maxTerms) terms = terms.slice(0, maxTerms);

  // Pass 1 — per-term hit counts per repo, and document frequency across repos.
  const hits = new Map();          // repoPath -> { term: count }
  const docFreq = new Map();       // term -> number of repos containing it
  for (const repo of repos) hits.set(repo.path, {});

  for (const term of terms) {
    let df = 0;
    for (const repo of repos) {
      let n = 0;
      try {
        n = (queryFn(term, repo.path, limit) || []).length;
      } catch {
        n = 0; // a repo whose index is unreadable simply contributes nothing
      }
      hits.get(repo.path)[term] = n;
      if (n > 0) df++;
    }
    docFreq.set(term, df);
  }

  // Pass 2 — combine. tf is log-damped so a huge count cannot swamp everything,
  // but (unlike a hard cap) it stays strictly monotonic: 50 always beats 20.
  return repos.map(repo => {
    const perTerm = hits.get(repo.path) || {};
    let tier2 = 0;
    const breakdown = {};
    for (const term of terms) {
      const n = perTerm[term] || 0;
      if (n <= 0) continue;
      const df = docFreq.get(term) || N;
      const idf = Math.log(1 + N / df);   // in 1 of N => large; in N of N => log(2)
      const tf = Math.log(1 + n);
      const contribution = tf * idf;
      tier2 += contribution;
      breakdown[term] = {
        hits: n,
        repoFrequency: df,
        contribution: Number(contribution.toFixed(3)),
      };
    }
    return { ...repo, tier2, breakdown };
  });
}

/**
 * Ranking confidence — lets a caller skip the LLM when the deterministic
 * evidence is already decisive, and flag when it genuinely is not.
 * `ratio` is top1/top2 (Infinity when top2 is zero).
 */
function rankingConfidence(scored) {
  const s = [...scored].sort((a, b) => b.tier2 - a.tier2);
  const top1 = s[0] ? s[0].tier2 : 0;
  const top2 = s[1] ? s[1].tier2 : 0;
  const ratio = top2 > 0 ? top1 / top2 : (top1 > 0 ? Infinity : 1);
  return { top1, top2, gap: top1 - top2, ratio, decisive: ratio >= 1.5 && top1 > 0 };
}

module.exports = { crossRepoTermScores, rankingConfidence, DEFAULT_TERM_QUERY_LIMIT };
