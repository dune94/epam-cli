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
// Explicit provider. These called ai-run.sh with --model but NO --provider, so
// provider came only from ambient env — e.g. `--provider qwen --model claude-haiku`.
const PROVIDER = getArg('--provider', process.env.ORCH_GATE_PROVIDER || process.env.EPAM_ORCHESTRATION_PROVIDER || 'qwen');
const MODEL   = getArg('--model', process.env.ORCH_GATE_MODEL || process.env.EPAM_MODEL || 'z-ai/glm-5.2');

const ISSUES_PATH = getArg('--issues');
const OUT_PATH    = getArg('--out', '');   // write JSON results to file instead of stdout

if (!ISSUES_PATH && !argv.includes('--help')) {
  process.stderr.write('Usage: node ac-gate.js --issues <path> [--out <path>]\n');
  process.exit(1);
}

const SCRIPT_DIR  = path.join(__dirname, '..');
const AI_RUN_SH   = path.join(SCRIPT_DIR, 'ai-run.sh');
const NODE_BIN    = process.env.NODE_BIN ||
  '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';
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
 * Parse a model's JSON answer, tolerating truncation.
 *
 * `/\{[\s\S]*\}/` needs a closing brace, so a response cut off mid-object
 * reads as "no JSON at all" and a correct answer is discarded. Live metrolinx
 * 2026-07-29: the classifier answered {"verdict":"insufficient",...}, the match
 * failed, and the gate recorded the OPPOSITE verdict.
 *
 * jsonrepair closes the object — the same recovery spec-mode-runner already
 * applies to this class of output. Guarded to text that actually begins with
 * '{', so prose is never coerced into an object.
 *
 * ONE function for every call site in this file: the truncation bug existed in
 * two places and was fixed in one, which is how the second site kept returning
 * a title-only AC list.
 */
function parseLooseJson(raw, what) {
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  const first = raw.indexOf('{');
  if (first !== -1) {
    try {
      const { jsonrepair } = require('jsonrepair');
      const repaired = JSON.parse(jsonrepair(raw.slice(first)));
      process.stderr.write(`[ac-gate] ${what} response was truncated; recovered via jsonrepair\n`);
      return repaired;
    } catch (_) { /* fall through */ }
  }
  throw new Error(`No JSON in ${what} response: ${raw.slice(0, 200)}`);
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

  return `You are an AC sufficiency gate for an autonomous software development pipeline.

Assess whether the acceptance criteria for this Jira story are sufficient for an AI agent
to implement it without human clarification.

STORY: ${issue.jiraKey} — ${issue.title}

DESCRIPTION:
${(issue.description || '(none)').slice(0, 1500)}

ACCEPTANCE CRITERIA:
${acsText}

CLASSIFICATION RULES:
- "sufficient": ACs are present, specific, testable, and cover the primary success path
  AND at least one error/edge case. Agent can implement without asking questions.
- "enrichable": ACs exist but are vague, incomplete, or missing error paths. Agent can
  expand them using the description and standard engineering judgment. Low risk of drift.
- "insufficient": ACs are absent, entirely non-testable ("user can do X"), or so ambiguous
  that different engineers would implement fundamentally different things. Human must clarify.

CODELINE CLASSIFICATION:
Also determine which codeline(s) this story touches:
${clBullets}
${splitLine}

When codeline is "${SPLIT_VALUE}", split the ACs per codeline:
${splitAcLines}
Use your understanding of the story domain — do NOT use keyword matching.
If an AC straddles two codelines, place it in the one where the primary implementation work lives.

RESPOND WITH JSON ONLY — no explanation, no markdown fences:
{
  "verdict": "sufficient" | "enrichable" | "insufficient",
  "reason": "<one sentence explaining the verdict>",
  "codeline": ${clList} | "${SPLIT_VALUE}",
  "gaps": ["<gap 1>", ...],
  "enrichedAcs": ["<expanded AC 1>", ...],
${schemaAcFields}
}

"enrichedAcs" is required when verdict is "enrichable". "enrichedAcs" should be [] otherwise.
${splitNote} are required when codeline is "${SPLIT_VALUE}". All should be [] otherwise.
"gaps" should be [] when verdict is "sufficient".

ENRICHMENT RULE (critical): enrichedAcs must describe OBSERVABLE BEHAVIOR to VERIFY — never HOW to implement it. Do NOT prescribe an internal mechanism or algorithm. Forbidden: "calculate independently", "split", "halve"/"×0.5", "per segment", "for each line item", adding new fields/flags, or any phrasing that presumes a particular code approach. A bug ticket describes a SYMPTOM ("the amount is not displayed for the return leg"); keep the enriched ACs at that symptom/behavior level (what a tester observes), and enrich ONLY for clarity, testability, and genuinely-missing edge/error cases. Inventing an implementation approach in an AC misdirects the downstream code investigation toward the wrong fix.`;
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
  fs.writeFileSync(tmpPrompt, prompt);

  try {
    // Use ai-run.sh for provider-agnostic LLM call with proper env/key routing
    const cmd = `bash ${AI_RUN_SH} --provider ${PROVIDER} --model ${MODEL} < ${tmpPrompt} 2>/dev/null`;
    const raw = execSync(cmd, {
      encoding: 'utf8',
      timeout: Number(process.env.AC_GATE_TIMEOUT_MS || 360000),
      env: { ...process.env, EPAM_AGENT_NAME: 'ac-gate' },
    }).trim();

    if (!raw) throw new Error('Empty response from ai-run.sh');

    return parseLooseJson(raw, 'classification');
  } catch (e) {
    process.stderr.write(`[ac-gate] LLM call failed for ${issue.jiraKey}: ${e.message}\n`);
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
      reason: `AC gate could not reach a verdict — the call or its parse failed: ${e.message.slice(0, 150)}`,
      gaps: [],
      enrichedAcs: [],
    };
  } finally {
    try { fs.unlinkSync(tmpPrompt); } catch { /* ignore */ }
  }
}

