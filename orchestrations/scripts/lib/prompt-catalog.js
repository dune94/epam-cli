'use strict';
/**
 * prompt-catalog — the prompt layer. Agent instructions are DATA, owned by the project.
 *
 * WHAT WENT WRONG WITHOUT ONE. Every agent prompt in this pipeline was composed in engine
 * code: shell heredocs and JS template literals, grown paragraph by paragraph as live failures
 * were diagnosed. 40,228 characters of instruction, addressed to a model, compiled into the
 * program that dispatches it. That has four consequences, and the pipeline has hit all four:
 *
 *   - It cannot be changed per project. One estate's investigator and another's read the same
 *     forty paragraphs, including the ones written for an incident in a repository the second
 *     project has never seen.
 *   - It carries stack facts nobody audits. `--glob "*.ts"` and "provider/hook/route/component"
 *     sit inside the detective's prompt today. Both are true of one stack and false of the next.
 *   - It drifts. The same rule was written twice, byte-identical, nine lines apart in one
 *     script, each copy then maintained separately.
 *   - It is invisible to review. The sweep that was supposed to enforce "no stack facts in the
 *     engine" read only *.sh, so the 30,128 characters in spec-mode-runner.js were never once
 *     scanned. Progress was reported against a gate that could not see the largest offender.
 *
 * THE CONTRACT
 *
 *   - A prompt is an ordered list of SECTION KEYS. The engine names the keys and supplies the
 *     data; the project owns every word.
 *   - A section is a string, or {header, rules[]} for a numbered block, or {variants} for a
 *     section that branches on a runtime value (defect vs novel, brownfield vs greenfield).
 *   - Placeholders are {name}, filled from the data object. An unmatched placeholder is left
 *     VISIBLE — a prompt that silently loses a value reads as complete while being wrong.
 *
 * A MISSING SECTION IS FATAL, AND THAT IS THE DIFFERENCE FROM THE MESSAGE CATALOG.
 *
 * renderAgentMessage degrades to a structured form when its catalog is absent, because a
 * message is a report and a bare report is still honest. A PROMPT is the agent's entire
 * contract. An agent dispatched with a section missing does not fail — it answers confidently
 * against instructions it never received, and that answer is indistinguishable from a good one
 * until a gate rejects it four steps later. So this throws, loudly, naming the key.
 *
 * There is NO built-in fallback text anywhere in this file. A fallback sentence is the
 * hardcoding with a branch in front of it.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Where the catalog lives. Configuration, then the project's own directory. */
function catalogPaths(env = process.env) {
  const out = [];
  if (env.EPAM_PROMPT_CATALOG) out.push(env.EPAM_PROMPT_CATALOG);
  if (env.EPAM_PROJECT_CONFIG_DIR) out.push(path.join(env.EPAM_PROJECT_CONFIG_DIR, 'agent-prompts.json'));
  out.push(path.join(__dirname, '..', '..', 'config', 'agent-prompts.json'));
  return out;
}

/**
 * Load and merge the catalogs, most specific last.
 *
 * A project overlay REPLACES a section it names and inherits the rest, so a project that wants
 * one paragraph different does not fork forty.
 */
function loadCatalog(env = process.env) {
  const merged = { version: 0, prompts: {}, sections: {} };
  let found = 0;
  // Reversed: the least specific is applied first so the most specific wins.
  for (const p of catalogPaths(env).slice().reverse()) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    found += 1;
    merged.version = parsed.version || merged.version;
    Object.assign(merged.prompts, parsed.prompts || {});
    Object.assign(merged.sections, parsed.sections || {});
    merged.source = p;
  }
  if (!found) {
    throw new Error(
      'no agent prompt catalog could be read. Looked at: ' + catalogPaths(env).join(', ') +
      '. Prompts are project data; the engine has no built-in copy to fall back to.');
  }
  return merged;
}

function fill(text, data) {
  return String(text).replace(/\{(\w+)\}/g, (whole, key) =>
    (Object.prototype.hasOwnProperty.call(data, key) && data[key] != null) ? String(data[key]) : whole);
}

