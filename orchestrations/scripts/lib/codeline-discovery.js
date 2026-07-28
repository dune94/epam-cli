#!/usr/bin/env node
/**
 * codeline-discovery.js — Brownfield codeline discovery for the Jira pipeline.
 *
 * Scans JIRA_CODELINE_ROOT, builds a repo manifest from the filesystem, then
 * calls an LLM (via ai-run.sh) to match the supplied Jira tickets to the
 * correct local repositories.  The caller (ingest-jira-tickets.sh) exports
 * JIRA_CODELINES and JIRA_WORKTREE_<NAME> from this output so that the
 * downstream synthesize-prd-from-jira.js step can build outputDirs without
 * any hardcoded worktree paths in the project env file.
 *
 * This module is an internal pipeline stage — not a standalone tool.  It is
 * invoked exclusively from ingest-jira-tickets.sh when EPAM_BROWNFIELD=1 and
 * JIRA_CODELINES is absent.  Greenfield runs never reach this code.
 *
 * Usage (called by ingest-jira-tickets.sh):
 *   node codeline-discovery.js --issues <path> --root <dir> --out <path> [--dry-run]
 *
 * Output JSON (written to --out):
 *   { "codelines": [{ "name": "cdts", "path": "/abs/path", "reason": "..." }] }
 *
 * Env vars consumed:
 *   ORCH_GATE_MODEL   — LLM model for classification (falls back to EPAM_MODEL)
 *   NODE_BIN          — node binary path
 */

'use strict';

const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');
const { crossRepoTermScores, applyRecency, repoRecency, orderCodelines, rankingConfidence } = require('./codeline-score');

// Semble removed from codeline scoring — all repos are CodeGraph-indexed,
// making Tier 3 probabilistic scoring redundant and a source of re-ranking noise.
// SEMBLE_ENABLED is kept for spec-mode-runner.js (brownfield context fallback only).

let _codegraph = null;
function getCodeGraph() {
  if (_codegraph) return _codegraph;
  try {
    _codegraph = require('./codegraph-context');
  } catch {
    _codegraph = { isCodeGraphIndexed: () => false, queryCodeGraph: () => [] };
  }
  return _codegraph;
}

// ── Arg parsing ────────────────────────────────────────────────────────────
const argv    = process.argv.slice(2);
const getArg  = (flag, def = '') => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : def; };
const DRY_RUN = argv.includes('--dry-run') || process.env.CODELINE_DISCOVERY_DRY_RUN === '1';
// Explicit provider. These called ai-run.sh with --model but NO --provider, so
// provider came only from ambient env — e.g. `--provider qwen --model claude-haiku`.
const PROVIDER = getArg('--provider', process.env.ORCH_GATE_PROVIDER || process.env.EPAM_ORCHESTRATION_PROVIDER || 'qwen');
const MODEL   = getArg('--model', process.env.ORCH_GATE_MODEL || process.env.EPAM_MODEL || 'z-ai/glm-5.2');

const ISSUES_PATH = getArg('--issues');
const ROOT_DIR    = getArg('--root', process.env.JIRA_CODELINE_ROOT || '');
const OUT_PATH    = getArg('--out', '');

if (!ISSUES_PATH || !ROOT_DIR || !OUT_PATH) {
  process.stderr.write('Usage: node codeline-discovery.js --issues <path> --root <dir> --out <path>\n');
  process.exit(1);
}

const SCRIPT_DIR = path.join(__dirname, '..');
// Overridable for tests only — lets a test point callLlm() at a fake
// ai-run.sh stub with a controlled response, without ever touching the real
// one. Empty by default in production; no behavior change unless set.
const AI_RUN_SH  = process.env.CODELINE_DISCOVERY_AI_RUN_SH_OVERRIDE || path.join(SCRIPT_DIR, 'ai-run.sh');

const log  = msg => process.stderr.write(`[codeline-discovery] ${msg}\n`);
const warn = msg => process.stderr.write(`[codeline-discovery] WARN: ${msg}\n`);

// ── Repo manifest builder ──────────────────────────────────────────────────
// Scans JIRA_CODELINE_ROOT and returns an array of repo descriptors.
// Only directories that are git repos are included (non-git dirs are skipped).

