#!/usr/bin/env node
/**
 * THE CONTRACT A GENERATED PROJECT PROMPT MUST HONOUR.
 *
 * Templates are generic and immutable. The project-authority copy is generated from one and
 * is the ONLY thing prompt-library.js will render — there is no fallback to the template, by
 * operator mandate, because a silent degrade runs an engine-embedded default for a whole
 * campaign without anyone noticing.
 *
 * WHY THIS IS CODE AND NOT AN INSTRUCTION IN THE PROMPT. Rendering is strict in both
 * directions: every declared placeholder must appear in the body, every placeholder in the
 * body must be declared, and every one must be supplied at render time. A generator that
 * adds, drops or renames a single placeholder therefore produces a prompt that does not
 * degrade — it THROWS, mid-run, after the roster is minted and the run is already spending.
 * Asking a model nicely to preserve placeholders is not a guarantee; checking its output is.
 *
 * The check runs at GENERATION time so the failure names the generator, rather than surfacing
 * three stages later at whichever seam happened to need that prompt.
 */
'use strict';

const crypto = require('crypto');

// ONE DEFINITION, IMPORTED — not a second copy of the rule.
//
// This file carried its own placeholder regex, and it was the GREEDY version. engine-prompt.js
// was fixed to match lazily so that adjacent placeholders (__A____B__, which is what ${a}${b}
// becomes) read as two, and this copy was not — so the contract saw seven adjacent blocks as
// one token and refused every generated spec-agent-openspec as "dropping placeholders" the
// template required. Two copies of a rule is two rules.
const { placeholdersIn: _placeholdersIn } = require('./engine-prompt.js');

/** Placeholders present in a body, deduped and sorted. */
function placeholdersIn(body) {
  return [..._placeholdersIn(body)].sort();
}

const sorted = (a) => [...(Array.isArray(a) ? a : [])].sort();
const missingFrom = (want, have) => want.filter((p) => !have.includes(p));

/**
 * Is this generated prompt safe to install as the project authority?
 *
 * @param {{id:string, body:string, placeholders:string[]}} template  the generic source
 * @param {{id:string, body:string, placeholders:string[]}} generated the model's output
 * @returns {{ok:boolean, reason:string}}  reason NAMES the offending placeholders — a bare
 *          "invalid" leaves the operator diffing two prompts by eye.
 */
function checkGeneratedPrompt(template, generated) {
  if (!generated || typeof generated.body !== 'string' || !generated.body.trim()) {
    return { ok: false, reason: 'the generated prompt has an empty body — nothing would be sent' };
  }

  const tplWanted = sorted(template && template.placeholders);
  const genUsed = placeholdersIn(generated.body);
  const genDeclared = sorted(generated.placeholders);

  // 1. Every value the pipeline supplies must still have somewhere to land.
  const dropped = missingFrom(tplWanted, genUsed);
  if (dropped.length) {
    return {
      ok: false,
      reason: `the generated prompt dropped placeholder(s) the template requires: ${dropped.join(', ')}. `
        + 'The evidence they carry would silently never reach the agent.',
    };
  }

  // 2. Nothing may be invented: render supplies values by NAME, so an unknown placeholder is
  //    never substituted and prompt-library throws "still contains placeholders after rendering".
  const invented = missingFrom(genUsed, tplWanted);
  if (invented.length) {
    return {
      ok: false,
      reason: `the generated prompt invented placeholder(s) nothing supplies: ${invented.join(', ')}. `
        + 'Rendering would throw at the seam that needs this prompt.',
    };
  }

  // 3. The declaration must match the body, in both directions — prompt-library enforces this
  //    at render time, and catching it here names the generator instead of the seam.
  const undeclared = missingFrom(genUsed, genDeclared);
  if (undeclared.length) {
    return { ok: false, reason: `body uses undeclared placeholder(s): ${undeclared.join(', ')}` };
  }
  const orphan = missingFrom(genDeclared, genUsed);
  if (orphan.length) {
    return { ok: false, reason: `declares placeholder(s) it never uses: ${orphan.join(', ')}` };
  }

  // 4. THE OUTPUT CONTRACT MUST SURVIVE GENERATION.
  //
  // A generated prompt may specialise anything about HOW an agent works — this project's
  // codelines, its stack, its tools. It may not change what an ANSWER looks like, because the
  // consumer that reads the answer was not regenerated with it.
  //
  // Checked because two real generations shipped without it. prompt-review lost
  // <PROMPT_REVIEW>{"falseClaims": []}</PROMPT_REVIEW> while lib/prompt-review.js parses exactly
  // that tag, so the reviewer's answer could never be read. skill-assessment-prephase lost every
  // output key and came back half the length. Both are the run-8 shape: the agent obeys its
  // prompt and the engine reads something else, and nothing can say which side is wrong.
  //
  // ADDITIONS ARE FINE. Only a LOSS is refused: the consumer still reads what the template
  // promised, so dropping it is what breaks.
  const tplBody = String((template && template.body) || Object.values((template && template.bodies) || {}).join('\n') || '');
  const genBody = generated.body;

  // Response tags — <PROMPT_REVIEW>, <SPEC_AGENT> — are how a consumer finds the answer at all.
  // A RESPONSE TAG IS PAIRED. A VALUE PLACEHOLDER IS NOT.
  //
  // This took every <UPPERCASE> in the body. skill-assessment-prephase's instructions contain an
  // example JSONL record — {"timestamp":"<ISO8601>", ...} — where <ISO8601> is a TYPE placeholder
  // inside an illustration, not a marker any consumer looks for. The guard demanded the generated
  // prompt reproduce it verbatim, the generator legitimately rephrased the example, and mock3
  // run 9 exhausted all three attempts and failed the step after 29 prompts had succeeded.
  //
  // A tag a consumer parses always wraps something: <PROMPT_REVIEW>…</PROMPT_REVIEW>. Across all
  // 117 templates that separates them exactly — 4 paired (DISCOVERY_VOCABULARY, MODEL_REVIEW,
  // PROMPT_REVIEW, SPEC_REVIEW), 1 unpaired (ISO8601). So pairing is the discriminator, and it is
  // derived from the template rather than an exception list that would go stale.
  const tplTags = [...new Set(tplBody.match(/<[A-Z][A-Z0-9_]+>/g) || [])]
    .filter((t) => tplBody.includes(`</${t.slice(1, -1)}>`))
    .flatMap((t) => [t, `</${t.slice(1, -1)}>`]);
  const lostTags = tplTags.filter((t) => !genBody.includes(t));
  if (lostTags.length) {
    return {
      ok: false,
      reason: `the generated prompt dropped the output tag(s) the template states: ${lostTags.join(', ')}. `
        + 'The consumer looks for exactly that marker, so the answer would be unreadable however '
        + 'good it is.',
    };
  }

  // Field names the template states as part of its response shape.
  const tplKeys = outputFieldsIn(tplBody);
  const lostKeys = tplKeys.filter((k) => !genBody.includes(k));
  if (lostKeys.length) {
    return {
      ok: false,
      reason: `the generated prompt dropped output field(s) the template states: ${lostKeys.join(', ')}. `
        + 'The consumer still reads them, so the agent would answer a shape nothing accepts.',
    };
  }

  return { ok: true, reason: '' };
}

