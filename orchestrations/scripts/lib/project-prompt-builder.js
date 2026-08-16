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
 * @param {string}   o.bootstrapFile       declares copyVerbatim / generated
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
  templatesDir, bootstrapFile, projectConfigDir, runText,
  projectContext, codelineContext, mintedRoles, attempts = 3, mode = 'generate', log = () => {},
}) {
  const boot = readJson(bootstrapFile);
  let copyVerbatim = Array.isArray(boot.copyVerbatim) ? boot.copyVerbatim : [];
  let generated = Array.isArray(boot.generated) ? boot.generated : [];

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
    fs.writeFileSync(path.join(outDir, `${id}.json`), fs.readFileSync(src));
    copied.push(id);
    log(`[prompt-builder] copied ${id} (bootstrap — cannot be generated)`);
  }

  // The generator's own prompt comes from the project copy just installed, not from an
  // engine-side string.
  const genId = 'project-prompt-generation';
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
