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
const path          = require('path');

// ── Configuration ──────────────────────────────────────────────────────────
const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';
const AI_RUNNER_CMD = process.env.AI_RUNNER_CMD || path.resolve(__dirname, '..', 'ai-run.sh');
const AI_PROVIDER = process.env.AI_PROVIDER
  || process.env.EPAM_ORCHESTRATION_PROVIDER
  || (/codex$/.test(CLAUDE_CMD) ? 'codex' : 'claude');
const TIMEOUT_MS = parseInt(process.env.CPA_TIMEOUT_MS || '120000', 10);

// ── Read stdin ─────────────────────────────────────────────────────────────
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
function buildPrompt(input) {
  const { story, kbChunks = [], codebaseSignals = {}, formulaEstimate = {},
          adjacentStories = [], systemPrompt = '' } = input;

  const storyJson = JSON.stringify({
    id:                 story.id,
    title:              story.title,
    description:        story.description,
    priority:           story.priority,
    storyType:          story.storyType,
    effort:             story.effort,
    humanHours:         story.humanHours || story.estimatedHours,
    dependencies:       story.dependencies,
    acceptanceCriteria: story.acceptanceCriteria,
    technicalNotes:     story.technicalNotes,
    agentRole:          story.agentRole,
  }, null, 2);

  const kbSection = kbChunks.length > 0
    ? `## Knowledge Base (${kbChunks.length} retrieved sources)\n\n` +
      kbChunks.map((c, i) =>
        `### Source ${i + 1}: \`${c.source}\` (relevance: ${c.score})\n\`\`\`\n${c.chunk.slice(0, 800)}\n\`\`\``
      ).join('\n\n')
    : '## Knowledge Base\n_No matching KB sources found for this story\'s required skills._';

  const snippets = (codebaseSignals.fileSnippets || []);
  const snippetSection = snippets.length > 0
    ? snippets.map(s =>
        `### \`${s.path}\` (${s.lines} lines)\n\`\`\`\n${(s.snippet || '').slice(0, 1200)}\n\`\`\``
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

  const userMessage = [
    `## Story Under Review\n\`\`\`json\n${storyJson}\n\`\`\``,
    `## Formula Baseline Estimate\n\`\`\`json\n${JSON.stringify(formulaEstimate, null, 2)}\n\`\`\``,
    kbSection,
    codeSection,
    adjSection,
    '---',
    'Respond with ONLY the JSON object as specified in your instructions. No prose, no markdown fences.',
  ].filter(Boolean).join('\n\n');

  // Combine system prompt + user message into a single prompt for --print mode
  return [systemPrompt, '', '---', '', userMessage].join('\n');
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

  const { formulaEstimate = {} } = input;
  const fullPrompt = buildPrompt(input);

  // ── Call provider-agnostic prompt runner ──────────────────────────────────
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const t0 = Date.now();
  const cliArgs = ['--provider', AI_PROVIDER];
  const result = spawnSync(
    AI_RUNNER_CMD,
    cliArgs,
    { input: fullPrompt, encoding: 'utf8', timeout: TIMEOUT_MS, env }
  );
  const latencyMs = Date.now() - t0;

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

main().catch(e => {
  process.stderr.write(`FATAL: ${e.message}\n`);
  process.exit(1);
});
