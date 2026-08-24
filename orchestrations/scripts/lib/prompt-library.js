#!/usr/bin/env node
/**
 * THE PROMPT LIBRARY. Resolves and renders an agent's PROJECT-AUTHORITY prompt.
 *
 * Operator mandate, 2026-08-11, verbatim:
 *   "WE WILL NEVER EVER run the template version of the prompts - NEVER. NEVER - no
 *    fallbacks. Only project authority prompts - the self-health mechanism is the only
 *    process permitted to mutate project level prompts. You will keep each prompt in a
 *    separate file (json) and never hide prompts in code ever again."
 *
 * So, precisely:
 *   - The TEMPLATE (orchestrations/prompts/templates/<id>.json) is the immutable generic
 *     source a project prompt is MINTED FROM. It is NEVER executed.
 *   - The PROJECT prompt (<project-config-dir>/prompts/<id>.json) is the ONLY thing
 *     rendered and sent to a model.
 *   - A missing project prompt is a HARD FAILURE. It never degrades to the template,
 *     because a silent degrade is how an engine-embedded default runs for a whole
 *     campaign without anyone noticing.
 *
 * WHY THIS EXISTS AT ALL: the failure-analyst prompt lived as a 44-line shell heredoc in
 * claude.sh, generic, with no project-level variant — so the self-heal mechanism had
 * nothing to mutate, and the prompt could not be corrected without editing the engine.
 * Four more prompts are still embedded the same way (PROMPT_HEADER, PLAN_PROMPT_EOF,
 * MODRES_EOF, COORD_PROMPT); this module is the pattern they migrate to.
 *
 * RENDERING IS TOTAL AND STRICT. Every declared placeholder must be supplied, and every
 * placeholder appearing in the body must be declared. A prompt that reaches a model with
 * a literal __STORY_ACS__ in it has silently lost its evidence, which is exactly the
 * class of defect this pipeline keeps paying for.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATE_DIR_REL = 'orchestrations/prompts/templates';
const PROJECT_PROMPT_SUBDIR = 'prompts';
// THE PLACEHOLDER RULE LIVES IN ONE PLACE.
//
// This regex existed in THREE files — here, engine-prompt.js and project-prompt-contract.js —
// and only one of them was fixed when adjacent placeholders turned out to merge. ${a}${b}
// becomes __A____B__ in a template, and a greedy match reads that as a single token. The two
// unfixed copies then disagreed with the fixed one about what a template declares, so a valid
// generated prompt was refused as "dropping placeholders" and a valid template was refused as
// "using undeclared placeholders". Three copies of a rule is three rules.
const { placeholdersIn: _placeholdersIn, substituteOnce } = require('./engine-prompt.js');

/** Repo root, derived from this file's location — never an env guess. */
function repoRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

function templatePath(id) {
  return path.join(repoRoot(), TEMPLATE_DIR_REL, `${id}.json`);
}

