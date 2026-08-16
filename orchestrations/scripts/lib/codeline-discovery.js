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
 *   { "codelines": [{ "name": "<identifier>", "path": "/abs/path", "reason": "..." }] }
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
const { rankByStructure } = require('./codeline-structure');
// THE ONE ECOSYSTEM TABLE. This file used to carry a three-branch stack ladder of its own.
const { allManifests } = require('./ecosystems.js');

/**
 * Append this call's spend to the activity log. Best-effort by design: a cost record that fails
 * to write must never take down the call it was measuring, and every failure here is silent for
 * that reason. What is NOT silent is the absence of the plumbing — that is what the test guards.
 */
function _emitDiscoveryCost(costFile, agent) {
  try {
    const { emitCostSnapshot } = require('./cost-emitter.js');
    emitCostSnapshot({
      resultFile: costFile,
      activityFile: process.env.ACTIVITY_FILE
        || path.join(process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs'), 'agent-activity.jsonl'),
      agent,
      storyId: '',
      phase: process.env.PHASE || '',
      model: MODEL,
      provider: PROVIDER,
    });
  } catch { /* cost emission must never break the agent call */ }
  try { fs.unlinkSync(costFile); } catch { /* ignore */ }
}

/**
 * The directory-name patterns the scan skips. Read once per scan so a test can change the
 * environment between scans, and so a malformed pattern fails loudly rather than silently
 * excluding nothing — a scan that quietly stops excluding grows the candidate list and shifts
 * the ranking that chooses a client repository.
 */
function _scanExclusions() {
  const env = (process.env.EPAM_CODELINE_EXCLUDE || '').trim();
  let patterns;
  if (env) {
    patterns = env.split(',').map((p) => p.trim()).filter(Boolean);
  } else {
    const cfg = path.join(__dirname, '..', '..', 'config', 'codeline-scan.json');
    patterns = JSON.parse(fs.readFileSync(cfg, 'utf8')).exclude || [];
  }
  return patterns.map((p) => new RegExp(p, 'i'));
}

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

// Scoped to DIRECT invocation. Unscoped, requiring this module for any reason exits the
// requiring process — which is what happened the moment a test tried to call the prompt
// builder to prove its migration changed no bytes. The check itself is unchanged: a run
// invoked without its paths still refuses to start.
if (require.main === module && (!ISSUES_PATH || !ROOT_DIR || !OUT_PATH)) {
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

    // EXCLUSIONS ARE DATA. This was a /^docs\./i literal, which made one naming convention an
    // engine fact: a project whose documentation repos are named anything else got no exclusion,
    // and a project with an in-scope repo matching the pattern could not opt out without editing
    // the engine. config/codeline-scan.json holds the patterns; EPAM_CODELINE_EXCLUDE overrides.
    const _skip = _scanExclusions().find((re) => re.test(name));
    if (_skip) {
      log(`Skipping ${name} — excluded by ${_skip} (config/codeline-scan.json)`);
      continue;
    }

    // ECOSYSTEM FROM THE ONE REGISTRY. This was a three-branch ladder written here, while
    // codeline-structure.js knew six manifest files — so a Rust or Ruby repository reached the
    // discovery agent labelled 'unknown', on the single input it uses to choose which client
    // repository gets written to. First match wins, in registry order.
    let stack = 'unknown';
    let packageName = name;
    let description = '';

    for (const eco of allManifests()) {
      const mf = path.join(full, eco.file);
      if (!fs.existsSync(mf)) continue;
      stack = eco.stack;
      if (typeof eco.describe === 'function') {
        try {
          const d = eco.describe(fs.readFileSync(mf, 'utf8'));
          packageName = d.packageName || name;
          description = d.description || '';
        } catch { /* an unparseable manifest still identifies the ecosystem */ }
      }
      break;
    }

    // README PROSE — what the repository says it is.
    //
    // This used to take the FIRST non-heading line and clip it to 120 characters. On real
    // repositories the first non-heading line is a badge row or a table-of-contents entry,
    // so the manifest for two live codelines carried `readme: - [Prerequisites](#prerequisites)`
    // — a field that contributed nothing to a decision about which client repo gets modified,
    // while looking like it contributed something.
    //
    // Select PROSE instead: skip headings, badge/image rows, link-only list items, code
    // fences and raw HTML, and keep the sentences that describe the project. The budget is a
    // PROMPT budget (every candidate repo contributes one of these to one prompt), not a
    // judgement about how much of the README matters — so it is configurable and applied to
    // prose that was chosen, never to the first line that happened to appear.
    let readmeExcerpt = '';
    const _readmeBudget = Number(process.env.EPAM_CODELINE_README_CHARS || 1200);
    for (const readmeName of ['README.md', 'readme.md', 'README.txt']) {
      const readmePath = path.join(full, readmeName);
      if (fs.existsSync(readmePath)) {
        try {
          const prose = [];
          let inFence = false;
          for (const raw of fs.readFileSync(readmePath, 'utf8').split('\n')) {
            const l = raw.trim();
            if (/^(```|~~~)/.test(l)) { inFence = !inFence; continue; }
            if (inFence || !l) continue;
            if (l.startsWith('#')) continue;                       // heading
            if (/^[-*+>|]/.test(l) && !/[a-z]{4,}\s+[a-z]{4,}/i.test(l)) continue; // TOC/list/table row, no sentence
            if (/^<\/?[a-z]/i.test(l)) continue;                   // raw HTML
            if (/^\s*[[!]/.test(l) && !/[a-z]{4,}\s+[a-z]{4,}/i.test(l)) continue; // badge / bare link
            if (!/[a-z]{4,}\s+[a-z]{4,}/i.test(l)) continue;       // not a sentence at all
            prose.push(l);
            if (prose.join(' ').length >= _readmeBudget) break;
          }
          readmeExcerpt = prose.join(' ').slice(0, _readmeBudget);
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

/**
 * deriveDiscoveryVocabulary — the terms that carry no repository-selection signal, decided
 * per ticket by an agent that can see the ticket AND the candidates.
 *
 * WHY THIS EXISTS. A list of words sat in scoreRepos filtering the ticket's terms. It was
 * hardcoded domain-and-language knowledge inside the generic pipeline: wrong for the next
 * project, wrong for a ticket written in another language, and maintained by nobody. The
 * comment four lines below it claimed stopwords had been removed, which was true of one list
 * and not of the other — the exact shape of a rule that erodes.
 *
 * WHY AN AGENT AND NOT A BETTER FORMULA. Measurement alone cannot do this. IDF over the
 * candidate repositories demotes a term every repo mentions, but a filler word appears in NO
 * repository text, so document frequency scores it as maximally discriminating and PROMOTES
 * it. Rarity and meaninglessness are indistinguishable by counting. Deciding that a word
 * carries no signal requires reading it.
 *
 * WHAT IT RECEIVES (context as input, never a fixed list):
 *   - the ticket: title, whole description, components
 *   - the candidates: every repository name, package name and description in the codeline root
 * so it judges "carries no signal HERE" against the actual choice being made, not in general.
 *
 * WHAT IT RETURNS is schema-bound (blacklist/whitelist, each term with a reason) — the same
 * contract lib/guard-vocabulary.js defines, applied by the same pure applier. This file holds
 * no terms of its own, in any language.
 */
function deriveDiscoveryVocabulary(issues, manifest) {
  const { normaliseVocabulary, isVocabularyUsable } = require('./guard-vocabulary.js');
  const persona = (() => {
    try {
      const p = JSON.parse(fs.readFileSync(
        path.join(SCRIPT_DIR, '..', 'agents', 'profiles.json'), 'utf8'));
      return p['discovery-vocabulary-agent'] || '';
    } catch { return ''; }
  })();

  const ticketBlock = issues.map((i, n) => [
    `TICKET ${n + 1}`,
    `Title: ${i.title || ''}`,
    `Components: ${(Array.isArray(i.components) ? i.components : []).join(', ') || '(none)'}`,
    `Description:\n${i.description || ''}`,
  ].join('\n')).join('\n\n');

  const candidateBlock = manifest.map((r) => [
    `- ${r.name}`,
    r.packageName && r.packageName !== r.name ? `  package: ${r.packageName}` : '',
    r.description ? `  description: ${r.description}` : '',
    r.readmeExcerpt ? `  readme: ${r.readmeExcerpt}` : '',
  ].filter(Boolean).join('\n')).join('\n');

  // RENDERED FROM THE TEMPLATE LAYER. This prompt was missed by the prose guard for the same
  // reason every earlier sweep under-reported: it opens with a heading rather than "You are".
  const prompt = renderEngineTemplate('discovery-vocabulary', {
    __PERSONA__: persona ? persona + '\n\n' : '',
    __TICKET_BLOCK__: ticketBlock,
    __CANDIDATE_BLOCK__: candidateBlock,
  });

  const raw = callLlm(prompt, { rawText: true });
  const m = String(raw || '').match(/<DISCOVERY_VOCABULARY>([\s\S]*?)<\/DISCOVERY_VOCABULARY>/);
  if (!m) throw new Error('discovery-vocabulary-agent returned no tagged JSON');
  const vocab = normaliseVocabulary(JSON.parse(m[1].trim().replace(/^```(?:json)?/i, '').replace(/```$/, '')));
  if (!isVocabularyUsable(vocab)) throw new Error('discovery-vocabulary-agent returned an empty blacklist');
  return vocab;
}

/**
 * Derive the vocabulary, or stop the run. There is deliberately no third outcome: a built-in
 * word list used as a fallback here would reinstate exactly what was removed, and discovery
 * chooses which client repository gets written to — proceeding on a filter nobody derived is
 * worse than not launching.
 *
 * The one case that is not a failure is the explicitly model-free mode, where no agent runs
 * at all and every term is kept. Unfiltered scoring is noisier; it is not invented.
 */
function deriveVocabularyOrAbort(issues, manifest) {
  if (DRY_RUN) {
    warn('DRY-RUN mode — no vocabulary agent; scoring on unfiltered terms.');
    return null;
  }
  log('Deriving discovery vocabulary for this ticket...');
  try {
    const v = deriveDiscoveryVocabulary(issues, manifest);
    log(`Vocabulary derived: ${v.blacklist.length} term(s) carry no selection signal, ` +
        `${v.whitelist.length} protected.`);
    return v;
  } catch (e) {
    process.stderr.write(
      `[codeline-discovery] ERROR: discovery-vocabulary-agent failed (${e.message}).\n` +
      '  Term filtering is agent-supplied by design — there is no built-in word list to fall\n' +
      '  back to, and inventing one here is the defect this replaced. Aborting.\n');
    process.exit(1);
  }
  return null;
}

function scoreRepos(issues, manifest, topN = 8, vocabulary = null) {
  // The WHOLE description. It used to be clipped to 500 characters here and to 300 in
  // buildDiscoveryPrompt — the same field, the same file, two different picked numbers,
  // neither with a comment. In brownfield the description is the only substantive content a
  // ticket carries (the AC gate skips acceptance criteria and records "VCs are derived from
  // the description"), and this function chooses which client repository gets modified.
  const text = issues.map(i => `${i.title || ''} ${i.description || ''}`).join(' ');
  // The term filter holds NO words. A list of them used to sit on this line — English
  // grammatical filler, hardcoded in the generic pipeline, silently wrong for a ticket
  // written in any other language and for any project whose product name it happened to
  // contain. It is now supplied per ticket by discovery-vocabulary-agent, which sees this
  // ticket and these candidates, and applied by the shared pure applier.
  const { applyVocabulary } = require('./guard-vocabulary.js');
  const _raw = text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4);
  const _flagged = vocabulary ? applyVocabulary([...new Set(_raw)], vocabulary) : [];
  const _dropped = new Set(_flagged.map(f => f.item));
  const _tokens = _raw.filter(w => !_dropped.has(w));

  // PERSISTED, because it is generated and because it is the only evidence of what the
  // filter actually did. The count in a log line says a vocabulary was DERIVED; this file
  // says which terms were APPLIED, which is the part that changes the repository chosen.
  //
  // INTO THE RUN'S EVIDENCE, not beside the discovery output. It went beside the output, and
  // every caller points that output at a temp directory it deletes on exit — the ingest at
  // $TMPDIR_INGEST, the scope resolver at an mktemp -d under a trap. So this file had never
  // survived a single run and nothing had ever read it. spec-mode-runner.js names the mistake
  // by this filename in its own comment while taking care to avoid it.
  //
  // Falls back to the output directory when there is no run directory, which is the standalone
  // case a test or a manual invocation takes; that is the only situation where beside-the-output
  // is the best available answer.
  try {
    const _vocabDir = (process.env.LOG_DIR && fs.existsSync(process.env.LOG_DIR))
      ? process.env.LOG_DIR
      : path.dirname(OUT_PATH);
    const _vocabPath = path.join(_vocabDir, 'discovery-vocabulary.json');
    fs.writeFileSync(_vocabPath, JSON.stringify({
      derived: !!vocabulary,
      vocabulary: vocabulary || null,
      termsDropped: _flagged.map(f => ({ term: f.item, reason: f.reason })),
      termsUsed: [...new Set(_tokens)],
    }, null, 2));
  } catch { /* never let evidence-writing change the outcome of discovery */ }
  // How often each term occurs in the ticket. Used to ORDER terms below; a term the
  // description returns to repeatedly is more central to the request than one mentioned once.
  const _tf = new Map();
  for (const w of _tokens) _tf.set(w, (_tf.get(w) || 0) + 1);
  const words = [...new Set(_tokens)];

  const cgEnabled = process.env.CODEGRAPH_ENABLED === '1';
  const cg        = cgEnabled ? getCodeGraph() : null;

  // Terms are NOT filtered against a hand-written vocabulary. A stopword list
  // used to sit here naming one client industry's everyday nouns — hardcoded
  // domain knowledge in engine code, wrong for the next project, and redundant
  // anyway: crossRepoTermScores computes IDF over the actual candidate set, so
  // a term appearing in every repo is demoted by measurement rather than by a
  // list somebody has to maintain. Removed 2026-08-06.
  //
  // ORDER MATTERS, because the term list is capped below. It used to be capped in DOCUMENT
  // ORDER — whichever terms happened to appear first in the title, then whatever followed in
  // the description until the count ran out. Now that the full description flows through
  // (the 500/300-char clips are gone) there are far more terms available and document order
  // decides which survive, which is not a relevance judgement at all.
  //
  // Order by measurement over the actual candidate set — TF-IDF, the same principle
  // codeline-score already applies, not a list somebody maintains:
  //   tf  = occurrences in the ticket        (a term the description returns to is central)
  //   idf = log(N / (1 + repos mentioning it)) (a term every repo mentions cannot separate them)
  // A term no repo mentions keeps a high idf deliberately: CodeGraph searches CODE, and the
  // symbol that decides the answer is routinely absent from any README or package name.
  const _repoTexts = (Array.isArray(manifest) ? manifest : []).map(
    r => `${r.name || ''} ${r.packageName || ''} ${r.description || ''} ${r.readmeExcerpt || ''}`.toLowerCase());
  const _N = Math.max(_repoTexts.length, 1);
  const _specificity = (w) => {
    const df = _repoTexts.reduce((n, t) => n + (t.includes(w) ? 1 : 0), 0);
    return (_tf.get(w) || 1) * Math.log(_N / (1 + df));
  };
  const _rank = new Map(words.map((w, i) => [w, i]));
  const cgSpecificWords = [...words].sort(
    (a, b) => (_specificity(b) - _specificity(a)) || (_rank.get(a) - _rank.get(b)));

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

  // ── Tier 0 — STRUCTURE (dominant, and a hard eligibility gate) ────────────
  // Tiers 1 and 2 both measure the same thing: how often the ticket's WORDS
  // appear in a repo's text. That cannot separate "implements this capability"
  // from "mentions this library". Live: a .NET CRM integration scored 143
  // against the real target's 152 on 25 hits that were all accessibility-request
  // validators — it had no live-preview code and no installed toolchain, so it
  // could not have run its own gates, and the model selected it on the fifth of
  // five runs. Pinning the codeline list was the response; fixing the signal is
  // this.
  //
  // Two structural facts, neither gameable by word count (see codeline-structure.js):
  //   canRunItsOwnGates    declared deps actually installed -> can be a lane at all
  //   declaredDependencies the repo's OWN manifest says it uses this technology
  //
  // A repo that cannot build is REMOVED, not demoted: selecting it guarantees a
  // failed lane whatever its relevance. A declared-dependency match then
  // outweighs any amount of lexical mention, and lexical score only orders
  // repos that are structurally equal.
  let structural = [];
  try {
    structural = rankByStructure(manifest, cgSpecificWords.length ? cgSpecificWords : words);
  } catch (e) {
    warn(`structural ranking unavailable (${e.message}) — falling back to lexical only`);
    structural = manifest.map(r => ({ ...r, structuralScore: 0, dependencyHits: [] }));
  }
  const structByPath = new Map(structural.map(r => [r.path, r]));

  const excluded = manifest.filter(r => !structByPath.has(r.path));
  for (const r of excluded) {
    log(`  EXCLUDED '${r.name}': declares dependencies it has not installed — cannot run its own gates, so it cannot be a lane at any relevance score`);
  }

  // Weight chosen so ONE declared-dependency match outranks a maximal lexical
  // score (Tier 1 ~30 + Tier 2 ~100). Structure is evidence; word count is a hint.
  const STRUCT_WEIGHT = Number(process.env.CODELINE_STRUCTURAL_WEIGHT || 500);

  const eligible = scored
    .filter(r => structByPath.has(r.path))
    .map(r => {
      const st = structByPath.get(r.path);
      return {
        ...r,
        structuralScore: st.structuralScore,
        dependencyHits: st.dependencyHits,
        lexicalScore: r.score,
        score: r.score + st.structuralScore * STRUCT_WEIGHT,
      };
    });

  eligible.sort((a, b) => b.score - a.score);
  const top = eligible.slice(0, topN);
  log(`Repo scoring: top ${top.length} of ${eligible.length} eligible (${excluded.length} excluded as unbuildable) from ${manifest.length} repos`);
  for (const r of top) {
    log(`  ${r.name}: total=${r.score} (structural=${r.structuralScore}${r.dependencyHits.length ? ` [${r.dependencyHits.join(', ')}]` : ''}, lexical=${r.lexicalScore})`);
  }
  return top;
}

// ── Best-candidate selection (used by dry-run and LLM-failure fallback) ───
// Picks the highest-scored repo from a pre-scored (sorted descending) list.
// Never selects by alphabetical position — that was the bug that caused wrong
// codeline selection when the LLM timed out.

function selectBestCandidate(scored, issues) {
  if (scored.length === 0) {
    throw new Error('No git repositories found under JIRA_CODELINE_ROOT — cannot discover codelines.');
  }

  // This fallback returns exactly ONE repository, so it cannot answer a ticket
  // that spans several product areas — it can only answer a DIFFERENT question
  // quietly.
  //
  // Live AMSD-2041 run 9: the discovery call returned an empty response, this
  // ran, and a ticket tagged [GO, UP, MX] became a one-lane run that would have
  // reported success for a third of the work. Six earlier runs hid that the
  // premise of every multi-codeline run rested on one model call succeeding.
  //
  // The ticket itself says whether it spans: its own components. Retrying is
  // now handled at the seam (ai-run.sh, with ladder escalation) — this is what
  // happens when even that is exhausted, and the honest answer is to stop
  // rather than invent a scope nobody chose.
  const areas = new Set();
  for (const issue of (Array.isArray(issues) ? issues : [])) {
    for (const c of ((issue && issue.components) || [])) {
      // Jira returns objects; some callers normalise to strings. Assuming one
      // shape would silently disable this check for the other.
      const label = typeof c === 'string' ? c : (c && c.name);
      if (label) areas.add(String(label));
    }
  }

  if (areas.size > 1) {
    throw new Error(
      `Cannot fall back to a single codeline: the ticket names ${areas.size} product areas ` +
      `(${[...areas].join(', ')}) and this fallback can only return one repository. ` +
      // Says only what it can prove. The previous wording asserted "failed after
      // every retry and ladder rung", which this code cannot know: when the
      // caller's spawnSync window expires the attempts are cut off mid-flight,
      // and on 2026-07-29 exactly one attempt had run. An error that overstates
      // its own evidence sends the reader hunting for a model problem that is
      // really a timeout problem.
      `The discovery call did not return a usable answer, so the codelines are ` +
      `genuinely unknown — running one lane would silently deliver part of the work.`);
  }

  const repo = scored[0]; // already sorted descending by scoreRepos()
  const name = deriveCodelineName(repo.name);
  return { codelines: [{ name, path: repo.path, reason: `[scored-fallback] Highest candidate (score: ${repo.score})` }] };
}

// Codeline name derivation lives in lib/codeline-name.js so it can be tested
// directly — this file is a CLI whose IIFE runs on require.
const { deriveCodelineName, deriveCodelineNames } = require('./codeline-name');


// ── LLM discovery call ─────────────────────────────────────────────────────

const { renderEngineTemplate } = require('./engine-prompt');

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
      // Whole description — see scoreRepos. Discovery sends one small prompt containing a
      // handful of candidate repositories; nothing about its size justified clipping the
      // one field that carries the requirement.
      `\n  description: ${i.description || ''}`;
  }).join('\n\n');

  // RENDERED FROM THE TEMPLATE LAYER. The two summaries are assembled above, because
  // assembling them is logic and a template that branches cannot be reviewed as prose.
  return renderEngineTemplate('codeline-discovery', {
    __ISSUES_SUMMARY__: issuesSummary,
    __MANIFEST_SUMMARY__: manifestSummary,
  });
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

// opts.rawText: return the model's text untouched instead of parsing a codeline selection
// out of it. The vocabulary agent shares this seam deliberately — the same provider, the same
// retry and ladder budget, the same stderr capture. A second hand-rolled spawn would be a
// second set of failure modes to discover in production.
function callLlm(prompt, opts = {}) {
  const tmpPrompt = `/tmp/codeline-discovery-prompt-${process.pid}.txt`;
  fs.writeFileSync(tmpPrompt, prompt);
  const debug = process.env.DEBUG_CODELINE_DISCOVERY === '1';
  // COST IS RECORDED, NOT ASSUMED. Discovery makes two model calls per run — the vocabulary
  // agent and the matcher, one of them at effort:high with a 16k output budget — and neither
  // appeared in any cost ledger, under any name. It spawns ai-run.sh directly rather than through
  // a path that emits a cost_snapshot, which is exactly the invisibility lib/cost-emitter.js was
  // written to close for spec-mode-runner.
  //
  // ai-run.sh already writes the normalized result JSON whenever ORCH_JSON_RESULT is set; it was
  // never asked to. Per CALL, so both calls are recorded rather than only the last.
  //
  // Declared OUTSIDE the try so the finally can still see it: a call that threw spent money too,
  // and dropping its record is how the expensive failures become the invisible ones.
  const _costFile = `${tmpPrompt}.cost.json`;
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
      // Sized to the SEAM'S RETRY BUDGET, not to one call. ai-run.sh retries up
      // to EPAM_CALL_MAX_ATTEMPTS times with ladder escalation INSIDE this one
      // spawnSync, so a flat 420s window meant a single slow attempt consumed
      // everything and attempts 2..N never ran — the ladder was unreachable
      // from here. Observed live 2026-07-29: discovery died on
      // "spawnSync /bin/sh ETIMEDOUT" after exactly one attempt.
      // Derived, not a constant: raise EPAM_CALL_MAX_ATTEMPTS and this follows.
      timeout: Number(
        process.env.CODELINE_DISCOVERY_TIMEOUT_MS ||
        (Number(process.env.EPAM_CALL_MAX_ATTEMPTS || 3) *
         Number(process.env.EPAM_CALL_ATTEMPT_BUDGET_MS || 300000))
      ),
      maxBuffer:  10 * 1024 * 1024,
      // Whatever this seam is configured to run with. Discovery decides which codelines are in
      // scope for the entire run — miss one and that site silently never receives the work —
      // so it is a seam worth configuring rather than leaving on the run's defaults.
      env:        {
        ...process.env,
        EPAM_AGENT_NAME: 'codeline-discovery',
        ORCH_JSON_RESULT: _costFile,
        ...(() => { try { return require('./seam-invocation.js').seamInvocationEnv('codeline-discovery'); }
                    catch { return {}; } })(),
      },
    }).trim();

    if (debug) log(`DEBUG raw LLM response:\n${raw}`);

    if (!raw) {
      // Say WHY. "Empty response" describes the symptom and hides the cause.
      let why = '';
      try { why = require('fs').readFileSync(_errFile, 'utf8').trim().slice(-400); } catch { /* none */ }
      throw new Error('Empty response from ai-run.sh' + (why ? ` — stderr: ${why}` : ' (no stderr captured)'));
    }

    if (opts.rawText) return raw;

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON in LLM response: ${raw.slice(0, 200)}`);

    const parsed = JSON.parse(jsonMatch[0]);
    if (debug) log(`DEBUG parsed codelines: ${JSON.stringify(parsed.codelines)}`);
    // The model decides WHICH repositories are in scope and why. It does not get to name
    // them: a codeline name is a primary key (byCodeline, the KB stores, story.codelines,
    // project.outputDirs, the lane loop) and a sampled key eventually disagrees with itself.
    // It did on 2026-08-08 — one spelling on one run, its punctuation-stripped form on the next, and a
    // resume that re-ran discovery left every investigator unresolvable. See deriveCodelineNames.
    const named = deriveCodelineNames(parsed);
    for (const cl of (named.codelines || [])) {
      if (cl && cl.modelName) log(`  codeline name derived from the repository: '${cl.modelName}' -> '${cl.name}'`);
    }
    return dropUngroundedCodelines(named);
  } finally {
    _emitDiscoveryCost(_costFile, opts.costAgent || 'codeline-discovery');
    try { fs.unlinkSync(tmpPrompt); } catch { /* ignore */ }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

// Requirable without running. The prompt below is migrating into the template layer, and a
// migration has to be provable byte-for-byte — which means a test must be able to call the
// builder. An unguarded IIFE runs a whole discovery pass the moment anything requires this.
module.exports = { buildDiscoveryPrompt, buildRepoManifest };

if (require.main !== module) return;

(async () => {
  const issues = JSON.parse(fs.readFileSync(ISSUES_PATH, 'utf8'));
  log(`Scanning ${ROOT_DIR} for git repositories...`);
  const manifest = buildRepoManifest(ROOT_DIR);
  log(`Found ${manifest.length} git repo(s) in codeline root.`);

  if (manifest.length === 0) {
    process.stderr.write('[codeline-discovery] ERROR: No git repositories found in JIRA_CODELINE_ROOT.\n');
    process.exit(1);
  }

  // The term vocabulary is DERIVED, before anything is scored. It is not optional and it is
  // not defaulted: a hardcoded fallback list here would reinstate exactly what was removed,
  // so a derivation failure aborts. Discovery chooses which client repository gets written
  // to — proceeding on a filter nobody derived is worse than not launching.
  const vocabulary = deriveVocabularyOrAbort(issues, manifest);

  // Score + rank repos (always — used for both the LLM candidate list and fallback selection).
  const candidates = scoreRepos(issues, manifest, 8, vocabulary);

  let result;
  if (DRY_RUN) {
    // Dry-run: use the highest-scored candidate, never the first alphabetically.
    warn('DRY-RUN mode — skipping LLM call, selecting highest-scored repo.');
    result = selectBestCandidate(candidates, issues);
  } else {
    log(`Calling LLM (${MODEL}) to match ${issues.length} ticket(s) to ${candidates.length} candidate repo(s)...`);
    const prompt = buildDiscoveryPrompt(issues, candidates);
    try {
      result = callLlm(prompt);
    } catch (e) {
      warn(`LLM call failed: ${e.message}. Using highest-scored candidate as fallback.`);
      result = selectBestCandidate(candidates, issues);
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
    result = selectBestCandidate(candidates, issues);
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

  // ── THE CODELINE FACTS THIS RUN OBSERVED ─────────────────────────────────
  //
  // codeline-facts.json had no producer: every one in the repo was typed by hand, so a new
  // project had none and whatever a run learned died with it. This agent is the single
  // producer, because it is the only stage that opens every candidate repository and sees the
  // estate at once. Written here, where the answer is, rather than exported and lost across the
  // process boundary — the mistake that cost this file its codelines on 2026-08-07.
  //
  // Rewritten every run, never merged: a fact that outlives the run that observed it is a fact
  // nobody re-checks.
  if (process.env.EPAM_PROJECT_CONFIG_DIR) {
    try {
      const { writeCodelineFacts } = require('./codeline-facts.js');
      const res = writeCodelineFacts({
        projectConfigDir: process.env.EPAM_PROJECT_CONFIG_DIR,
        codelines: ordered,
        warn: (m) => log(m),
      });
      log(`Codeline facts written → ${res.path} (${res.codelines.length} codeline(s)` +
          `${res.withoutFacts.length ? `, ${res.withoutFacts.length} with none` : ''})`);
    } catch (e) {
      // Loud, and non-fatal: the codelines themselves are valid and the run can proceed on
      // them. What must never happen is proceeding while BELIEVING facts were provisioned.
      log(`WARN: could not write codeline facts: ${(e && e.message) || e} — ` +
          'agents will work from the source alone');
    }
  } else {
    log('WARN: EPAM_PROJECT_CONFIG_DIR is unset, so this run\'s codeline facts have nowhere to '
        + 'go — agents will work from the source alone');
  }

  for (const cl of ordered) {
    log(`  → codeline '${cl.name}' = ${cl.path} (${cl.reason})`);
  }
  log(`Discovery complete. ${ordered.length} codeline(s) identified.`);
})();