/**
 * THE RESPONSE-SHAPE FIELD NAMES A TEMPLATE STATES.
 *
 * Defined once and exported, because two places need the same answer: this contract check, which
 * REFUSES a generated prompt that lost a field, and the generator prompt, which must be TOLD the
 * fields so it can keep them. Judging an agent against a list it was never shown is how
 * skill-assessment-prephase came back missing timestamp, phase_id, agent_role, event,
 * skill_category, context and added_by — the generator prompt gave placeholders their own section
 * and an explicit list, and gave output fields one clause in the middle of a sentence.
 */
function outputFieldsIn(body) {
  return [...new Set((String(body == null ? '' : body).match(/"([a-zA-Z][a-zA-Z0-9_]*)"\s*:/g) || [])
    .map((m) => m.replace(/[":\s]/g, '')))];
}

/**
 * Assemble the document to write as the project authority.
 *
 * derivedFromSha256 is taken over the TEMPLATE, so a later run can tell whether the template
 * has moved on since this copy was generated. Without it, a project prompt generated from a
 * since-corrected template looks indistinguishable from a current one.
 */
function buildGeneratedDoc(template, generatedBody) {
  const body = String(generatedBody);
  return {
    $why: [
      `Generated from the ${template.id} template by the agent that minted this project's roster.`,
      'The template is never executed; this copy is. Placeholders were checked against the',
      'template before installation — see lib/project-prompt-contract.js.',
    ],
    authority: 'project',
    body,
    derivedFromSha256: crypto
      .createHash('sha256')
      .update(JSON.stringify({ id: template.id, body: template.body, placeholders: sorted(template.placeholders) }))
      .digest('hex'),
    derivedFromVersion: template.version == null ? null : template.version,
    id: template.id,
    // NO `seams` FIELD. It was a hand-maintained inverse index of something the registry already
    // declares — a seam names the template it runs — and the two copies drifted: run
    // 20260817T211517Z installed a copy claiming seams ["failure-analyst"] where its template says
    // ["impl-failure-analyst"], and the link failed after 37 prompts had provisioned. Worse, that
    // one template serves TWO seams and a single array cannot name both, so the relationship was
    // unrepresentable rather than merely mis-copied.
    //
    // prompt-agent-link now reads the registry directly, so nothing consumes this field. Writing
    // it anyway would only invite the drift back.
    placeholders: placeholdersIn(body),
    // THE DECLARATION TRAVELS WITH THE COPY THAT IS EXECUTED.
    //
    // mayBeEmpty says a placeholder may legitimately render blank — no prior gaps on a first pass,
    // no fix sites before discovery, no forced retry on attempt one. The TEMPLATE declared it and
    // this doc did not carry it, so every generated prompt lost the protection and the renderer
    // refused at runtime on a block that was supposed to be empty.
    //
    // Live 2026-08-27, run 20260827T125654Z: the pipeline reached the specification pass for the
    // first time and died there deterministically —
    //   prompt 'spec-agent-openspec' was given EMPTY values for: __DECLARED_FILE_BLOCK__,
    //   __FIX_SITE_BLOCK__, __FORCED_RETRY_BLOCK__, __PRIOR_GAPS_BLOCK__, …
    // Three retries changed nothing because no model was ever asked anything, and both lanes
    // halted. guard-vocabulary's template declared two and its generated copy carried none.
    //
    // FILTERED TO WHAT THIS BODY ACTUALLY HAS. A declaration naming a placeholder the generated
    // text does not contain protects nothing and would only mislead the next reader — the same
    // drift that removed the `seams` field above.
    mayBeEmpty: (Array.isArray(template.mayBeEmpty) ? template.mayBeEmpty : [])
      .filter((ph) => body.includes(ph)),
  };
}

module.exports = { checkGeneratedPrompt, buildGeneratedDoc, placeholdersIn, outputFieldsIn };
