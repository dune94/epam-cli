
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
 * repoRecency(repoPath) — how alive is this repository?
 *
 * Deterministic, from git. No model, no heuristic about names.
 * Returns null when there is no usable history (shallow clone, empty repo), so
 * a MISSING measurement is never confused with a DORMANT repo.
 */
function repoRecency(repoPath, execFileSync = require('child_process').execFileSync) {
  const git = (args) => execFileSync('git', ['-C', repoPath, ...args],
    { encoding: 'utf8', timeout: toolTimeoutMs('gitRead'), stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const iso = git(['log', '-1', '--format=%cI']);
    if (!iso) return null;
    const days = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 86400000));
    const commits90d = git(['log', '--since=90 days ago', '--oneline'])
      .split('\n').filter(Boolean).length;
    return { daysSinceLastCommit: days, commits90d };
  } catch {
    return null;                       // not a repo, no history, git unavailable
  }
}

/**
 * applyRecency(scored, ages) — demote repositories nobody is working in.
 *
 * AMSD-2041 selected UPExpress.com: last commit eight months earlier, zero
 * commits in ninety days, for a feature landing in the actively-developed
 * next.* sites. Pure TF-IDF cannot tell "this repo is ABOUT UP Express" from
 * "this repo is where UP Express is still BUILT" — and a legacy codebase often
 * matches BETTER, precisely because it is the old implementation of the same
 * domain.
 *
 * Recency is a MODIFIER, never a term. Relevance decides who is in the running;
 * this breaks ties and demotes the dead. A repo that matches nothing scores zero
 * and stays zero however busy it is — otherwise the most active repository in
 * the organisation would win every ticket.
 *
 * Multiplicative and bounded: a live repo keeps its score, a dormant one is
 * halved. It cannot rescue an irrelevant repo, and it cannot bury a decisive
 * relevance gap.
 */
function applyRecency(scored, ages = {}, opts = {}) {
  const staleDays = opts.staleDays || Number(process.env.CODELINE_STALE_DAYS || 180);
  const floor = opts.floor || Number(process.env.CODELINE_STALE_FLOOR || 0.5);
  return scored.map((repo) => {
    const age = ages[repo.path];
    if (!age || typeof age.daysSinceLastCommit !== 'number') {
      // No measurement is NOT evidence of dormancy. Leave the score untouched.
      return { ...repo, score: repo.tier2, recency: null };
    }
    // Linear decay from "today" to staleDays, then flat at the floor.
    const decay = age.daysSinceLastCommit >= staleDays
      ? floor
      : 1 - (1 - floor) * (age.daysSinceLastCommit / staleDays);
    return {
      ...repo,
      score: repo.tier2 * decay,
      recency: { ...age, multiplier: Number(decay.toFixed(3)) },
    };
  });
}


/**
 * orderCodelines(repos) — producers before consumers.
 *
 * A story spanning several codelines runs lane by lane, sequentially, and a
 * completed lane publishes its exported surface for later lanes to read. That is
 * only useful if the lane producing the surface runs first; in discovery order
 * it frequently does not, and every lane investigates blind.
 *
 * The ordering is taken from the code, not from configuration: a repository
 * declares a package name, and repositories that consume it list that name among
 * their dependencies. That edge is a fact. Only edges BETWEEN the selected
 * codelines count — every repo depends on third-party packages, and those say
 * nothing about run order.
 *
 * Refuses to invent what it cannot justify: repositories with no edges keep the
 * order they arrived in, and a dependency cycle (no valid topological order)
 * falls back to input order rather than dropping a codeline, because a silently
 * skipped repository is a repository whose work never happens.
 */
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

module.exports = { crossRepoTermScores, applyRecency, repoRecency, orderCodelines, rankingConfidence, DEFAULT_TERM_QUERY_LIMIT };
