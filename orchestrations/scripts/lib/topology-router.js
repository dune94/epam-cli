#!/usr/bin/env node
/**
 * topology-router.js — LLM-based orchestration topology selector (GAP-P11)
 *
 * Reads story metadata from stdin (JSON), makes a single Haiku tool-call to
 * decide the execution topology, and prints a JSON decision to stdout.
 *
 * Falls back to the count heuristic if:
 *   - No ANTHROPIC_API_KEY / EPAM_API_KEY_ANTHROPIC is set
 *   - The API call fails or times out
 *   - The response doesn't match the expected tool schema
 *
 * Input (stdin, JSON):
 *   {
 *     phase: string,
 *     stories: [{ id, effort, storyType, agentRole, dependencies: [] }],
 *     cpaSignals: [{ id, filesExist, estimatedTurns }]   // optional
 *   }
 *
 * Output (stdout, JSON):
 *   { topology: "single"|"parallel"|"sequential", reason: string, source: "llm"|"heuristic" }
 *
 * Usage:
 *   echo '{"phase":"core","stories":[...]}' | node topology-router.js
 */
'use strict';

const TIMEOUT_MS = 12000;
const MODEL      = process.env.ORCH_GATE_MODEL || 'claude-haiku-4-5-20251001';

// ── Tool schema ──────────────────────────────────────────────────────────────
const TOPOLOGY_TOOL = {
  name: 'select_topology',
  description: 'Select the execution topology for this orchestration phase based on story metadata.',
  input_schema: {
    type: 'object',
    properties: {
      topology: {
        type: 'string',
        enum: ['single', 'parallel', 'sequential'],
        description:
          'single: one story or tightly coupled stories — run on main branch, no worktrees. ' +
          'parallel: independent stories — run in parallel worktrees. ' +
          'sequential: stories with shared file overlap or ordering risk — run sequentially on main.',
      },
      reason: {
        type: 'string',
        description: 'One sentence explaining the topology choice citing the key signal.',
      },
    },
    required: ['topology', 'reason'],
  },
};

// ── Heuristic fallback ────────────────────────────────────────────────────────
function heuristicTopology(stories) {
  const wt = stories.filter(s => !['review-agent', 'qa-engineer'].includes(s.agentRole));
  if (wt.length <= 1) return { topology: 'single',     reason: 'Count heuristic: ≤1 worktree story.', source: 'heuristic' };
  if (wt.length <= 4) return { topology: 'parallel',   reason: `Count heuristic: ${wt.length} stories → parallel worktrees.`, source: 'heuristic' };
  return                      { topology: 'sequential', reason: `Count heuristic: ${wt.length} stories → sequential (large set).`, source: 'heuristic' };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  let input;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    process.stdout.write(JSON.stringify({ topology: 'parallel', reason: 'No input — defaulting to parallel.', source: 'heuristic' }) + '\n');
    return;
  }

  const { phase = '', stories = [], cpaSignals = [] } = input;

  // Fast path: no API key
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.EPAM_API_KEY_ANTHROPIC;
  if (!apiKey) {
    process.stdout.write(JSON.stringify(heuristicTopology(stories)) + '\n');
    return;
  }

  // Build prompt
  const storyLines = stories.map(s =>
    `  - ${s.id}: effort=${s.effort || '?'}, role=${s.agentRole || '?'}, deps=[${(s.dependencies || []).join(',')}]`
  ).join('\n');

  const cpaLines = cpaSignals.length
    ? '\nCPA signals:\n' + cpaSignals.map(c =>
        `  - ${c.id}: filesExist=${c.filesExist ?? '?'}, estimatedTurns=${c.estimatedTurns ?? '?'}`
      ).join('\n')
    : '';

  const prompt =
    `You are selecting an execution topology for orchestration phase "${phase}".\n\n` +
    `Stories to classify:\n${storyLines}${cpaLines}\n\n` +
    `Rules:\n` +
    `- single: 0–1 worktree stories, OR high-effort story that needs focused attention\n` +
    `- parallel: 2–4 independent stories with no shared file scope\n` +
    `- sequential: stories with overlapping file scope, tight coupling, or shared state risk\n\n` +
    `Use the select_topology tool to return your decision.`;

  try {
    // Walk up from script location to find the repo root's node_modules
    const path = require('path');
    let sdkPath = null;
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'node_modules', '@anthropic-ai', 'sdk');
      if (require('fs').existsSync(candidate)) { sdkPath = candidate; break; }
      dir = path.dirname(dir);
    }
    if (!sdkPath) throw new Error('Cannot locate @anthropic-ai/sdk');
    const Anthropic = require(sdkPath);
    const client = new Anthropic.default({ apiKey, timeout: TIMEOUT_MS });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      tools: [TOPOLOGY_TOOL],
      tool_choice: { type: 'tool', name: 'select_topology' },
      messages: [{ role: 'user', content: prompt }],
    });

    const toolUse = response.content.find(b => b.type === 'tool_use' && b.name === 'select_topology');
    if (!toolUse || !toolUse.input || !toolUse.input.topology) throw new Error('No tool_use block');

    const { topology, reason } = toolUse.input;
    process.stdout.write(JSON.stringify({ topology, reason, source: 'llm', model: MODEL }) + '\n');

  } catch (err) {
    // LLM path failed — fall back gracefully
    const fallback = heuristicTopology(stories);
    fallback.reason += ` (LLM fallback: ${err.message})`;
    process.stdout.write(JSON.stringify(fallback) + '\n');
  }
}

main().catch(err => {
  process.stdout.write(JSON.stringify({ topology: 'parallel', reason: `Fatal: ${err.message}`, source: 'heuristic' }) + '\n');
});
