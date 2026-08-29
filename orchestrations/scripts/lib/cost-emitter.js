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
const path = require('path');

/**
 * Parse the normalized result JSON written by ai-run.sh.
 * Field names vary by provider, so accept the known aliases.
 *
 * THE TWO PRODUCERS SPELL THE TOKEN KEYS DIFFERENTLY, AND THIS READ ONLY ONE OF THEM.
 *
 * claude.sh's path (CLAUDE_CMD --output-format json) emits snake_case:
 *     { total_cost_usd, usage: { input_tokens, output_tokens } }
 * The epam CLI's path emits camelCase — buildRunResultJson in src/cli/commands/run.ts:
 *     { cost_usd, usage: { inputTokens, outputTokens, cached_input_tokens } }
 *
 * Only the snake_case spelling was read, so EVERY call through the epam provider recorded
 * tokensIn = tokensOut = 0. Two consequences, the second much worse than the first:
 *
 *   - token counts were flatly wrong wherever the epam path was used, which on this pipeline is
 *     every JS-side agent — detective, openspec, speckit, spec-coordinator, the reviewers, the
 *     prompt builder;
 *   - a call whose provider reports $0 (MiniMax-M3 and GLM both do) then parsed as ALL zeros,
 *     and emitCostSnapshot discards an all-zero record as "nothing happened". So the calls that
 *     most needed flagging vanished entirely, and costUnknown — the flag written precisely so a
 *     dashboard shows "unknown" rather than a confident $0.00 — could never fire on that path.
 *
 * The bash ledger writer already read both spellings ('.usage.input_tokens // .usage.inputTokens'
 * in claude.sh's append_cost_record). This is the JS side catching up to it, so both producers
 * are parsed by one rule rather than each knowing about half the aliases.
 *
 * @returns {{costUsd:number, tokensIn:number, tokensOut:number, tokensCached:number,
 *            costUnknown:boolean, costIsEstimate:boolean|null}|null}
 */
function parseCostRecord(text) {
  if (!text || typeof text !== 'string' || !text.trim()) return null;
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object') return null;

  const num = v => (typeof v === 'number' && isFinite(v) ? v : 0);
  const usage = (j.usage && typeof j.usage === 'object') ? j.usage : {};
  const tokens = (j.tokens && typeof j.tokens === 'object') ? j.tokens : {};

  // FIRST POSITIVE ALIAS, not first present one. `??` falls through on null/undefined only, so a
  // total_cost_usd that is present and ZERO used to outrank a real cost_usd sitting one field
  // along — and that zero was fabricated by ai-run.sh's merge rather than reported by anyone.
  // Live 2026-08-17 (evidence-anomaly-agent-mint.json): total_cost_usd 0 beat cost_usd 0.0164 and
  // every ledger row read $0, on the measurement the story budget guard sums to enforce a limit.
  // A zero-valued alias carries no information; all-zero still yields 0, a genuinely free call.
  const costUsd = [j.total_cost_usd, j.cost_usd, j.cost, j.part && j.part.cost]
    .map(num).find(v => v > 0) || 0;
  const tokensIn = num(
    usage.input_tokens ?? usage.inputTokens ?? usage.input ?? tokens.input ?? 0);
  const tokensOut = num(
    usage.output_tokens ?? usage.outputTokens ?? usage.output ?? tokens.output ?? 0);
  // Cached input is billed differently and is reported by both producers under its own name.
  // Recorded, never folded into tokensIn: the two have different prices, and a single number that
  // silently mixes them cannot be priced correctly afterwards.
  const tokensCached = num(
    usage.cached_input_tokens ?? usage.cachedInputTokens
    ?? usage.cache_read_input_tokens ?? 0);

  // CACHE CREATION IS BILLED, AND AT A PREMIUM. The argument the comment above makes for cache
  // READS applies here, and this was hardcoded to 0 at the emitter so the ledger could not see it
  // at all. A trivial "say ok" probe on 2026-08-26 reported cache_creation_input_tokens: 16827 —
  // creation dwarfing a nine-token prompt — while every row of that day's mock3 ledger recorded
  // cache_create_tokens: 0.
  //
  // Both TTL buckets are summed when the provider breaks them out: which bucket they land in
  // changes the price, not whether it was paid.
  const _cc = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null;
  const tokensCacheCreate = num(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens)
    || (_cc ? num(_cc.ephemeral_1h_input_tokens) + num(_cc.ephemeral_5m_input_tokens) : 0);

  // Says whether the number above is the provider's REAL billed cost or a local pricing-table
  // guess. Omitted by producers that do not distinguish the two, and null is not false — an
  // estimate presented as confirmed spend is the thing this field exists to prevent.
  const costIsEstimate = typeof j.cost_is_estimate === 'boolean' ? j.cost_is_estimate : null;

  // A model absent from the provider's/tracker's price table reports cost 0 while
  // really consuming tokens — live: moonshotai/kimi-k3, 34,511 in / 3,088 out /
  // $0.0000. Recording that as free under-reports exactly on the TOP ladder rung,
  // which is only reached when a story is already burning money. Flag it so a
  // dashboard can show "unknown", never a confident $0.00.
  const costUnknown = costUsd === 0
    && (tokensIn > 0 || tokensOut > 0 || tokensCached > 0 || tokensCacheCreate > 0);

  return { costUsd, tokensIn, tokensOut, tokensCached, tokensCacheCreate, costUnknown, costIsEstimate };
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
      tokensCached: cost.tokensCached || 0,
      tokensCacheCreate: cost.tokensCacheCreate || 0,
      costUnknown: !!cost.costUnknown,
      // null when the producer did not say. Kept distinct from false so "we know this is billed"
      // never gets confused with "nobody told us".
      costIsEstimate: cost.costIsEstimate === undefined ? null : cost.costIsEstimate,
      turns,
      source,
    },
  };
}

