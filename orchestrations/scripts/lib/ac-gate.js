#!/usr/bin/env node
/**
 * ac-gate.js — AC sufficiency gate for the Jira-first brownfield pipeline.
 *
 * For each Jira issue, classifies whether acceptance criteria are sufficient
 * to proceed with autonomous implementation. Posts a comment to Jira for each
 * verdict, then writes a classification report to stdout as JSON.
 *
 * Classification verdicts:
 *   sufficient   — ACs are present, testable, and cover happy + error paths
 *   enrichable   — ACs exist but are thin/vague; agent can expand from context
 *   insufficient — ACs are missing, untestable, or too ambiguous to implement
 *
 * Pipeline behaviour (enforced by caller, not this script):
 *   sufficient / enrichable → proceed
 *   insufficient            → post permission-request comment, caller halts run
 *
 * Usage:
 *   node ac-gate.js --issues <path-to-issues.json> [--dry-run] [--model <model>]
 *
 * Issues JSON: array of { jiraKey, storyId, title, description, acceptanceCriteria[] }
 * Output (stdout): JSON array of { jiraKey, verdict, reason, enrichedAcs? }
 *
 * Env vars:
 *   JIRA_URL, JIRA_EMAIL, JIRA_TOKEN — for comment posting
 *   EPAM_API_KEY_ANTHROPIC (or others) — for LLM classification
 *   EPAM_MODEL — model to use (default: claude-haiku-4-5-20251001 for cost)
 *   AC_GATE_DRY_RUN=1 — skip LLM calls and Jira comments
 */

'use strict';

const fs           = require('fs');
const { renderEngineTemplate } = require('./engine-prompt');

/**
 * THE ENVIRONMENT A SEAM GRANTS: ladder position, effort, output budget, timeout, tool grant.
 *
 * This gate announced itself as 'ac-gate' and 'ac-gate-codeline'. Neither is a seam the registry
 * knows, so resolveSeam found nothing and every call ran with no ladder and no budget — on a
 * hardcoded fallback model, which is the shape the ladder work removed everywhere else under the
 * rule that a seam with no resolvable model must decline rather than guess.
 *
 * Meanwhile the registry declared 'ac-classification' (ladder=base, effort=low) and
 * 'ac-elaboration' (ladder=top, effort=medium) for exactly this stage: profiles written for a
 * step, addressed by no caller.
 *
 * The identity IS the seam, which is how discovery already does it and what makes the two
 * impossible to drift apart. Each template declares the seam it serves, and these match.
 *
 * Cost travels with it: ai-run.sh writes the normalized result JSON when ORCH_JSON_RESULT is set,
 * and this gate runs once per ticket — the more expensive of the two invisible stages.
 */
/** The tail of a failed call's stderr, as a phrase to append to an error. */
function _why(errFile) {
  try {
    const t = fs.readFileSync(errFile, 'utf8').trim();
    return t ? ` — stderr: ${t.slice(-400)}` : ' (no stderr captured)';
  } catch { return ' (no stderr captured)'; }
}

function seamEnv(seam, costFile) {
  let granted = {};
  try {
    granted = require('./seam-invocation.js').seamInvocationEnv(seam);
  } catch (e) {
    // Loud. Running anyway on ambient settings is what this replaced.
    process.stderr.write(`[ac-gate] seam '${seam}' did not resolve: ${(e && e.message) || e}\n`);
  }
  if (granted.EPAM_ALLOWED_TOOLS) granted.AI_GATE_ALLOW_TOOLS = '1';
  return { ...process.env, ...granted, EPAM_AGENT_NAME: seam, ORCH_JSON_RESULT: costFile };
}

