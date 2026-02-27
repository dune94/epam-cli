#!/usr/bin/env node
/**
 * CPA Inference — calls Claude API with story context, returns structured review JSON.
 *
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
 *   EPAM_API_KEY_ANTHROPIC  — required
 *   CPA_MODEL               — optional, default claude-haiku-4-5-20251001
 *   CPA_MAX_TOKENS          — optional, default 1024
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── SDK resolution ─────────────────────────────────────────────────────────
// Script lives at orchestrations/scripts/lib/; project root is 3 levels up.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SDK_PATH     = path.join(PROJECT_ROOT, 'node_modules', '@anthropic-ai', 'sdk');

let Anthropic;
try {
  Anthropic = require(fs.existsSync(SDK_PATH) ? SDK_PATH : '@anthropic-ai/sdk');
} catch (e) {
  process.stderr.write(`ERROR: @anthropic-ai/sdk not found at ${SDK_PATH}\n`);
  process.stderr.write(`Install with: npm install (from ${PROJECT_ROOT})\n`);
  process.exit(1);
}

// ── Configuration ──────────────────────────────────────────────────────────
const API_KEY    = process.env.EPAM_API_KEY_ANTHROPIC || '';
const MODEL      = process.env.CPA_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TOKENS = parseInt(process.env.CPA_MAX_TOKENS || '1024', 10);

// ── Read stdin ─────────────────────────────────────────────────────────────
async function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

// ── Build user message ─────────────────────────────────────────────────────
function buildUserMessage(input) {
  const { story, kbChunks = [], codebaseSignals = {}, formulaEstimate = {}, adjacentStories = [] } = input;

  const storyJson = JSON.stringify({
    id:          story.id,
    title:       story.title,
    description: story.description,
    priority:    story.priority,
    storyType:   story.storyType,
    effort:      story.effort,
    humanHours:  story.humanHours || story.estimatedHours,
    dependencies: story.dependencies,
    acceptanceCriteria: story.acceptanceCriteria,
    technicalNotes: story.technicalNotes,
    agentRole:   story.agentRole,
  }, null, 2);

  const kbSection = kbChunks.length > 0
    ? `## Knowledge Base (${kbChunks.length} retrieved sources)\n\n` +
      kbChunks.map((c, i) =>
        `### Source ${i + 1}: \`${c.source}\` (relevance score: ${c.score})\n\`\`\`\n${c.chunk.slice(0, 800)}\n\`\`\``
      ).join('\n\n')
    : '## Knowledge Base\n_No matching KB sources found for this story\'s skills._';

  const codeSection = Object.keys(codebaseSignals).length > 0
    ? `## Codebase Signals\n\`\`\`json\n${JSON.stringify(codebaseSignals, null, 2)}\n\`\`\``
    : '## Codebase Signals\n_No existing source files found — story targets new code._';

  const adjSection = adjacentStories.length > 0
    ? `## Adjacent Stories in Phase\n` +
      adjacentStories.map(s =>
        `- **${s.id}**: ${s.title} | effort: ${s.effort} | status: ${s.status}`
      ).join('\n')
    : '';

  return [
    `## Story Under Review\n\`\`\`json\n${storyJson}\n\`\`\``,
    `## Formula Baseline Estimate\n\`\`\`json\n${JSON.stringify(formulaEstimate, null, 2)}\n\`\`\``,
    kbSection,
    codeSection,
    adjSection,
    '---',
    'Respond with ONLY the JSON object as specified in your system prompt. No prose, no markdown fences.',
  ].filter(Boolean).join('\n\n');
}

// ── JSON extraction ────────────────────────────────────────────────────────
function extractJSON(text) {
  // Try direct parse
  try { return JSON.parse(text.trim()); } catch {}

  // Strip code fences
  const fenced = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  try { return JSON.parse(fenced); } catch {}

  // Find first { … } block
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }

  throw new Error('No valid JSON found in response');
}

// ── Fallback review (when inference fails or API unavailable) ──────────────
function fallbackReview(formulaEstimate, reason) {
  return {
    confidence:          0.30,
    complexityAdjustment: 1.0,
    adjustedEstimate:    formulaEstimate,
    riskFlags:           [`CPA inference unavailable: ${reason}`],
    missingKbCoverage:   [],
    citedSources:        [],
    reasoning:           `Inference failed (${reason}). Formula estimate used as-is with uncertainty markup.`,
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

  const { formulaEstimate = {}, systemPrompt = '' } = input;

  // Graceful degradation when API key is missing — mark as skipped so gate defaults to pass
  if (!API_KEY) {
    const review = {
      confidence: 0.70,           // neutral: trust the formula, don't penalise missing key
      complexityAdjustment: 1.0,
      adjustedEstimate: formulaEstimate,
      riskFlags: [],
      missingKbCoverage: [],
      citedSources: [],
      reasoning: 'Inference skipped — EPAM_API_KEY_ANTHROPIC not set. Formula estimate used unchanged.',
      _inferenceSkipped: true,    // shell reads this to bypass confidence gate
      _metrics: { latencyMs: 0, tokensIn: 0, tokensOut: 0, tokenEfficiency: 0 },
    };
    process.stdout.write(JSON.stringify(review) + '\n');
    return;
  }

  const userMessage = buildUserMessage(input);
  const client      = new Anthropic({ apiKey: API_KEY });
  const t0          = Date.now();

  let response;
  try {
    response = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userMessage }],
    });
  } catch (e) {
    process.stderr.write(`WARN: API call failed for story: ${e.message}\n`);
    const review = fallbackReview(formulaEstimate, `API error: ${e.message}`);
    review._metrics = { latencyMs: Date.now() - t0, tokensIn: 0, tokensOut: 0, tokenEfficiency: 0 };
    process.stdout.write(JSON.stringify(review) + '\n');
    return;
  }

  const latencyMs = Date.now() - t0;
  const rawText   = response.content[0]?.text || '';
  const tokensIn  = response.usage?.input_tokens  || 0;
  const tokensOut = response.usage?.output_tokens || 0;

  let reviewData;
  try {
    reviewData = extractJSON(rawText);
  } catch (e) {
    process.stderr.write(`WARN: JSON parse failed: ${e.message}\nRaw: ${rawText.slice(0, 300)}\n`);
    reviewData = fallbackReview(formulaEstimate, `parse error: ${e.message}`);
  }

  // Validate and clamp required fields
  reviewData.confidence          = Math.max(0, Math.min(1, parseFloat(reviewData.confidence) || 0.3));
  reviewData.complexityAdjustment = Math.max(0.5, Math.min(2.5, parseFloat(reviewData.complexityAdjustment) || 1.0));

  // Enrich with inference metrics
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
