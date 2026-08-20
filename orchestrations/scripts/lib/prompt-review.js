// prompt-review — falsify what a generated prompt claims about this project, before any agent
// inherits it.
//
// WHY THIS IS A MODULE AND NOT A CLOSURE. It lived inline in mint-agents-step.js's call to
// buildProjectPrompts, where no test could reach it. That is not a detail: on 2026-08-18 the
// reviewer's ability to REJECT was disabled by hand and all 268 tests still passed, because
// nothing executed the body — it only asserted the shape around it. A component that fails open
// (see below) and is untestable by construction is a component that cannot be trusted to run.
//
// FAIL-OPEN IS DELIBERATE AND IS THE REASON THIS NEEDS TESTS. A reviewer that cannot run must not
// condemn the artefact — its own failure is not evidence the prompt is wrong, the same rule
// reviewSurvey follows. But that means every internal defect looks identical to approval, so each
// path below is exercised by test/unit/orchestration/the-prompt-reviewer-was-never-executed.test.ts
// and each announces itself rather than passing silently.
'use strict';

/**
 * Build the reviewPrompt callback buildProjectPrompts expects.
 *
 * Every dependency is injected so the whole path — render, invoke, parse, decide — is executable
 * in a test with a stubbed runner and no model call.
 *
 * @param {object}   deps
 * @param {Function} deps.render   (id, projectConfigDir, values) => string   the prompt library
 * @param {Function} deps.invoke   (prompt, logPath) => Promise<string>       the model runner
 * @param {Function} deps.values   ({id, template, generated}) => object      placeholder values
 * @param {Function} [deps.logPathFor] (id) => string
 * @param {Function} [deps.warn]   (msg) => void
 * @param {string}   [deps.projectConfigDir]
 * @returns {Function} async ({id, template, generated}) => {ok:boolean, reason?:string}
 */
function makePromptReviewer({ render, invoke, values, logPathFor, warn, projectConfigDir }) {
  const _warn = typeof warn === 'function' ? warn : (m) => process.stderr.write(`${m}\n`);
  return async function reviewPrompt({ id, template, generated }) {
    let prompt;
    try {
      prompt = render('prompt-review', projectConfigDir, values({ id, template, generated }));
    } catch (e) {
      // The strict renderer refuses a values/placeholder mismatch. That is a defect in THIS
      // wiring, not in the artefact under review — say so loudly and install unreviewed.
      _warn(`[prompt-review] ${id}: could not build the reviewer's prompt (${e && e.message}) — installing UNREVIEWED`);
      return { ok: true };
    }

    // The renderer returning nothing means the reviewer never had an artefact to judge.
    // Sending an empty prompt to the model buys a confident-looking verdict about nothing.
    if (typeof prompt !== 'string' || !prompt.trim()) {
      _warn(`[prompt-review] ${id}: rendered an empty prompt — installing UNREVIEWED`);
      return { ok: true };
    }
    let out = '';
    try {
      out = await invoke(prompt, typeof logPathFor === 'function' ? logPathFor(id) : undefined);
    } catch (e) {
      _warn(`[prompt-review] ${id}: reviewer did not run (${e && e.message}) — installing UNREVIEWED`);
      return { ok: true };
    }

    const m = String(out || '').match(/<PROMPT_REVIEW>([\s\S]*?)<\/PROMPT_REVIEW>/);
    if (!m) {
      _warn(`[prompt-review] ${id}: reviewer returned no parseable verdict — installing UNREVIEWED`);
      return { ok: true };
    }
    let verdict;
    try {
      verdict = JSON.parse(m[1].trim().replace(/^```(?:json)?/i, '').replace(/```$/, ''));
    } catch (e) {
      _warn(`[prompt-review] ${id}: verdict was not valid JSON (${e && e.message}) — installing UNREVIEWED`);
      return { ok: true };
    }
    const bad = Array.isArray(verdict.falseClaims)
      ? verdict.falseClaims.map((c) => (typeof c === 'string' ? c : (c && c.claim) || '')).filter(Boolean)
      : [];
    if (bad.length) return { ok: false, reason: bad.join('; ') };
    return { ok: true };
  };
}

/**
 * The render adapter the call site injects.
 *
 * It exists here rather than as a lambda in mint-agents-step.js because it is a SEAM, and the
 * lambda form shipped the wrong one: `render(id, dir, vals)` against a library whose signature is
 * `render(doc, values)`. That returns undefined without throwing, so every prompt rendered empty
 * and every review fell through to the fail-open path. `buildPrompt` is the load-then-render entry
 * point that takes an id. Living here, a test can execute the real adapter against the real
 * library instead of re-implementing it and agreeing with itself.
 */
function makePromptRenderer(promptsLib) {
  return (id, projectConfigDir, values) => promptsLib.buildPrompt(id, projectConfigDir, values);
}

module.exports = { makePromptReviewer, makePromptRenderer };
