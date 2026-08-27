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

// Local tool caps are DECLARED — config/tool-timeouts.json. A literal here would be a
// second home for a decision that already has one.
const { toolTimeoutMs } = require('./tool-timeouts.js');

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
    // THIS PROJECT's roster, not the engine's roles file. This read
    // agents/project-roles.json — the ENGINE's copy — whatever project was running, so a client
    // codeline's stack facts named epam-cli's own roles. The roster carries `kind` per agent and
    // is derived per project every run.
    const roles = process.env.EPAM_PROJECT_CONFIG_DIR
      ? path.join(process.env.EPAM_PROJECT_CONFIG_DIR, 'roster.json')
      : '';
    const out = execFileSync(process.execPath, [
      path.join(__dirname, 'handlers', 'stack-facts.js'), repo, roles,
    ], { encoding: 'utf8', timeout: toolTimeoutMs('promptRender') });
    _stackFacts = JSON.parse(out);

    // THE SKILL PICTURE, rendered for a reader. Same derivation as agent-skills.js — the ecosystem
    // registry plus the KB written for these codelines — flattened to text a prompt can carry.
    try {
      const skills = JSON.parse(execFileSync(process.execPath, [
        path.join(__dirname, 'handlers', 'agent-skills.js'),
        process.env.EPAM_CODELINE_PATH || '',
        path.join(__dirname, '..', '..', 'agents'),
        process.env.EPAM_CODELINE_PATHS || process.env.PROJECT_ROOT || '',
      ], { encoding: 'utf8', timeout: toolTimeoutMs('promptRender') }));

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
/**
 * Which layer owns a prompt, resolved from the SEAM REGISTRY rather than a list.
 *
 * A template is immutable and generic and is never executed directly — an agent runs THIS
 * PROJECT's prompt, which the template generated. The exception is the bootstrap set: seams that
 * run inside the mint, before the project prompt layer exists. A prompt that generates prompts
 * cannot itself be generated, which is why bootstrap.copyVerbatim exists for the same reason.
 *
 * Declared on the seam as `layer: "bootstrap"`, so adding or moving a stage changes one datum and
 * not a list in code — a hand-kept copy of a derivable fact only ever drifts.
 *
 * An id NO seam declares is a fragment composed into another prompt, not something an agent
 * executes. Those stay generic and take their project content from the prompt they land in.
 */
function templateLayerOf(id) {
  // __dirname, like templatesDir() beside it. The first version called repoRoot(), which this
  // file does not define — and the ReferenceError landed in the catch below, which returned
  // 'engine' and let every seam-declared prompt render from the template exactly as before. A
  // catch that turns a programming error into a permissive default is the fail-open shape this
  // whole layer exists to remove, and it hid its own bug for one test cycle.
  const registryPath = path.join(__dirname, '..', '..', 'agents', 'invocation-profiles.json');
  let reg;
  try {
    reg = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (e) {
    // An unreadable registry means the layer of every prompt is unknown. Guessing 'engine' would
    // render templates for agents; guessing 'project' would halt every seam. Say so instead.
    throw new Error(
      `[engine-prompt] cannot read the seam registry at ${registryPath}: ${e && e.message}. `
      + 'Which layer owns a prompt is undecidable without it.');
  }
  const profiles = (reg && reg.profiles) || {};
  let found = null;
  (function walk(o) {
    for (const k in o) {
      const v = o[k];
      if (v && typeof v === 'object') { if (v.template === id) found = v; walk(v); }
    }
  }(profiles));
  if (!found) return 'engine';                       // a fragment: no agent executes it
  return found.layer === 'bootstrap' ? 'bootstrap' : 'project';
}

/**
 * Substitute every declared placeholder in ONE pass, so an inserted value is never rescanned.
 *
 * Keys are placeholder tokens (`__LIKE_THIS__`) — no regex metacharacters — but they are escaped
 * anyway, because the day one is not is the day this corrupts something quietly.
 */
function substituteOnce(body, keys, values) {
  if (!keys.length) return body;
  const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(keys.map(esc).join('|'), 'g');
  return body.replace(re, (m) => String(values[m]));
}

function renderEngineTemplate(id, values, bodyKey) {
  // A SEAM-DECLARED PROMPT IS NOT THIS RENDERER'S TO EXECUTE.
  //
  // 89 template ids were rendered straight from the template layer, 29 of them declared by a
  // seam — so an agent ran generic text with none of this project's facts in it, and self-heal
  // had nothing to correct. Enforced here rather than at 25 call sites, because a rule applied
  // at call sites is a rule the 26th call site does not have.
  if (templateLayerOf(id) === 'project') {
    // ROUTED, not refused. Refusing would be correct about the rule and useless in practice: 25
    // call sites render these, and a rule enforced by breaking every caller is a rule that gets
    // reverted. The callers were never choosing a LAYER — they were asking for a prompt — so the
    // renderer answers with the one an agent may actually execute.
    //
    // prompt-library refuses to fall back to the template, which is the point: if this project
    // has no copy, that is a provisioning defect and it surfaces here by name.
    //
    // Required lazily: prompt-library imports placeholdersIn from this module, and requiring it
    // at load time would give one of them a half-initialised copy of the other.
    // eslint-disable-next-line global-require
    const lib = require('./prompt-library.js');
    const projectDir = process.env.EPAM_PROJECT_CONFIG_DIR || '';
    if (!projectDir) {
      throw new Error(
        `[engine-prompt] '${id}' is a seam-declared prompt — an agent executes it, so it renders `
        + 'from THIS PROJECT\'s copy. EPAM_PROJECT_CONFIG_DIR is unset, so there is no project '
        + 'to render for, and the template is never executed directly.');
    }
    const doc = lib.loadProjectPrompt(id, projectDir, bodyKey ? { part: bodyKey } : undefined);

    // STACK FACTS REACH THIS PATH TOO. The injection below happens after this return, so routing
    // skipped it and every project prompt declaring __TEST_COMMAND__ failed for a missing value
    // — a defect introduced by the routing itself, caught because the stack-fact tests render
    // exactly these ids.
    //
    // Same rule as below: only the keys the document DECLARES, and only where the caller has not
    // supplied one. Merging all of them is what killed four seams in 8f52dab.
    const merged = { ...(values || {}) };
    const declaredHere = new Set(placeholdersIn(doc.body));
    const needStack = STACK_FACT_KEYS.filter((k) => declaredHere.has(k) && !(k in merged));
    if (needStack.length) {
      const facts = stackFacts();
      for (const k of needStack) if (facts[k] !== undefined) merged[k] = facts[k];
    }
    return lib.render(doc, merged);
  }
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

  // Absence in JavaScript is `undefined`, and a key holding it is still a key: Object.keys lists
  // it, so a failed lookup passed this check and rendered the word "undefined" into the prompt.
  const missing = declared.filter((p) => !supplied.includes(p)
    || values[p] === undefined || values[p] === null);
  if (missing.length) {
    throw new Error(`[engine-prompt] '${id}' is missing values for: ${missing.join(', ')}`);
  }
  // AN EMPTY VALUE IS SILENCE. Same rule as prompt-library: the renderer refused a MISSING key and
  // accepted a present-but-empty one, so `|| ''` produced a prompt that looked complete and said
  // nothing. A placeholder that may legitimately be empty declares it in the template.
  const _mayBeEmpty = new Set(Array.isArray(doc.mayBeEmpty) ? doc.mayBeEmpty : []);
  const _blank = declared.filter((p) => !_mayBeEmpty.has(p)
    && typeof values[p] === 'string' && !values[p].trim());
  if (_blank.length) {
    throw new Error(
      `[engine-prompt] '${id}' was given EMPTY values for: ${_blank.join(', ')}. An empty payload `
      + 'renders as a blank section and the agent answers about silence. Supply it, or declare the '
      + "placeholder in the template's `mayBeEmpty` if absent is a real state for it.");
  }

  const unused = supplied.filter((p) => !declared.includes(p));
  if (unused.length) {
    throw new Error(`[engine-prompt] '${id}' was given values it does not use: ${unused.join(', ')}`);
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
  out = substituteOnce(out, declared, values);

  // The check that means something is on the BODY, not on the result: a body placeholder this
  // pass did not cover. Scanning the OUTPUT could only ever find tokens that arrived as
  // evidence, because every body placeholder is in `declared` and every one of them is
  // replaced.
  const uncovered = placeholdersIn(String(doc.bodies ? doc.bodies[bodyKey || 'prompt'] : (doc.body || '')))
    .filter((p) => !declared.includes(p));
  if (uncovered.length) {
    throw new Error(`[engine-prompt] '${id}' has placeholders no value covered: ${uncovered.join(', ')}`);
  }
  return out;
}

module.exports = { renderEngineTemplate, placeholdersIn, templatePath, templatesDir, substituteOnce };
