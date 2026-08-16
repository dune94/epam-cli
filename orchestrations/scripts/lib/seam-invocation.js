/**
 * seam-invocation — the model settings ANY agent is configured to run with.
 *
 * WHICH seam an agent belongs to is data. WHICH ladder that seam climbs is data. WHAT models a
 * ladder contains is the project's, as EPAM_MODEL_LADDER_<NAME> in its own config. No agent
 * name, seam name or pattern appears in this file — adding an agent kind is a registry edit,
 * adding a model is a project edit, and neither is ever an edit to the engine.
 *
 * RESOLUTION IS TOTAL.
 *
 * This used to look up an agent by exact name and return {} when it found nothing, and called
 * that intentional: "A seam with no entry gets {} and runs on whatever the run already
 * provides." That is fine for a registry of hand-written names and impossible for a pipeline
 * that MINTS its agents. A 2026-08-11 run minted 64 — gotransit-investigator,
 * upexpress-investigator, contentstack-live-preview-integration-engineer — against 17 names
 * written before the project existed. Every one of them resolved to {}: no ladder, no declared
 * effort, no temperature, and nothing said so.
 *
 * Operator, 2026-08-12: "you cannot just say after mint - oh, it has no seam and then treat it
 * as a bug - that will not work at all and is a poor design."
 *
 * So every agent resolves, in this order:
 *
 *   1. EXACT PROFILE      the agent is named in the registry
 *   2. DECLARED PATTERN   registry.seamPatterns maps a name shape to a seam
 *   3. DECLARED DEFAULT   registry.defaultSeam
 *   4. THROW              never {}
 *
 * A registry that declares neither a matching pattern nor a default cannot describe its own
 * pipeline, and saying so loudly is the whole point: the failure belongs at mint time, where
 * it can be fixed, not three hours into a run as an agent quietly running unconfigured.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function registryPath(agentsDir) {
  if (process.env.AGENT_PROFILES_REGISTRY) return process.env.AGENT_PROFILES_REGISTRY;
  const dir = agentsDir || path.join(__dirname, '..', '..', 'agents');
  return path.join(dir, 'invocation-profiles.json');
}

function readRegistry(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`invocation registry unreadable (${file}): ${e && e.message}`);
  }
}

/**
 * The seam an agent belongs to. Throws rather than guessing.
 *
 * @param {string} agent      any agent name, minted or hand-written
 * @param {string} [file]     registry path; defaults to the shipped one
 */
/**
 * Resolve a POSITION in the project's declared tier order to that project's own tier name.
 *
 * The order is lowest → highest, so:
 *   base -> the first tier the project declares
 *   top  -> the last
 *   mid  -> the middle one, biased low when the count is even, because over-spending is the
 *           more expensive mistake and a seam asking for "mid" is not asking for the ceiling.
 *
 * Returns '' when no order is available; the caller reports that rather than guessing a name.
 */
function resolveTierPosition(position, sourceEnv) {
  const order = String((sourceEnv && sourceEnv.EPAM_MODEL_LADDER_TIER_ORDER) || '')
    .split(/[\s,]+/).filter(Boolean);
  if (!order.length) return '';
  const p = String(position || '').trim().toLowerCase();
  if (p === 'base') return order[0];
  if (p === 'top') return order[order.length - 1];
  if (p === 'mid') return order[Math.floor((order.length - 1) / 2)];
  // Not a position: a project tier name may still be passed through unchanged, so an older
  // registry keeps working while it is being migrated.
  return order.includes(p) ? p : '';
}

function resolveSeam(agent, file, opts) {
  if (!agent) throw new Error('cannot resolve a seam for an empty agent name');
  // ignoreXref: resolve from the RULES alone, as if this agent had never been mapped. The mint
  // needs this to re-derive an entry it wrote itself — reading the cross-reference there would
  // return the stale answer and a corrected rule could never land. Every other caller wants the
  // recorded decision and gets it.
  const _ignoreXref = !!(opts && opts.ignoreXref);
  const reg = readRegistry(file || registryPath());
  const profiles = reg.profiles || {};

  // 1. Exact name always wins, so a specifically-configured agent is never captured by a
  //    pattern meant for a family.
  if (profiles[agent]) return agent;

  // 2. The explicit cross-reference: this agent enters by this seam. Named agents that are
  //    not themselves profiles live here, and an entry always beats a pattern — a family rule
  //    must never override a decision someone made deliberately about one agent.
  const xref = _ignoreXref ? {} : (reg.agentSeams || {});
  if (Object.prototype.hasOwnProperty.call(xref, agent)) {
    const seam = xref[agent];
    if (!profiles[seam]) {
      throw new Error(`agentSeams maps '${agent}' to profile '${seam}', which the registry does not define`);
    }
    return seam;
  }

  // 2. Declared patterns. The registry owns the shapes; this file owns none of them.
  for (const rule of Array.isArray(reg.seamPatterns) ? reg.seamPatterns : []) {
    if (!rule || !rule.match || !rule.seam) continue;
    let re;
    try {
      re = new RegExp(rule.match);
    } catch (e) {
      throw new Error(`invocation registry has an invalid seamPattern '${rule.match}': ${e && e.message}`);
    }
    if (!re.test(agent)) continue;
    if (!profiles[rule.seam]) {
      throw new Error(
        `seamPattern '${rule.match}' matched agent '${agent}' but names profile '${rule.seam}', which the registry does not define`);
    }
    return rule.seam;
  }

  // 3. A declared default, which must itself be real.
  if (reg.defaultSeam) {
    if (!profiles[reg.defaultSeam]) {
      throw new Error(`registry defaultSeam '${reg.defaultSeam}' names a profile that does not exist`);
    }
    return reg.defaultSeam;
  }

  // 4. Never {}.
  throw new Error(
    `agent '${agent}' resolves to no seam: it is not a named profile, no seamPattern matches it, ` +
    'and the registry declares no defaultSeam. A minted agent must be able to enter the ' +
    'pipeline — add a pattern or a default rather than leaving it unconfigured.');
}

