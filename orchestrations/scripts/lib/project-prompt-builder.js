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
const { refusalBlock } = require('./refusal-block.js');

/**
 * The template's body as one string — the SAME expression checkGeneratedPrompt uses, so the text
 * the generator is shown and the text its output is judged against cannot drift apart.
 */
function templateBodyText(template) {
  if (!template) return '';
  if (typeof template.body === 'string' && template.body) return template.body;
  const bodies = template.bodies && typeof template.bodies === 'object' ? template.bodies : {};
  return Object.values(bodies).filter((b) => typeof b === 'string').join('\n');
}

function renderGeneratorPrompt({ generatorBody, template, projectContext, codelineContext, mintedRoles, refusal }) {
  let out = generatorBody
    .split('__GEN_TEMPLATE_ID__').join(template.id)
    .split('__GEN_TEMPLATE_DESCRIPTION__').join(template.description || '')
    // A MULTI-BODY TEMPLATE HAS NO .body, AND join(undefined) IS A COMMA.
    //
    // 21 templates carry `bodies` instead of `body`. This read template.body — undefined for every
    // one of them — and String.prototype.join(undefined) falls back to its DEFAULT separator, so
    // the generator prompt received the single character "," where the template should have been.
    // The model was asked to rewrite a comma, could not possibly preserve the placeholders it had
    // never seen, and the shape guard refused all three attempts for "dropped placeholder(s)".
    //
    // That aborted mock3 runs 9 and 10 at skill-assessment-prephase, each after ~29 single-body
    // templates had generated cleanly — and it was invisible because the refusal named the
    // placeholders rather than the empty input that caused them to be missing.
    //
    // Joined the way checkGeneratedPrompt already joins them, so the text the model is given and
    // the text its output is checked against are the same text. Two readers of one template that
    // disagree is the defect this whole file keeps meeting.
    .split('__GEN_TEMPLATE_PLACEHOLDERS__').join((template.placeholders || []).join(', ') || '(none)')
    // THE SAME LIST THE CONTRACT CHECK WILL JUDGE IT AGAINST, from the same function, so the
    // generator cannot be refused for losing a field it was never told about.
    .split('__GEN_TEMPLATE_OUTPUT_FIELDS__').join(
      // eslint-disable-next-line global-require
      (require('./project-prompt-contract.js').outputFieldsIn(templateBodyText(template)) || []).join(', ') || '(none)')
    .split('__GEN_PROJECT_CONTEXT__').join(projectContext || '')
    .split('__GEN_CODELINE_CONTEXT__').join(codelineContext || '')
    .split('__GEN_MINTED_ROLES__').join(mintedRoles || '')
    // THE RETRY MUST BE TOLD WHY — re-sending an identical instruction gets an identical answer,
    // and the refusal is the only new information the next attempt has. The words that carry it
    // are the GENERATOR PROMPT'S, not this file's: they used to be appended here in JavaScript,
    // where the prompt layer could not review them, the drift checks could not see them, and no
    // project could change them. roster-specialisation.json has always done it this way.
    //
    // An absent refusal substitutes empty, so a first attempt carries no heading for a refusal
    // that never happened.
    .split('__GEN_PREVIOUS_REFUSAL__').join(refusalBlock(refusal, 'prompt'));

  // THE TEMPLATE BODY GOES IN LAST, AND THIS ORDER IS THE WHOLE POINT.
  //
  // Three of the generator's own placeholders — __PROJECT_CONTEXT__, __CODELINE_CONTEXT__ and
  // __PREVIOUS_REFUSAL__ — are ALSO placeholders in templates it has to specialise. The body was
  // embedded first and the value substitutions then ran across the entire string, so the embedded
  // template's own placeholders were replaced with real project text before the model ever saw
  // them. It was then refused for "dropping" placeholders it was never shown.
  //
  // Live 2026-08-27: roster-specialisation refused on exactly those three, on every attempt and on
  // every rung, because no model can reproduce a token that is not in its input. Same shape as the
  // join(undefined) comma that aborted runs 9 and 10 — the input was wrong, and the refusal
  // described the output.
  //
  // Substituted last, the body is inert text by the time it arrives: nothing after this line can
  // reach inside it.
  out = out.split('__GEN_TEMPLATE_BODY__').join(templateBodyText(template));
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
 * @param {Function} [o.reviewPrompt]      async ({id,template,generated}) => {ok, reason}
 *                                         falsifies the derivative's claims about the project;
 *                                         omitted means no review, exactly as before
 * @param {string}   o.projectContext      what this project is
 * @param {string}   o.codelineContext     codelines and declared dependencies
 * @param {string}   o.mintedRoles         the roles the mint just produced
 * @param {number}   [o.attempts=3]        generation attempts per prompt
 * @param {Function} [o.log]               progress sink
 * @returns {Promise<{copied:string[], generated:string[]}>}
 */
/**
 * WHAT NEEDS A PROJECT COPY — resolved from the registry, with bootstrap supplying only what the
 * registry cannot know.
 *
 * Pure and exported so the contract is assertable without provisioning anything.
 *
 * THE REGISTRY IS THE SOURCE. A seam declaring `template: X` IS the statement that X needs a
 * project copy. bootstrap.generated used to restate 25 of those by hand, and a hand-kept copy of a
 * derivable fact only ever drifts: seven seam-run templates had already fallen out of it, the last
 * being prompt-review — a seam added by the very session that documented the drift at six.
 *
 * bootstrap now carries ONLY auxiliary prompts: sub-prompts referenced INSIDE a template body
 * (retry prefixes, hint bodies) which no seam names and which deriving alone would drop.
 *
 * A seam naming a template that exists NOWHERE throws. Under the old union that was rescued into
 * silence; the registry being the source means a gap in it is an error, not something bootstrap
 * quietly covers for.
 *
 * @param {object} o.bootstrap        parsed bootstrap.json
 * @param {object} o.registry         parsed invocation-profiles.json
 * @param {function} [o.templateExists] (id) => bool; defaults to assuming it does
 * @returns {string[]} template ids needing a generated project copy
 */
function provisioningList({ bootstrap = {}, registry = {}, templateExists = () => true }) {
  const copyVerbatim = Array.isArray(bootstrap.copyVerbatim) ? bootstrap.copyVerbatim : [];
  const aux = Array.isArray(bootstrap.generated) ? bootstrap.generated : [];

  const seamRun = [...new Set(
    Object.values(registry.profiles || {}).map((p) => p && p.template).filter(Boolean),
  )];

  const orphaned = seamRun.filter((t) => !templateExists(t));
  if (orphaned.length) {
    throw new Error(
      `[prompt-builder] seam registry names template(s) that exist nowhere: ${orphaned.join(', ')}. `
      + 'A seam that runs a template with no file cannot be provisioned, and provisioning around it '
      + 'would leave that seam executing nothing. Add the template, or correct the seam.');
  }

  // Union of the two KINDS, not of two copies of one kind: seam-declared, plus the auxiliaries the
  // registry has no way to see. copyVerbatim is installed unchanged and is never generated.
  return [...new Set([...seamRun, ...aux])].filter((t) => !copyVerbatim.includes(t));
}

async function buildProjectPrompts({
  templatesDir, bootstrapFile, registryFile, projectConfigDir, runText, reviewPrompt,
  projectContext, codelineContext, mintedRoles, attempts = 3, mode = 'generate', log = () => {},
}) {
  // SAY WHICH IT WAS. This reviewer is opt-in (registry: prompt-review.optIn), and a run with no
  // reviewer looked exactly like a run whose reviewer approved everything — 35 prompts
  // provisioned, "REVIEW REJECTED: 0". Silence is not a clean bill of health, so the run states
  // plainly that these prompts went in unexamined. Turned on per project via
  // EPAM_PROMPT_REVIEW_ENABLED; see mint-agents-step.js.
  if (typeof reviewPrompt === 'function') {
    log('[prompt-builder] prompt review ENABLED — each generated prompt is falsified before install');
  } else {
    log('[prompt-builder] prompt review is OFF — generated prompts are installed NOT REVIEWED '
      + '(this project set EPAM_PROMPT_REVIEW_ENABLED=0 — review is ON by default)');
  }

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
    // ONE RESOLUTION, ONE PLACE. provisioningList is the contract, asserted directly by
    // test/unit/orchestration/bootstrap-duplicates-the-seam-registry.test.ts; computing the list a
    // second time here is how the two would come to disagree.
    generated = provisioningList({
      bootstrap: boot,
      registry: readJson(registryFile),
      templateExists: (id) => fs.existsSync(path.join(templatesDir, `${id}.json`)),
    });
    log(`[prompt-builder] ${generated.length} template(s) need a project copy `
      + '(seam-declared, plus bootstrap auxiliaries)');
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
  // WHERE THE TEMPLATES ARE BEING READ FROM, said once.
  //
  // Run 20260817T211517Z installed a copy whose seams did not match its template and whose
  // provenance digest was empty — a value buildGeneratedDoc cannot produce. The same code
  // reproduces correctly offline, so what differs is which FILE was read, and nothing recorded
  // that. One line here answers it instead of another run spent guessing.
  log(`[prompt-builder] templates read from ${templatesDir}`);

  // ── REUSE: DO NOT PAY TWICE FOR THE SAME PROMPT ──────────────────────────────────────────
  //
  // The pre-run reset deletes <project>/prompts every run, so every prompt was regenerated from
  // unchanged immutable templates. Measured on mock3 run 9: 29 prompts, $5.48 — 89% of the run's
  // cost, before a single story was touched.
  //
  // The obstacle is __MINTED_ROLES__: the mint invents new role names every run, so a digest over
  // all inputs never matches. But of run 9's 31 generated prompts only FOUR embed a minted role
  // name. Whether a template's OUTPUT depends on the roster is a fact about that template, and it
  // is knowable — after generating once, by looking at what it produced.
  //
  // Each entry records both digests and which one governs it: a prompt naming a minted role is
  // regenerated when the roster changes, one that does not is reused. Nothing is guessed — a
  // template not in the cache is always generated.
  //
  // The cache lives OUTSIDE prompts/ so the reset's clean slate is untouched. This is memoisation
  // on an exact key, not surviving state.
  const cacheDir = path.join(outDir, '..', '.prompt-cache');
  const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
  const baseDigest = (t) => sha(JSON.stringify({ t, generatorBody, projectContext, codelineContext }));
  const rolesDigest = sha(String(mintedRoles || ''));
  const usesRoles = (doc, roles) => {
    const names = String(roles || '').match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g) || [];
    const body = JSON.stringify(doc);
    return names.some((n) => body.includes(n));
  };
  const cacheRead = (id) => {
    try { return JSON.parse(fs.readFileSync(path.join(cacheDir, `${id}.json`), 'utf8')); }
    catch { return null; }
  };
  const cacheWrite = (id, entry) => {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, `${id}.json`), JSON.stringify(entry, null, 2) + '\n');
    } catch { /* a cache that cannot be written costs money, never correctness */ }
  };

  // THE REVIEWER'S OWN PROMPT IS PROVISIONED FIRST, because it cannot review anything until it
  // exists. In run 20260827T151832Z it was generated 32nd of 39: the first 31 prompts were
  // handed to a reviewer whose prompt was not on disk yet, the render failed, and every one of
  // them was installed UNREVIEWED — while the log said review was enabled.
  //
  // Ordering only. Nothing is skipped and nothing is generated twice; the reviewer is simply
  // built before the artefacts it must judge.
  // WHICH prompt is the reviewer's is DERIVED, never named here: it is the template run by the
  // seam that produces the prompt verdict. A literal would put a seam's identity in engine code
  // and go stale the moment the seam is renamed.
  const _reviewerTemplate = (() => {
    try {
      const _reg = registryFile && fs.existsSync(registryFile) ? readJson(registryFile) : null;
      for (const prof of Object.values((_reg && _reg.profiles) || {})) {
        if (prof && prof.produces === 'prompt-verdict' && prof.template) return prof.template;
      }
    } catch { /* absent stays absent — provisioning order is then unchanged */ }
    return '';
  })();
  if (_reviewerTemplate) {
    generated = [...generated].sort((a, b) => (a === _reviewerTemplate ? -1
      : b === _reviewerTemplate ? 1 : 0));
  }
  for (const id of generated) {
    const template = readJson(path.join(templatesDir, `${id}.json`));
    // Per-template, only when it could matter: a template whose seam name differs from its id is
    // the one case where losing `seams` is visible at all. 36 of 37 hide the same rewrite.
    if (Array.isArray(template.seams) && template.seams.some((sm) => sm !== template.id)) {
      log(`[prompt-builder] ${id}: template declares seams ${JSON.stringify(template.seams)}`);
    }
    // REUSE, before any model time is spent.
    const _base = baseDigest(template);
    const _hit = cacheRead(id);
    // A CACHE ENTRY IS ONLY A HIT IF IT PASSED THE GATES THAT APPLY NOW.
    //
    // The key was (template, generatorBody, contexts) and said nothing about REVIEW. So when
    // review was finally switched on, 39 entries written while it was off were reused verbatim —
    // never regenerated, therefore never reviewed — and the run logged "prompt review ENABLED"
    // while reviewing almost nothing.
    //
    // Memoisation on inputs must also be keyed on the gates the artefact passed. An entry made
    // without review is a MISS while review is on; one made WITH review stays a hit, so the cache
    // keeps paying for itself.
    const _reviewNow = typeof reviewPrompt === 'function';
    if (_hit && _reviewNow && _hit.reviewed !== true) {
      log(`[prompt-builder] ${id}: cached copy predates prompt review — regenerating so it is reviewed`);
    }
    if (_hit && (!_reviewNow || _hit.reviewed === true) && _hit.base === _base && (!_hit.usesRoles || _hit.roles === rolesDigest)) {
      fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(_hit.doc, null, 2) + '\n');
      built.push(id);
      log(`[prompt-builder] reused ${id} (inputs unchanged${_hit.usesRoles ? ', roster unchanged' : ''})`);
      continue;
    }

    let refusal = '';
    let callFailure = '';
    let installed = false;

    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
      const prompt = renderGeneratorPrompt({
        generatorBody, template, projectContext, codelineContext, mintedRoles, refusal,
      });
      // A CALL THAT NEVER CAME BACK IS THE MOST RETRYABLE FAILURE THERE IS.
      //
      // This loop already retries a prompt that came back WRONG — a dropped placeholder is refused,
      // the reason is fed back, the next attempt corrects it. A call that THREW escaped the loop
      // entirely, out of buildProjectPrompts and out of the mint step.
      //
      // Live 2026-08-17, run 20260817T185759Z: "prompt runner timed out after 360000ms" destroyed
      // the estate survey, the minted roster, the story assignment and 12 already-generated
      // prompts — 30 minutes into the first run that had cleared every earlier stage correctly.
      // One slow call out of 51.
      //
      // Nothing is known to be wrong with the request; it simply did not finish. So it costs one
      // attempt, exactly as a refusal does — but stays DISTINGUISHABLE from one, because a
      // contract refusal is fixed in the prompt and a failed call is fixed in the budget or the
      // provider, and collapsing them sends the reader to the wrong file.
      let body;
      try {
        body = String((await runText(prompt, { id, attempt })) || '');
      } catch (err) {
        const why = (err && err.message) || String(err);
        callFailure = why;
        refusal = `the previous attempt did not come back: ${why}. Nothing was found wrong with `
          + 'your answer — it never arrived. Produce the same prompt again.';
        log(`[prompt-builder] ! ${id} attempt ${attempt}/${attempts} CALL FAILED: ${why}`);
        continue;
      }
      const doc = buildGeneratedDoc(template, body);
      const verdict = checkGeneratedPrompt(template, doc);

      if (verdict.ok) {
        // THE CONTRACT CHECK PROVES IT IS WIREABLE, NOT THAT IT IS TRUE.
        //
        // checkGeneratedPrompt verifies placeholders in and out. A derivative can satisfy that
        // completely and still tell an agent this codeline's tests live in a directory it does
        // not have, or that a dependency is present when it is not — and install cleanly, because
        // every placeholder was in the right place. The agent then inherits the claim as
        // instruction and nothing later questions it.
        //
        // The roster already gets this treatment: roster-review reads the repositories and
        // falsifies a generated brief before any implementer inherits it. reviewPrompt is that
        // reviewer pointed at prompts. It is OPTIONAL — a caller that supplies none provisions
        // exactly as before, so this cannot block a project that has not adopted it.
        if (typeof reviewPrompt === 'function') {
          const review = await reviewPrompt({ id, template, generated: doc });
          if (review && review.ok === false) {
            refusal = `a review of this prompt found claims about the project that are false: ${review.reason}`;
            log(`[prompt-builder] ! ${id} attempt ${attempt}/${attempts} REVIEW REJECTED: ${review.reason}`);
            continue;
          }
        }

        // Written only once the contract passes AND the review found nothing false — never a
        // partial, a refused, or an unreviewed-but-rejected prompt.
        fs.writeFileSync(path.join(outDir, `${id}.json`), JSON.stringify(doc, null, 2) + '\n');
        built.push(id);
        installed = true;
        // Whether this template's OUTPUT depends on the roster is decided by looking at what it
        // produced, not guessed from what it was handed.
        cacheWrite(id, { base: _base, roles: rolesDigest, usesRoles: usesRoles(doc, mintedRoles), doc,
          // The gate this artefact passed, so a later run cannot reuse an unreviewed prompt.
          reviewed: typeof reviewPrompt === 'function' });
        log(`[prompt-builder] generated ${id} (attempt ${attempt}/${attempts})`);
        break;
      }
      refusal = verdict.reason;
      // THE REFUSED TEXT IS THE ONLY EVIDENCE OF WHY, AND IT WAS THROWN AWAY.
      //
      // The log records WHICH placeholders went missing; the model's actual answer — the thing
      // that would say whether it emitted JSON, truncated, or rewrote the body — was discarded
      // the moment the verdict came back. Run 20260827T092415Z aborted on 'tc-writer' after three
      // refusals and left nothing to read, so the cause had to be inferred from the symptom. The
      // comment at the top of this file records the same blindness misdiagnosing runs 9 and 10.
      //
      // Generated output must be persisted — a refused artefact most of all, because it is the
      // only one nobody can regenerate by rerunning a step that now succeeds.
      try {
        const refusedDir = path.join(outDir, '.refused');
        fs.mkdirSync(refusedDir, { recursive: true });
        fs.writeFileSync(
          path.join(refusedDir, `${id}.attempt-${attempt}.txt`),
          `# refused: ${verdict.reason}\n`
          + `# template: ${id}   attempt: ${attempt}/${attempts}\n`
          + `# required placeholders: ${(template.placeholders || []).join(', ') || '(none)'}\n`
          + `# ---------------- model reply below, verbatim ----------------\n`
          + body);
      } catch (e) {
        // Never let evidence-keeping break the build it is evidence about.
        log(`[prompt-builder] (could not persist refused ${id} attempt ${attempt}: ${e.message})`);
      }
      // THE ANALYST SEES THE REFUSED PROMPT ITSELF, not just which placeholder went missing.
      // Seven generations were refused across runs 13 and 14 and none reached self-heal.
      try {
        // eslint-disable-next-line global-require
        const _sh = require('./self-heal.js').selfHeal({
          agent: `prompt-builder:${id}`, reason: verdict.reason, output: body,
    // The rung that produced it — without this the analyst declines and heals nothing.
    model: process.env.EPAM_MODEL || '', provider: process.env.AI_PROVIDER || '',
    projectConfigDir: process.env.EPAM_PROJECT_CONFIG_DIR || '',
          context: `template ${id} requires: ${(template.placeholders || []).join(', ')}`,
        });
        if (_sh.rc === 2) log(`[prompt-builder] self-heal analyst FAILED for ${id} — attempt ${attempt + 1} has no corrective`);
      } catch { /* a diagnostic must never fail the run it is diagnosing */ }
      log(`[prompt-builder] ! ${id} attempt ${attempt}/${attempts} refused: ${verdict.reason}`);
    }

    if (!installed) {
      // No fallback. The template is never executed, so there is nothing to degrade to, and
      // a project missing one prompt must not look provisioned.
      throw new Error(
        `[prompt-builder] could not generate a valid '${id}' in ${attempts} attempt(s). `
        + (callFailure
          ? `The call itself failed: ${callFailure}. That is a budget or provider problem, not a `
            + 'prompt one — check the seam\'s declared timeoutSecs before changing the template.'
          : `Last refusal: ${refusal}`));
    }
  }

  return { copied, generated: built };
}

module.exports = { buildProjectPrompts, renderGeneratorPrompt, provisioningList,
  // Exported so the prompt REVIEWER reads a template the same way the generator and the
  // contract check do. Three readers of one shape is how the last three of these drifted.
  templateBodyText };
