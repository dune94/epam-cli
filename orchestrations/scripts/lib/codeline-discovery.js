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
// Only what survives the removal of the ranking apparatus: recency is now a FACT stated to the
// agent, and orderCodelines sequences the lanes the agent chose. crossRepoTermScores,
// applyRecency, rankingConfidence and rankByStructure existed solely to rank candidates in
// engine code, which is the decision that belongs to the agent.
const { orderCodelines } = require('./codeline-score');
// THE ONE ECOSYSTEM TABLE. This file used to carry a three-branch stack ladder of its own.

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
      model: MODEL(),
      provider: PROVIDER,
    });
  } catch { /* cost emission must never break the agent call */ }
  try { fs.unlinkSync(costFile); } catch { /* ignore */ }
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
// NO VENDOR NAMED HERE. This ended in `|| 'qwen'`, so a project that configured nothing had its
// discovery call routed to a vendor it never chose — and the run looked configured. An absent
// provider is a configuration gap, and the call refuses rather than picking someone.
const PROVIDER = getArg('--provider',
  process.env.ORCH_GATE_PROVIDER || process.env.EPAM_ORCHESTRATION_PROVIDER || '');
// No literal fallback: see lib/seam-model.js. Discovery picking the wrong codeline is already
// a known failure chain; doing it on an unchosen model makes the cause untraceable.
const { resolveOrRefuse } = require('./seam-model.js');

/**
 * THIS SEAM'S MODEL, FROM ITS OWN LADDER.
 *
 * Replaces process.env.ORCH_GATE_MODEL — a RUN-WIDE PIN that reached every seam unable to
 * resolve one itself, which was all of them outside the story path. `.env` set it to
 * z-ai/glm-5.2, so a mockserver run asked for an OpenRouter model and nothing else could
 * supply a different answer.
 *
 * Returns '' when the ladder cannot answer, so resolveOrRefuse still REFUSES rather than
 * substituting: "we could not tell" is never "it is fine".
 */
function seamLadderModel(seam) {
  try {
    const { seamInvocationEnv } = require('./seam-invocation.js');
    const env = seamInvocationEnv(seam, undefined, { sourceEnv: process.env }) || {};
    return env.EPAM_MODEL || '';
  } catch { return ''; }
}
// RESOLVED WHERE IT IS USED, not at import. Resolving here ran the refusal the moment anything
// required this module — so the prompt builder could not be exercised by a test without a full
// project environment, and the one part of this file that decides which client repository gets
// modified was the part hardest to test. The refusal is unchanged; it now fires at the call.
let _model = null;
const MODEL = () => {
  if (_model) return _model;
  _model = resolveOrRefuse({ seam: 'codeline-discovery',
    sources: [getArg('--model', ''), seamLadderModel('codeline-discovery'), process.env.EPAM_MODEL] });
  return _model;
};

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
//
// WHAT ONLY THE ENGINE CAN KNOW, AND NOTHING ELSE.
//
// A directory listing is a fact: these repositories exist, at these paths, and the agent cannot
// discover them without being told where to look. Everything that used to be gathered here was
// the engine forming a view and handing it over as though it were fact:
//
//   stack / packageName / description  parsed from whichever manifest matched first, so a repo
//                                      with two ecosystems was labelled by registry order
//   readmeExcerpt                      selected by seven regexes deciding what counts as prose,
//                                      then clipped to a budget nobody measured
//   canRunItsOwnGates                  an ELIGIBILITY RULE, which removed repositories from
//                                      consideration before the agent saw them
//   declaredDependencies               the engine parsing manifests on the agent's behalf
//   lastCommitDaysAgo / commits90d     recency, arriving first as a scoring multiplier and then
//                                      as "facts" — the same judgement in a different hat, and
//                                      the 90-day window was a number nobody chose
//
// The agent has read_file, list_files, search, codegraph_query, dependency_contract,
// dependency_available and git_state. Every one of those fields is something it can establish
// itself, about the repositories it actually cares about, in the form the ticket calls for —
// rather than in the form the engine guessed at, for all thirty-three, in advance.

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

    // A git repository is what a codeline IS — the unit a worktree is cut from and a change is
    // committed to. A directory that is not one cannot receive the work at all, whatever it
    // contains, so this is the shape of the thing rather than a judgement about relevance.
    if (!fs.existsSync(path.join(full, '.git'))) continue;

    // NOTHING IS EXCLUDED. A regex over directory names — /^docs\./i, then the same pattern
    // relocated to config/codeline-scan.json — deleted repositories before anything reasoned
    // about them. Moving the literal out of this file did not make it project data: it stayed an
    // engine default asserting one client's naming habit over every project, and it failed in the
    // direction of doing less, silently, on a project whose product IS a documentation platform.

    entries.push({ name, path: full });
  }

  return entries;
}

