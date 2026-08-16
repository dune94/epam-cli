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
 * Which installed prompts serve which seam.
 *
 * Read from the prompts themselves — each declares the seams it serves — rather than by
 * matching a prompt id against a seam name. Name-matching is what lost the link between
 * `qa-gate:sast` and `qa-sast-sentinel`, and it would silently drop every prompt whose name
 * differs from its seam's, which is most of the interesting ones.
 */
function promptsBySeam(installed) {
  const bySeam = {};
  for (const [id, doc] of Object.entries(installed)) {
    for (const seam of doc.seams || []) {
      (bySeam[seam] = bySeam[seam] || []).push(id);
    }
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
  if (!roster.length) throw new Error('[prompt-link] the roster is empty — nothing to link');

  const installed = installedPrompts(projectConfigDir);
  const bySeam = promptsBySeam(installed);

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
      .map(({ agent, seam }) => `  ${agent}  ->  seam '${seam}'  ->  no installed prompt declares it`)
      .join('\n');
    throw new Error(
      `[prompt-link] ${unserved.length} minted agent(s) enter at a seam this project has no prompt `
      + `for, so they would fail at their first invocation rather than here:\n${detail}\n`
      + 'Either the builder did not provision that seam\'s template, or the template does not '
      + 'declare the seam it serves.');
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
