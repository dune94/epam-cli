// ─────────────────────────────────────────────────────────────────────────────
// cost-emitter.js — shared cost_snapshot emission for JS-side pipeline agents.
//
// WHY (measured live, AMSD-1820 2026-07-24): `cost_snapshot` events were emitted
// ONLY from bash (claude.sh, run-agent-orchestration.sh, team-lead-review.sh,
// lib/tc-writer-gate.sh). `spec-mode-runner.js` emitted none, so every agent it
// drives — code-graph-detective, openspec, speckit, spec-coordinator, VC reviewer,
// PRD change reviewer — was invisible to cost tracking:
//
//     agent-activity cost_snapshots : $0.1115
//     REAL billed (OpenRouter)      : $0.3480    <- ~68% of spend invisible
//     Langfuse: 97 calls / 649,164 input tokens  vs  4 cost_snapshot events
//
// The plumbing already existed and was simply unused: ai-run.sh writes the
// normalized result JSON to $ORCH_JSON_RESULT whenever that variable is set.
// This module parses that file and emits an event in exactly the shape the bash
// side already writes, so both producers land in one uniform stream.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');

/**
 * Parse the normalized result JSON written by ai-run.sh.
 * Field names vary by provider, so accept the known aliases.
 *
 * @returns {{costUsd:number, tokensIn:number, tokensOut:number, costUnknown:boolean}|null}
 */
function parseCostRecord(text) {
  if (!text || typeof text !== 'string' || !text.trim()) return null;
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object') return null;

  const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);
  const costUsd = num(j.total_cost_usd ?? j.cost_usd ?? j.cost ?? (j.part && j.part.cost));
  const tokensIn = num(
    (j.usage && (j.usage.input_tokens ?? j.usage.input)) ??
    (j.tokens && j.tokens.input) ?? 0);
  const tokensOut = num(
    (j.usage && (j.usage.output_tokens ?? j.usage.output)) ??
    (j.tokens && j.tokens.output) ?? 0);

  // A model absent from the provider's/tracker's price table reports cost 0 while
  // really consuming tokens — live: moonshotai/kimi-k3, 34,511 in / 3,088 out /
  // $0.0000. Recording that as free under-reports exactly on the TOP ladder rung,
  // which is only reached when a story is already burning money. Flag it so a
  // dashboard can show "unknown", never a confident $0.00.
  const costUnknown = costUsd === 0 && (tokensIn > 0 || tokensOut > 0);

  return { costUsd, tokensIn, tokensOut, costUnknown };
}

/** Build a cost_snapshot event identical in shape to the bash emitter's. */
function buildCostSnapshot({ agent, storyId, phase, model, provider, cost, turns = 1, source = 'spec-mode-runner' }) {
  const ts = new Date().toISOString();
  return {
    event_id: 'evt-cost-' + ts.replace(/[^0-9]/g, '') + '-' + Math.floor(Math.random() * 1e6),
    timestamp: ts,
    agent: agent || null,
    story_id: storyId ? storyId : null,
    phase: phase ? phase : null,
    type: 'cost_snapshot',
    model: model ? model : null,
    provider: provider ? provider : null,
    detail: {
      costUsd: cost.costUsd,
      tokensIn: cost.tokensIn,
      tokensOut: cost.tokensOut,
      costUnknown: !!cost.costUnknown,
      turns,
      source,
    },
  };
}

/**
 * Read $ORCH_JSON_RESULT-style file and append a cost_snapshot to the activity log.
 * Best-effort: never throws, never blocks the caller.
 * @returns {object|null} the emitted event, or null if there was nothing to emit.
 */
function emitCostSnapshot({ resultFile, activityFile, agent, storyId, phase, model, provider, turns }) {
  try {
    if (!resultFile || !activityFile) return null;
    let raw = '';
    try { raw = fs.readFileSync(resultFile, 'utf8'); } catch { return null; }
    const cost = parseCostRecord(raw);
    if (!cost) return null;
    // Nothing happened at all — don't clutter the timeline with empty records.
    if (!cost.costUsd && !cost.tokensIn && !cost.tokensOut) return null;
    const evt = buildCostSnapshot({ agent, storyId, phase, model, provider, cost, turns });
    fs.appendFileSync(activityFile, JSON.stringify(evt) + '\n');
    return evt;
  } catch {
    return null;
  }
}

module.exports = { parseCostRecord, buildCostSnapshot, emitCostSnapshot };
