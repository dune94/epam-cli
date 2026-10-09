'use strict';
/**
 * A GITHUB COPILOT CLI CALL, JUDGED BY WHAT IT SAID — and written in the claude runner's result shape.
 *
 * `copilot --output-format json` streams JSONL events (user.message, assistant.message{content,
 * outputTokens}, session.error{message,statusCode}, result{exitCode, usage.premiumRequests}). Its process
 * exit code is not a verdict: an unknown model, an unsupported reasoning effort and a provider 402 all exit
 * 0 (spike, 2026-09-27). The verdict is read from the events and the CLI's stderr, and written as
 *   {type:"result", is_error, result, stop_reason, usage:{input_tokens, output_tokens}, total_cost_usd,
 *    premium_requests, num_turns, model, error?:{class, statusCode, message}}
 * — the shape `claude --print --output-format json` produces, so every consumer of a result (cost ledger,
 * failure classification, retry, self-heal) reads a copilot call the way it reads a claude one.
 * error.class names what the attempt's handler should do, read from the call's structured cause only
 * (classify below). One class is this plugin's reading of the call's shape: invocation — the CLI
 * refused on stderr before any session event (the call itself was malformed); its words are kept as
 * the message, never read for the class.
 *
 * CLI: node copilot-result.js <events.jsonl> <stderr.txt> <out.json> [<COPILOT_HOME/session-state>]
 *   stdout: the answer text; exit 0 when the call answered, 1 when it failed (the reason on stderr).
 */
const fs = require('fs');

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

const { failureClass } = require('../failure-class');

/**
 * The class of a session.error, from its structured fields only (statusCode, errorType, errorCode)
 * through config/failure-classes.json and this plugin's failures.json — never its message.
 */
const classify = (data) => failureClass(__dirname, { status: data && data.statusCode, fields: data || {} });

/**
 * THIS CALL'S USAGE, FROM ITS OWN SESSION RECORD. Up to 1.0.18 the CLI put outputTokens on each
 * assistant.message it streamed; 1.0.85 streams none, and records usage only in the session it wrote
 * under $COPILOT_HOME/session-state/<id>/events.jsonl — the `session.shutdown` event's modelMetrics.
 * The session is found by an event id this call's own stdout carried (user.message is written to
 * both), never by "the newest one", so parallel calls sharing a home cannot read each other's usage.
 */
function sessionUsage(events, sessionStateDir) {
  if (!sessionStateDir) return null;
  const ids = new Set(events.filter((e) => e.type === 'user.message' && e.id).map((e) => e.id));
  if (!ids.size) return null;
  let dirs = [];
  try { dirs = fs.readdirSync(sessionStateDir); } catch { return null; }
  for (const d of dirs) {
    const text = read(`${sessionStateDir}/${d}/events.jsonl`);
    if (!text || ![...ids].some((id) => text.includes(`"id":"${id}"`))) continue;
    let shutdown = null;
    for (const line of text.split('\n')) {
      if (!line.includes('"session.shutdown"')) continue;
      try { shutdown = JSON.parse(line); } catch { /* a torn line is not a record */ }
    }
    if (!shutdown) return null;
    const metrics = Object.values((shutdown.data && shutdown.data.modelMetrics) || {});
    const sum = (k) => metrics.reduce((n, m) => n + (Number(m.usage && m.usage[k]) || 0), 0);
    return { input_tokens: sum('inputTokens'), output_tokens: sum('outputTokens'),
      cache_read_input_tokens: sum('cacheReadTokens'), cache_creation_input_tokens: sum('cacheWriteTokens'),
      // WHAT IT COST: the session's billed usage in nano AI credits (live AMSD-2974 run 2, 2026-10-09: 116 calls
      // recorded $0 while this sat in every session's record). null when the record does not carry it.
      nano_aiu: Number.isFinite(Number(shutdown.data.totalNanoAiu)) ? Number(shutdown.data.totalNanoAiu) : null,
      premium_requests: Number(shutdown.data.totalPremiumRequests) || 0 };
  }
  return null;
}

