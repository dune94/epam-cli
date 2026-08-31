#!/usr/bin/env node
/**
 * CPA Inference — pipes story context to the `claude` CLI for structured review.
 *
 * Uses the claude CLI (already authenticated via Claude Code) — no API key needed.
 * Reads a JSON payload from stdin:
 *   {
 *     story:           { id, title, description, ... },
 *     kbChunks:        [{ source, score, chunk }],
 *     codebaseSignals: { totalLoc, fileCount, importCount, filesExist },
 *     formulaEstimate: { aiMinutes, cost, tokens, turns },
 *     adjacentStories: [{ id, title, effort, status }],
 *     systemPrompt:    "string"
 *   }
 *
 * Returns CPA review JSON to stdout. Errors to stderr only.
 *
 * Env:
 *   CLAUDE_CMD   — claude binary override (default: 'claude')
 */

'use strict';

const { spawnSync } = require('child_process');
const { renderEngineTemplate } = require('./engine-prompt');
const path          = require('path');
const fs            = require('fs');

// ── Configuration ──────────────────────────────────────────────────────────
const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';
const AI_RUNNER_CMD = process.env.AI_RUNNER_CMD || path.resolve(__dirname, '..', 'ai-run.sh');
// Default provider: openrouter (OpenRouter). Override via CPA_PROVIDER or AI_PROVIDER env vars.
// NO VENDOR OF ITS OWN. This ended in a hardcoded vendor name, the second copy of the fallback
// removed from ac-gate.js: it fires when the project env has not reached the child, and where a
// missing provider should defer it instead SUCCEEDS against a stack the operator did not choose.
// llm-handler.sh resolves the provider from the ACTIVE SET when it is not told one, so empty is
// the correct answer and the flag is omitted rather than passed blank.
//
// The codex branch stays: that is not a vendor preference but a fact about the runner in hand —
// a codex binary cannot be driven as anything else.
const AI_PROVIDER = process.env.AI_PROVIDER
  || process.env.EPAM_ORCHESTRATION_PROVIDER
  || (/codex$/.test(CLAUDE_CMD) ? 'codex' : '');
const TIMEOUT_MS = parseInt(process.env.CPA_TIMEOUT_MS || '120000', 10);

// ── Read stdin ─────────────────────────────────────────────────────────────
// Retrieved source chunks reach the estimator whole. They were cut at 800/1200 chars —
// numbers unrelated to the model, the content or any budget — so the estimate was formed
// from a partial view with nothing recording that.
function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

// ── Build full prompt ──────────────────────────────────────────────────────
/**
 * THE ESTIMATE, AND WHETHER THE MODEL ACTUALLY GAVE ONE.
 *
 * The floor of 1 is deliberate — it overrides nothing, and must never inflate a story's budget
 * from a value the model did not provide. But a bare 1 is indistinguishable from a genuine
 * estimate of 1, and that is exactly how 1,817 unanswered CPA records read as answers while 211
 * stories took budgets from them. `provided` keeps the two apart; the value keeps its floor and
 * its 500 sanity ceiling.
 */
function normaliseIterationEstimate(raw) {
  const n = parseFloat(raw);
  return {
    provided: Number.isFinite(n),
    value: Math.round(Math.max(1, Math.min(500, Number.isFinite(n) ? n : 1))),
  };
}

/**
 * STATE THE CONDITION THE ESTIMATE DEPENDS ON.
 *
 * cpa-system.md asks for `iterationEstimate` "BROWNFIELD STORIES ONLY", and nothing ever told the
 * model whether the story was brownfield — the word appeared once in this file, in a comment. So
 * the model was asked for a field whose condition it could not evaluate. Measured across
 * orchestrations/logs/cpa-review.jsonl: 1,817 records, iterationEstimate returned ZERO times.
 *
 * Caller first, environment second: a caller that knows beats an env var that might be stale, and
 * a run that sets neither says nothing rather than guessing.
 */
function buildModeSection(input = {}) {
  const declared = (input && input.brownfield !== undefined)
    ? Boolean(input.brownfield)
    : (String(process.env.EPAM_BROWNFIELD || '') === '1' ? true : null);
  if (declared === true) {
    return '## Delivery Mode\nThis is a BROWNFIELD story: it changes an existing codebase rather '
      + 'than creating one. The iterationEstimate field applies to this story — supply it.';
  }
  if (declared === false) {
    return '## Delivery Mode\nThis is a GREENFIELD story. Omit iterationEstimate.';
  }
  return '';
}

