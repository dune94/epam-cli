#!/usr/bin/env node
/**
 * THE MINT BUILDS THIS PROJECT'S PROMPTS.
 *
 * Operator design, 2026-08-15: the agent that mints the roster also builds the prompts,
 * because it is the stage that already knows what this project is and which roles will work
 * on it — the two things a specialised prompt needs.
 *
 * Before this existed, nothing generated project prompts. prompt-library.js renders only the
 * project-authority copy and refuses to fall back to a template, so a project without them
 * cannot run — yet the only way to obtain them was to write them by hand. Hence exactly seven
 * in the repo, all for one project.
 *
 * TWO PROVISIONING MODES, DECLARED IN bootstrap.json:
 *   copyVerbatim — installed byte-identical. These cannot be generated because generating
 *                  them would require themselves (the mint's own prompt; this generator's).
 *   generated    — specialised by the model, checked against the template, then installed.
 *
 * FAILURE IS LOUD AND TOTAL. A generated prompt that drops, renames or invents one
 * placeholder does not degrade — prompt-library throws at whichever seam needed it, mid-run,
 * after the roster is minted and the run is already spending. So a prompt that fails its
 * contract is never written, and the builder throws rather than leaving a project
 * half-provisioned. It never falls back to the generic template: running a template is
 * forbidden outright, and a silent degrade is how an engine default runs a whole campaign
 * without anyone noticing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// The one template this builder reads a PROJECT copy of, in order to generate the rest. Named once
// so the provisioning guard above and the read below cannot disagree about it.
const PROJECT_PROMPT_GENERATOR_ID = 'project-prompt-generation';
const crypto = require('crypto');

const { checkGeneratedPrompt, buildGeneratedDoc } = require('./project-prompt-contract.js');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/**
 * Render the generator's own prompt for one template.
 *
 * The generator is itself a project-authority prompt (bootstrap-copied), so it is rendered
 * through the same library as everything else rather than assembled here — an engine-side
 * copy of its text is precisely the thing this whole design removes.
 */
function renderGeneratorPrompt({ generatorBody, template, projectContext, codelineContext, mintedRoles, refusal }) {
  let out = generatorBody
    .split('__TEMPLATE_ID__').join(template.id)
    .split('__TEMPLATE_DESCRIPTION__').join(template.description || '')
    .split('__TEMPLATE_BODY__').join(template.body)
    .split('__TEMPLATE_PLACEHOLDERS__').join((template.placeholders || []).join(', ') || '(none)')
    .split('__PROJECT_CONTEXT__').join(projectContext || '')
    .split('__CODELINE_CONTEXT__').join(codelineContext || '')
    .split('__MINTED_ROLES__').join(mintedRoles || '');
  if (refusal) {
    // THE RETRY MUST BE TOLD WHY. Re-sending an identical instruction gets an identical
    // answer; the refusal is the only new information the next attempt has.
    out += `\n\n## Your previous attempt was REFUSED\n\n${refusal}\n\n`
      + 'Produce the prompt again, correcting exactly this. Change nothing else.';
  }
  return out;
}

/**
 * Provision every prompt this project needs.
 *
 * @param {object}   o
 * @param {string}   o.templatesDir        the immutable generic zone
 * @param {string}   o.bootstrapFile       declares copyVerbatim / generated (auxiliary prompts)
 * @param {string}   [o.registryFile]      invocation-profiles.json — every seam.template needs a copy
 * @param {string}   o.projectConfigDir    prompts are written to <dir>/prompts
 * @param {Function} o.runText             async (prompt) => model's reply text
 * @param {string}   o.projectContext      what this project is
 * @param {string}   o.codelineContext     codelines and declared dependencies
 * @param {string}   o.mintedRoles         the roles the mint just produced
 * @param {number}   [o.attempts=3]        generation attempts per prompt
 * @param {Function} [o.log]               progress sink
 * @returns {Promise<{copied:string[], generated:string[]}>}
 */
