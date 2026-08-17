/**
 * A MALFORMED ANSWER IS NOT A DEAD RUN.
 *
 * Ladder access is universal here, and so is TRANSPORT retry: ai-run.sh retries a FAILED call up
 * to EPAM_CALL_MAX_ATTEMPTS with ladder escalation between attempts. Neither covers the case that
 * actually kills runs — the call SUCCEEDS, the model answers, the response arrives intact, and the
 * CONTENT is wrong. Four sites parsed that answer once and threw:
 *
 *   codeline-discovery.js  'discovery-vocabulary-agent returned no tagged JSON'
 *   codeline-discovery.js  'discovery-vocabulary-agent returned an empty blacklist'
 *   cpa-inference.js       'No valid JSON object found in response'
 *   ac-gate.js             'No JSON in <what> response'
 *
 * Live 2026-08-17: runs 20260817T165956Z and 20260817T174348Z both died at the first of these —
 * roughly two runs in three, each after a four-minute call, before any work began.
 *
 * The mint already solves this and has for weeks: a proposal that violates the contract is refused
 * WITH THE REASON, the reason is fed back into the prompt, and the model re-proposes. That is why
 * the empty-rationale case corrected itself on attempt 2 rather than ending the run. This is that
 * mechanism, extracted so every parse site inherits it instead of each one being patched.
 *
 * IT KEEPS THE EVIDENCE. `throw new Error('returned no tagged JSON')` discarded the response, so a
 * truncated answer, a well-formed answer with no tag, and an empty answer were indistinguishable —
 * three causes, one useless message, and every diagnosis blind. The final error carries the length
 * and the answer itself, because the cheapest fix is the one that does not need another run.
 *
 * SYNCHRONOUS BY DESIGN: every current caller drives a synchronous execSync/spawnSync path. An
 * async variant can be added when a caller needs one; inventing it now would be untested surface.
 *
 * @param {object}   o
 * @param {Function} o.call     (correctionNote) => raw text. The note is '' on the first attempt.
 * @param {Function} o.parse    (raw) => {ok:true, value} | {ok:false, reason}
 * @param {number}   [o.attempts=3]
 * @param {string}   o.what     what is being parsed, named in every message
 * @param {Function} [o.log]
 * @returns the parsed value
 */
'use strict';

function retryUntilParsed({ call, parse, attempts = 3, what = 'response', log = () => {} }) {
  const budget = Math.max(1, Number(attempts) || 1);
  let raw = '';
  let reason = '';

  for (let attempt = 1; attempt <= budget; attempt += 1) {
    // THE RETRY MUST BE TOLD WHY, AND WHAT IT SENT. Re-sending an identical instruction gets an
    // identical answer; the refusal is the only new information the next attempt has, and quoting
    // the previous answer back is what lets the model see WHICH part was rejected.
    const note = attempt === 1 ? '' : [
      `YOUR PREVIOUS ANSWER WAS REJECTED: ${reason}`,
      '',
      'This is what you sent, and it could not be used:',
      '---',
      String(raw).slice(0, 2000),
      '---',
      'Answer again in exactly the format requested. Change nothing else.',
      '',
    ].join('\n');

    raw = call(note);
    const verdict = parse(raw) || { ok: false, reason: 'the parser returned nothing' };
    if (verdict.ok) {
      if (attempt > 1) log(`[content-retry] ${what}: recovered on attempt ${attempt}`);
      return verdict.value;
    }
    reason = verdict.reason || 'unusable';
    log(`[content-retry] ${what}: attempt ${attempt}/${budget} rejected — ${reason}`);
  }

  // EMPTY AND MALFORMED ARE DIFFERENT FAILURES and must not report identically: one is a transport
  // or budget problem, the other a contract problem, and they are fixed in different places.
  const text = String(raw == null ? '' : raw);
  const shape = text.trim().length === 0
    ? 'the answer was EMPTY (no text at all — a transport or budget failure, not a format one)'
    : `the answer was ${text.length} characters long and did not parse`;

  throw new Error(
    `${what}: gave up after ${budget} attempt(s). ${shape}. Last rejection: ${reason}.\n`
    + `--- what it actually returned (first 2000 chars) ---\n${text.slice(0, 2000)}\n---`);
}

module.exports = { retryUntilParsed };
