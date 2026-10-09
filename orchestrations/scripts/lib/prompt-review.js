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

const fs = require('fs');

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
// THE SAME CLAIM, reworded or not: a strike on a later attempt matches an earlier one when one contains the other, or
// most of their words are shared. Only a REPEATED strike goes to the adjudicator.
function _claimKey(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9^@./_-]+/g, ' ').trim(); }
function _sameClaim(a, b) {
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const A = new Set(a.split(' ')); const B = new Set(b.split(' '));
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / Math.max(1, Math.min(A.size, B.size)) >= 0.7;
}

function makePromptReviewer({ render, invoke, values, logPathFor, warn, projectConfigDir, attempts = 2, recordVerdict, adjudicate }) {
  // What this reviewer has struck so far, per prompt: the second strike of the same claim is adjudicated.
  const _struck = new Map();
  const _warn = typeof warn === 'function' ? warn : (m) => process.stderr.write(`${m}\n`);
  return async function reviewPrompt({ id, template, generated }) {
    let prompt;
    try {
      prompt = render('prompt-review', projectConfigDir, values({ id, template, generated }));
    } catch (e) {
      // THE ONE FALLBACK THE MANDATE ALLOWS, AND ONLY THIS ONE.
      //
      // prompt-library's header is emphatic — operator 2026-08-11: "WE WILL NEVER EVER run the
      // template version of the prompts - NEVER. NEVER - no fallbacks." That rule is about AGENT
      // prompts: a generic template running unspecialised gives every project the same prompt.
      //
      // The reviewer's own prompt cannot obey it at bootstrap. Prompts are reviewed AS they are
      // generated and prompt-review.json is itself generated, so on a fresh project the first
      // prompts are judged by a reviewer whose project copy does not exist yet. Live 2026-09-08,
      // pipeline-tests-45: every early prompt installed UNREVIEWED while the run logged that
      // review was enabled — a gate failing open behind a log that claims cover.
      //
      // Operator, 2026-09-08: "If a project level prompt-review prompt is not available - then
      // defer to app level prompt." Kept as narrow as its reason: the REVIEWER'S OWN prompt, only
      // when genuinely absent, and announced — a template-sourced review must never be silently
      // indistinguishable from a project-authority one.
      //
      // ONE FAIL-OPEN EXIT, not two: whichever source failed, this ends at the single return
      // below. no-gate-reports-pass-when-it-could-not-run counts these paths, and a fix that adds
      // one while removing none is not a fix.
      let why = (e && e.message) || String(e);
      if (/project-authority prompt missing/i.test(why)) {
        try {
          // FROM THE TEMPLATE FILE DIRECTLY, on purpose: renderEngineTemplate refuses a
          // seam-declared prompt ("an agent executes it, so it renders from THIS PROJECT's copy"),
          // which is the very rule being excepted, so going through it restates the refusal.
          // eslint-disable-next-line global-require
          const ep = require('./engine-prompt.js');
          const tplDoc = JSON.parse(fs.readFileSync(ep.templatePathFor('prompt-review'), 'utf8'));
          const tplBody = tplDoc.body
            || Object.values(tplDoc.bodies || {}).filter((b) => typeof b === 'string').join('\n');
          // substituteOnce takes (body, keys, values); called with (body, values) it substituted nothing and the
          // bootstrap review judged the unfilled template text.
          const _vals = values({ id, template, generated });
          prompt = ep.substituteOnce(tplBody, Object.keys(_vals), _vals);
          _warn(`[prompt-review] ${id}: this project has no reviewer prompt yet — reviewing from `
            + 'the TEMPLATE for this bootstrap generation; the project copy takes over once minted');
        } catch (e2) {
          why = `the project copy is missing and the template would not render either: `
            + `${(e2 && e2.message) || String(e2)}`;
        }
      }
      if (typeof prompt !== 'string' || !prompt) {
        // The strict renderer refuses a values/placeholder mismatch. That is a defect in THIS
        // wiring, not in the artefact under review — say so loudly and install unreviewed.
        _warn(`[prompt-review] ${id}: could not build the reviewer's prompt (${why}) — installing UNREVIEWED`);
        return { reviewed: false, reason: `the reviewer's prompt could not be built: ${why}` };
      }
    }

    // The renderer returning nothing means the reviewer never had an artefact to judge.
    // Sending an empty prompt to the model buys a confident-looking verdict about nothing.
    if (typeof prompt !== 'string' || !prompt.trim()) {
      _warn(`[prompt-review] ${id}: rendered an empty prompt — installing UNREVIEWED`);
      return { reviewed: false, reason: 'the reviewer\'s prompt rendered empty' };
    }
    // A REVIEW THAT DID NOT ANSWER IS ASKED AGAIN. One unreadable reply used to install the prompt
    // UNREVIEWED at once — a single flake, and every agent inherited an unexamined brief (found
    // 2026-09-25 by the £0 mocking agent). The reviewer is retried, told what was wrong; only when
    // it never produces a verdict is the prompt installed — labelled unreviewed, never condemned,
    // because a reviewer's own failure is not evidence against the prompt.
    let verdict; let why = '';
    for (let attempt = 1; attempt <= attempts && verdict === undefined; attempt += 1) {
      const asked = why ? `${prompt}\n\nYOUR PREVIOUS ANSWER COULD NOT BE READ: ${why}. Emit the <PROMPT_REVIEW> block exactly as stated above.` : prompt;
      let out = '';
      try {
        out = await invoke(asked, typeof logPathFor === 'function' ? logPathFor(id) : undefined);
      } catch (e) {
        why = `the reviewer did not run (${e && e.message})`;
        continue;
      }
      const m = String(out || '').match(/<PROMPT_REVIEW>([\s\S]*?)<\/PROMPT_REVIEW>/);
      if (!m) { why = 'it held no <PROMPT_REVIEW> block'; continue; }
      try {
        verdict = JSON.parse(m[1].trim().replace(/^```(?:json)?/i, '').replace(/```$/, ''));
      } catch (e) {
        why = `the verdict was not valid JSON (${e && e.message})`;
      }
    }
    if (verdict === undefined) {
      _warn(`[prompt-review] ${id}: no verdict after ${attempts} attempt(s) — ${why} — installing UNREVIEWED`);
      return { reviewed: false, reason: why };
    }
    // EVERY VERDICT IS KEPT. The review log is rewritten per attempt, so a prompt that passed on its
    // fifth try left no record of why the first four were rejected (AMSD-2974 run 3, 2026-10-09).
    if (typeof recordVerdict === 'function') {
      try { recordVerdict({ id, at: new Date().toISOString(), verdict }); } catch { /* a record never fails the review */ }
    }
    // THE BUILDER IS TOLD WHAT THE REVIEWER FOUND, not only which claim it struck — without the evidence
    // it cannot tell a wrong fact from one that does not belong in a reusable prompt, and repeats it.
    // A CLAIM STRUCK TWICE IS SETTLED, NOT REPEATED. The reviewer is a model and strict on wording; a correct prompt
    // lost every attempt to strikes that did not hold, and the run ended (AMSD-2974 runs 3 and 4). A claim this
    // reviewer already struck for this prompt goes to the adjudicator — another agent, on another rung — which checks
    // that one claim in the repositories. Upheld: the strike is withdrawn. Otherwise, or with no ruling: it stands.
    let claims = Array.isArray(verdict.falseClaims) ? verdict.falseClaims : [];
    if (typeof adjudicate === 'function' && claims.length) {
      const seen = _struck.get(id) || []; _struck.set(id, seen);
      const kept = [];
      for (const c of claims) {
        const text = typeof c === 'string' ? c : (c && c.claim) || '';
        const key = _claimKey(text);
        const repeated = seen.some((k) => _sameClaim(k, key));
        seen.push(key);
        if (repeated && text) {
          let ruling = null; // the adjudicator's claim-ruling: { holds, evidence }
          try {
            ruling = await adjudicate({ id, claim: text, finding: (c && (c.found || c.finding || c.evidence)) || '' });
          } catch (e) { _warn(`[prompt-review] ${id}: the adjudicator did not run (${e && e.message}) — the strike stands`); }
          if (typeof recordVerdict === 'function') {
            try { recordVerdict({ id, at: new Date().toISOString(), adjudication: { claim: text, ruling } }); } catch { /* never fails the review */ }
          }
          if (ruling && ruling.holds === true) {
            _warn(`[prompt-review] ${id}: struck twice, UPHELD by the adjudicator — withdrawn: "${text.slice(0, 100)}" (${String(ruling.evidence || '').slice(0, 160)})`);
            continue;
          }
          _warn(`[prompt-review] ${id}: struck twice, and the adjudicator ${ruling ? 'agreed it is false' : 'gave no ruling'} — stands: "${text.slice(0, 100)}"`);
        }
        kept.push(c);
      }
      claims = kept;
    }
    const bad = claims.length
      ? claims.map((c) => {
        if (typeof c === 'string') return c;
        if (!c || !c.claim) return '';
        const said = c.found || c.correction || c.evidence || '';
        return said ? `${c.claim} — the reviewer found: ${said}` : c.claim;
      }).filter(Boolean)
      : [];
    if (bad.length) return { ok: false, reviewed: true, reason: bad.join('; ') };
    return { ok: true, reviewed: true };
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