function buildRepoManifest(rootDir) {
  const entries = [];
  let names;
  try {
    names = fs.readdirSync(rootDir).sort();
  } catch (e) {
    throw new Error(`Cannot read JIRA_CODELINE_ROOT: ${rootDir} — ${e.message}`);
  }

  for (const name of names) {
    const full = path.join(rootDir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;

    // Only include git repos — bare directories without .git have no meaningful
    // commit history and cannot serve as a brownfield worktree baseline.
    const isGit = fs.existsSync(path.join(full, '.git'));
    if (!isGit) continue;

    // Exclude docs.* repos — documentation projects are never in scope for
    // brownfield code changes and add Semble noise (they match ticket keywords
    // via documentation content rather than implementation code).
    if (/^docs\./i.test(name)) {
      log(`Skipping docs repo (not in maintenance scope): ${name}`);
      continue;
    }

    // Stack detection from manifest files
    let stack = 'unknown';
    let packageName = name;
    let description = '';

    if (fs.existsSync(path.join(full, 'package.json'))) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(full, 'package.json'), 'utf8'));
        stack       = 'typescript';
        packageName = pkg.name || name;
        description = pkg.description || '';
      } catch { /* use defaults */ }
    } else if (fs.existsSync(path.join(full, 'pyproject.toml'))) {
      stack = 'python';
    } else if (fs.existsSync(path.join(full, 'go.mod'))) {
      stack = 'go';
    }

    // Short README excerpt for extra context (first non-empty line after headings)
    let readmeExcerpt = '';
    for (const readmeName of ['README.md', 'readme.md', 'README.txt']) {
      const readmePath = path.join(full, readmeName);
      if (fs.existsSync(readmePath)) {
        try {
          const lines = fs.readFileSync(readmePath, 'utf8').split('\n');
          const excerpt = lines.find(l => l.trim() && !l.startsWith('#'));
          readmeExcerpt = (excerpt || '').slice(0, 120);
        } catch { /* ignore */ }
        break;
      }
    }

    entries.push({ name, path: full, stack, packageName, description, readmeExcerpt });
  }

  return entries;
}

// ── Repo scoring ───────────────────────────────────────────────────────────
// Three-tier scoring. Runs every tier that is available so the highest-signal
// method always wins regardless of which tools are installed.
//
//   Tier 1 — name/description/readme keyword match   (fast, zero I/O, always)
//   Tier 2 — CodeGraph FTS5 symbol-name query        (CODEGRAPH_ENABLED=1, indexed repos only)
//             Deterministic: finds functions literally named "applyReportDiscounts";
//             5 pts per symbol hit, maximum 100 pts. All indexed repos in the codeline root are
//             indexed — this tier fires for every repo, giving decisive separation.
//
// Returns repos sorted descending by combined score, sliced to topN.

