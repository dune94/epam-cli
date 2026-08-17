#!/usr/bin/env node
/**
 * LINK THE PROMPTS TO THE AGENTS THIS RUN MINTED.
 *
 * Minting and provisioning happened in the same stage and knew nothing about each other. The
 * builder walked a static list in bootstrap.json; the mint separately resolved every minted
 * agent to a seam. Nothing ever asked the question that decides whether the run can proceed:
 *
 *     this run minted `mock3-fare-investigator`. It enters at seam `code-graph-detective`.
 *     Does a prompt for that seam exist IN THIS PROJECT?
 *
 * Nobody asked, so the answer arrived the expensive way — prompt-library throws at whichever
 * seam needed it, mid-run, after the roster is minted and the run is already spending. That is
 * the failure the builder's own header says it exists to prevent, coming through the one door
 * it did not cover.
 *
 * Operator, 2026-08-16: "this is a pipeline activity then linking the prompts to the new agents
 * and seams."
 *
 * THE CHAIN THIS COMPLETES:
 *
 *     template (id)  ->  project prompt (same id)  ->  seam(s)  ->  minted agent
 *      declares seams      installed by the builder     profile      resolved by rule
 *
 * The first three hops are recorded in the documents themselves. This is the fourth, and it is
 * the only one that cannot be: which agents exist is not known until the roster is minted.
 *
 * DECIDABLE WITHOUT A MODEL. Roster, registry and installed library are all on disk, so this
 * costs nothing and can run before any story does — the same argument validateWorkflow makes
 * for checking a roster can run before running it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { resolveSeam } = require('./seam-invocation.js');

/** Every prompt installed for this project, by id. */
function installedPrompts(projectConfigDir) {
  const dir = path.join(projectConfigDir, 'prompts');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch (_) {
    throw new Error(
      `[prompt-link] this project has no prompts directory at ${dir}. The mint provisions it; `
      + 'if provisioning ran, it failed before writing anything.');
  }
  const byId = {};
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    try {
      byId[id] = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (e) {
      // A prompt that cannot be parsed is not "absent" — say which one, because the seam it
      // serves will otherwise be reported as unprovisioned and send the reader to the wrong file.
      throw new Error(`[prompt-link] installed prompt '${id}' is not readable JSON: ${e && e.message}`);
    }
  }
  return byId;
}

/**
 * Which installed prompts serve which seam — DERIVED FROM THE REGISTRY.
 *
 * The registry already declares this: a seam names the template it runs. Every prompt document
 * ALSO carried a `seams` array, and this function used to read that instead — a hand-maintained
 * inverse index of something already derivable, and the two drifted.
 *
 * Live 2026-08-17, run 20260817T211517Z: 37 prompts provisioned successfully, then the link failed
 * because the installed copy of failure-analyst said seams ["failure-analyst"] where its template
 * says ["impl-failure-analyst"]. Worse, `failure-analyst` is the template for BOTH
 * agent-failure-analyst and impl-failure-analyst, and one array cannot name two seams — so even a
 * byte-perfect copy left one of them unlinked. The relationship was unrepresentable, not merely
 * mis-copied. And 36 of 37 prompts hid it, because for them the seam name equals the template id.
 *
 * Reading the source instead removes all of it at once: no drift, N:1 works, and a prompt document
 * no longer restates something the registry owns.
 */
function promptsBySeam(installed, registry) {
  const bySeam = {};
  for (const [seam, profile] of Object.entries((registry && registry.profiles) || {})) {
    const tpl = profile && profile.template;
    if (!tpl) continue;                       // a seam with no template has no prompt to link
    if (!Object.prototype.hasOwnProperty.call(installed, tpl)) continue;
    (bySeam[seam] = bySeam[seam] || []).push(tpl);
  }
  for (const list of Object.values(bySeam)) list.sort();
  return bySeam;
}

/**
 * Link every agent in the roster to its seam and to the prompts that seam runs on.
 *
 * @param {object}   o
 * @param {string}   o.projectConfigDir  where the installed library lives
 * @param {string}   o.registryFile      invocation-profiles.json
 * @param {string[]} o.agents            the roster this run minted
 * @param {object}   [o.env]             for seam resolution; pass {} to ignore ambient config
 * @param {boolean}  [o.write=true]      persist the artefact
 * @returns {{agents:Object, seamsInUse:string[], promptsBySeam:Object}}
 */
function linkPromptsToRoster({ projectConfigDir, registryFile, agents, env, write = true }) {
  if (!projectConfigDir) throw new Error('[prompt-link] projectConfigDir is required');
  const roster = Array.isArray(agents) ? agents.filter(Boolean) : [];

  const installed = installedPrompts(projectConfigDir);
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  const bySeam = promptsBySeam(installed, registry);

  const out = {};
  const seamsInUse = new Set();
  const unserved = [];

  for (const agent of roster) {
    // Resolution throws when nothing matches, and that throw is correct here: an agent with no
    // seam has no ladder, no budget and no prompt, so there is nothing to link it to. Let it
    // through rather than reporting a prompt gap for what is really a seam gap.
    const seam = resolveSeam(agent, registryFile, { env });
    seamsInUse.add(seam);

    const prompts = bySeam[seam] || [];
    if (!prompts.length) unserved.push({ agent, seam });
    out[agent] = { seam, prompts };
  }

  if (unserved.length) {
    // NAME THE SEAM, not only the agent. An error naming just the agent leaves the reader to
    // work out which of the registry's seams it entered at and which prompt that seam wanted.
    // This step already knows both, and knowing them is the whole reason it exists.
    const detail = unserved
      .map(({ agent, seam }) => {
        const want = ((registry.profiles || {})[seam] || {}).template;
        return `  ${agent}  ->  seam '${seam}'  ->  needs template `
          + `'${want || '(the seam declares none)'}', which is not installed`;
      })
      .join('\n');
    throw new Error(
      `[prompt-link] ${unserved.length} minted agent(s) enter at a seam this project has no prompt `
      + `for, so they would fail at their first invocation rather than here:\n${detail}\n`
      + 'The builder did not provision that template. The seam->template link is the registry\'s '
      + 'to state and this step reads it directly, so a prompt no longer has to declare anything.');
  }

  const artefact = {
    _what: 'Which prompt each agent this run minted will actually run on, and the seam that '
      + 'joins them. Derived at mint time from the roster, the registry and the installed '
      + 'library; written down because a link held only in memory cannot answer "why did this '
      + 'agent get that prompt" after the run is over.',
    agents: out,
    seamsInUse: [...seamsInUse].sort(),
    promptsBySeam: bySeam,
  };

  if (write) {
    // Persisted at derivation time, in the project's own directory: un-persisted output is a
    // defect, and this is exactly the record an operator wants when an agent behaved oddly.
    fs.writeFileSync(
      path.join(projectConfigDir, 'prompt-agent-link.json'),
      JSON.stringify(artefact, null, 2) + '\n');
  }
  return artefact;
}

module.exports = { linkPromptsToRoster, promptsBySeam, installedPrompts };