// ── AC elaboration (AC_GATE_AUTO_ELABORATE=1) ──────────────────────────────
// When a story has no ACs (verdict=insufficient), generate testable ACs from
// the description and title so the pipeline can continue without Jira intervention.
// Result is stored in prd.json as enrichedAcs — never written to Jira.

function elaborateAcs(issue) {
  if (DRY_RUN) {
    return [`Given "${issue.title}", verify the feature behaves as described.`];
  }

  const prompt = `You are an acceptance-criteria writer for a brownfield software pipeline.

A Jira story has NO formal acceptance criteria. Generate a complete, testable set of ACs
so that an AI agent can implement the change without human clarification.

STORY: ${issue.jiraKey} — ${issue.title}

DESCRIPTION:
${(issue.description || '(none)').slice(0, 2000)}

Rules:
1. Each AC must be specific and testable (observable in UI, API response, or logs).
2. Infer "expected" behaviour from the description, domain knowledge, and the word "NOT".
3. Include: primary success path, at least one edge case, and one error/boundary case.
4. Do NOT invent requirements not implied by the description.
5. Use plain English, present tense, third-person ("The system...", "The UI shows...").
6. Describe WHAT to verify (observable behavior), never HOW to implement it. Do NOT prescribe a mechanism/algorithm — no "calculate independently", "split", "halve", "per segment", "for each line item", new fields, or internal approach. Keep a bug's ACs at the symptom/behavior level; prescribing an implementation misdirects the downstream code investigation.

Respond with JSON only — no markdown, no preamble:
{ "enrichedAcs": ["<AC 1>", "<AC 2>", ...] }`;

  const tmpPrompt = `/tmp/ac-gate-elaborate-${issue.jiraKey}.txt`;
  fs.writeFileSync(tmpPrompt, prompt);
  try {
    const cmd = `bash ${AI_RUN_SH} --provider ${PROVIDER} --model ${MODEL} < ${tmpPrompt} 2>/dev/null`;
    const raw = execSync(cmd, { encoding: 'utf8', timeout: Number(process.env.AC_GATE_TIMEOUT_MS || 360000), env: { ...process.env, EPAM_AGENT_NAME: 'ac-gate' } }).trim();
    if (!raw) throw new Error('Empty elaboration response');
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
    process.stderr.write(`[ac-gate]     elaboration failed: ${e.message}\n`);
    process.stderr.write('[ac-gate]     NOT substituting a title-based criterion — that is a fabricated answer.\n');
    throw e;
  } finally {
    try { fs.unlinkSync(tmpPrompt); } catch { /* ignore */ }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

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

    const classification = classifyWithLLM(issue, knownCodelines);
    let verdict = classification.verdict || 'enrichable';

    process.stderr.write(`[ac-gate]     verdict: ${verdict} — ${classification.reason}\n`);

    // AUTO_ELABORATE: when verdict is insufficient, generate ACs locally from
    // description and override to enrichable so the pipeline continues.
    // No Jira write occurs — ACs land in prd.json only.
    if (verdict === 'insufficient' && AUTO_ELABORATE) {
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

    results.push({
      jiraKey:     issue.jiraKey,
      storyId:     issue.storyId,
      title:       issue.title,
      codeline:    resolvedCodeline,
      // Carry the Jira ticket type through the gate so synthesize-prd can set
      // story.issueType — without this the defect/novel classification anchor
      // (Bug → defect) silently never fires (found live 2026-07-23, AMSD-1820:
      // issueType arrived null at the PRD because the gate dropped it here).
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
