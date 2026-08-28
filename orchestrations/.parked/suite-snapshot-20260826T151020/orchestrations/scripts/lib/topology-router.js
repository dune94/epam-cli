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
// No literal fallback: see lib/seam-model.js.
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
// RESOLVED LAZILY, NOT AT MODULE LOAD.
//
// This ran at module scope, and `topology-router` is not one of the declared seams — so
// resolveOrRefuse threw before main() existed to catch it. The module's own docblock
// promises a heuristic fallback when no model resolves; instead the process died with a
// stack trace, and the caller pre-set "heuristic" and swallowed it. The documented
// behaviour and the real behaviour disagreed, silently, in every run.
//
// Refusing is still correct — it must never substitute an unchosen model. It simply has to
// refuse where the fallback can see it.
function resolveModel() {
  return resolveOrRefuse({ seam: 'topology-router',
    sources: [seamLadderModel('topology-router'), process.env.EPAM_MODEL] });
}

// The tool schema that used to live here is gone with the SDK client. The hub returns JSON
// and the template states the shape, so a second copy of the contract here could only drift
// from it. The enum it carried — single | parallel | sequential — is stated in the template.

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

  // NO CREDENTIAL IS READ HERE, AND NO VENDOR IS NAMED HERE.
  //
  // This built its own @anthropic-ai/sdk client from ANTHROPIC_API_KEY, guarded by
  // `if (!apiKey) fall back to the heuristic`. The free-run scrub writes `sk-mock-not-real`
  // — which is TRUTHY — so the guard passed and the vendor was called anyway. Scrubbing
  // never bought silence, only a 401.
  //
  // The hub decides the vendor from the active provider set; this seam decides only WHAT to
  // ask. The old non-Anthropic provider check is gone with it: which stack serves the call
  // is the SET's decision, and asking here re-implemented one already made elsewhere.

  // Build prompt
  // THE DATA IS BUILT HERE; THE INSTRUCTIONS ARE NOT.
  //
  // The prompt was concatenated in this file, so it was invisible to the prompt layer: it
  // could not be reviewed, versioned, or provisioned per project. What remains here is the
  // ENVELOPE — the stories and the signals — which is data the seam already holds.
  const storyLines = stories.map(s =>
    `  - ${s.id}: effort=${s.effort || '?'}, role=${s.agentRole || '?'}, deps=[${(s.dependencies || []).join(',')}]`
  ).join('\n');

  const cpaLines = cpaSignals.length
    ? '\nCPA signals:\n' + cpaSignals.map(c =>
        `  - ${c.id}: filesExist=${c.filesExist ?? '?'}, estimatedTurns=${c.estimatedTurns ?? '?'}`
      ).join('\n')
    : '';

  try {
    const MODEL = resolveModel();
    const { renderEngineTemplate } = require('./engine-prompt.js');
    const { callLlmJson } = require('./llm-call.js');

    // Renders from THIS PROJECT's provisioned copy. If the project has no copy that is a
    // provisioning defect and it throws by name — the catch below degrades to the heuristic
    // rather than inventing a topology, which is the same contract as before.
    const prompt = renderEngineTemplate('topology-router', {
      __PHASE__: phase,
      __STORIES__: storyLines,
      __CPA_SIGNALS__: cpaLines,
    });
    // The hub is overridable so this seam is testable against a stub without ever reaching a
    // vendor — the same affordance codeline-discovery already relies on.
    const decision = await callLlmJson({
      seam: 'topology-router',
      prompt,
      model: MODEL,
      timeoutMs: TIMEOUT_MS,
      hubPath: process.env.EPAM_LLM_HUB || undefined,
    });

    if (!decision || !decision.topology) throw new Error('no topology in the hub response');
    const { topology, reason } = decision;
    process.stdout.write(JSON.stringify({ topology, reason, source: 'llm', model: MODEL }) + '\n');

  } catch (err) {
    // LLM path failed — fall back gracefully
    const fallback = heuristicTopology(stories);
    fallback.reason += ` (LLM fallback: ${err.message})`;
    process.stdout.write(JSON.stringify(fallback) + '\n');
  }
}

if (require.main === module) {
  main().catch(err => {
    process.stdout.write(JSON.stringify({ topology: 'parallel', reason: `Fatal: ${err.message}`, source: 'heuristic' }) + '\n');
  });
}

module.exports = { heuristicTopology };
