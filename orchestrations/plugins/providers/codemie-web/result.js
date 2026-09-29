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
 * error.class is read from the call's STRUCTURED cause only — the HTTP status, Node's system error
 * code, and CodeMie's AgentErrorDetails.error_code — through config/failure-classes.json and this
 * plugin's failures.json (../failure-class.js). Two classes are this plugin's own reading of the chat's
 * shape: empty (success with nothing in it — retry, then climb) and plugin (no answer, and a Plugin
 * tool failed). The failure's words are kept as its message and never read for its class.
 */
const { failureClass } = require('../failure-class');

const classify = (cause) => failureClass(__dirname, cause);

const text = (g) => (g == null ? '' : typeof g === 'string' ? g : JSON.stringify(g));

/** The result object for a chat response (`r`) or a thrown error (`err`). */
function judge({ r, err, model }) {
  let error = null;
  let answer = '';
  if (err) {
    const code = Number(err.statusCode) || null;
    const msg = `${err.message || err}${err.response ? ` ${JSON.stringify(err.response.error ?? err.response)}` : ''}`;
    error = { class: classify({ status: code, systemCode: err.code || (err.cause && err.cause.code) }), statusCode: code, message: msg.slice(0, 600) };
  } else {
    answer = text(r && r.generated);
    const toolErrors = (r && r.tool_errors) || [];
    if (r && r.agent_error) error = { class: classify({ fields: r.agent_error }), statusCode: null, message: JSON.stringify(r.agent_error).slice(0, 600) };
    else if (!answer.trim() && toolErrors.length) error = { class: 'plugin', statusCode: null, message: JSON.stringify(toolErrors).slice(0, 600) };
    else if (r && r.success === false) error = { class: classify({}), statusCode: null, message: 'CodeMie reported success=false' };
    else if (!answer.trim()) error = { class: 'empty', statusCode: null, message: 'CodeMie answered with nothing (success with an empty reply)' };
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