/**
 * The environment an agent's seam is configured to run with.
 *
 * @param {string} agent
 * @param {string} [agentsDir]
 * @param {{registryFile?: string, env?: object}} [opts]
 */
function seamInvocationEnv(agent, agentsDir, opts) {
  if (!agent) return {};
  const o = opts || {};
  const file = o.registryFile || registryPath(agentsDir);
  const sourceEnv = o.env || process.env;

  const seam = resolveSeam(agent, file);
  const profile = (readRegistry(file).profiles || {})[seam];
  if (!profile) return {};

  const env = {};
  if (profile.reasoningEffort) env.EPAM_REASONING_EFFORT = String(profile.reasoningEffort);
  if (profile.temperature !== undefined && profile.temperature !== '') {
    env.EPAM_TEMPERATURE = String(profile.temperature);
  }
  if (profile.ladder) {
    // A SEAM DECLARES A POSITION; THE PROJECT SUPPLIES THE NAME.
    //
    // The registry used to name tiers literally ('HIGHEST', 'medium'). llm-settings.json
    // already said that was wrong in its own words — "the engine holds no ordering of its
    // own" — and a project naming its tiers anything else left every seam pointing at a tier
    // it does not have. Live on hello-dolly: twenty seams asked for HIGHEST, the project
    // declared only high and medium, and all twenty ran with no escalation chain because the
    // miss below is reported and then continued past.
    //
    // ladderTierOrder is declared lowest-to-highest by the project and exported by
    // model-ladders.sh. Positions are resolved against it, so they hold whatever a project
    // calls its tiers and however many it declares.
    const tierName = resolveTierPosition(profile.ladder, sourceEnv);
    if (!tierName) {
      process.stderr.write(
        "[seam-invocation] seam '" + seam + "' asks for ladder position '" + profile.ladder +
        "' but EPAM_MODEL_LADDER_TIER_ORDER is unset or empty — the project declares no tier " +
        "order, so no position can be resolved\n");
    }
    const key = 'EPAM_MODEL_LADDER_' + String(tierName || profile.ladder).toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const rungs = sourceEnv[key];
    if (rungs) {
      // The ladder this seam climbs, under the generic name every consumer reads.
      env.EPAM_MODEL_LADDER = rungs;
      // WHERE THIS SEAM STARTS — declared, not inferred.
      //
      // This used to take the first pair's "from". A modelLadder is a set of HOPS with several
      // independent roots (MiniMax, zhipuai, z-ai, moonshotai all appear in one map), so that
      // picked whichever root was listed first in the JSON and made every seam's opening model a
      // property of text ordering. Reordering the file changed which model every agent began on,
      // with nothing to indicate it had.
      const declaredStart = (sourceEnv[key + '_START'] || '').trim();
      if (declaredStart) {
        env.EPAM_MODEL = declaredStart;
      } else {
        // Absent stays absent: the seam keeps whatever model it would otherwise resolve, and the
        // gap is stated rather than filled with a root chosen by accident.
        process.stderr.write(
          "[seam-invocation] seam '" + seam + "' climbs ladder '" + profile.ladder +
          "' which declares no startModel — not inferring one from map order; the seam will start " +
          "on whatever model it resolves for itself\n");
      }
    } else {
      // Not fatal: the seam is resolved and its effort/temperature still apply. But a ladder
      // that cannot be reached is not a ladder assignment, so it is never silent.
      process.stderr.write(
        `[seam-invocation] agent '${agent}' resolved to seam '${seam}' which asks for ladder ` +
        `'${profile.ladder}', but ${key} is unset in this process — no model or escalation ` +
        'chain will be applied\n');
    }
  }
  return env;
}

// resolveTierPosition is exported because the SHELL side needs the same answer: a profile
// declares a position, and two places must not each decide what a position means.
module.exports = { seamInvocationEnv, resolveSeam, registryPath, resolveTierPosition };