function buildPrompt(input) {
  const { story, kbChunks = [], codebaseSignals = {}, formulaEstimate = {},
          adjacentStories = [], systemPrompt = '', manifest } = input;

  // THE PERSONA IS NOT OPTIONAL, AND AN EMPTY ONE IS WORSE THAN A MISSING FILE.
  //
  // Defaulting it to '' renders a blank section, the model is asked to answer as nobody in
  // particular, and the answer comes back looking like every other answer — so the failure is
  // invisible in the output and only shows up as degraded estimates. Refusing here, by the
  // placeholder's own name, turns a silent quality loss into a stated one that names what to fix.
  if (typeof systemPrompt !== 'string' || systemPrompt.trim() === '') {
    throw new Error('cpa-inference buildPrompt: __SYSTEM_PROMPT__ is empty — the persona is not '
      + 'optional. A blank persona renders a blank section and the agent answers as nobody in '
      + 'particular, which cannot be seen in the output.');
  }

  const storyJson = JSON.stringify({
    id:                  story.id,
    title:               story.title,
    description:         story.description,
    priority:            story.priority,
    storyType:           story.storyType,
    storyKind:           story.storyKind,
    effort:              story.effort,
    humanHours:          story.humanHours || story.estimatedHours,
    dependencies:        story.dependencies,
    acceptanceCriteria:  story.acceptanceCriteria,
    verificationCriteria: story.verificationCriteria,
    technicalNotes:      story.technicalNotes,
    agentRole:           story.agentRole,
  }, null, 2);

  const kbSection = kbChunks.length > 0
    ? `## Knowledge Base (${kbChunks.length} retrieved sources)\n\n` +
      kbChunks.map((c, i) =>
        `### Source ${i + 1}: \`${c.source}\` (relevance: ${c.score})\n\`\`\`\n${c.chunk}\n\`\`\``
      ).join('\n\n')
    : '## Knowledge Base\n_No matching KB sources found for this story\'s required skills._';

  const snippets = (codebaseSignals.fileSnippets || []);
  const snippetSection = snippets.length > 0
    ? snippets.map(s =>
        `### \`${s.path}\` (${s.lines} lines)\n\`\`\`\n${s.snippet || ''}\n\`\`\``
      ).join('\n\n')
    : '';

  const signalsSummary = { totalLoc: codebaseSignals.totalLoc, fileCount: codebaseSignals.fileCount,
    filesExist: codebaseSignals.filesExist, importCount: codebaseSignals.importCount };

  const codeSection = codebaseSignals.fileCount > 0
    ? `## Codebase Signals\n\`\`\`json\n${JSON.stringify(signalsSummary, null, 2)}\n\`\`\`` +
      (snippetSection ? `\n\n## File Previews (first ~30 lines)\n${snippetSection}` : '')
    : '## Codebase Signals\n_No existing source files found — story targets new code._';

  const adjSection = adjacentStories.length > 0
    ? `## Adjacent Stories in Phase\n` +
      adjacentStories.map(s =>
        `- **${s.id}**: ${s.title} | effort: ${s.effort} | status: ${s.status}`
      ).join('\n')
    : '';

  const manifestSection = manifest
    ? `## Project Manifest\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\``
    : '';

  // Feeds the brownfield-only iterationEstimate judgment (see cpa-system.md).
  // Without this, CPA never sees the detective's prescribed fix sites or the
  // deterministic coverage verdict (checkFixSiteCoverage, spec-mode-runner.js)
  // at all — it could not judge turn-count complexity from a signal it never
  // receives.
  const fixSiteAnalysis = Array.isArray(story.fixSiteAnalysis) ? story.fixSiteAnalysis : [];
  const rcaSection = fixSiteAnalysis.length
    ? `## Root Cause Analysis (detective's prescribed fix sites)\n\`\`\`json\n${JSON.stringify(fixSiteAnalysis, null, 2)}\n\`\`\`` +
      (story.fixSiteAnalysisCoverage
        ? `\n\nCoverage check: ${story.fixSiteAnalysisCoverage.complete
            ? 'every verification criterion shares a term with at least one fix site.'
            : `${story.fixSiteAnalysisCoverage.uncoveredVerificationCriteria.length} verification criterion/criteria share NO term with any fix site above — treat this as a signal the prescribed fix may be incomplete.`}`
        : '')
    : '';

  // Sections are assembled here: filter(Boolean) means an absent section removes its
  // separator too, which a template cannot express without becoming a program. The envelope
  // and the closing instruction are the prompt, and they live in the template layer.
  const sections = [
    buildModeSection(input),
    `## Story Under Review\n\`\`\`json\n${storyJson}\n\`\`\``,
    `## Formula Baseline Estimate\n\`\`\`json\n${JSON.stringify(formulaEstimate, null, 2)}\n\`\`\``,
    kbSection,
    codeSection,
    adjSection,
    manifestSection,
    rcaSection,
  ].filter(Boolean).join('\n\n');

  return renderEngineTemplate('cpa-inference', {
    __SYSTEM_PROMPT__: systemPrompt,
    __SECTIONS__: sections,
  });
}