// ── The evidence handed to the discovery agent ─────────────────────────────
//
// WHAT USED TO BE HERE: ~370 lines that decided which client repository gets modified by
// arithmetic — a shortlist of 8, a filter dropping every ticket word under 4 characters, +3 per
// lexical hit, a x10 tier scaling, a structural weight of 500, a 7-term cap, recency multipliers,
// and a paid LLM call to derive a per-ticket stopword list to feed the filter. Every number was a
// guess about a project nobody had seen, written into the generic pipeline.
//
// The 4-character filter shows what the apparatus cost: it discarded `UP`, `MX` and `GO` — the
// identifiers that name the product — and kept the generic prose. For a ticket titled "[UP] Live
// Preview of Content in CMS" the shortlist was chosen with no way to tell next.upexpress.com from
// next.metrolinx.com, and `components: ["UP"]` never reached the ranking at all.
//
// Measured on the live estate: the full manifest is ~6,700 tokens against the shortlist's ~1,900.
// The apparatus spent an extra agent call to save ~4,800 tokens, and paid for it with the answer.
//
// What replaces it is not a better formula. It is the agent doing the work: it receives every
// repository, every field of the ticket, and TOOLS to search the code — including codegraph_query,
// which the engine used to run on the agent's behalf and then hand over as a number.


// directly — this file is a CLI whose IIFE runs on require.
const { deriveCodelineName, deriveCodelineNames } = require('./codeline-name');


// ── LLM discovery call ─────────────────────────────────────────────────────

const { renderEngineTemplate } = require('./engine-prompt');

/**
 * EVERY REPOSITORY, EVERY FIELD OF THE TICKET.
 *
 * `manifest` is the whole estate, not a shortlist. Nothing here selects, ranks or truncates: the
 * agent has tools and can read the code, and it is the only participant that can read the ticket.
 *
 * The label of every field is emitted even when the value is empty, because "this ticket declares
 * no components" and "this pipeline did not tell you the components" are different statements and
 * the agent cannot distinguish them from an absent line.
 */