function scoreRepos(issues, manifest, topN = 8) {
  const text = issues.map(i => `${i.title || ''} ${(i.description || '').slice(0, 500)}`).join(' ');
  const words = [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4)
      .filter(w => !['with','that','this','from','have','will','when','then','also','been','were','they','them'].includes(w))
  )];

  const cgEnabled = process.env.CODEGRAPH_ENABLED === '1';
  const cg        = cgEnabled ? getCodeGraph() : null;

  // CodeGraph query uses ONLY high-specificity terms — words that are rare in the
  // transit domain and therefore discriminate between repos. Generic transit nouns
  // ("trip", "ticket", "return", "schedule", "route", "station", "fare", "service",
  // "booking", "departure", "arrival") appear in every repo and flood FTS5 results
  // equally, collapsing score separation. Stripping them forces the query to match
  // on product names (mozio, promo), business concepts (discount, confirmation), and
  // integration specifics (email, dispatch, amount) that only the right repo handles.
  const DOMAIN_STOPWORDS = new Set([
    'trip','trips','ticket','tickets','return','schedule','schedules','route','routes',
    'station','stations','fare','fares','service','services','booking','bookings',
    'departure','departures','arrival','arrivals','transit','passenger','passengers',
    'platform','journey','journeys','stop','stops','line','lines','train','trains',
    'bus','buses','payment','payments','order','orders','account','accounts',
    'user','users','status','request','response','data','item','items','list',
    'number','code','type','name','time','date','from','path','info',
  ]);
  const cgSpecificWords = words.filter(w => !DOMAIN_STOPWORDS.has(w));
  const cgQuery = cgSpecificWords.slice(0, 10).join(' ');

  // Tier 2 is computed for ALL repos at once, because cross-repo document
  // frequency is only knowable across the whole candidate set — see
  // codeline-score.js for the full root cause. Terms are queried INDIVIDUALLY
  // (not as one joined query) so a globally-rare token like a product name
  // cannot be drowned by generic ones sharing a capped result window.
  let tier2ByPath = new Map();
  if (cgEnabled && cg && cgSpecificWords.length) {
    // Bound = codeline-score's own cap, so the count logged below is the count
    // actually queried (they diverged at first, making the log lie).
    const _maxTerms = Number(process.env.CODELINE_SCORE_MAX_TERMS || 7);
    const terms = cgSpecificWords.slice(0, _maxTerms);
    // Index-on-demand first: indexing status must never decide whether a repo
    // is considered (the 2026-07-22 starvation bug — see the note below).
    for (const repo of manifest) {
      try {
        if (!cg.isCodeGraphIndexed(repo.path)) cg.initCodeGraph(repo.path, { quiet: true });
      } catch { /* unindexable repo still gets Tier 1 */ }
    }
    const indexed = manifest.filter(r => { try { return cg.isCodeGraphIndexed(r.path); } catch { return false; } });
    let t2 = crossRepoTermScores(indexed, terms, (term, repoPath, limit) =>
      cg.queryCodeGraph(term, repoPath, limit));

    // Demote repositories nobody is working in. Live 2026-07-27: a repository
    // whose last commit was eight months earlier, with zero commits in ninety
    // days, outranked the actively-developed sites where the work belonged. A
    // legacy codebase
    // often out-matches its replacement on term frequency precisely BECAUSE it is
    // the old implementation of the same domain. Recency is the discriminator
    // relevance cannot provide, and git already knows it.
    if (process.env.CODELINE_RECENCY !== '0') {
      const ages = {};
      for (const r of indexed) {
        const age = repoRecency(r.path);
        if (age) ages[r.path] = age;
      }
      t2 = applyRecency(t2, ages);
      for (const r of t2) {
        if (r.recency && r.recency.multiplier < 1) {
          log(`  recency: ${r.name} last commit ${r.recency.daysSinceLastCommit}d ago, ` +
              `${r.recency.commits90d} commit(s)/90d → score ×${r.recency.multiplier}`);
        }
      }
      // The modifier decides the ranking from here on.
      for (const r of t2) r.tier2 = r.score;
    }
    for (const r of t2) tier2ByPath.set(r.path, r);

    const conf = rankingConfidence(t2);
    const ranked = [...t2].sort((a, b) => b.tier2 - a.tier2).slice(0, 3);
    log(`Tier-2 cross-repo scoring (${terms.length} term(s) over ${indexed.length} indexed repo(s)): ` +
        ranked.map(r => `${r.name}=${r.tier2.toFixed(1)}`).join(', ') +
        ` | top1/top2=${conf.ratio === Infinity ? 'inf' : conf.ratio.toFixed(2)}` +
        ` ${conf.decisive ? '(DECISIVE)' : '(CLOSE — genuine ambiguity, LLM judgment matters)'}`);
    const best = ranked[0];
    if (best && best.breakdown) {
      const drivers = Object.entries(best.breakdown)
        .sort((a, b) => b[1].contribution - a[1].contribution).slice(0, 3)
        .map(([t, d]) => `${t}(hits=${d.hits}, in ${d.repoFrequency}/${indexed.length} repos)`);
      log(`  top candidate '${best.name}' driven by: ${drivers.join(', ')}`);
    }
  }

  const scored = manifest.map(repo => {
    let score = 0;

    // Tier 1 — name/description keyword match (no I/O, always runs)
    const repoText = `${repo.name} ${repo.packageName} ${repo.description} ${repo.readmeExcerpt}`.toLowerCase();
    for (const word of words) {
      if (repoText.includes(word)) score += 3;
    }

    // Tier 2 — CodeGraph FTS5 symbol-name query.
    // Use the SUM of BM25 scores, not result count. BM25 rewards rare/specific
    // terms (e.g. "mozio" in a symbol name scores 70-100) and penalises common
    // words (e.g. "email" in comments scores 3-5). Simple result counting
    // saturated at the 20-result cap for every repo because common words like
    // "email" and "amount" appear in every codebase, collapsing score separation.
    //
    // Live bug (2026-07-22): this used to assume every candidate repo was
    // already indexed ("every repo in the root is indexed" — a stale,
    // unverified assumption). A repo missing its .codegraph/codegraph.db got
    // ZERO Tier-2 score no matter how relevant it actually was, while any
    // already-indexed-but-irrelevant repo still got a real BM25 boost —
    // silently starving the correct repo out of the top-N candidates offered
    // to the LLM. Confirmed live: azure.commerce.cdts (the actual fix site for
    // AMSD-1820) was never indexed and didn't even make top-8; the LLM was
    // forced to pick from the wrong candidates and chose an unrelated repo.
    // Fix: index on demand, right here, before scoring — indexing status must
    // never gate whether a repo is even considered.
    // Tier 2 — cross-repo term exclusivity, computed above for the whole set.
    // Scaled by 10 to sit on the same order of magnitude as Tier 1 (~9-30):
    // a term unique to one repo contributes ~10-14 here, a term present in every
    // repo contributes ~2, so a genuine discriminator outweighs generic noise
    // instead of being averaged away by it.
    const t2 = tier2ByPath.get(repo.path);
    const tier2Score = t2 ? Math.round(t2.tier2 * 10) : 0;
    score += tier2Score;

    return { ...repo, score, tier2: tier2Score, tier2Breakdown: t2 ? t2.breakdown : {} };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, topN);
  log(`Repo scoring: top ${top.length} candidate(s) from ${manifest.length} repos (scores: ${top.map(r => `${r.name}=${r.score}`).join(', ')})`);
  return top;
}

