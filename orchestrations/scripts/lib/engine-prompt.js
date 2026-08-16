#!/usr/bin/env node
/**
 * RENDER AN ENGINE PROMPT FROM THE TEMPLATE LAYER.
 *
 * Operator rule, 2026-08-15: every prompt lives in orchestrations/prompts/templates. All of
 * them, no exceptions. A prompt embedded in code cannot be diffed, reviewed, corrected by
 * self-heal, or evaluated — and fixing a wording problem means editing and shipping the
 * engine.
 *
 * TWO RENDERERS, DELIBERATELY:
 *   prompt-library.js  renders a PROJECT-AUTHORITY copy for an agent-facing seam. The
 *                      template is never executed there, and a missing project copy is a hard
 *                      failure, because the project layer is what self-heal may correct.
 *   this module        renders the GENERIC template for engine-internal prompts — the ones
 *                      the engine itself assembles before any project agent is involved.
 *
 * STRICT IN BOTH DIRECTIONS, for the same reason prompt-library is. A placeholder left
 * unreplaced means evidence silently never reached the agent — the failure looks like a bad
 * answer, not a missing input. A value nobody uses means the caller believes it supplied
 * something that went nowhere, which is the same defect seen from the other end.
 *
 * Extracted 2026-08-15 after the second migration copied it into a second file. Eighteen
 * migrations remained; pasting it eighteen more times would have made a wording fix an
 * eighteen-file change, which is exactly the single-point-of-maintenance rule this pipeline
 * keeps paying to relearn.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// NON-GREEDY, because placeholders sit ADJACENT.
//
// A prompt that ends one block and begins the next with no separator — ${a}${b} in the
// original — becomes __A____B__ here. Greedy matching swallowed the whole run as a single
// token, so a template with seven adjacent blocks declared ONE placeholder nobody supplies
// and threw at render time. Lazy matching stops at the first closing pair, which is what the
// author meant, and substitution by key was always adjacency-safe.
const PLACEHOLDER_RE = /__[A-Z][A-Z0-9_]*?__/g;

/** The template zone, resolved from this file's own location — never from an env guess. */
function templatesDir() {
  return path.join(__dirname, '..', '..', 'prompts', 'templates');
}

function templatePath(id) {
  return path.join(templatesDir(), `${id}.json`);
}

/** Placeholders present in a body, deduped — the same rule prompt-library applies. */
function placeholdersIn(body) {
  return [...new Set(String(body == null ? '' : body).match(PLACEHOLDER_RE) || [])];
}

/**
 * Render template `id` with `values`.
 *
 * @param {string} id      template id, e.g. 'estate-survey'
 * @param {Object} values  every placeholder the body uses, exactly — no more, no fewer
 * @returns {string}
 */
function renderEngineTemplate(id, values, bodyKey) {
  const file = templatePath(id);
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    // Never fall back to an inline default. A prompt that silently degrades to something
    // written in code is precisely what this layer exists to remove, and the degraded version
    // would run for a whole campaign looking like the real one.
    throw new Error(`[engine-prompt] cannot load template '${id}' from ${file}: ${e && e.message}`);
  }

  // ONE TEMPLATE MAY HOLD SEVERAL BODIES. The format already existed — prompt-library and the
  // project builder both handle `bodies` — but this renderer only ever read `body`, so an engine
  // prompt whose variants belong together had to be split across files or left in the script.
  // The caller names the body it wants; asking for one that is not there is an error, never a
  // silent fall back to some other variant.
  let out;
  if (doc.bodies && typeof doc.bodies === 'object') {
    const key = bodyKey || 'prompt';
    if (!(key in doc.bodies)) {
      throw new Error(`[engine-prompt] template '${id}' has no body '${key}' — it declares: ${Object.keys(doc.bodies).join(', ')}`);
    }
    out = String(doc.bodies[key]);
  } else {
    if (bodyKey) throw new Error(`[engine-prompt] template '${id}' has a single body, but body '${bodyKey}' was asked for`);
    out = String(doc.body || '');
  }
  if (!out.trim()) throw new Error(`[engine-prompt] template '${id}' has an empty body`);

  const declared = placeholdersIn(out);
  const supplied = Object.keys(values || {});

  const missing = declared.filter((p) => !supplied.includes(p));
  if (missing.length) {
    throw new Error(`[engine-prompt] '${id}' is missing values for: ${missing.join(', ')}`);
  }
  const unused = supplied.filter((p) => !declared.includes(p));
  if (unused.length) {
    throw new Error(`[engine-prompt] '${id}' was given values it does not use: ${unused.join(', ')}`);
  }

  // Replacer FUNCTION, not a string. A `$&` or `$1` inside a diff, a log, a regex or a JSON
  // example — all routine in these values — would otherwise be read as a replacement pattern
  // and corrupt the evidence silently. This bit me while writing this very module: inserting
  // it with String.replace expanded the `$&` in the comment above.
  for (const key of declared) {
    out = out.replace(new RegExp(key, 'g'), () => String(values[key]));
  }

  const leftover = placeholdersIn(out);
  if (leftover.length) {
    throw new Error(`[engine-prompt] '${id}' still contains placeholders after rendering: ${leftover.join(', ')}`);
  }
  return out;
}

module.exports = { renderEngineTemplate, placeholdersIn, templatePath, templatesDir };