function buildDiscoveryPrompt(issues, manifest) {
  // NAME AND PATH. Everything else a repository could be described by — its stack, its package
  // name, its README, its dependencies, how recently it was touched — is something the agent
  // establishes with its own tools, about the repositories it actually cares about, in the form
  // this ticket calls for. Stated here it would be the engine's view of thirty-three repositories,
  // formed in advance and handed over as fact.
  const manifestSummary = manifest.map(
    r => `- dir: ${r.name}\n  path: ${r.path}`).join('\n\n');

  const issuesSummary = issues.map(i => {
    // Jira returns objects for these; some callers normalise to strings. Assuming one shape
    // silently drops the field for the other.
    const nameOf = (c) => (typeof c === 'string' ? c : (c && (c.name || c.value)) || '');
    const comps = (Array.isArray(i.components) ? i.components : []).map(nameOf).filter(Boolean);
    const labels = (Array.isArray(i.labels) ? i.labels : []).map(nameOf).filter(Boolean);
    return `- key: ${i.jiraKey}\n  title: ${i.title}` +
      // The tracker's own statement of which product areas the ticket touches. Several components
      // is evidence of several repositories — it is not a hint to be weighed against the summary,
      // it is the field maintained for exactly this purpose. It used to reach this prompt and NOT
      // the ranking that chose the candidates, so it could only ever confirm a shortlist it had no
      // part in choosing.
      `\n  components: ${comps.length ? comps.join(', ') : '(none declared)'}` +
      `\n  labels: ${labels.length ? labels.join(', ') : '(none declared)'}` +
      // THE WHOLE DESCRIPTION, unclipped and unfiltered. A ticket's own words are the requirement;
      // a pipeline that edits them before the agent reads them is answering a different question.
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
      ? `bash ${AI_RUN_SH} --provider ${PROVIDER} --model ${MODEL()} < ${tmpPrompt}`
      : `bash ${AI_RUN_SH} --provider ${PROVIDER} --model ${MODEL()} < ${tmpPrompt} 2>${_errFile}`;
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
      env:        (() => {
        // THE ESTATE IS THIS AGENT'S SCOPE, and it has to be published BEFORE the seam env is
        // resolved.
        //
        // codegraph_query is a PLUGIN tool, provisioned per repository, and the grant resolves
        // plugin tools from EPAM_CODELINE_PATHS || PROJECT_ROOT. Discovery runs before any
        // codeline is known — that is its entire job — so both were empty and the grant silently
        // came back as read_file,list_files,search. The one agent whose whole task is to search
        // the estate was the one agent that could not search it, and the engine compensated by
        // running CodeGraph itself and handing over a number.
        //
        // Every candidate repository is in scope here because the agent may look at any of them;
        // that is what it is choosing between. The same list gives codegraph_query its scope, so
        // the agent can query any codeline BY NAME (see resolveQueryRepo in codegraph-plugin.js).
        const _paths = (opts.manifest || []).map((r) => r.path).filter(Boolean).join(',');
        const _base = { ...process.env, EPAM_CODELINE_PATHS: _paths };
        return {
          ..._base,
          EPAM_AGENT_NAME: 'codeline-discovery',
          ORCH_JSON_RESULT: _costFile,
          // THIS FILE EMITS ITS OWN COST ROW (_emitDiscoveryCost below), so the hub must not
          // write a second one for the same call. Both fired: run 5 on 2026-08-26 recorded 5
          // rows for 4 calls, and discovery was the one still doubled after spec-mode-runner
          // was fixed. See lib/cost-record.sh and the same declaration in spec-mode-runner.js.
          EPAM_COST_RECORDED_BY_CALLER: '1',
          ...(() => {
            try {
              // (agent, agentsDir, opts) — the options are the THIRD argument. Passing them
              // second hands an object where a directory path is expected.
              return require('./seam-invocation.js')
                .seamInvocationEnv('codeline-discovery', undefined, { env: _base });
            } catch { return {}; }
          })(),
        };
      })(),
    }).trim();

    // AN EXHAUSTED CALL IS NOT AN ANSWER.
    //
    // Discovery decides which codelines the whole run touches. On 2026-08-18 the agent ran out
    // of iterations, AgentRunner returned the exhaustion text with exit 0, and this function
    // handed that text on as the model's reply — the fallback then picked the highest-scored
    // repo and the run proceeded against the wrong codeline until it was killed.
    //
    // The engine now records the condition structurally (AgentRunResult.stopReason ->
    // stop_reason in the result JSON this call already writes for cost tracking), so this reads
    // a field rather than matching an English sentence that may be reworded. Throwing puts it
    // through the same retry-and-escalate path as any other failed call, which is what should
    // have happened the first time.
    try {
      const _r = JSON.parse(fs.readFileSync(_costFile, 'utf8'));
      if (_r && _r.stop_reason === 'max_iterations') {
        throw new Error(
          'the discovery agent ran out of iterations before answering — its reply is truncated, '
          + 'not a selection. Raise maxIterations on the codeline-discovery profile if this recurs.'
        );
      }
    } catch (e) {
      // Only the refusal above propagates. An unreadable or absent cost file means the call
      // simply did not report — it is not evidence that the agent was cut off, and inventing a
      // failure from a missing observability file would block runs that were fine.
      if (/ran out of iterations/.test(e.message)) throw e;
    }

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
module.exports = {
  buildDiscoveryPrompt, buildRepoManifest };

if (require.main !== module) return;

(async () => {
  const issues = JSON.parse(fs.readFileSync(ISSUES_PATH, 'utf8'));
  log(`Scanning ${ROOT_DIR} for git repositories...`);
  let manifest = buildRepoManifest(ROOT_DIR);
  log(`Found ${manifest.length} git repo(s) in codeline root.`);

  // NOT BOUNDED BY AN OPERATOR VARIABLE. Discovery only runs when the PRD declares no scope —
  // resolve-codeline-scope.sh leaves an already-declared scope alone — so there is nothing for a
  // hand-typed list to constrain, and requiring one asked a human to know the answer this step
  // exists to derive. See lib/codeline-scope.sh.

  if (manifest.length === 0) {
    process.stderr.write('[codeline-discovery] ERROR: No git repositories found in JIRA_CODELINE_ROOT.\n');
    process.exit(1);
  }

  if (DRY_RUN) {
    // A dry run shows what WOULD be sent. It does not pick a codeline: choosing without the agent
    // is the deterministic shortcut this step exists to remove, and a "dry" run that silently
    // selects a repository is the most misleading output this file could produce.
    warn('DRY-RUN — the prompt below is what discovery would send. No selection is made.');
    process.stdout.write(`${buildDiscoveryPrompt(issues, manifest)}\n`);
    process.exit(0);
  }

  log(`Asking the discovery agent to match ${issues.length} ticket(s) against all `
      + `${manifest.length} repo(s), with tools to search them...`);
  const prompt = buildDiscoveryPrompt(issues, manifest);

  // NO FALLBACK. A failed call used to select the highest-scored repository and carry on, so a
  // discovery that never happened was indistinguishable from one that did — and the run proceeded
  // against a repository nothing had reasoned about. The call is retried and escalated at the seam
  // (ai-run.sh, with ladder escalation); when that is exhausted the honest answer is that the
  // codelines are unknown, and a run must not start on a scope nobody chose.
  // A MALFORMED ANSWER IS CORRECTED BY THE AGENT, not replaced by the engine.
  //
  // ai-run.sh retries a FAILED CALL and escalates the ladder. This is the other failure: the call
  // succeeds and the CONTENT breaks its contract — no JSON, a path that does not exist, a
  // selection with no evidence. The old code answered that by substituting the highest-scored
  // repository, so a discovery that never happened was indistinguishable from one that did.
  //
  // The agent is told WHICH contract it broke and answers again, exactly as the mint's refused
  // proposals are re-proposed. That is self-correction, not a deterministic workaround: nothing
  // here invents a selection, and when the attempts are exhausted the run stops.
  // eslint-disable-next-line global-require
  const { retryUntilParsed } = require('./content-retry.js');
  const result = retryUntilParsed({
    what: 'codeline-discovery',
    attempts: Number(process.env.EPAM_CONTENT_RETRY_ATTEMPTS || 3),
    log,
    call: (note) => callLlm(note ? `${note}${prompt}` : prompt, { manifest }),
    parse: (answer) => {
      const picked = (answer && answer.codelines) || [];
      if (!picked.length) {
        return { ok: false,
          reason: 'you selected no codeline. You have tools and every repository was listed: '
            + 'search for what the ticket names, then select what you can ground. If a part of '
            + 'the ticket genuinely cannot be placed, put THAT part in "unsure" — but a run '
            + 'cannot start with no scope at all.' };
      }
      for (const cl of picked) {
        const why = !path.isAbsolute(cl.path) ? 'that path is not absolute'
          : !fs.existsSync(cl.path) ? 'that path does not exist'
            : !fs.existsSync(path.join(cl.path, '.git')) ? 'that path is not a git repository'
              : null;
        if (why) {
          return { ok: false,
            reason: `you selected '${cl.name}' at ${cl.path}, but ${why}. Every candidate was `
              + 'listed with its real path — copy the path of the repository you mean.' };
        }
      }
      return { ok: true, value: answer };
    },
  });

  // Everything the contract requires was checked by the parser above, and a reply that still
  // broke it exhausted its corrections — retryUntilParsed threw rather than returning. So what
  // reaches here is a selection whose every path exists and is a repository.
  const validated = result.codelines || [];

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
