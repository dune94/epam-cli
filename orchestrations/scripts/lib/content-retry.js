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

/**
 * The correction a retry carries. Empty on the first attempt — nothing to correct yet.
 *
 * THE WORDS ARE IN THE TEMPLATE LAYER, not here. This is text sent to a model, and every other
 * instruction an agent receives is reviewable as prose in orchestrations/prompts/templates. A
 * template literal in a shared library is prompt text nobody auditing the prompts would ever see.
 *
 * Falls back to nothing rather than to an engine-authored sentence: if the template cannot be
 * rendered, the retry still happens and simply carries no correction, which is the old behaviour
 * and not a silent substitution of words from the wrong layer.
 */
function _correctionNote(attempt, reason, raw) {
  if (attempt === 1) return '';
  try {
    const { renderEngineTemplate } = require('./engine-prompt.js');
    return renderEngineTemplate('content-retry-correction', {
      __REASON__: reason,
      __PREVIOUS_ANSWER__: _text(raw).slice(0, 2000),
    });
  } catch {
    return '';
  }
}

/** Whatever the caller returned, as text — a parsed object is still evidence worth showing. */
function _text(raw) {
  if (raw == null) return '';
  return typeof raw === 'string' ? raw : (() => {
    try { return JSON.stringify(raw); } catch { return String(raw); }
  })();
}

/**
 * EMPTY AND MALFORMED ARE DIFFERENT FAILURES and must not report identically: one is a transport
 * or budget problem, the other a contract problem, and they are fixed in different places.
 */
/**
 * THE REPLY THAT FAILED IS THE ONLY EVIDENCE OF WHY — so it is written whole.
 *
 * The give-up message carries the first 2000 characters and the rest was discarded. On 2026-08-29
 * the agent-mint rejected `[{"proposedAgents":[...]}]` three times; a fix to unwrap that envelope
 * was written and committed, the next paid run failed identically, and whether the array held ONE
 * element (the fix should have fired) or several (it correctly refuses) could not be established
 * because nothing kept the reply. The next step had to be a guess — and guessing is what made the
 * two fixes before it wrong.
 */
function _persistRejected(logDir, what, text) {
  if (!logDir || !text) return '';
  try {
    const fs = require('fs');
    const path = require('path');
    const slug = String(what).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(logDir, `rejected-${slug}-${stamp}.txt`);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  } catch {
    return '';
  }
}

function _giveUpMessage(what, budget, raw, reason, logDir) {
  const text = _text(raw);
  const shape = text.trim().length === 0
    ? 'the answer was EMPTY (no text at all — a transport or budget failure, not a format one)'
    : `the answer was ${text.length} characters long and did not parse`;
  const kept = _persistRejected(logDir, what, text);
  return `${what}: gave up after ${budget} attempt(s). ${shape}. Last rejection: ${reason}.\n`
    + `--- what it actually returned (first 2000 chars) ---\n${text.slice(0, 2000)}\n---`
    + (kept ? `\n--- the FULL reply is kept at ${kept} ---` : '');
}

function retryUntilParsed({ call, parse, attempts = 3, what = 'response', log = () => {}, logDir = '' }) {
  const budget = Math.max(1, Number(attempts) || 1);
  let raw = '';
  let reason = '';

  for (let attempt = 1; attempt <= budget; attempt += 1) {
    // THE ATTEMPT TRAVELS WITH THE CALL, so a caller can climb its ladder.
    //
    // This passed only the correction note, so every caller re-invoked the SAME model and the
    // retry was the same coin flipped again. Live 2026-08-27: prompt-builder refused a template
    // three times, attempts 1 and 2 dropping the identical placeholders, and the run died with
    // two stronger rungs unused. Telling a model what it got wrong is half a retry; the other
    // half is asking a model that can do better.
    //
    // The rung is the CALLER'S decision — only it knows which seam it speaks for — so this
    // hands over the attempt number and nothing else.
    // A CALL THAT THREW IS AN ATTEMPT, NOT THE END OF THE RUN.
    //
    // Live 2026-08-27, run 20260827T143143Z: the discovery agent wrapped its JSON in markdown
    // fences, callLlm ran JSON.parse on it, threw, and the exception escaped this loop and
    // killed the process — on attempt ONE of three, at the most ordinary failure a model has.
    // The run then reported "codeline scope could not be resolved", naming the consequence
    // and not the cause.
    //
    // A throw costs one attempt and is fed back like any other refusal. Nothing here knows
    // about JSON: whatever the reason, the loop exists for an answer that came back unusable.
    try {
      raw = call(_correctionNote(attempt, reason, raw), attempt);
    } catch (e) {
      raw = '';
      reason = `the call itself failed: ${(e && e.message) || e}`;
      log(`[content-retry] ${what}: attempt ${attempt}/${budget} CALL FAILED — ${reason}`);
      continue;
    }
    const verdict = parse(raw) || { ok: false, reason: 'the parser returned nothing' };
    if (verdict.ok) {
      if (attempt > 1) log(`[content-retry] ${what}: recovered on attempt ${attempt}`);
      return verdict.value;
    }
    reason = verdict.reason || 'unusable';
    log(`[content-retry] ${what}: attempt ${attempt}/${budget} rejected — ${reason}`);
    // EVERY AGENT REACHES THE ANALYST, AND IT IS SENT WHAT CAME BACK.
    //
    // A refusal was fed back to the model and nothing else happened: the episode was never
    // recorded and no constraint was ever synthesised from it. agent-attempt-analyst.sh has
    // existed for that since it was written and had ONE caller out of forty seams.
    //
    // `raw` is the point — the bytes the agent actually produced. A reason string says which
    // rule was broken; only the output says why the agent broke it.
    try {
      // eslint-disable-next-line global-require
      const _sh = require('./self-heal.js').selfHeal({
        agent: what, reason, output: raw, context: _correctionNote(attempt, reason, raw),
        model: process.env.EPAM_MODEL || '', provider: process.env.AI_PROVIDER || '',
        projectConfigDir: process.env.EPAM_PROJECT_CONFIG_DIR || '',
      });
      if (_sh.rc === 2) {
        // Reported, never inferred: the next attempt runs with no corrective guidance.
        log(`[content-retry] ${what}: self-heal analyst FAILED — attempt ${attempt + 1} has no corrective`);
      }
    } catch { /* a diagnostic must never fail the run it is diagnosing */ }
  }

  throw new Error(_giveUpMessage(what, budget, raw, reason, logDir));
}

