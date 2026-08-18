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

  return { ok: true, reason: '' };
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
  };
}

module.exports = { checkGeneratedPrompt, buildGeneratedDoc, placeholdersIn };