// ── Best-candidate selection (used by dry-run and LLM-failure fallback) ───
// Picks the highest-scored repo from a pre-scored (sorted descending) list.
// Never selects by alphabetical position — that was the bug that caused wrong
// codeline selection when the LLM timed out.

function selectBestCandidate(scored) {
  if (scored.length === 0) {
    throw new Error('No git repositories found under JIRA_CODELINE_ROOT — cannot discover codelines.');
  }
  const repo = scored[0]; // already sorted descending by scoreRepos()
  const name = deriveCodelineName(repo.name);
  return { codelines: [{ name, path: repo.path, reason: `[scored-fallback] Highest candidate (score: ${repo.score})` }] };
}

// Codeline name derivation lives in lib/codeline-name.js so it can be tested
// directly — this file is a CLI whose IIFE runs on require.
const { deriveCodelineName } = require('./codeline-name');


// ── LLM discovery call ─────────────────────────────────────────────────────

function buildDiscoveryPrompt(issues, manifest) {
  const manifestSummary = manifest.map(r =>
    `- dir: ${r.name}\n  path: ${r.path}\n  stack: ${r.stack}\n  package: ${r.packageName}` +
    (r.description ? `\n  description: ${r.description}` : '') +
    (r.readmeExcerpt ? `\n  readme: ${r.readmeExcerpt}` : '')
  ).join('\n\n');

  const issuesSummary = issues.map(i => {
    const comps = Array.isArray(i.components) ? i.components.filter(Boolean) : [];
    return `- key: ${i.jiraKey}\n  title: ${i.title}` +
      // The tracker's own statement of which product areas the ticket touches.
      // Several components is evidence of several repositories — it is not a
      // hint to be weighed against the summary, it is the field maintained for
      // exactly this purpose.
      (comps.length ? `\n  components: ${comps.join(', ')}` : '') +
      `\n  description: ${(i.description || '').slice(0, 300)}`;
  }).join('\n\n');

  return `You are the codeline-discovery agent for a brownfield engineering pipeline.

Your task: given a set of Jira tickets and a manifest of local code repositories,
identify which repository (or repositories) each ticket's changes belong to.

JIRA TICKETS:
${issuesSummary}

REPOSITORY MANIFEST (git repos only):
${manifestSummary}

The repository manifest above is PRE-SCORED and pre-filtered before reaching you —
each one is already a plausible candidate, not a random sample of all repos. It is
listed in descending order of match confidence: the FIRST entry is the strongest
candidate found by keyword and code-symbol matching against the ticket text.

Rules:
1. Match each ticket to the repository whose name, packageName, or description
   best fits the ticket's domain. Use context clues: service names, domain terms,
   technology references, component names, file path mentions.
2. You MUST return at least one repository for every ticket — an empty result is
   NEVER acceptable and will abort the entire pipeline run before any work can
   happen. If you are not fully confident, select your best guess from the list
   (the first-listed entry is usually a good choice, since the list is already
   ranked by match confidence) rather than returning nothing.

2a. ONE TICKET MAY SPAN SEVERAL REPOSITORIES, and you MUST return one entry for
   each. This estate is maintained as many separate codelines, so a single
   ticket routinely covers work in more than one of them — a change with both
   front-end and back-end parts, or one applied across several product areas.
   Returning a single repository for such a ticket silently drops the rest of
   the work: those repositories are never touched, and the run reports success
   having done a fraction of the job.

   The strongest evidence is the ticket's own "components" field, which is the
   tracker's record of which product areas it touches. When a ticket names
   several distinct product areas, return the repository that owns each one.
   Do not collapse them because one candidate scored highest — the ranking
   measures textual similarity to a single repository, not how much of the
   ticket that repository covers.

   Decide the count from the ticket. Do not aim for any particular number.
3. SELECT ON EVIDENCE, NOT ON A HUNCH. Every selected repository must be grounded
   in something concrete you can point at:
     - a ticket component, label or phrase that names that product area, or
     - something in the repository itself (its name, its manifest, its code)
       that matches what the ticket asks for.
   Its RANK IS NOT EVIDENCE. The scores are the thing you are adjudicating, so
   "it was the second-ranked candidate" justifies nothing. Neither does "it is
   probably the backend for X" — if you have to say likely, probably, or may be,
   you do not have evidence.
   If a part of the ticket clearly belongs SOMEWHERE but you cannot ground it in
   one of these repositories, DO NOT SELECT ONE ANYWAY. Put it in "unsure" with
   what you could not resolve. An unresolved component is real information and a
   human can settle it; a guess promoted to a selection cannot be spotted later.
   Do not omit a candidate you CAN ground merely because another also fits — a
   ticket spanning several product areas needs all of them (rule 2a).
4. Assign each selected repo a short codeline identifier: 2-20 chars, lowercase,
   alphanumeric only, no dots or dashes. Derive it from the directory name by
   removing only decoration - a domain suffix, or an organisation or platform
   prefix - and keeping the part that actually names the product. Keep every
   remaining word: for a directory "alpha-beta-gamma" the identifier is
   "alphabetagamma", NOT "gamma". Dropping words produces an identifier that no
   longer identifies the repository.
5. Return exactly one entry only when the ticket genuinely belongs to exactly one
   repository. "One entry" is the right answer for a self-contained change, and
   the wrong answer for a ticket spanning several product areas — see rule 2a.
6. "reason" must be one sentence explaining why THIS repository was selected, and
   what part of the ticket it covers. Every selected repository needs its own
   reason — a single justification covering the whole set makes a wrong
   selection impossible to spot afterwards.
7. "evidence" must quote the CONCRETE thing that grounds the selection: the
   ticket component/label/phrase verbatim, or the file, directory or manifest
   entry in that repository. It is not a second reason and not a restatement —
   if you cannot fill it without hedging, the repository belongs in "unsure",
   not in "codelines".

Output format (strict JSON, no markdown fences, no preamble, no trailing text):
{
  "codelines": [
    { "name": "cdts", "path": "/absolute/path/to/repo",
      "reason": "what part of the ticket this repo covers",
      "evidence": "ticket component \\"GO\\"" }
  ],
  "unsure": [
    { "part": "the part of the ticket you could not place",
      "why": "what you would need in order to place it" }
  ]
}`;
}