/**
 * The async twin, for callers whose model call returns a promise — which is every spec-mode agent.
 *
 * It exists because the synchronous version silently "works" on an async caller: `parse` receives
 * a Promise, which is non-null and therefore looks like an answer, so the retry never fires and
 * the caller accepts an object that is not the response. Caught before shipping while wiring the
 * mint; a sync retry there would have been worse than no retry at all.
 *
 * Deliberately a separate function rather than a sync/async hybrid: a function that sometimes
 * returns a promise is a bug waiting for the one caller that forgets to await it.
 */
async function retryUntilParsedAsync({ call, parse, attempts = 3, what = 'response', log = () => {}, logDir = '' }) {
  const budget = Math.max(1, Number(attempts) || 1);
  let raw = '';
  let reason = '';

  for (let attempt = 1; attempt <= budget; attempt += 1) {
    // THE ATTEMPT TRAVELS WITH THE CALL, so a caller can climb its ladder.
    //
    // This passed only the correction note, so every caller re-invoked the SAME model and the
    // retry was the same coin flipped again. Live 2026-08-27: prompt-builder refused a template
    // three times, attempts 1 and 2 dropping the identical placeholders, and the run died with
    // two stronger rungs unused. Telling a model what it got wrong is half a retry; the other
    // half is asking a model that can do better.
    //
    // The rung is the CALLER'S decision — only it knows which seam it speaks for — so this
    // hands over the attempt number and nothing else.
    // Same guard as the sync twin: a throwing call costs one attempt, never the run.
    try {
      raw = await call(_correctionNote(attempt, reason, raw), attempt);
    } catch (e) {
      raw = '';
      reason = `the call itself failed: ${(e && e.message) || e}`;
      log(`[content-retry] ${what}: attempt ${attempt}/${budget} CALL FAILED — ${reason}`);
      continue;
    }
    const verdict = parse(raw) || { ok: false, reason: 'the parser returned nothing' };
    if (verdict.ok) {
      if (attempt > 1) log(`[content-retry] ${what}: recovered on attempt ${attempt}`);
      return verdict.value;
    }
    reason = verdict.reason || 'unusable';
    log(`[content-retry] ${what}: attempt ${attempt}/${budget} rejected — ${reason}`);
    // EVERY AGENT REACHES THE ANALYST, AND IT IS SENT WHAT CAME BACK.
    //
    // A refusal was fed back to the model and nothing else happened: the episode was never
    // recorded and no constraint was ever synthesised from it. agent-attempt-analyst.sh has
    // existed for that since it was written and had ONE caller out of forty seams.
    //
    // `raw` is the point — the bytes the agent actually produced. A reason string says which
    // rule was broken; only the output says why the agent broke it.
    try {
      // eslint-disable-next-line global-require
      const _sh = require('./self-heal.js').selfHeal({
        agent: what, reason, output: raw, context: _correctionNote(attempt, reason, raw),
        model: process.env.EPAM_MODEL || '', provider: process.env.AI_PROVIDER || '',
        projectConfigDir: process.env.EPAM_PROJECT_CONFIG_DIR || '',
      });
      if (_sh.rc === 2) {
        // Reported, never inferred: the next attempt runs with no corrective guidance.
        log(`[content-retry] ${what}: self-heal analyst FAILED — attempt ${attempt + 1} has no corrective`);
      }
    } catch { /* a diagnostic must never fail the run it is diagnosing */ }
  }
  throw new Error(_giveUpMessage(what, budget, raw, reason, logDir));
}

module.exports = { retryUntilParsed, retryUntilParsedAsync };