/** Append this call's spend to the activity log. Best-effort; never breaks the call it measured. */
function emitSpend(costFile, seam) {
  try {
    require('./cost-emitter.js').emitCostSnapshot({
      resultFile: costFile,
      activityFile: process.env.ACTIVITY_FILE
        || path.join(process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs'), 'agent-activity.jsonl'),
      agent: seam,
      storyId: '',
      phase: process.env.PHASE || '',
      model: MODEL,
      provider: PROVIDER,
    });
  } catch { /* cost emission must never break the agent call */ }
  try { fs.unlinkSync(costFile); } catch { /* ignore */ }
}
const path         = require('path');
const { execSync } = require('child_process');

// ── Config ─────────────────────────────────────────────────────────────────
// This project never writes to Jira — ac-gate.js only reads issue data
// (passed in by the caller) and classifies it. No jira-client require, no
// comment-posting code path, unconditionally — not a flag to leave off.

const argv    = process.argv.slice(2);
const getArg  = (flag, def = '') => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : def; };
const DRY_RUN           = argv.includes('--dry-run') || process.env.AC_GATE_DRY_RUN === '1';
const AUTO_ELABORATE     = process.env.AC_GATE_AUTO_ELABORATE === '1';
const BROWNFIELD         = process.env.EPAM_BROWNFIELD === '1';
const DEFAULT_CODELINE   = process.env.JIRA_DEFAULT_CODELINE || '';
// Explicit provider. These called ai-run.sh with --model but NO --provider, so
// provider came only from ambient env — e.g. `--provider openrouter --model claude-haiku`.
// NO VENDOR OF ITS OWN. This ended in `|| 'openrouter'` — a hardcoded last resort firing under
// exactly the condition that killed discovery: the project env not reaching the child. Where
// discovery DIED, this succeeded against the wrong vendor, so a run launched as claude spent
// on another stack with nothing in the log saying so.
//
// Empty is the correct answer: llm-handler.sh resolves the provider from the ACTIVE SET when
// it is not told one, and the flag is omitted below rather than passed empty.
const PROVIDER = getArg('--provider',
  process.env.ORCH_GATE_PROVIDER || process.env.EPAM_ORCHESTRATION_PROVIDER || '');

// A FLAG WITH NO VALUE IS NOT AN EMPTY ARGUMENT — IT IS NO ARGUMENT, and the flag then swallows
// whatever follows. codeline-discovery.js emitted `--provider --model X` this way; the hub read
// '--model' as the provider and rejected the model name as an unknown option. Quoted, so a value
// with a space cannot split either.
const flagArg = (name, value) => (String(value == null ? '' : value).trim()
  ? ` --${name} ${JSON.stringify(String(value).trim())}`
  : '');
// No literal fallback: see lib/seam-model.js. An AC classification produced by a model the
// run never chose still reads as authoritative.
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
const MODEL   = resolveOrRefuse({ seam: 'ac-gate',
  sources: [getArg('--model', ''), seamLadderModel('ac-classification'), process.env.EPAM_MODEL] });

const ISSUES_PATH = getArg('--issues');
const OUT_PATH    = getArg('--out', '');   // write JSON results to file instead of stdout

// Scoped to DIRECT invocation: unscoped, requiring this module to call a prompt builder
// exits the requiring process. The check itself is unchanged.
if (require.main === module && (!ISSUES_PATH && !argv.includes('--help'))) {
  process.stderr.write('Usage: node ac-gate.js --issues <path> [--out <path>]\n');
  process.exit(1);
}

const SCRIPT_DIR  = path.join(__dirname, '..');
// OVERRIDABLE, so this gate can be exercised without reaching a provider. lib/cpa-inference.js
// and lib/kb-synthesizer.js already read AI_RUNNER_CMD, and codeline-discovery.js has its own
// override for the same reason: a model caller that can only be tested by calling a model is
// one whose failure handling never gets tested, which is how three swallowed stderr redirects
// survived here. Empty by default; no behaviour change unless set.
const AI_RUN_SH   = process.env.AI_RUNNER_CMD || path.join(SCRIPT_DIR, 'ai-run.sh');
// process.execPath IS a node that satisfies this repo's requirement — it is the one
// currently executing this file. The path that was here was valid on one machine, for one
// nvm install, until that version was upgraded.
const NODE_BIN    = process.env.NODE_BIN || process.execPath;
const SPLIT_VALUE = process.env.JIRA_SPLIT_CODELINE || 'both';

// ── Codeline registry ──────────────────────────────────────────────────────
// Resolved once at startup from JIRA_CODELINES (comma-separated names, e.g.
// "be,fe" or "backend,frontend,mobile") and JIRA_CODELINE_DESC_<UPPER> for
// human-readable descriptions used in the LLM prompt.
//
// If JIRA_CODELINES is not set, codelines are discovered from the issues'
// own codeline labels at call time (passed into buildClassificationPrompt).
// This means zero config is required for single-codeline projects.

