'use strict';
/**
 * A CODEMIE WEB CHAT, JUDGED — and written in the claude runner's result shape.
 *
 * The chat returns {generated, success, agent_error, tool_errors, tokens_used, time_elapsed} or throws
 * an ApiError with a statusCode. Neither alone is a verdict: mx-tracker saw CodeMie answer
 * success=true with an EMPTY `generated` when a reply was dropped. So the verdict is read from all of
 * it and written as {type:"result", is_error, result, usage, error?:{class,...}} — the shape every
 * consumer of a result (cost ledger, failure classification, retry, self-heal) already reads.
 *
 * error.class: credit (402/budget/quota — halt, do not climb), auth (sign-in expired or refused),
 * rate_limit, transient (5xx/connection — retry), empty (success with nothing in it — retry, then
 * climb), plugin (a Plugin tool failed or the plugin was not connected), provider (anything else).
 */
function classify(statusCode, message) {
  const m = String(message || '').toLowerCase();
  if (statusCode === 402 || /insufficient|budget|quota|out of credits?|credit limit|max budget/.test(m)) return 'credit';
  if (statusCode === 401 || statusCode === 403 || /unauthori[sz]ed|authentication|sso|not signed in|login/.test(m)) return 'auth';
  if (statusCode === 429 || /rate limit|too many requests/.test(m)) return 'rate_limit';
  if ((statusCode && statusCode >= 500) || /econn|etimedout|socket hang up|network|timed out|502|503|504/.test(m)) return 'transient';
  if (/plugin|mcpbridge|nats/.test(m)) return 'plugin';
  return 'provider';
}

const text = (g) => (g == null ? '' : typeof g === 'string' ? g : JSON.stringify(g));

/** The result object for a chat response (`r`) or a thrown error (`err`). */
function judge({ r, err, model }) {
  let error = null;
  let answer = '';
  if (err) {
    const code = Number(err.statusCode) || null;
    const msg = `${err.message || err}${err.response ? ` ${JSON.stringify(err.response.error ?? err.response)}` : ''}`;
    error = { class: classify(code, msg), statusCode: code, message: msg.slice(0, 600) };
  } else {
    answer = text(r && r.generated);
    const toolErrors = (r && r.tool_errors) || [];
    if (r && r.agent_error) error = { class: classify(null, JSON.stringify(r.agent_error)), statusCode: null, message: JSON.stringify(r.agent_error).slice(0, 600) };
    else if (r && r.success === false) error = { class: 'provider', statusCode: null, message: 'CodeMie reported success=false' };
    else if (!answer.trim()) error = { class: 'empty', statusCode: null, message: 'CodeMie answered with nothing (success with an empty reply)' };
    else if (toolErrors.length && !answer.trim()) error = { class: 'plugin', statusCode: null, message: JSON.stringify(toolErrors).slice(0, 600) };
  }
  return {
    type: 'result', subtype: error ? 'error' : 'success', is_error: !!error,
    result: error ? '' : answer, stop_reason: error ? 'error' : 'end_turn',
    usage: { input_tokens: 0, output_tokens: Number(r && r.tokens_used) || 0 },
    total_cost_usd: 0, model: model || null, time_elapsed: (r && r.time_elapsed) || null,
    tool_errors: (r && r.tool_errors) || [],
    ...(error ? { error } : {}),
  };
}

module.exports = { judge, classify };
