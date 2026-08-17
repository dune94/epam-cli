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

/**
 * THE STACK FACTS THIS RENDERER CAN FILL IN, resolved once per process.
 *
 * Keyed off the codeline being worked on, which every agent invocation already knows. Failure is
 * NOT fatal here: a template that declares one of these still fails loudly below with "missing
 * values for", which names the template and is the diagnosis a reader needs. Throwing from the
 * loader would blame the wrong thing.
 */
const STACK_FACT_KEYS = [
  '__STACK__', '__MANIFEST_FILE__', '__TEST_COMMAND__',
  '__TEST_FILE_CONVENTIONS__', '__PROTECTED_FILES__', '__IMPL_ROLE__', '__TEST_ROLE__',
  // The full skill picture, for a prompt that needs more than one fact: every codeline's stack,
  // manifest, test command and declared dependencies, plus the KB the pipeline wrote for it.
  // Auto-injected for the same reason the others are — wiring it at one call site is how the
  // next call site gets forgotten.
  '__PROJECT_SKILLS__',
];

let _stackFacts;
function stackFacts() {
  if (_stackFacts) return _stackFacts;
  _stackFacts = {};
  try {
    const { execFileSync } = require('child_process');
    const repo = process.env.PROJECT_ROOT || process.env.EPAM_CODELINE_PATH || process.cwd();
    const roles = path.join(__dirname, '..', '..', 'agents', 'project-roles.json');
    const out = execFileSync(process.execPath, [
      path.join(__dirname, 'handlers', 'stack-facts.js'), repo, roles,
    ], { encoding: 'utf8', timeout: 15000 });
    _stackFacts = JSON.parse(out);

    // THE SKILL PICTURE, rendered for a reader. Same derivation as agent-skills.js — the ecosystem
    // registry plus the KB written for these codelines — flattened to text a prompt can carry.
    try {
      const skills = JSON.parse(execFileSync(process.execPath, [
        path.join(__dirname, 'handlers', 'agent-skills.js'),
        process.env.EPAM_CODELINE_PATH || '',
        path.join(__dirname, '..', '..', 'agents'),
        process.env.EPAM_CODELINE_PATHS || process.env.PROJECT_ROOT || '',
      ], { encoding: 'utf8', timeout: 20000 }));

      const lines = [];
      for (const s of skills.stacks || []) {
        lines.push(`- ${s.codeline} (${s.path})`);
        lines.push(`    stack: ${s.stack} · manifest: ${s.manifest} · tests run with: ${s.testCommand || '(declares none)'}`);
        if ((s.declaredDeps || []).length) lines.push(`    declares: ${s.declaredDeps.join(', ')}`);
      }
      for (const l of skills.learned || []) {
        lines.push(`- from the ${l.source} — what this pipeline has already learned here:`);
        lines.push(l.text.split('\n').map((x) => `    ${x}`).join('\n'));
      }
      // EMPTY IS AN ANSWER. A first run has learned nothing and a project may declare no stack;
      // saying so is correct, and inventing knowledge an agent has not earned is not.
      _stackFacts.__PROJECT_SKILLS__ = lines.length
        ? lines.join('\n')
        : '(this project declares no resolvable codeline stack, and the pipeline has learned nothing here yet)';
    } catch { /* the placeholder simply stays unsupplied, and the render fails loudly by name */ }
  } catch {
    _stackFacts = {};
  }
  return _stackFacts;
}

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

  // STACK FACTS ARE INJECTED, NOT WRITTEN INTO THE PROMPT.
  //
  // Templates used to state the stack directly — "*.test.ts", "typescript-engineer", "NEVER modify
  // package.json" — so every agent on every project was told the world is TypeScript, vitest and
  // npm. They now carry placeholders instead, and the values come from the ecosystem registry and
  // the project's own minted roster (lib/handlers/stack-facts.js).
  //
  // Supplied HERE rather than at ~30 call sites: every caller would otherwise have to know which
  // stack facts its template happens to use, and would break the moment a template started using
  // one more. Only the placeholders a template DECLARES are added — this renderer is strict in
  // both directions, and an unused value is as much an error as a missing one.
  //
  // A caller's own value always wins: a site that knows better than the registry keeps saying so.
  const stackDeclared = declared.filter((p) => STACK_FACT_KEYS.includes(p) && !supplied.includes(p));
  if (stackDeclared.length) {
    const facts = stackFacts();
    for (const key of stackDeclared) {
      if (facts[key] !== undefined) { values[key] = facts[key]; supplied.push(key); }
    }
  }

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