function projectPromptPath(id, projectConfigDir) {
  return path.join(projectConfigDir, PROJECT_PROMPT_SUBDIR, `${id}.json`);
}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`prompt file unreadable (${file}): ${e && e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Never "fall back to the template" here. An unparseable project prompt means the
    // authority for this agent is broken, and running SOMETHING ELSE hides that.
    throw new Error(`prompt file is not valid JSON (${file}): ${e && e.message}`);
  }
}

/**
 * Load the project-authority prompt. NO FALLBACK — see the header.
 * @param {string} id            prompt id, e.g. 'failure-analyst'
 * @param {string} projectConfigDir  EPAM_PROJECT_CONFIG_DIR
 */
function loadProjectPrompt(id, projectConfigDir, opts) {
  if (!id || typeof id !== 'string') throw new Error('prompt id is required');
  if (!projectConfigDir) {
    throw new Error(
      `no project config dir given for prompt '${id}' — EPAM_PROJECT_CONFIG_DIR must be set. ` +
      'The template is never executed, so there is nothing to fall back to.',
    );
  }
  const file = projectPromptPath(id, projectConfigDir);
  if (!fs.existsSync(file)) {
    throw new Error(
      `project-authority prompt missing: ${file}. Mint it from ` +
      `${TEMPLATE_DIR_REL}/${id}.json — the template is NEVER executed directly.`,
    );
  }
  const doc = readJson(file);

  // A MULTI-PART PROMPT: ONE POLICY, SEVERAL AUDIENCES.
  //
  // Some rules bind more than one agent, and the two halves must never drift. "Tests are NOT
  // your job" lived only in the writer's prompt; the reviewer had never heard of it and raised
  // a blocker for missing tests, so the writer was ordered to create what it was forbidden to
  // create. Splitting that across two prompt files would recreate the same defect with extra
  // steps, so a prompt may declare `bodies: { <part>: text }` and each consumer asks for its
  // own part of the SAME document.
  //
  // A part is REQUIRED when bodies exist: silently picking one would make the caller's audience
  // an accident of ordering.
  if (doc && doc.bodies && typeof doc.bodies === 'object') {
    const part = opts && opts.part;
    if (!part) {
      throw new Error(
        `prompt '${id}' declares parts (${Object.keys(doc.bodies).join(', ')}) — ask for one by name`);
    }
    if (typeof doc.bodies[part] !== 'string' || !doc.bodies[part].trim()) {
      throw new Error(
        `prompt '${id}' has no part '${part}' (declares: ${Object.keys(doc.bodies).join(', ')})`);
    }
    // THE PART'S CONTRACT IS THE PART'S PLACEHOLDERS. `placeholders` on a multi-part document
    // is the UNION across parts — that is what the whole document declares. render() then
    // compares it against ONE part's body and refuses it for "declaring placeholders it never
    // uses", so every multi-part project prompt was unrenderable through this path.
    //
    // Surfaced when seam prompts started routing here instead of to the template renderer, which
    // computes its declared set per body already. Narrowed rather than relaxing render(): a
    // prompt that declares a placeholder its body never uses is still a real defect, and the
    // check that catches it is worth keeping.
    const used = new Set(placeholdersIn(doc.bodies[part]));
    return {
      ...doc,
      body: doc.bodies[part],
      placeholders: (doc.placeholders || []).filter((x) => used.has(x)),
    };
  }

  if (!doc || typeof doc.body !== 'string' || !doc.body.trim()) {
    throw new Error(`project-authority prompt has no body: ${file}`);
  }
  if (doc.authority && doc.authority !== 'project') {
    throw new Error(`refusing to run a non-project prompt (authority='${doc.authority}'): ${file}`);
  }
  return doc;
}

/** Placeholders actually present in a body, deduped and sorted. */
function placeholdersIn(body) {
  return [..._placeholdersIn(body)].sort();
}

/**
 * Render a prompt body with values. Strict in both directions.
 *
 * Values are substituted with a replacer FUNCTION, not a string, so that `$&`, `$1` and
 * friends inside a value (a diff, a regex, a test log — all routine here) are inserted
 * literally instead of being interpreted as replacement patterns. That bug would corrupt
 * evidence silently and only for values that happen to contain a dollar sign.
 */
function render(doc, values) {
  const body = doc.body;
  const declared = Array.isArray(doc.placeholders) ? [...doc.placeholders].sort() : [];
  const present = placeholdersIn(body);

  const undeclared = present.filter((p) => !declared.includes(p));
  if (undeclared.length) {
    throw new Error(`prompt '${doc.id}' uses undeclared placeholders: ${undeclared.join(', ')}`);
  }
  const orphanDeclared = declared.filter((p) => !present.includes(p));
  if (orphanDeclared.length) {
    throw new Error(`prompt '${doc.id}' declares placeholders it never uses: ${orphanDeclared.join(', ')}`);
  }

  const supplied = values && typeof values === 'object' ? values : {};

  // A VALUE NOTHING CONSUMES IS EVIDENCE THROWN AWAY.
  //
  // This checked three things and not this one, so a value supplied to a prompt with no
  // matching placeholder was silently dropped. engine-prompt.js has always rejected exactly
  // that — "was given values it does not use" — so the two renderers disagreed on the same
  // class, and the lenient one lost evidence without a trace.
  //
  // Live 20260821T212250Z: prior-reviews.py produced the reviewer's history correctly and it
  // was supplied as __PRIOR_REVIEW__. The project's prompt declares no such placeholder, so
  // it went nowhere. All three review cycles ran with no memory of each other and the
  // approval missed a regression the earlier cycle had caught. The run log mentions prior
  // review zero times: a whole feedback loop absent, with nothing to show it.
  //
  // Loud, because the caller believed it sent something. A stale project prompt is now a
  // failure at render rather than a quiet degrade — which is the same rule the rest of this
  // file already applies in the other direction.
  const unconsumed = Object.keys(supplied).filter((k) => /^__[A-Z0-9_]+__$/.test(k) && !present.includes(k));
  if (unconsumed.length) {
    // LOUD, NOT FATAL — and that asymmetry is deliberate.
    //
    // Throwing here kills the seam outright: the reviewer supplies __PRIOR_REVIEW__ to project
    // prompts minted before that placeholder existed, so a hard failure would take the reviewer
    // out of every such run. Losing one block of context is bad; losing the whole review is
    // worse, and the operator has not asked for a re-mint.
    //
    // engine-prompt.js DOES throw on this, correctly: it renders templates, which are the
    // in-repo source and can always be corrected. A project prompt is generated, may lag the
    // template, and cannot be corrected from here.
    //
    // What was unacceptable was silence. This is the trace that was missing when the reviewer's
    // entire prior-review history was dropped on 20260821T212250Z and the run log mentioned it
    // zero times.
    process.stderr.write(
      `[prompt-library] '${doc.id}' was given values it does not use: ${unconsumed.join(', ')}. `
      + 'That evidence is being DROPPED — the prompt has no placeholder for it. '
      + 'Add the placeholder to this project prompt, or stop supplying the value.\n');
  }

  // A LOOKUP THAT FOUND NOTHING IS ABSENCE, NOT A VALUE. `p in supplied` is true for a key whose
  // value is undefined, so the rule stated below — absent is not empty — was defeated by the one
  // shape absence actually takes in JavaScript, and the prompt rendered with the literal word
  // "undefined" where the evidence belonged. null is the same thing arriving from JSON.
  const missing = present.filter((p) => !(p in supplied) || supplied[p] === undefined || supplied[p] === null);
  if (missing.length) {
    // An empty string is a legitimate value and must be passed explicitly. Absent is not
    // empty: a prompt rendered without its evidence is worse than one that fails loudly.
    throw new Error(`prompt '${doc.id}' is missing values for: ${missing.join(', ')}`);
  }

  // ONE PASS OVER THE BODY. Replacing each key in turn over the accumulating output meant every
  // value was re-read by every later key: a diff that mentioned __B__ had __B__'s content
  // spliced into it, and a diff carrying any double-underscore token — a Python dunder, a C
  // macro — tripped the leftover check below and killed the render of a complete prompt. A
  // single alternation pass inserts each value exactly where the BODY asked for it and never
  // looks at what was inserted.
  //
  // Replacer FUNCTION, not a string, so a `$&` or `$1` inside a diff, a log or a JSON example
  // is inserted literally instead of being read as a replacement pattern.
  // AN EMPTY VALUE IS SILENCE, AND SILENCE REACHES THE MODEL AS A BLANK SECTION.
  //
  // The renderer refused a MISSING key and accepted a present-but-empty one, so `|| ''` — which
  // fifteen call sites use — turned a failed lookup into a prompt that looked complete and said
  // nothing. Live 2026-08-23: the roster reviewer was handed a header with a blank line under it
  // for every agent, reported the briefs "entirely empty", and blocked the roster twice. The
  // briefs existed; the lookup read the wrong map.
  //
  // A placeholder that may legitimately be empty says so IN THE TEMPLATE, as `mayBeEmpty`. A retry
  // note absent on a first attempt is a real state; a brief is not. That distinction belongs with
  // the prompt, which is reviewable, rather than in the producer, which is where it got lost.
  const mayBeEmpty = new Set(Array.isArray(doc.mayBeEmpty) ? doc.mayBeEmpty : []);
  const blank = present.filter((p) => !mayBeEmpty.has(p)
    && typeof supplied[p] === 'string' && !supplied[p].trim());
  if (blank.length) {
    throw new Error(
      `prompt '${doc.id}' was given EMPTY values for: ${blank.join(', ')}. An empty payload renders `
      + 'as a blank section and the agent answers about silence — it cannot tell a failed lookup '
      + 'from a genuinely absent one. Supply the value, or declare the placeholder in the '
      + "template's `mayBeEmpty` if absent is a real state for it.");
  }

  const out = substituteOnce(body, present, supplied);

  // The check that means something is on the BODY: a placeholder this pass did not cover.
  // Scanning the OUTPUT could only ever find tokens that arrived as evidence.
  const uncovered = placeholdersIn(body).filter((p) => !present.includes(p));
  if (uncovered.length) {
    throw new Error(`prompt '${doc.id}' has placeholders no value covered: ${uncovered.join(', ')}`);
  }
  return out;
}

/** Convenience: load + render in one call. */
function buildPrompt(id, projectConfigDir, values, opts) {
  return render(loadProjectPrompt(id, projectConfigDir, opts), values);
}

module.exports = {
  loadProjectPrompt,
  render,
  buildPrompt,
  placeholdersIn,
  templatePath,
  projectPromptPath,
  TEMPLATE_DIR_REL,
  PROJECT_PROMPT_SUBDIR,
};

/**
 * CLI, so shell can use the library without reimplementing resolution:
 *   node prompt-library.js render <id> <projectConfigDir> <values.json> [part]
 * Values arrive as a JSON file rather than argv because they routinely contain newlines,
 * quotes and megabytes of test output.
 */
if (require.main === module) {
  const [, , cmd, id, dir, valuesFile, part] = process.argv;
  try {
    if (cmd !== 'render') throw new Error(`unknown command '${cmd}' (expected: render)`);
    const values = valuesFile ? readJson(valuesFile) : {};
    process.stdout.write(buildPrompt(id, dir, values, part ? { part } : undefined));
  } catch (e) {
    process.stderr.write(`[prompt-library] ${e && e.message}\n`);
    process.exit(1);
  }
}
