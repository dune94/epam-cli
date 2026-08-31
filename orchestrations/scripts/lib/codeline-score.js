
// Local tool caps are DECLARED — config/tool-timeouts.json. A literal here would be a
// second home for a decision that already has one.
const { toolTimeoutMs } = require('./tool-timeouts.js');
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
function orderCodelines(repos, readIdentity = null) {
  const fs = require('fs');
  const path = require('path');

  // WHAT A REPOSITORY CALLS ITSELF, AND WHAT IT DEPENDS ON — asked of the ecosystem, not assumed.
  //
  // This read `package.json` directly and took `dependencies`/`devDependencies` from it. On any
  // codeline that is not Node it returned null, so `pkgName` was null, nothing was ever entered
  // into the owned-name map, every indegree stayed 0, and the producers-before-consumers ordering
  // silently degraded to input order. A wrong order that looks exactly like a right one.
  //
  // Each provider already answers both questions for its own ecosystem (`selfName`, `deps`), so
  // the first manifest the repository actually carries decides how it is read.
  const read = readIdentity || ((repoPath) => {
    const { allManifests } = require('./ecosystem-registry.js');
    for (const eco of allManifests()) {
      let text;
      try { text = fs.readFileSync(path.join(repoPath, eco.file), 'utf8'); } catch { continue; }
      return {
        name: typeof eco.selfName === 'function' ? (eco.selfName(text) || null) : null,
        deps: typeof eco.deps === 'function' ? (eco.deps(text) || []) : [],
      };
    }
    return null;
  });

  const meta = repos.map((r) => {
    const id = read(r.path) || {};
    return {
      repo: r,
      pkgName: id.name || null,
      deps: Array.isArray(id.deps) ? id.deps : [],
    };
  });

  const owned = new Map();                       // package name -> index
  meta.forEach((m, i) => { if (m.pkgName) owned.set(m.pkgName, i); });

  // edge i -> j : i must run BEFORE j, because j depends on i
  const indegree = meta.map(() => 0);
  const edges = meta.map(() => []);
  meta.forEach((m, j) => {
    for (const d of m.deps) {
      const i = owned.get(d);
      if (i === undefined || i === j) continue;  // external package, or itself
      edges[i].push(j);
      indegree[j] += 1;
    }
  });

  // Kahn LEVEL BY LEVEL. The ready set is collected before any decrement is
  // applied — decrementing mid-pass lets a consumer freed earlier in the same
  // sweep overtake one that appeared before it in the input, which silently
  // reorders repositories whose relative order was never ours to change.
  const out = [];
  const done = new Set();
  for (;;) {
    const ready = [];
    for (let i = 0; i < meta.length; i += 1) {
      if (!done.has(i) && indegree[i] === 0) ready.push(i);
    }
    if (!ready.length) break;
    for (const i of ready) { out.push(meta[i].repo); done.add(i); }
    for (const i of ready) { for (const j of edges[i]) indegree[j] -= 1; }
  }
  // A cycle leaves nodes unplaced. Append them rather than lose them.
  meta.forEach((m, i) => { if (!done.has(i)) out.push(m.repo); });
  return out;
}

// The ranking apparatus that used to live here — crossRepoTermScores, repoRecency,
// applyRecency, rankingConfidence and DEFAULT_TERM_QUERY_LIMIT — is gone. It ranked candidate
// repositories in engine code, and that decision belongs to the agent; codeline-discovery.js said
// so in a comment while the functions stayed behind, exported and called by nothing. Sequencing
// the lanes the agent chose is what remains.
module.exports = { orderCodelines };
