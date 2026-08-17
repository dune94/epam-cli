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

  // 3. WHAT THE AGENT SAYS IT IS, when its name matched nothing.
  //
  // The steps above key entirely off the NAME. The roster is model-authored, so the name is never
  // ours: run 20260817T181432Z minted exactly the right roster and died on
  // "'typescript-vitest-implementer' resolves to no seam" — a correctly declared implementer,
  // refused because the suffix rules know '-engineer' and '-fixer'.
  //
  // Proposals declare kind outright, so the archetype is stated rather than inferred. Read from
  // the SAME rules above, which already name a seam and now say which kind they serve; a separate
  // kind->seam table would be a second place to keep correct.
  //
  // Best-effort: many callers run in processes that never load a roster, and a kind lookup must
  // never turn a working resolution into a crash.
  const _kind = (() => {
    try {
      const pf = (opts && opts.profilesFile) || path.join(path.dirname(file || registryPath()), 'profiles.json');
      const entry = JSON.parse(fs.readFileSync(pf, 'utf8'))[agent];
      return (entry && typeof entry.kind === 'string') ? entry.kind.trim() : '';
    } catch { return ''; }
  })();
  if (_kind) {
    for (const rule of Array.isArray(reg.seamPatterns) ? reg.seamPatterns : []) {
      if (!rule || rule.kind !== _kind || !rule.seam) continue;
      if (!profiles[rule.seam]) continue;
      return rule.seam;
    }
  }

  // 4. A default the PROJECT declares — never one the engine holds.
  //
  // The registry used to carry defaultSeam: cpa-inference, so resolution could not fail. Every
  // unmatched agent silently became a planning agent and inherited its ladder, effort and tool
  // grants, and the mint's "fails if any agent resolves to nothing" guard could essentially
  // never fire. Seven gate-path agents were found running the wrong ladder for exactly this
  // reason, and nothing had reported anything. A safety net that catches everything catches
  // nothing.
  //
  // A project that genuinely wants unmatched agents absorbed says so in its own config. The
  // engine declares no default, so for everyone else an unmatched agent is a loud failure at
  // mint time — one line to fix, before any story runs — instead of a silent misconfiguration
  // discovered hours into a run.
  const declaredDefault = (opts && opts.defaultSeam)
    || ((opts && opts.env) || process.env).EPAM_DEFAULT_SEAM
    || '';
  if (declaredDefault) {
    if (!profiles[declaredDefault]) {
      throw new Error(`EPAM_DEFAULT_SEAM names '${declaredDefault}', which the registry does not define`);
    }
    return declaredDefault;
  }

  // 4. Never {}, and never a guess.
  throw new Error(
    `agent '${agent}' resolves to no seam: it is not a named profile and no seamPattern matches ` +
    'it. Add a seamPattern for its family, or an agentSeams entry for this one agent, or set ' +
    'EPAM_DEFAULT_SEAM in the project config if unmatched agents should share one seam. Leaving ' +
    'it unconfigured would run it with no ladder, no effort and no tool grants.');
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

  // THE SEAM THAT WAS RESOLVED, STAMPED ONCE, SO EVERY CONSUMER READS ONE IDENTITY.
  //
  // Call sites already name their seam — seamInvocationEnv('agent-mint', …) — and then separately
  // pass an unrelated literal for the cost label, the log tag and the dashboard row. Two identities
  // for one invocation, kept in step by hand.
  //
  // Live 2026-08-17, run 20260817T162132Z: phase-cost.jsonl recorded ESTATE_SURVEY, PROJECT_AGENTS,
  // ROSTER_REVIEW and ROLE_ASSIGNMENTS beside codeline-discovery and prompt-builder. Two of those
  // four name no seam at all (PROJECT_AGENTS is 'agent-mint', ROLE_ASSIGNMENTS is 'role-assigner'),
  // so per-agent spend could not be joined to the roster, the registry or the activity timeline —
  // and normalising the case would not have fixed it, because the names genuinely differ.
  //
  // Resolved, not declared: this is the seam the invocation ACTUALLY entered, including via a
  // seamPattern, so it stays correct for a minted agent whose name nobody wrote down anywhere.
  env.EPAM_SEAM = seam;

  if (profile.reasoningEffort) env.EPAM_REASONING_EFFORT = String(profile.reasoningEffort);
  if (profile.temperature !== undefined && profile.temperature !== '') {
    env.EPAM_TEMPERATURE = String(profile.temperature);
  }

  // WHAT THE SEAM IS ALLOWED TO DO, AND HOW LONG IT HAS.
  //
  // The registry has let a seam declare these for weeks and none of them were exported, so every
  // one was inert: story-writer declared bash,read_file,list_files,search and the writer received
  // no grant at all through this path. Same shape as a ladder that resolves to nothing — a
  // declaration nothing reads is documentation, and it reads as configuration.
  //
  // ABSENT STAYS ABSENT. An empty grant and a missing one differ downstream: "these zero tools"
  // would override a caller's own explicit grant, while "nothing configured here" lets it stand.
  if (profile.allowedTools !== undefined && profile.allowedTools !== '') {
    env.EPAM_ALLOWED_TOOLS = String(profile.allowedTools);
  } else if (profile.toolGrant) {
    // A GRANT KIND RESOLVES TO A LIST PER PROJECT, because part of the list belongs to the
    // project: a codeline that provisions the codegraph plugin grants codegraph_query, and a
    // project without it must not be handed a tool that does not exist. A literal list in the
    // registry freezes one project's answer into the engine — which is what allowedTools above
    // still does for the seams that carry one, and why nothing new should.
    //
    // Codeline paths come from the run, never from here: EPAM_CODELINE_PATHS is set by the
    // codeline loop, and PROJECT_ROOT is the single-codeline case.
    const src = (opts && opts.env) || process.env;
    const paths = String(src.EPAM_CODELINE_PATHS || src.PROJECT_ROOT || '')
      .split(/[,:]/).map((x) => x.trim()).filter(Boolean);
    try {
      const grant = require('./agent-tools.js').toolGrantFor(profile.toolGrant, paths);
      if (grant) {
        env.EPAM_ALLOWED_TOOLS = grant;
        // The channel and the list are separate switches: granting one without the other
        // produces an agent that quietly has nothing.
        env.AI_GATE_ALLOW_TOOLS = '1';
      }
    } catch (e) {
      // A seam asking for a grant this engine does not define is mis-declared. Say so rather
      // than silently running it with no tools, which looks identical to a seam that needs none.
      throw new Error(`[seam-invocation] '${agent}' -> seam '${seam}': ${e.message}`);
    }
  }
  // ── SKILLS: what this agent knows about THIS project, resolved at invocation ──────────────
  //
  // Not declared per seam, because a skill is not a property of the archetype: an -investigator on
  // a Rust service and one on a Node front end are the same seam and need different knowledge. It
  // is derived from what the project already has — the ecosystem registry (stack, manifest, test
  // command, declared dependencies) and the KB the pipeline itself wrote for THAT codeline, plus
  // the shared KB.
  //
  // Passed as a PATH, not as text. Skills grow with the KB, and an unbounded string in the
  // environment hits ARG_MAX exactly the way prompt values did — the failure being a command that
  // exits 126 with no output, three steps from the cause.
  //
  // Best-effort by design: a project on its first run has no KB and a codeline may not resolve.
  // An agent with no skills file behaves as it did before this existed; one that refuses to start
  // because the KB is empty would refuse every first run.
  try {
    const src = (opts && opts.env) || process.env;
    const cl = String(src.EPAM_CODELINE_PATH || src.PROJECT_ROOT || '');
    const all = String(src.EPAM_CODELINE_PATHS || '');
    const outDir = src.LOG_DIR || require('os').tmpdir();
    const skillsFile = path.join(outDir, `agent-skills-${String(agent).replace(/[^\w.-]/g, '_')}.json`);
    const out = require('child_process').execFileSync(process.execPath, [
      path.join(__dirname, 'handlers', 'agent-skills.js'), cl,
      path.join(__dirname, '..', '..', 'agents'), all,
    ], { encoding: 'utf8', timeout: 20000 });
    require('fs').writeFileSync(skillsFile, out);
    env.EPAM_AGENT_SKILLS_FILE = skillsFile;
  } catch { /* no skills resolved — the agent runs as it did before this existed */ }

  if (profile.maxIterations !== undefined) env.EPAM_MAX_ITERATIONS = String(profile.maxIterations);
  if (profile.maxOutputTokens !== undefined) env.EPAM_MAX_OUTPUT_TOKENS = String(profile.maxOutputTokens);
  if (profile.timeoutSecs !== undefined) env.EPAM_TIMEOUT_SECS = String(profile.timeoutSecs);

  // WHERE THE TEMPLATE ZONE IS, for a seam granted the tools to read it. A read grant with no
  // path is useless, and the alternative — a directory named inside a prompt — is exactly the
  // project fact in prompt text that this layer exists to remove. Resolved from the engine's own
  // location, never from a caller's guess.
  if (env.EPAM_ALLOWED_TOOLS && /read_file|list_files/.test(env.EPAM_ALLOWED_TOOLS)) {
    env.EPAM_PROMPT_TEMPLATES_DIR = path.join(__dirname, '..', '..', 'prompts', 'templates');
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