/**
 * Resolve one section to text.
 *
 * `variants` branches on a value the ENGINE computes but does not word: the engine knows a
 * story is a defect, the project decides what a detective is told about defects.
 */
function renderSection(catalog, key, data = {}) {
  const section = String(key).split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), catalog.sections);
  if (section == null) {
    throw new Error(
      `prompt section '${key}' is not in the catalog (${catalog.source || 'unknown source'}). ` +
      'An agent dispatched without it would answer against instructions it never received.');
  }
  if (typeof section === 'string') return fill(section, data);
  if (Array.isArray(section)) return section.map((s) => fill(s, data)).join('\n');

  if (section.variants) {
    const which = data[section.variantOn || 'variant'];
    const chosen = section.variants[which] != null ? section.variants[which] : section.variants.default;
    if (chosen == null) {
      throw new Error(
        `prompt section '${key}' has no variant for '${which}' and declares no default. ` +
        'Silently choosing one would put a different contract in front of the agent than the ' +
        'engine believes it sent.');
    }
    return renderSectionValue(chosen, data);
  }
  return renderSectionValue(section, data);
}

function renderSectionValue(section, data) {
  if (typeof section === 'string') return fill(section, data);
  if (Array.isArray(section)) return section.map((s) => fill(s, data)).join('\n');
  const header = section.header ? fill(section.header, data) : '';
  const rules = Array.isArray(section.rules) ? section.rules : [];
  const start = Number.isFinite(section.startIndex) ? section.startIndex : 1;
  const numbered = rules.map((r, i) => `${start + i}. ${fill(r, data)}`);
  return [header, ...numbered].filter(Boolean).join('\n');
}

/**
 * Render a whole prompt: the ordered sections its entry names.
 *
 * A section may be conditional on the data (`when`), so a prompt can drop a block without the
 * engine assembling the list itself — which is how "the engine composes the prompt" creeps
 * back in one conditional at a time.
 */
function renderPrompt(promptKey, data = {}, env = process.env) {
  const catalog = loadCatalog(env);
  const entry = catalog.prompts[promptKey];
  if (!entry) {
    throw new Error(
      `no prompt '${promptKey}' in the catalog (${catalog.source}). ` +
      `Known prompts: ${Object.keys(catalog.prompts).join(', ') || '(none)'}`);
  }
  const refs = Array.isArray(entry) ? entry : (entry.sections || []);
  const parts = [];
  for (const ref of refs) {
    const isObj = ref && typeof ref === 'object';
    const key = isObj ? ref.section : ref;
    if (isObj && ref.when && !data[ref.when]) continue;
    if (isObj && ref.unless && data[ref.unless]) continue;
    const text = renderSection(catalog, key, data);
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

/** Every section key a prompt needs — so a catalog can be checked before a run, not during. */
function requiredSections(promptKey, env = process.env) {
  const catalog = loadCatalog(env);
  const entry = catalog.prompts[promptKey];
  if (!entry) return [];
  const refs = Array.isArray(entry) ? entry : (entry.sections || []);
  return refs.map((r) => (r && typeof r === 'object' ? r.section : r)).filter(Boolean);
}

/**
 * Which declared prompts cannot be rendered. Run this at launch: a catalog missing a section
 * should stop a run before it spends, not surface as a strangely confident agent answer.
 */
function validateCatalog(env = process.env) {
  const catalog = loadCatalog(env);
  const problems = [];
  for (const promptKey of Object.keys(catalog.prompts)) {
    for (const key of requiredSections(promptKey, env)) {
      const found = String(key).split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), catalog.sections);
      if (found == null) problems.push({ prompt: promptKey, missing: key });
    }
  }
  return { source: catalog.source, prompts: Object.keys(catalog.prompts).length, problems };
}

module.exports = {
  catalogPaths, loadCatalog, renderSection, renderPrompt, requiredSections, validateCatalog,
};