// ── Input validation ───────────────────────────────────────────────────────
// Structural contract only — never blocks a run (CPA must always produce
// SOME estimate). `warnings` flags cases the model can silently misjudge,
// most importantly: nothing concrete to size complexity from at all.
function validateInput(input) {
  const errors = [];
  const warnings = [];

  if (!input || typeof input !== 'object') {
    return { valid: false, errors: ['input must be an object'], warnings };
  }

  const { story } = input;
  if (!story || typeof story !== 'object') {
    errors.push('story is required');
  } else {
    if (!story.id) errors.push('story.id is required');
    if (!story.title) errors.push('story.title is required');

    const hasAC = Array.isArray(story.acceptanceCriteria) && story.acceptanceCriteria.length > 0;
    const hasVC = Array.isArray(story.verificationCriteria) && story.verificationCriteria.length > 0;
    if (!hasAC && !hasVC) {
      warnings.push(
        'story has nothing concrete to size from: acceptanceCriteria and verificationCriteria are both empty/absent'
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── JSON extraction ────────────────────────────────────────────────────────
function extractJSON(text) {
  try { return JSON.parse(text.trim()); } catch {}

  const fenced = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  try { return JSON.parse(fenced); } catch {}

  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }

  throw new Error('No valid JSON object found in response');
}

// ── Fallback (inference unavailable) ──────────────────────────────────────
function skippedReview(formulaEstimate, reason) {
  return {
    confidence:           0.70,
    complexityAdjustment: 1.0,
    adjustedEstimate:     formulaEstimate,
    riskFlags:            [],
    missingKbCoverage:    [],
    citedSources:         [],
    reasoning:            `Inference skipped — ${reason}. Formula estimate used unchanged.`,
    _inferenceSkipped:    true,
    _metrics:             { latencyMs: 0, tokensIn: 0, tokensOut: 0, tokenEfficiency: 0 },
  };
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  let rawInput;
  try {
    rawInput = await readStdin();
  } catch (e) {
    process.stderr.write(`ERROR: Failed to read stdin: ${e.message}\n`);
    process.exit(1);
  }

  let input;
  try {
    input = JSON.parse(rawInput);
  } catch (e) {
    process.stderr.write(`ERROR: Invalid JSON on stdin: ${e.message}\n`);
    process.exit(1);
  }

  const { valid, errors, warnings } = validateInput(input);
  if (!valid) {
    process.stderr.write(`ERROR: invalid CPA input: ${errors.join('; ')}\n`);
    process.exit(1);
  }
  for (const w of warnings) process.stderr.write(`WARN: ${w}\n`);

  const { formulaEstimate = {} } = input;
  const fullPrompt = buildPrompt(input);

  // ── Call provider-agnostic prompt runner ──────────────────────────────────
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  // THE SEAM, asked for. This call passed none, so it ran with no ladder, no effort, no output
  // budget and no tool grant — the cpa-inference profile sat in the registry reaching nothing.
  //
  // IDENTITY AFTER THE SPREAD. It was `{ EPAM_AGENT_NAME: 'cpa-inference', ...env }`, and env is
  // process.env — so a parent stage that had set EPAM_AGENT_NAME overrode it, and this agent ran,
  // was costed, and had its self-heal episodes filed under whatever ran before it.
  let seam = {};
  try { seam = require('./seam-invocation.js').seamInvocationEnv('cpa-inference'); }
  catch (e) { process.stderr.write(`WARN: seam 'cpa-inference' did not resolve: ${(e && e.message) || e}\n`); }

  // ai-run.sh writes the normalized result JSON when this is set; it was never asked to, so a call
  // made once per story recorded no spend at all.
  const _costFile = `${require('os').tmpdir()}/cpa-cost-${process.pid}-${Date.now()}.json`;

  const t0 = Date.now();
  // A flag with no value is not an empty argument — omit it, and let the hub resolve.
  const cliArgs = AI_PROVIDER ? ['--provider', AI_PROVIDER] : [];
  const result = spawnSync(
    AI_RUNNER_CMD,
    cliArgs,
    { input: fullPrompt, encoding: 'utf8', timeout: TIMEOUT_MS,
      env: { ...env, ...seam, EPAM_AGENT_NAME: 'cpa-inference', ORCH_JSON_RESULT: _costFile } }
  );
  const latencyMs = Date.now() - t0;

  // Recorded whether the call returned or failed: a failed call spent too, and dropping its record
  // is how the expensive failures become the invisible ones.
  try {
    require('./cost-emitter.js').emitCostSnapshot({
      resultFile: _costFile,
      activityFile: process.env.ACTIVITY_FILE
        || path.join(process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs'), 'agent-activity.jsonl'),
      agent: 'cpa-inference',
      storyId: (input && input.storyId) || '',
      phase: process.env.PHASE || '',
      model: process.env.AI_MODEL || '',
      provider: AI_PROVIDER,
    });
  } catch { /* cost emission must never break the agent call */ }
  try { fs.unlinkSync(_costFile); } catch { /* ignore */ }

  // ── Handle CLI failure ────────────────────────────────────────────────────
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || (result.stderr || '').slice(0, 200) || `exit ${result.status}`;
    process.stderr.write(`WARN: prompt runner failed: ${reason}\n`);
    const review = skippedReview(formulaEstimate, `prompt runner unavailable: ${reason}`);
    review._metrics.latencyMs = latencyMs;
    process.stdout.write(JSON.stringify(review) + '\n');
    return;
  }

  const rawText = (result.stdout || '').trim();
  if (!rawText) {
    process.stderr.write('WARN: prompt runner returned empty response\n');
    const review = skippedReview(formulaEstimate, 'empty response from prompt runner');
    review._metrics.latencyMs = latencyMs;
    process.stdout.write(JSON.stringify(review) + '\n');
    return;
  }

  // ── Parse JSON from response ───────────────────────────────────────────────
  let reviewData;
  try {
    reviewData = extractJSON(rawText);
  } catch (e) {
    process.stderr.write(`WARN: JSON parse failed: ${e.message}\nRaw (first 400): ${rawText.slice(0, 400)}\n`);
    reviewData = skippedReview(formulaEstimate, `parse error: ${e.message}`);
    reviewData._inferenceSkipped = false; // inference ran, output was malformed
  }

  // ── Clamp required fields ──────────────────────────────────────────────────
  reviewData.confidence           = Math.max(0, Math.min(1, parseFloat(reviewData.confidence) || 0.3));
  reviewData.complexityAdjustment = Math.max(0.5, Math.min(2.5, parseFloat(reviewData.complexityAdjustment) || 1.0));
  // Brownfield-only ABSOLUTE iteration estimate (see cpa-system.md "Iteration
  // Estimate" — a real turn count, not a multiplier: a 1.0-3.0x multiplier on
  // an already-scaled base cannot span "5 for a bug fix" to "200 for a large
  // multi-layer change," a ~40x real-world range). 1 (a floor that overrides
  // nothing) when absent/invalid/greenfield — never silently inflates a
  // story's real budget from a value the model didn't actually provide. 500
  // is a sanity ceiling against a malformed/hallucinated value, not the real
  // engine-side iteration cap (that's enforced separately in claude.sh).
  const _est = normaliseIterationEstimate(reviewData.iterationEstimate);
  reviewData.iterationEstimate = _est.value;
  reviewData.iterationEstimateProvided = _est.provided;

  // ── Estimate token counts from text length (1 token ≈ 4 chars) ────────────
  // claude CLI does not expose usage data in --print mode
  const tokensIn  = Math.round(fullPrompt.length / 4);
  const tokensOut = Math.round(rawText.length / 4);

  const schemaFields = ['confidence','complexityAdjustment','adjustedEstimate','riskFlags','citedSources','reasoning'];
  const populated    = schemaFields.filter(k => reviewData[k] !== undefined).length;

  reviewData._metrics = {
    latencyMs,
    tokensIn,
    tokensOut,
    tokenEfficiency: Math.min(1.0, Math.round((populated * 60) / Math.max(1, tokensOut) * 100) / 100),
  };

  process.stdout.write(JSON.stringify(reviewData) + '\n');
}

if (require.main === module) {
  main().catch(e => {
    process.stderr.write(`FATAL: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { extractJSON, buildPrompt, skippedReview, validateInput, buildModeSection, normaliseIterationEstimate };