/**
 * Append one record to the COST LEDGER — phase-cost.jsonl.
 *
 * THE JS SIDE RECORDED ITS SPEND WHERE NOTHING READS IT.
 *
 * cost_snapshot events go to agent-activity.jsonl, which drives the activity timeline. But every
 * consumer of MONEY — the dashboard's cost panel, the run report, calibrate.py, the cost-variance
 * gate, the story-budget guard, check-phase-gate.sh — reads phase-cost.jsonl, and only claude.sh's
 * append_cost_record ever wrote to it. So a run whose spend is dominated by JS-side agents (the
 * mint, the roster reviewer, the prompt builder, the detective, the spec agents) recorded nothing
 * there and every one of those readers reported $0.00.
 *
 * That is exactly the shape lib/cost-ledger.sh exists to catch, and on mock3 it did: the ledger
 * really was empty while the run spent real money on 35 prompt generations and a full mint.
 *
 * This is NOT a second way of computing cost — the prohibition in cost-ledger.sh stands. It is the
 * same parsed record the activity event already carries, written to the ledger at the moment of
 * spend by the process that spent it. One measurement, two readers.
 *
 * Field names match append_cost_record's record exactly, so both producers land in one uniform
 * stream: a consumer must never need to know which side of the pipeline paid.
 */
function appendLedgerRecord({ ledgerFile, agent, storyId, phase, model, cost, turns, startedAt, endedAt, rung }) {
  try {
    if (!ledgerFile) return null;
    const now = new Date().toISOString();
    const started = startedAt || now;
    const ended = endedAt || now;
    const elapsedMin = Math.max(0,
      Math.round(((new Date(ended) - new Date(started)) / 60000) * 100) / 100) || 0;

    const rec = {
      // RUN-STAMPED. An unstamped record cannot be attributed to a run, and the budget guard that
      // reads this file filters by run precisely so one run is never charged for another's spend.
      run_id: process.env.ORCH_RUN_ID || '',
      phase_id: phase || null,
      phase_name: phase || null,
      // Agent work is not story work. story_id stays null rather than borrowing some nearby story,
      // and the agent's own name identifies it — a reader summing by story must not silently
      // attribute the mint's spend to whichever story happened to be in scope.
      story_id: storyId || null,
      story_title: '',
      agent_id: agent || 'unknown',
      agent_name: agent || 'unknown',
      forecast_hours: 0,
      forecast_cost_usd: 0,
      started_at: started,
      ended_at: ended,
      elapsed_minutes: elapsedMin,
      task_cost_usd: cost.costUsd,
      task_tokens_in: cost.tokensIn,
      task_tokens_out: cost.tokensOut,
      task_turns: turns || 1,
      cache_read_tokens: cost.tokensCached || 0,
      cache_create_tokens: cost.tokensCacheCreate || 0,
      // Distinguishable from a story's terminal states, so consumers filtering on
      // completed/failed are unaffected by these appearing in the same file.
      status: 'agent',
      notes: '',
      effort: '',
      storyType: 'agent',
      resolvedModel: model || '',
      plannerModel: '',
      prompt_tokens_measured: 0,
      invokeMode: 'spec-mode-runner',
      costIsEstimate: cost.costIsEstimate === undefined ? null : cost.costIsEstimate,
      // Recorded so a $0.00 from a provider with no price table stays visibly different from a
      // call that genuinely cost nothing — the same distinction costUnknown draws in the event.
      costUnknown: !!cost.costUnknown,
      // THE RUNG THIS CALL RAN ON. Hardcoded null, so an escalation left no trace: a seam that
      // climbed haiku -> sonnet -> opus recorded three rows that looked like three identical
      // calls, and "did the retry escalate?" was unanswerable from the ledger. Supplied by the
      // seam via EPAM_LADDER_RUNG; absent stays null rather than guessing rung 0.
      attempt: rung === undefined || rung === null || rung === '' ? null : Number(rung),
    };
    // One line, well under PIPE_BUF, opened O_APPEND: concurrent lanes interleave records rather
    // than corrupting them. Nothing here is free text, so the record cannot grow past that bound.
    fs.appendFileSync(ledgerFile, JSON.stringify(rec) + '\n');
    return rec;
  } catch {
    return null;
  }
}