/**
 * Parse a model's JSON answer.
 *
 * ONE function for every call site in this file: the same extractor existed in
 * two places, and a change applied to one of them left the other behaving
 * differently. Consolidated so that cannot recur.
 *
 * Deliberately NOT tolerant of truncation. A repair path was added on
 * 2026-07-29 and removed the same day: the truncated responses that motivated
 * it were an artifact of the provider being out of credits — it could not cover
 * the requested max_tokens and cut responses mid-object. With that resolved the
 * same call returns short, complete, valid JSON. Repairing a malformed answer
 * would have masked an external outage as a parse quirk, and the principled fix
 * for a model returning the wrong shape is provider-side schema binding
 * (EPAM_RESPONSE_SCHEMA), not client-side repair.
 */
function parseLooseJson(raw, what) {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`No JSON in ${what} response: ${raw.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

function resolveCodelines(issues) {
  if (process.env.JIRA_CODELINES) {
    return process.env.JIRA_CODELINES.split(',').map(c => c.trim()).filter(Boolean);
  }
  // Discover from the batch of issues being classified
  const seen = new Set();
  for (const issue of (issues || [])) {
    if (issue.codeline && issue.codeline !== SPLIT_VALUE) seen.add(issue.codeline);
  }
  if (seen.size > 0) return [...seen];
  // Last resort: single-codeline from JIRA_DEFAULT_CODELINE
  const def = process.env.JIRA_DEFAULT_CODELINE;
  return def ? [def] : [];
}

function codelineDesc(cl) {
  return process.env[`JIRA_CODELINE_DESC_${cl.toUpperCase()}`] || cl;
}

// ── AC classification prompt ───────────────────────────────────────────────

function buildClassificationPrompt(issue, knownCodelines) {
  const acsText = issue.acceptanceCriteria && issue.acceptanceCriteria.length > 0
    ? issue.acceptanceCriteria.map((ac, i) => `  ${i + 1}. ${ac}`).join('\n')
    : '  (none)';

  // Build codeline section dynamically from the registered codelines
  const clList    = knownCodelines.map(cl => `"${cl}"`).join(' | ');
  const clBullets = knownCodelines
    .map(cl => `- "${cl}"   — ${codelineDesc(cl)}`)
    .join('\n');
  const splitLine = `- "${SPLIT_VALUE}" — spans multiple codelines (ACs must be split per codeline)`;
  const splitAcLines = knownCodelines
    .map(cl => `- "${cl}Acs": ACs that belong exclusively to the "${cl}" codeline`)
    .join('\n');
  const schemaAcFields = knownCodelines
    .map(cl => `  "${cl}Acs": ["<${cl}-specific AC>", ...]`)
    .join(',\n');
  const splitNote = knownCodelines
    .map(cl => `"${cl}Acs"`)
    .join(' and ');

  // RENDERED FROM THE TEMPLATE LAYER. Every codeline-shaped block is assembled here from the
  // run's own registered codelines — the template names no codeline, and could not stay
  // correct for another project if it did.
  return renderEngineTemplate('ac-classification', {
    __STORY_KEY__: issue.jiraKey,
    __STORY_TITLE__: issue.title,
    __STORY_DESCRIPTION__: issue.description || '(none)',
    __AC_LIST__: acsText,
    __CODELINE_LIST__: clList,
    __CODELINE_BULLETS__: clBullets,
    __SPLIT_AC_LINES__: splitAcLines,
    __SCHEMA_AC_FIELDS__: schemaAcFields,
    __SPLIT_NOTE__: splitNote,
  });
}

// ── LLM call via epam run ──────────────────────────────────────────────────

function classifyWithLLM(issue, knownCodelines) {
  if (DRY_RUN) {
    const hasMeaningfulAcs = issue.acceptanceCriteria &&
      issue.acceptanceCriteria.length >= 3 &&
      issue.acceptanceCriteria.some(ac => ac.length > 30);
    const verdict = hasMeaningfulAcs ? 'sufficient' : 'enrichable';
    return {
      verdict,
      reason: `[dry-run] Heuristic: ${issue.acceptanceCriteria?.length || 0} ACs found.`,
      gaps: [],
      enrichedAcs: [],
    };
  }

  const prompt = buildClassificationPrompt(issue, knownCodelines);

  const tmpPrompt = `/tmp/ac-gate-prompt-${issue.jiraKey}.txt`;
  // Declared outside the try: a call that threw spent money too, and dropping its record
  // is how the expensive failures become the invisible ones.
  const _costFile = `${tmpPrompt}.cost.json`;
  // STDERR IS CAPTURED, NEVER DISCARDED. `2>/dev/null` turned a timeout, a missing key and a
  // provider refusal into the same bare "Empty response", and the reason a call failed is
  // the only thing that makes the fallback judgeable. Discovery already learned this: there
  // it produced a tidy fallback to the highest-scored repo, against the wrong codeline.
  const _errFile = `${tmpPrompt}.err`;
  fs.writeFileSync(tmpPrompt, prompt);

  try {
    // Use ai-run.sh for provider-agnostic LLM call with proper env/key routing
    const cmd = `bash ${AI_RUN_SH}${flagArg('provider', PROVIDER)}`
      + `${flagArg('model', MODEL)} < ${tmpPrompt} 2>${_errFile}`;
    const raw = execSync(cmd, {
      encoding: 'utf8',
      timeout: Number(process.env.AC_GATE_TIMEOUT_MS || 360000),
      env: seamEnv('ac-classification', _costFile),
    }).trim();

    if (!raw) throw new Error(`Empty response from ai-run.sh${_why(_errFile)}`);

    return parseLooseJson(raw, 'classification');
  } catch (e) {
    process.stderr.write(`[ac-gate] LLM call failed for ${issue.jiraKey}: ${e.message}${_why(_errFile)}\n`);
    // A FAILED CALL IS NOT A VERDICT. This used to return 'enrichable', which
    // is a claim about the STORY, invented from a failure to reach or parse the
    // model. Live metrolinx 2026-07-29: the model actually answered
    // "insufficient", the parse broke, and the gate recorded the OPPOSITE
    // verdict and printed "All stories classified. Pipeline may proceed." The
    // story ended with codelines:null, zero lanes launched, and the run died
    // with a green tick in the log.
    //
    // 'unknown' is carried instead, so the caller can tell "the gate could not
    // decide" from "the gate decided". Nothing downstream may treat it as a
    // pass — see the caller's handling.
    return {
      verdict: 'unknown',
      reason: `AC gate could not reach a verdict — the call or its parse failed: ${e.message.slice(0, 150)}${_why(_errFile)}`,
      gaps: [],
      enrichedAcs: [],
    };
  } finally {
    emitSpend(_costFile, 'ac-classification');
    try { fs.unlinkSync(_errFile); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPrompt); } catch { /* ignore */ }
  }
}

// ── Codeline-only classification (brownfield, no ACs) ─────────────────────
//
// Same routing decision as the full classifier, without any acceptance-criteria work:
// no sufficiency verdict to reason about, no gaps, no per-codeline AC split, no
// elaboration. Brownfield derives its VCs from the description, so every token spent
// judging ACs here buys nothing — but the story still has to reach a lane.
function classifyCodelineOnly(issue, knownCodelines) {
  const verdict = 'enrichable';
  const reason = 'brownfield story with no acceptance criteria — AC processing skipped ' +
                 '(VCs are derived from the description); codeline classified only';

  if (DRY_RUN) {
    return { verdict, reason, gaps: [], enrichedAcs: [], codeline: SPLIT_VALUE };
  }

  const codelineList = knownCodelines.map((cl) => `- "${cl}" — ${codelineDesc(cl)}`).join('\n');
  // RENDERED FROM THE TEMPLATE LAYER.
  const prompt = renderEngineTemplate('ac-gate-codeline-assignment', {
    __JIRA_KEY__: issue.jiraKey,
    __TITLE__: issue.title || '',
    __DESCRIPTION__: issue.description || '',
    __CODELINE_LIST__: codelineList,
    __SPLIT_VALUE__: SPLIT_VALUE,
  });

  const tmpPrompt = `/tmp/ac-gate-codeline-${issue.jiraKey}.txt`;
  // Declared outside the try: a call that threw spent money too, and dropping its record
  // is how the expensive failures become the invisible ones.
  const _costFile = `${tmpPrompt}.cost.json`;
  // STDERR IS CAPTURED, NEVER DISCARDED. `2>/dev/null` turned a timeout, a missing key and a
  // provider refusal into the same bare "Empty response", and the reason a call failed is
  // the only thing that makes the fallback judgeable. Discovery already learned this: there
  // it produced a tidy fallback to the highest-scored repo, against the wrong codeline.
  const _errFile = `${tmpPrompt}.err`;
  fs.writeFileSync(tmpPrompt, prompt);
  try {
    const cmd = `bash ${AI_RUN_SH}${flagArg('provider', PROVIDER)}`
      + `${flagArg('model', MODEL)} < ${tmpPrompt} 2>${_errFile}`;
    const raw = execSync(cmd, {
      encoding: 'utf8',
      timeout: Number(process.env.AC_GATE_TIMEOUT_MS || 360000),
      env: seamEnv('ac-classification', _costFile),
    }).trim();
    if (!raw) throw new Error(`Empty response from ai-run.sh${_why(_errFile)}`);
    const parsed = parseLooseJson(raw, 'codeline classification');
    return { verdict, reason, gaps: [], enrichedAcs: [], codeline: parsed.codeline || SPLIT_VALUE };
  } catch (e) {
    // A failed call is not a routing decision. SPLIT_VALUE is the inclusive fallback —
    // the story spans every codeline rather than silently reaching none, which is the
    // failure this whole change caused once already.
    process.stderr.write(`[ac-gate] codeline classification failed for ${issue.jiraKey}: ${e.message}${_why(_errFile)}\n`);
    return { verdict, reason, gaps: [], enrichedAcs: [], codeline: SPLIT_VALUE };
  } finally {
    emitSpend(_costFile, 'ac-classification');
    try { fs.unlinkSync(_errFile); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPrompt); } catch { /* best effort */ }
  }
}

// ── AC elaboration (AC_GATE_AUTO_ELABORATE=1) ──────────────────────────────
// When a story has no ACs (verdict=insufficient), generate testable ACs from
// the description and title so the pipeline can continue without Jira intervention.
// Result is stored in prd.json as enrichedAcs — never written to Jira.

/**
 * The AC-elaboration prompt. Extracted verbatim so a test can call it.
 */
function buildElaborationPrompt(issue) {
  // RENDERED FROM THE TEMPLATE LAYER.
  return renderEngineTemplate('ac-elaboration', {
    __STORY_KEY__: issue.jiraKey,
    __STORY_TITLE__: issue.title,
    __STORY_DESCRIPTION__: issue.description || '(none)',
  });
}

function elaborateAcs(issue) {
  if (DRY_RUN) {
    return [`Given "${issue.title}", verify the feature behaves as described.`];
  }

  const prompt = buildElaborationPrompt(issue);

  const tmpPrompt = `/tmp/ac-gate-elaborate-${issue.jiraKey}.txt`;
  // Declared outside the try: a call that threw spent money too, and dropping its record
  // is how the expensive failures become the invisible ones.
  const _costFile = `${tmpPrompt}.cost.json`;
  // STDERR IS CAPTURED, NEVER DISCARDED. `2>/dev/null` turned a timeout, a missing key and a
  // provider refusal into the same bare "Empty response", and the reason a call failed is
  // the only thing that makes the fallback judgeable. Discovery already learned this: there
  // it produced a tidy fallback to the highest-scored repo, against the wrong codeline.
  const _errFile = `${tmpPrompt}.err`;
  fs.writeFileSync(tmpPrompt, prompt);
  try {
    const cmd = `bash ${AI_RUN_SH}${flagArg('provider', PROVIDER)}`
      + `${flagArg('model', MODEL)} < ${tmpPrompt} 2>${_errFile}`;
    const raw = execSync(cmd, { encoding: 'utf8', timeout: Number(process.env.AC_GATE_TIMEOUT_MS || 360000), env: seamEnv('ac-elaboration', _costFile) }).trim();
    if (!raw) throw new Error(`Empty elaboration response${_why(_errFile)}`);
    const parsed = parseLooseJson(raw, 'elaboration');
    return Array.isArray(parsed.enrichedAcs) && parsed.enrichedAcs.length > 0
      ? parsed.enrichedAcs
      : [`Implement the behaviour described in ${issue.jiraKey}: ${issue.title}`];
  } catch (e) {
    // A title-only AC is a FABRICATED answer, not a degraded one. It is exactly
    // what produced the live cascade on 2026-07-29: no real criteria -> the spec
    // pass derived verification criteria from the title -> CPA had nothing to
    // size from -> effort:"low", 5.4 estimated minutes for a novel capability
    // across three repositories -> the cheapest model -> nothing built.
    //
    // Elaboration failing means the pipeline does not know what the story
    // requires. Proceeding on an invented criterion is worse than stopping,
    // and the caller treats a throw here as 'unknown', which halts.
    process.stderr.write(`[ac-gate]     elaboration failed: ${e.message}${_why(_errFile)}\n`);
    process.stderr.write('[ac-gate]     NOT substituting a title-based criterion — that is a fabricated answer.\n');
    throw e;
  } finally {
    emitSpend(_costFile, 'ac-elaboration');
    try { fs.unlinkSync(_errFile); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPrompt); } catch { /* ignore */ }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

module.exports = { buildClassificationPrompt, buildElaborationPrompt };

if (require.main !== module) return;

(async () => {
  const issues = JSON.parse(fs.readFileSync(ISSUES_PATH, 'utf8'));
  if (!Array.isArray(issues) || issues.length === 0) {
    process.stderr.write('[ac-gate] No issues found in input file.\n');
    process.stdout.write('[]\n');
    process.exit(0);
  }

  process.stderr.write(`[ac-gate] Classifying ${issues.length} issues (model: ${MODEL})${DRY_RUN ? ' [DRY RUN]' : ''}\n`);

  // Resolve codelines once for the whole batch — used to build prompts and
  // to emit per-codeline AC fields generically (${cl}Acs for each codeline).
  const knownCodelines = resolveCodelines(issues);
  if (knownCodelines.length === 0) {
    process.stderr.write('[ac-gate] WARNING: no codelines resolved (set JIRA_CODELINES or add codeline-* labels to Jira tickets)\n');
  } else {
    process.stderr.write(`[ac-gate] Codelines: [${knownCodelines.join(', ')}]\n`);
  }

  const results = [];
  let hasInsufficient = false;
  let hasUnknown = false;

  for (const issue of issues) {
    process.stderr.write(`[ac-gate]   ${issue.jiraKey} — ${(issue.title || '').slice(0, 60)}\n`);

    // THE RULE (2026-08-05): a story that HAS acceptance criteria goes through AC
    // processing as designed — brownfield or greenfield alike, because the ticket carries
    // a real contract to assess. A BROWNFIELD story with NO ACs skips it entirely: ACs are
    // immutable in brownfield and the VCs are derived from the DESCRIPTION instead (see
    // ingest-jira-tickets.sh, which already logs exactly that), so every model call here
    // judges a field nothing will read.
    //
    // Measured before this guard: 4 model calls per story — a planning pass, an answer
    // pass, and with AC_GATE_AUTO_ELABORATE a further elaboration that GENERATES criteria.
    // That elaboration is how 8 fabricated ACs came to be frozen into a PRD template for a
    // ticket whose Jira record never had any.
    //
    // The codeline half of the classification IS load-bearing: it routes the story to its
    // lanes, and a Jira issue does NOT carry a codeline — the model assigns it. My first
    // attempt at this skip read `issue.codeline`, which is always empty, so the story
    // became unroutable and the live run logged "Codeline 'metrolinx': no stories —
    // skipping". The skip therefore still classifies the CODELINE; it drops only the
    // acceptance-criteria reasoning and the elaboration.
    const hasAcs = Array.isArray(issue.acceptanceCriteria) && issue.acceptanceCriteria.length > 0;
    const skipAcProcessing = BROWNFIELD && !hasAcs;

    const classification = skipAcProcessing
      ? classifyCodelineOnly(issue, knownCodelines)
      : classifyWithLLM(issue, knownCodelines);
    let verdict = classification.verdict || 'enrichable';

    process.stderr.write(`[ac-gate]     verdict: ${verdict} — ${classification.reason}\n`);

    // AUTO_ELABORATE: when verdict is insufficient, generate ACs locally from
    // description and override to enrichable so the pipeline continues.
    // No Jira write occurs — ACs land in prd.json only.
    if (verdict === 'insufficient' && AUTO_ELABORATE && !skipAcProcessing) {
      process.stderr.write(`[ac-gate]     AUTO_ELABORATE: generating ACs from description (no Jira write)...\n`);
      const generated = elaborateAcs(issue);
      classification.enrichedAcs = generated;
      classification.reason = `Auto-elaborated from description (original verdict: insufficient). ${classification.reason}`;
      verdict = 'enrichable';
      process.stderr.write(`[ac-gate]     elaborated ${generated.length} AC(s) → enrichable, pipeline continues\n`);
    }

    // This project never writes to Jira, unconditionally — no flag, no
    // DRY_RUN branch. Only track whether the story needs human attention.
    if (verdict === 'insufficient') hasInsufficient = true;
    // 'unknown' means the gate could not decide — the call or its parse failed.
    // It must NOT pass: a gate that cannot reach its model has produced no
    // judgement about the story, and treating that as approval is how a run
    // with zero working LLM calls printed "All stories classified" and then
    // launched zero lanes (live 2026-07-29). Halting here is the same rule as
    // "cannot-verify is never a pass" applied to Step 5.
    if (verdict === 'unknown') hasUnknown = true;

    // LLM codeline overrides the Jira label when present (LLM has richer context).
    // Fall back to the issue's own label, then JIRA_DEFAULT_CODELINE — never a
    // hardcoded name so the engine works for any project's codeline taxonomy.
    const resolvedCodeline = classification.codeline
      || issue.codeline
      || process.env.JIRA_DEFAULT_CODELINE
      || '';

    // Emit ${cl}Acs for every known codeline — synthesize-prd-from-jira.js reads
    // them as c[`${cl}Acs`] generically, so no names are hardcoded there either.
    const perClAcs = {};
    for (const cl of knownCodelines) {
      perClAcs[`${cl}Acs`] = classification[`${cl}Acs`] || [];
    }

    // THE TICKET PASSES THROUGH. This used to enumerate the fields to keep, one by one,
    // which made the gate a WHITELIST: anything not named here was destroyed on its way to
    // the PRD, silently, with no error and no log line.
    //
    // It cost the same defect twice. 2026-07-23: `issueType` was dropped, the Bug → defect
    // anchor never fired, and the fix was to add one more name to the list — leaving the
    // shape that caused it. 2026-08-06, live: the ticket's `description`, `comments`,
    // `commentLinks` and `components` were all dropped, so a brownfield story reached the
    // spec pass with its description replaced by its own title (43 characters), zero
    // comments, and zero of the two vendor documentation links its thread contained. The
    // ticket-link agent then had nothing to review, and everything downstream reasoned
    // about a ticket that had been emptied.
    //
    // The gate's job is to CLASSIFY, not to decide what a ticket consists of. So the issue
    // spreads first and the gate's own findings override — a field added to a ticket
    // tomorrow arrives at the PRD without anyone remembering to name it here.
    results.push({
      ...issue,
      jiraKey:     issue.jiraKey,
      storyId:     issue.storyId,
      title:       issue.title,
      codeline:    resolvedCodeline,
      issueType:   issue.issueType || null,
      effort:      issue.effort,
      verdict,
      reason:      classification.reason,
      gaps:        classification.gaps || [],
      enrichedAcs: classification.enrichedAcs || [],
      ...perClAcs,
      originalAcs: issue.acceptanceCriteria || [],
    });
  }

  const json = JSON.stringify(results, null, 2) + '\n';
  if (OUT_PATH) {
    fs.writeFileSync(OUT_PATH, json);
    process.stderr.write(`[ac-gate] Results written to ${OUT_PATH}\n`);
  } else {
    process.stdout.write(json);
  }

  // Exit code 2 signals "insufficient found — caller must halt"
  if (hasUnknown) {
    process.stderr.write('[ac-gate] HALT: could not reach a verdict for one or more stories — the call or its parse failed.\n');
    process.stderr.write('[ac-gate]   This is not a story problem. Check provider reachability and credits, then re-run.\n');
    process.exit(2);
  }
  if (hasInsufficient) {
    process.stderr.write('\n[ac-gate] ⛔ One or more stories have INSUFFICIENT ACs.\n');
    process.stderr.write('[ac-gate] Pipeline must halt. Human approval required (see Jira comments).\n');
    process.exit(2);
  }

  process.stderr.write('\n[ac-gate] ✅ All stories classified. Pipeline may proceed.\n');
  process.exit(0);
})();
