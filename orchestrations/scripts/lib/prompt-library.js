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
const PLACEHOLDER_RE = /__[A-Z][A-Z0-9_]*__/g;

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
    return { ...doc, body: doc.bodies[part] };
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
  return [...new Set(String(body).match(PLACEHOLDER_RE) || [])].sort();
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
  const missing = present.filter((p) => !(p in supplied));
  if (missing.length) {
    // An empty string is a legitimate value and must be passed explicitly. Absent is not
    // empty: a prompt rendered without its evidence is worse than one that fails loudly.
    throw new Error(`prompt '${doc.id}' is missing values for: ${missing.join(', ')}`);
  }

  let out = body;
  for (const key of present) {
    const value = String(supplied[key]);
    out = out.replace(new RegExp(key, 'g'), () => value);
  }

  const leftover = placeholdersIn(out);
  if (leftover.length) {
    throw new Error(`prompt '${doc.id}' still contains placeholders after rendering: ${leftover.join(', ')}`);
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