/**
 * dropUngroundedCodelines — a selection without evidence is not a selection.
 *
 * Live AMSD-2041: three codelines were grounded in ticket components (GO, UP,
 * MX) and a fourth was not — "second-ranked candidate LIKELY SERVING AS the
 * content management backend". That repo has no package.json; it holds
 * Functional/ and Integration/ assets and its last commit was an Azure Data
 * Factory pipeline change. The ticket is front-end live preview. It was included
 * because rule 3 used to say never to omit an uncertain candidate.
 *
 * Under MC-1 that is not merely wasteful. A story completes only when EVERY
 * declared lane completes and partial coverage fails the run, so a detective
 * correctly finding nothing to change in an irrelevant repo fails the story.
 *
 * Enforced in code because prompt wording alone has repeatedly not held here —
 * the detective was told "HARD LIMIT: 6 tool calls" and made 25. Deliberately
 * NOT a hedge-word blocklist: "likely"/"probably" is unmaintainable and evaded
 * by rephrasing. The requirement is positive — say what grounds it — and an
 * entry that cannot is surfaced, not silently dropped.
 */
function dropUngroundedCodelines(parsed) {
  if (!parsed || !Array.isArray(parsed.codelines)) return parsed;

  const kept = [];
  const dropped = [];
  for (const cl of parsed.codelines) {
    const evidence = String((cl && cl.evidence) || '').trim();
    if (evidence) kept.push(cl);
    else dropped.push(cl);
  }

  for (const cl of dropped) {
    warn(`codeline '${cl && cl.name}' (${cl && cl.path}) was selected with NO evidence — not running against it.`);
    warn(`  its stated reason was: ${(cl && cl.reason) || '(none)'}`);
    warn(`  a repository is selected on a ticket component/label/phrase or on something in the repo itself; a hunch is not enough.`);
  }
  for (const u of (Array.isArray(parsed.unsure) ? parsed.unsure : [])) {
    warn(`unresolved part of the ticket: ${u && u.part} — ${u && u.why}`);
    warn(`  no codeline was invented for it. Resolve it by hand if it matters.`);
  }

  // Never let this empty the selection: zero codelines aborts ingest entirely,
  // which is a worse outcome than proceeding with an unevidenced pick the
  // operator can see in the log.
  if (!kept.length && parsed.codelines.length) {
    warn('every codeline lacked evidence — keeping them rather than aborting the run, but treat this selection as unverified.');
    return parsed;
  }

  return { ...parsed, codelines: kept };
}