/**
 * Read $ORCH_JSON_RESULT-style file and append a cost_snapshot to the activity log.
 * Best-effort: never throws, never blocks the caller.
 * @returns {object|null} the emitted event, or null if there was nothing to emit.
 */
/**
 * THE COMPLETION, OUT OF WHATEVER SHAPE THE RUNNER RETURNED IT IN.
 *
 * The cost seam already reads the provider's whole JSON to count tokens, so the reply has been in
 * that string all along while every trace recorded out=4ch. Runners shape the result differently,
 * exactly as they shape usage differently — which is why the token parser above already accepts
 * input_tokens, inputTokens and input. This reads text with the same tolerance, and returns empty
 * rather than inventing something when there is genuinely no text to find.
 */
function replyTextFrom(j) {
  if (!j || typeof j !== 'object') return '';
  if (typeof j.result === 'string' && j.result) return j.result;
  if (typeof j.completion === 'string' && j.completion) return j.completion;
  if (Array.isArray(j.content)) {
    const parts = j.content
      .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  if (Array.isArray(j.choices) && j.choices.length) {
    const m = j.choices[0] && j.choices[0].message;
    if (m && typeof m.content === 'string' && m.content) return m.content;
  }
  if (typeof j.text === 'string' && j.text) return j.text;
  return '';
}

function _parsedResult(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * THE PROMPT OF THE CALL IN FLIGHT, WHEREVER IT CAME FROM.
 *
 * A caller that already holds the prompt passes it and wins. Everything else reads the file the
 * invoker named in the environment — because most emitters never see a prompt at all, which is why
 * every trace recorded in=4ch and why wiring the one site that HAD a prompt changed nothing.
 *
 * Never throws, and returns empty rather than inventing a prompt: an uncaptured call must not look
 * like a call made with nothing.
 */
function promptForTrace(explicit, agent) {
  if (typeof explicit === 'string' && explicit) return explicit;
  try {
    // eslint-disable-next-line global-require
    const { PROMPT_FILE_ENV, promptFileForTag } = require('./agent-reply-log.js');
    // The environment first: same-process callers have it, and it is the freshest answer.
    let f = process.env[PROMPT_FILE_ENV] || '';
    if (!f && agent) {
      // ACROSS A PROCESS BOUNDARY, VIA THE SEAM'S OWN TAG. The shell edge emits from a sibling
      // process that never saw the variable — which is why the prompts were on disk and every
      // trace still read in=4ch. Which tag this agent writes under is DECLARED, not guessed:
      // the contract registry already says so, so no mapping is kept here.
      // eslint-disable-next-line global-require
      const { declaredContracts } = require('./agent-output-schema.js');
      const c = (declaredContracts() || {})[agent];
      if (c && c.tag) f = promptFileForTag(c.tag);
    }
    if (!f) {
      // SAY WHY THE FIELD IS EMPTY. A trace that silently records in=4ch is exactly the condition
      // this whole seam exists to end, so when the prompt cannot be found the reason is stated
      // once, on stderr, naming the agent — never swallowed.
      if (process.env.EPAM_TRACE_DEBUG) {
        process.stderr.write(`[trace] no prompt found for '${agent || '(no agent)'}'\n`);
      }
      return '';
    }
    return fs.readFileSync(f, 'utf8');
  } catch (e) {
    if (process.env.EPAM_TRACE_DEBUG) {
      process.stderr.write(`[trace] prompt lookup failed for '${agent || '(no agent)'}': ${e.message}\n`);
    }
    return '';
  }
}

function emitCostSnapshot({
  resultFile, activityFile, ledgerFile, agent, storyId, phase, model, provider, turns, startedAt, endedAt, rung,
  logDir,
  // The PROMPT, when the caller has it: the cost seam never sees the prompt, only the caller
  // that built it does, so it is offered here rather than guessed at downstream.
  input,
}) {
  try {
    if (!resultFile || !activityFile) return null;
    let raw = '';
    try { raw = fs.readFileSync(resultFile, 'utf8'); } catch { return null; }
    const cost = parseCostRecord(raw);
    if (!cost) return null;
    // Nothing happened at all — don't clutter the timeline with empty records. Cached tokens
    // count as something happening: a fully-cached call still consumed input and still bills.
    if (!cost.costUsd && !cost.tokensIn && !cost.tokensOut && !cost.tokensCached) return null;
    // AN UNEXPLAINED $0 KEEPS ITS EVIDENCE.
    //
    // costUnknown flags a zero cost alongside real tokens — a provider that did not price the
    // call, or a producer whose fields we are misreading. Either way the result file is unlinked
    // the moment it is read, so on 2026-08-17 ten records totalling 158,515 input tokens showed
    // $0.0000 and three separate attempts to explain it were blind: the record that caused it no
    // longer existed. Same evidence-destroying shape as an agent throwing away the answer it
    // could not parse.
    //
    // Written once per (agent, run) so a systematic failure leaves one file rather than hundreds.
    if (cost.costUnknown && logDir) {
      try {
        const stamp = `${process.env.ORCH_RUN_ID || 'norun'}-${agent || 'unknown'}`;
        const dump = path.join(logDir, `cost-anomaly-${stamp}.json`);
        if (!fs.existsSync(dump)) {
          fs.writeFileSync(dump, JSON.stringify({
            _what: 'A model call reported $0 while consuming tokens. This is the record it '
              + 'reported, kept because the source file is deleted immediately after it is read.',
            agent: agent || null,
            model: model || null,
            provider: provider || null,
            parsed: cost,
            raw: JSON.parse(raw),
          }, null, 2));
        }
      } catch { /* diagnostics must never break a call */ }
    }

    // OBSERVABILITY RIDES THE COST SEAM, because it is the one place every call already passes
    // with its model, tokens, cost and timing resolved. Tracing used to live in the TypeScript
    // provider decorator, which only the `epam` arm reaches — so a stack that executes a vendor
    // binary directly traced nothing. Emitted here, it covers every arm without naming one.
    // Fire-and-forget by contract: lib/langfuse-emit.js never throws and never fails a call.
    try {
      // eslint-disable-next-line global-require
      require('./langfuse-emit.js').emitGeneration({
        agent, storyId, phase, model, provider, turns, rung,
        startedAt, endedAt,
        // The words, not just the price. Read from the result this function already holds.
        output: replyTextFrom(_parsedResult(raw)),
        // And the prompt. The caller passes it when it has one; otherwise it is read from the
        // pointer the invoker left, which is the only channel that crosses to the shell edge.
        input: promptForTrace(input, agent),
        costUsd: cost.costUsd, tokensIn: cost.tokensIn, tokensOut: cost.tokensOut,
        cacheRead: cost.tokensCached, cacheCreate: cost.tokensCacheCreate,
        costIsEstimate: cost.costIsEstimate,
      });
    } catch { /* observability must never break the call it observes */ }

    const evt = buildCostSnapshot({ agent, storyId, phase, model, provider, cost, turns });
    fs.appendFileSync(activityFile, JSON.stringify(evt) + '\n');

    // The same measurement, to the file that every consumer of money actually reads. Resolved at
    // call time from LOG_DIR — never captured once — for the reason resolve_cost_ledger gives:
    // a lane that sets its own LOG_DIR must write to its own ledger.
    appendLedgerRecord({
      ledgerFile: ledgerFile || process.env.PHASE_COST_FILE
        || path.join(process.env.LOG_DIR || path.join(__dirname, '..', 'logs'), 'phase-cost.jsonl'),
      agent, storyId, phase, model, cost, turns, startedAt, rung,
    });
    return evt;
  } catch {
    return null;
  }
}

module.exports = {
  parseCostRecord, buildCostSnapshot, appendLedgerRecord, emitCostSnapshot,
  replyTextFrom,
  promptForTrace,
};
