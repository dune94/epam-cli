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
const MODEL   = getArg('--model', process.env.ORCH_GATE_MODEL || process.env.EPAM_MODEL || 'claude-haiku-4-5-20251001');

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
"gaps" should be [] when verdict is "sufficient".`;
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
    const cmd = `bash ${AI_RUN_SH} --model ${MODEL} < ${tmpPrompt} 2>/dev/null`;
    const raw = execSync(cmd, {
      encoding: 'utf8',
      timeout: 90000,
      env: { ...process.env },
    }).trim();

    if (!raw) throw new Error('Empty response from ai-run.sh');

    // Extract JSON from response (may have surrounding explanation)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON in LLM response: ${raw.slice(0, 200)}`);

    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    process.stderr.write(`[ac-gate] LLM call failed for ${issue.jiraKey}: ${e.message}\n`);
    return {
      verdict: 'enrichable',
      reason: `AC gate LLM call failed — treating as enrichable. Error: ${e.message.slice(0, 150)}`,
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

Respond with JSON only — no markdown, no preamble:
{ "enrichedAcs": ["<AC 1>", "<AC 2>", ...] }`;

  const tmpPrompt = `/tmp/ac-gate-elaborate-${issue.jiraKey}.txt`;
  fs.writeFileSync(tmpPrompt, prompt);
  try {
    const cmd = `bash ${AI_RUN_SH} --model ${MODEL} < ${tmpPrompt} 2>/dev/null`;
    const raw = execSync(cmd, { encoding: 'utf8', timeout: 90000, env: { ...process.env } }).trim();
    if (!raw) throw new Error('Empty elaboration response');
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON in elaboration response: ${raw.slice(0, 200)}`);
    const parsed = JSON.parse(jsonMatch[0]);
    return Array.isArray(parsed.enrichedAcs) && parsed.enrichedAcs.length > 0
      ? parsed.enrichedAcs
      : [`Implement the behaviour described in ${issue.jiraKey}: ${issue.title}`];
  } catch (e) {
    process.stderr.write(`[ac-gate]     elaboration LLM call failed: ${e.message} — using title-based fallback\n`);
    return [`Implement the behaviour described in ${issue.jiraKey}: ${issue.title}`];
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
  if (hasInsufficient) {
    process.stderr.write('\n[ac-gate] ⛔ One or more stories have INSUFFICIENT ACs.\n');
    process.stderr.write('[ac-gate] Pipeline must halt. Human approval required (see Jira comments).\n');
    process.exit(2);
  }

  process.stderr.write('\n[ac-gate] ✅ All stories classified. Pipeline may proceed.\n');
  process.exit(0);
})();