function callLlm(prompt) {
  const tmpPrompt = `/tmp/codeline-discovery-prompt-${process.pid}.txt`;
  fs.writeFileSync(tmpPrompt, prompt);
  const debug = process.env.DEBUG_CODELINE_DISCOVERY === '1';
  try {
    // stderr is captured (not discarded) when DEBUG_CODELINE_DISCOVERY=1, so
    // provider-side warnings/errors that still produce SOME stdout output
    // (and would otherwise be silently invisible) can actually be seen.
    // stderr is CAPTURED, never discarded. `2>/dev/null` turned a timeout into
    // "Empty response from ai-run.sh", so the run logged a tidy fallback to the
    // highest-scored repo and proceeded against the wrong codeline. The reason a
    // call failed is the only thing that makes the fallback judgeable.
    const _errFile = `${tmpPrompt}.err`;
    const cmd = debug
      ? `bash ${AI_RUN_SH} --provider ${PROVIDER} --model ${MODEL} < ${tmpPrompt}`
      : `bash ${AI_RUN_SH} --provider ${PROVIDER} --model ${MODEL} < ${tmpPrompt} 2>${_errFile}`;
    const raw = execSync(cmd, {
      encoding:   'utf8',
      // Covers BOTH passes: plan-execute puts a plan call (up to
      // EPAM_PLAN_TIMEOUT_SECS, 90s) and an execute call inside one ai-run.sh
      // invocation. 300000 was set for a single call and failed live on
      // AMSD-2041 the first time this ran with two.
      timeout:    Number(process.env.CODELINE_DISCOVERY_TIMEOUT_MS || 420000),
      maxBuffer:  10 * 1024 * 1024,
      env:        { ...process.env, EPAM_AGENT_NAME: 'codeline-discovery' },
    }).trim();

    if (debug) log(`DEBUG raw LLM response:\n${raw}`);

    if (!raw) {
      // Say WHY. "Empty response" describes the symptom and hides the cause.
      let why = '';
      try { why = require('fs').readFileSync(_errFile, 'utf8').trim().slice(-400); } catch { /* none */ }
      throw new Error('Empty response from ai-run.sh' + (why ? ` — stderr: ${why}` : ' (no stderr captured)'));
    }

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON in LLM response: ${raw.slice(0, 200)}`);

    const parsed = JSON.parse(jsonMatch[0]);
    if (debug) log(`DEBUG parsed codelines: ${JSON.stringify(parsed.codelines)}`);
    return dropUngroundedCodelines(parsed);
  } finally {
    try { fs.unlinkSync(tmpPrompt); } catch { /* ignore */ }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

(async () => {
  const issues = JSON.parse(fs.readFileSync(ISSUES_PATH, 'utf8'));
  log(`Scanning ${ROOT_DIR} for git repositories...`);
  const manifest = buildRepoManifest(ROOT_DIR);
  log(`Found ${manifest.length} git repo(s) in codeline root.`);

  if (manifest.length === 0) {
    process.stderr.write('[codeline-discovery] ERROR: No git repositories found in JIRA_CODELINE_ROOT.\n');
    process.exit(1);
  }

  // Score + rank repos (always — used for both the LLM candidate list and fallback selection).
  const candidates = scoreRepos(issues, manifest);

  let result;
  if (DRY_RUN) {
    // Dry-run: use the highest-scored candidate, never the first alphabetically.
    warn('DRY-RUN mode — skipping LLM call, selecting highest-scored repo.');
    result = selectBestCandidate(candidates);
  } else {
    log(`Calling LLM (${MODEL}) to match ${issues.length} ticket(s) to ${candidates.length} candidate repo(s)...`);
    const prompt = buildDiscoveryPrompt(issues, candidates);
    try {
      result = callLlm(prompt);
    } catch (e) {
      warn(`LLM call failed: ${e.message}. Using highest-scored candidate as fallback.`);
      result = selectBestCandidate(candidates);
    }
  }

  // Validate: paths must be absolute and must exist
  const validated = (result.codelines || []).filter(cl => {
    if (!path.isAbsolute(cl.path)) {
      warn(`Skipping codeline '${cl.name}' — path is not absolute: ${cl.path}`);
      return false;
    }
    if (!fs.existsSync(cl.path)) {
      warn(`Skipping codeline '${cl.name}' — path does not exist: ${cl.path}`);
      return false;
    }
    if (!fs.existsSync(path.join(cl.path, '.git'))) {
      warn(`Skipping codeline '${cl.name}' — not a git repo: ${cl.path}`);
      return false;
    }
    return true;
  });

  // Live bug (2026-07-22): the LLM sometimes returns a VALID JSON response
  // with an empty (or all-invalid-path) codelines array — not a call
  // failure (no exception thrown, so the try/catch above never fires), but
  // a genuine model decision to select nothing. Reproduced directly: same
  // prompt, same top-scored candidate, non-deterministic across identical
  // invocations — sometimes it picks a repo, sometimes it returns
  // {"codelines": []}. This used to hard-fail the entire pipeline before a
  // single story could even be attempted. Code-level determinism beats
  // relying on prompt wording alone to fix non-deterministic model
  // behavior — fall back to the same highest-scored candidate used for
  // dry-run and LLM-call-failure, exactly like those paths already do.
  if (validated.length === 0) {
    warn('LLM returned no valid codeline selection (empty result or all paths invalid). Using highest-scored candidate as fallback.');
    result = selectBestCandidate(candidates);
    const fallbackValidated = result.codelines.filter(cl =>
      path.isAbsolute(cl.path) && fs.existsSync(cl.path) && fs.existsSync(path.join(cl.path, '.git'))
    );
    if (fallbackValidated.length === 0) {
      process.stderr.write('[codeline-discovery] ERROR: Discovery returned no valid codeline paths, and the scored fallback is also invalid.\n');
      process.exit(1);
    }
    validated.push(...fallbackValidated);
  }

  // Producers before consumers. Lanes run sequentially and a completed lane
  // publishes its exported surface for later lanes' detectives to read — which
  // is only useful if the lane producing it went first. Taken from declared
  // inter-repo dependencies, so it is a fact about the code rather than a
  // configured preference; repos with no edges keep the order they arrived in.
  const ordered = orderCodelines(validated);
  if (ordered.length > 1 && ordered.map(c => c.name).join() !== validated.map(c => c.name).join()) {
    log(`Run order (producers first): ${ordered.map(c => c.name).join(' → ')}`);
  }

  const output = { codelines: ordered };
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));

  for (const cl of ordered) {
    log(`  → codeline '${cl.name}' = ${cl.path} (${cl.reason})`);
  }
  log(`Discovery complete. ${ordered.length} codeline(s) identified.`);
})();