async function buildProjectPrompts({
  templatesDir, bootstrapFile, registryFile, projectConfigDir, runText,
  projectContext, codelineContext, mintedRoles, attempts = 3, mode = 'generate', log = () => {},
}) {
  const boot = readJson(bootstrapFile);
  let copyVerbatim = Array.isArray(boot.copyVerbatim) ? boot.copyVerbatim : [];
  let generated = Array.isArray(boot.generated) ? boot.generated : [];

  // WHAT NEEDS A PROJECT COPY IS DERIVED FROM THE SEAM REGISTRY, NOT MAINTAINED BY HAND.
  //
  // A seam names the template it runs. If a seam runs it, that seam needs a PROJECT copy —
  // otherwise it executes the immutable generic parent, unspecialised for the project it is
  // working on. That makes the list a fact of the registry, not a list anyone curates.
  //
  // Curating it had already drifted: of 33 templates referenced by a seam, six appeared in
  // bootstrap NOWHERE — codeline-bridge, e2e-route-check, assign-agent-roles, spec-story-block,
  // skill-assessment-prephase, prd-model-coordinator. Those seams had no project-prompt path at
  // all, and nothing reported it, because the only list was the one that omitted them.
  //
  // bootstrap.generated is still read: it carries AUXILIARY prompts that a seam template
  // references but no seam names directly (retry prefixes, hint bodies, sub-prompts). Union, not
  // replacement — deriving alone would silently drop those.
  if (registryFile && fs.existsSync(registryFile)) {
    const reg = readJson(registryFile);
    const seamTemplates = [...new Set(
      Object.values(reg.profiles || {}).map((p) => p.template).filter(Boolean),
    )];
    const before = generated.length;
    generated = [...new Set([...generated, ...seamTemplates.filter((t) => !copyVerbatim.includes(t))])];
    if (generated.length !== before) {
      log(`[prompt-builder] ${generated.length - before} template(s) added from the seam registry `
        + 'that bootstrap did not list — a seam runs them, so a project copy is required');
    }
  }

  // ONLY WHAT A PROJECT-LAYER RENDERER READS.
  //
  // There are two renderers and the split is deliberate: prompt-library.js reads the PROJECT
  // copy, engine-prompt.js reads the TEMPLATE. A project copy of an engine-layer prompt can
  // therefore never be executed — codeline discovery, for one, runs before the mint that would
  // have written its copy.
  //
  // Provisioning them anyway cost three things: model spend under 'generate' mode; a file that
  // reads as live to anyone who opens it; and a place for self-heal corrections to land and do
  // nothing. One had already gone stale against its template and silently dropped the rule that
  // makes discovery emit codeline facts — a capability lost in a file nothing runs.
  //
  // The template declares its own layer, because inference does not hold: a project prompt can be
  // addressed dynamically (agent-inputs.js resolves an id through the seam registry), so no scan
  // of call sites is complete. Absent means engine — the safe default writes nothing.
  // EXISTENCE FIRST. Reading the layer of a template that is not there cannot answer the
  // question, and answering 'engine' would silently drop it — turning a bootstrap that names a
  // missing template into a quiet no-op instead of the loud refusal it must be.
  for (const id of [...copyVerbatim, ...generated]) {
    const p = path.join(templatesDir, `${id}.json`);
    if (!fs.existsSync(p)) {
      throw new Error(`[prompt-builder] bootstrap declares '${id}' but no template exists at ${p}`);
    }
  }

  const _layerOf = (id) => readJson(path.join(templatesDir, `${id}.json`)).layer || 'engine';

  // A TEMPLATE THIS BUILDER ITSELF READS CANNOT BE FILTERED OUT OF ITS OWN INSTALL.
  //
  // The layer heuristic decides whether a project copy is worth writing. But this builder reads
  // the PROJECT copy of the generator prompt to produce every other prompt (see genId below), so
  // dropping it is self-contradictory: bootstrap declares it, the filter removes it, and the
  // failure surfaces eighty lines later as "'project-prompt-generation' is not installed. It must
  // be declared in bootstrap.copyVerbatim" — which it already was.
  //
  // Derived from the code that reads them, not a list anyone maintains: whatever this builder
  // requires from outDir is required, whatever its template metadata happens to say.
  const _requiredFromProjectCopy = [PROJECT_PROMPT_GENERATOR_ID];
  for (const id of _requiredFromProjectCopy) {
    if ([...copyVerbatim, ...generated].includes(id) && _layerOf(id) !== 'project') {
      throw new Error(
        `[prompt-builder] '${id}' is declared in bootstrap but its template is layer='${_layerOf(id)}', `
        + 'so provisioning would drop it — and this builder reads the project copy of it to generate '
        + 'every other prompt. Set "layer": "project" on the template, or remove it from bootstrap.');
    }
  }

  // A TEMPLATE A SEAM RUNS IS PROJECT-LAYER BY DEFINITION.
  //
  // The layer field was the only gate, and absent defaults to 'engine' — so 37 of 44 templates
  // were dropped and their seams executed the generic parent on a specific project. That is the
  // condition this whole layer exists to prevent, decided by a metadata field nobody set.
  //
  // Running it is the proof: if a seam names a template, that seam needs a specialised copy. The
  // layer field still decides for templates NO seam names — auxiliary bodies that only another
  // prompt references.
  const _seamRun = new Set();
  if (registryFile && fs.existsSync(registryFile)) {
    for (const p of Object.values(readJson(registryFile).profiles || {})) {
      if (p.template) _seamRun.add(p.template);
    }
  }
  const _needsProjectCopy = (id) => _seamRun.has(id) || _layerOf(id) === 'project';
  const _dropped = [...copyVerbatim, ...generated].filter((id) => !_needsProjectCopy(id));
  if (_dropped.length) {
    // Said out loud. A silently shorter list is indistinguishable from a bootstrap that never
    // declared them.
    log(`[prompt-builder] ${_dropped.length} template(s) are engine-layer and are not provisioned `
      + `— nothing would ever read a project copy: ${_dropped.join(', ')}`);
  }
  copyVerbatim = copyVerbatim.filter(_needsProjectCopy);
  generated = generated.filter(_needsProjectCopy);

  // TWO PROVISIONING MODES, one per project, by operator design:
  //
  //   'copy'      the template layer is installed AS IS. What the project runs is exactly the
  //               generic text — no model involved, nothing to draw differently twice.
  //   'generate'  everything outside the bootstrap set is specialised by the agent that minted
  //               the roster.
  //
  // The mode belongs to the PROJECT, not to this file: a project is data. Copy mode is not a
  // degraded generate — it is the deliberate choice for a project whose prompts should stay
  // identical to the generic ones until someone decides otherwise.
  if (mode === 'copy') {
    copyVerbatim = [...copyVerbatim, ...generated];
    generated = [];
  } else if (mode !== 'generate') {
    throw new Error(`[prompt-builder] unknown mode '${mode}' — expected 'copy' or 'generate'`);
  }

  // EVERY DECLARED TEMPLATE MUST EXIST BEFORE ANYTHING IS WRITTEN. Discovering a missing one
  // halfway through leaves the project partially provisioned, which starts and then dies.
  for (const id of [...copyVerbatim, ...generated]) {
    const p = path.join(templatesDir, `${id}.json`);
    if (!fs.existsSync(p)) {
      throw new Error(`[prompt-builder] bootstrap declares '${id}' but no template exists at ${p}`);
    }
  }

  const outDir = path.join(projectConfigDir, 'prompts');
  fs.mkdirSync(outDir, { recursive: true });

  // ── Bootstrap: verbatim, byte for byte ──────────────────────────────────
  const copied = [];
  for (const id of copyVerbatim) {
    const src = path.join(templatesDir, `${id}.json`);
    const doc = readJson(src);

    // THE TEXT IS COPIED VERBATIM; THE PROVENANCE IS ADDED.
    //
    // A project copy must record which template it came from, or a later template edit is
    // invisible: the project keeps running the older prompt while the template claims
    // otherwise. Writing the file byte-for-byte lost that — and worse, ERASED the provenance
    // the hand-minted copies already carried.
    //
    // The digest covers the prompt TEXT only, matching the convention the existing copies
    // used: bodies for a multi-part prompt, body for a single one.
    // TWO CONVENTIONS ALREADY EXIST, and both are load-bearing because separate tests assert
    // each: a MULTI-PART prompt hashes JSON.stringify(bodies), a single-body prompt hashes the
    // RAW body string. Picking one would have silently invalidated every copy of the other
    // shape. Matched rather than unified — unifying them is a change to what "unchanged"
    // means for prompts already in the field.
    doc.derivedFromSha256 = doc.bodies !== undefined
      ? crypto.createHash('sha256').update(JSON.stringify(doc.bodies, null, 0)).digest('hex')
      : crypto.createHash('sha256').update(String(doc.body)).digest('hex');
    doc.authority = 'project';

    fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(doc, null, 2) + '\n');
    copied.push(id);
    log(`[prompt-builder] copied ${id}`);
  }

  // The generator's own prompt comes from the project copy just installed, not from an
  // engine-side string.
  const genId = PROJECT_PROMPT_GENERATOR_ID;
  const genPath = path.join(outDir, `${genId}.json`);
  const generatorBody = fs.existsSync(genPath) ? readJson(genPath).body : null;
  if (generated.length && !generatorBody) {
    throw new Error(
      `[prompt-builder] cannot generate ${generated.length} prompt(s): '${genId}' is not installed. `
      + 'It must be declared in bootstrap.copyVerbatim — it cannot be its own output.');
  }

  // ── Generated: specialise, check, then install ──────────────────────────
  const built = [];
  for (const id of generated) {
    const template = readJson(path.join(templatesDir, `${id}.json`));
    let refusal = '';
    let installed = false;

    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
      const prompt = renderGeneratorPrompt({
        generatorBody, template, projectContext, codelineContext, mintedRoles, refusal,
      });
      const body = String((await runText(prompt, { id, attempt })) || '');
      const doc = buildGeneratedDoc(template, body);
      const verdict = checkGeneratedPrompt(template, doc);

      if (verdict.ok) {
        // Written only once the contract passes — never a partial or refused prompt.
        fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(doc, null, 2) + '\n');
        built.push(id);
        installed = true;
        log(`[prompt-builder] generated ${id} (attempt ${attempt}/${attempts})`);
        break;
      }
      refusal = verdict.reason;
      log(`[prompt-builder] ! ${id} attempt ${attempt}/${attempts} refused: ${verdict.reason}`);
    }

    if (!installed) {
      // No fallback. The template is never executed, so there is nothing to degrade to, and
      // a project missing one prompt must not look provisioned.
      throw new Error(
        `[prompt-builder] could not generate a valid '${id}' in ${attempts} attempt(s). `
        + `Last refusal: ${refusal}`);
    }
  }

  return { copied, generated: built };
}

module.exports = { buildProjectPrompts, renderGeneratorPrompt };