/** The copilot set's declared credit price (config/provider-sets.json sets.copilot.billing). */
function billing() {
  try {
    const sets = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', '..', '..', 'config', 'provider-sets.json'), 'utf8'));
    const b = (sets.sets && sets.sets.copilot && sets.sets.copilot.billing) || {};
    return { usd: Number(b.usdPerAiCredit), nano: Number(b.nanoAiuPerCredit) };
  } catch { return { usd: NaN, nano: NaN }; }
}

/** The session's billed cost in dollars; 0 when it is not known. */
function billedUsd(fromSession) {
  if (!fromSession || fromSession.nano_aiu == null) return 0;
  const { usd, nano } = billing();
  if (!(usd > 0) || !(nano > 0)) return 0;
  return (fromSession.nano_aiu / nano) * usd;
}

function judgeCall(jsonlText, stderrText, sessionStateDir) {
  const events = [];
  for (const line of String(jsonlText || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* a non-JSON line is noise, not an event */ }
  }
  const messages = events.filter((e) => e.type === 'assistant.message');
  const errors = events.filter((e) => e.type === 'session.error');
  const resultEv = events.filter((e) => e.type === 'result').pop();
  const stderr = String(stderrText || '').trim();
  // The CLI's own complaint, for the MESSAGE only: the line it prefixed as an error, else its first.
  const stderrLines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const stderrError = stderrLines.find((l) => /^error\b/i.test(l)) || stderrLines[0] || '';
  const answer = messages.length ? String(messages[messages.length - 1].data && messages[messages.length - 1].data.content || '') : '';
  const outputTokens = messages.reduce((n, e) => n + (Number(e.data && e.data.outputTokens) || 0), 0);
  const fromSession = sessionUsage(events, sessionStateDir);
  const premium = Math.max(Number(resultEv && resultEv.usage && resultEv.usage.premiumRequests) || 0, fromSession ? fromSession.premium_requests : 0);
  const turns = events.filter((e) => e.type === 'assistant.turn_end').length || messages.length;

  let error = null;
  if (errors.length) {
    const e = errors[errors.length - 1].data || {};
    const code = Number(e.statusCode) || null;
    error = { class: classify(e), statusCode: code, message: String(e.message || 'session error') };
  } else if (!messages.length && stderrError) {
    error = { class: 'invocation', statusCode: null, message: stderrError.replace(/^error:\s*/i, '') };
  } else if (resultEv && Number(resultEv.exitCode) !== 0) {
    error = { class: 'provider', statusCode: null, message: `the CLI reported exit code ${resultEv.exitCode}` };
  } else if (!messages.length) {
    error = { class: 'provider', statusCode: null, message: stderr ? stderr.slice(0, 400) : 'the CLI produced no answer and said nothing' };
  }

  return {
    type: 'result',
    subtype: error ? 'error' : 'success',
    is_error: !!error,
    result: error ? '' : answer,
    stop_reason: error ? 'error' : 'end_turn',
    usage: fromSession
      ? { input_tokens: fromSession.input_tokens, output_tokens: Math.max(outputTokens, fromSession.output_tokens),
          cache_read_input_tokens: fromSession.cache_read_input_tokens, cache_creation_input_tokens: fromSession.cache_creation_input_tokens }
      : { input_tokens: 0, output_tokens: outputTokens },
    // Dollars from the billed credits, at the copilot set's declared rate; no record = unknown, never a confident $0.
    total_cost_usd: billedUsd(fromSession),
    ...(billedUsd(fromSession) > 0 || (fromSession && fromSession.nano_aiu === 0) ? { cost_is_estimate: false } : {}),
    premium_requests: premium,
    num_turns: turns,
    ...(error ? { error } : {}),
  };
}

module.exports = { judgeCall, classify, sessionUsage };

if (require.main === module) {
  const [jsonl, stderrFile, out, sessionStateDir] = process.argv.slice(2);
  const r = judgeCall(read(jsonl), read(stderrFile), sessionStateDir);
  if (out) fs.writeFileSync(out, JSON.stringify(r) + '\n');
  if (r.is_error) {
    process.stderr.write(`[copilot] call failed (${r.error.class}${r.error.statusCode ? ' ' + r.error.statusCode : ''}): ${r.error.message}\n`);
    process.exit(1);
  }
  process.stdout.write(r.result);
}
