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
 * error.class names what the attempt's handler should do: credit (halt), rate_limit (retry later),
 * auth, invocation (the call itself was malformed), provider (anything else the service said).
 *
 * CLI: node copilot-result.js <events.jsonl> <stderr.txt> <out.json>
 *   stdout: the answer text; exit 0 when the call answered, 1 when it failed (the reason on stderr).
 */
const fs = require('fs');

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

function classify(statusCode, message) {
  const m = String(message || '').toLowerCase();
  if (statusCode === 402 || /insufficient (balance|quota|credit)|premium request|quota exceeded|out of credits|credit limit/.test(m)) return 'credit';
  if (statusCode === 429 || /rate limit|too many requests/.test(m)) return 'rate_limit';
  if (statusCode === 401 || statusCode === 403 || /unauthori[sz]ed|not authenticated|authentication|forbidden|no copilot access/.test(m)) return 'auth';
  if (/does not support reasoning effort|is not available|unknown option|invalid (value|option)|possible values/.test(m)) return 'invocation';
  return 'provider';
}

function judgeCall(jsonlText, stderrText) {
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
  const stderrError = stderr.split('\n').map((l) => l.trim()).find((l) => /^error\b/i.test(l)) || '';
  const answer = messages.length ? String(messages[messages.length - 1].data && messages[messages.length - 1].data.content || '') : '';
  const outputTokens = messages.reduce((n, e) => n + (Number(e.data && e.data.outputTokens) || 0), 0);
  const premium = Number(resultEv && resultEv.usage && resultEv.usage.premiumRequests) || 0;
  const turns = events.filter((e) => e.type === 'assistant.turn_end').length || messages.length;

  let error = null;
  if (errors.length) {
    const e = errors[errors.length - 1].data || {};
    const code = Number(e.statusCode) || null;
    error = { class: classify(code, e.message), statusCode: code, message: String(e.message || 'session error') };
  } else if (stderrError) {
    error = { class: classify(null, stderrError), statusCode: null, message: stderrError.replace(/^error:\s*/i, '') };
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
    usage: { input_tokens: 0, output_tokens: outputTokens },
    total_cost_usd: 0,
    premium_requests: premium,
    num_turns: turns,
    ...(error ? { error } : {}),
  };
}

module.exports = { judgeCall, classify };

if (require.main === module) {
  const [jsonl, stderrFile, out] = process.argv.slice(2);
  const r = judgeCall(read(jsonl), read(stderrFile));
  if (out) fs.writeFileSync(out, JSON.stringify(r) + '\n');
  if (r.is_error) {
    process.stderr.write(`[copilot] call failed (${r.error.class}${r.error.statusCode ? ' ' + r.error.statusCode : ''}): ${r.error.message}\n`);
    process.exit(1);
  }
  process.stdout.write(r.result);
}
