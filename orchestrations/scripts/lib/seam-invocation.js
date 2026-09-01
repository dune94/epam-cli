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
 *   3. DECLARED DEFAULT   EPAM_DEFAULT_SEAM, or opts.defaultSeam — NOT registry.defaultSeam.
 *                         The engine ships no default (removed 2026-08-16, see _defaultSeam in
 *                         the registry): an unmatched agent fails the mint loudly rather than
 *                         being absorbed silently. A PROJECT that wants absorption declares the
 *                         env var. This line used to name registry.defaultSeam, which the code
 *                         has never read — a registry declaring that field is ignored in silence,
 *                         which is precisely the failure mode the removal was meant to end.
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
 * THE PROJECT'S OWN LADDER DECLARATION, read from disk.
 *
 * The tier order and each tier's chain are declared in the project's llm-settings.json, and
 * model-ladders.sh exports them as EPAM_MODEL_LADDER_TIER_ORDER and EPAM_MODEL_LADDER_<TIER>.
 * Reading ONLY those exports made a seam's ladder depend on whether its caller happened to source
 * one shell library: resolve-codeline-scope.sh and ingest-jira-tickets.sh do not, and
 * codeline-discovery runs under both — so it resolved to no ladder, no chain and no iteration
 * budget, while the declaration sat correct on disk and every audit of the declaration passed.
 *
 * This is the same file model-ladders.sh reads, in the same shapes, so the two cannot disagree.
 * The environment still WINS where it is set: an exported chain is an operator override and this
 * is only the fallback for a caller that exported nothing.
 */
const _ladderDeclCache = new Map();
function projectLadderDecl(sourceEnv) {
  const dir = (sourceEnv && sourceEnv.EPAM_PROJECT_CONFIG_DIR) || '';
  if (!dir) return null;
  if (_ladderDeclCache.has(dir)) return _ladderDeclCache.get(dir);
  let decl = null;
  try {
    decl = JSON.parse(fs.readFileSync(path.join(dir, 'llm-settings.json'), 'utf8'));
  } catch {
    decl = null;                    // a project that declares none gets none, and says so above
  }
  _ladderDeclCache.set(dir, decl);
  return decl;
}

/** The tier order this project declares, from the environment first, then from its own file. */
function declaredTierOrder(sourceEnv) {
  const fromEnv = String((sourceEnv && sourceEnv.EPAM_MODEL_LADDER_TIER_ORDER) || '')
    .split(/[\s,]+/).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  const decl = projectLadderDecl(sourceEnv);
  const order = decl && Array.isArray(decl.ladderTierOrder) ? decl.ladderTierOrder : [];
  return order.map(String).filter(Boolean);
}

/**
 * A tier's chain in the form every consumer already parses: "from=to|from=to", plus its declared
 * start model. Built from the same declaration model-ladders.sh builds it from.
 */
function declaredTierChain(sourceEnv, tierName) {
  const decl = projectLadderDecl(sourceEnv);
  const tier = decl && decl.ladders && decl.ladders[tierName];
  if (!tier) return null;
  const hops = Array.isArray(tier.modelLadder) ? tier.modelLadder : [];
  const chain = hops.filter((h) => h && h.from && h.to)
    .map((h) => `${h.from}=${h.to}`).join('|');
  if (!chain) return null;
  return { chain, start: tier.startModel || '' };
}

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
/**
 * THE POSITION VOCABULARY IS THE ENGINE'S; THE TIER NAMES ARE THE PROJECT'S.
 *
 * Declared once here because two readers need the same answer: resolveTierPosition, which maps a
 * position onto a project's tier, and seamLadderFor, which refuses a project override that is not
 * a position. Split across the two, a position added to one and not the other would resolve for a
 * seam and be rejected for a project.
 */
let _positionsCache;
function ladderPositions() {
  // THE ENGINE'S OWN REGISTRY, ALWAYS — never a caller's file and never AGENT_PROFILES_REGISTRY.
  //
  // Positions are the engine's vocabulary; only the TIER NAMES they resolve to belong to a
  // project. Reading them from whatever registry a caller passed made every consumer with a
  // fixture or minimal registry throw instead of resolving — the shell-side callers and the
  // archetype ladder fixtures all point AGENT_PROFILES_REGISTRY at their own file, and a
  // ladder that cannot name its positions stopped climbing.
  if (_positionsCache) return _positionsCache;
  const own = path.join(__dirname, '..', '..', 'agents', 'invocation-profiles.json');
  const decl = (readRegistry(own) || {})._ladderPositions;
  const names = decl && Array.isArray(decl.names) ? decl.names.filter(Boolean) : [];
  if (!names.length) {
    throw new Error(
      '[seam-invocation] invocation-profiles.json declares no _ladderPositions.names, so there is '
      + 'no position vocabulary to resolve a seam or validate a project override against. '
      + 'Refusing to guess one.');
  }
  _positionsCache = names;
  return names;
}

/**
 * WHICH RUNG THIS SEAM STARTS ON, FOR THIS PROJECT.
 *
 * The registry's `ladder` is the DEFAULT, not the decision. It is one shared file, so while it was
 * the only source, moving a seam to a cheaper rung for one project moved it for every project —
 * and the only way to make a cheap seam-test project cheap was to retune production with it.
 *
 * A project overrides per seam in its own llm-settings.json, which is the same file it already
 * uses to declare its tier order and its rungs:
 *
 *   "seamLadders": { "codeline-discovery": "mid", "estate-survey": "mid" }
 *
 * A position that is not one is refused rather than silently ignored: a cost decision that
 * quietly did not apply is the failure this exists to replace.
 */
function seamLadderFor(seam, projectDir, registryFile) {
  const profile = (readRegistry(registryFile || registryPath()).profiles || {})[seam] || {};
  const decl = projectLadderDecl({ EPAM_PROJECT_CONFIG_DIR: projectDir || '' });
  const overrides = (decl && decl.seamLadders) || null;
  // A named seam wins; '*' is the project's default for everything it did not name; failing both,
  // the registry's default stands.
  if (!overrides) return profile.ladder;
  const named = Object.prototype.hasOwnProperty.call(overrides, seam);
  if (!named && !Object.prototype.hasOwnProperty.call(overrides, '*')) return profile.ladder;
  const raw = named ? overrides[seam] : overrides['*'];
  const want = String(raw || '').trim().toLowerCase();
  const _positions = ladderPositions();
  if (!_positions.includes(want)) {
    throw new Error(
      `[seam-invocation] this project's llm-settings.json sets seamLadders['${named ? seam : '*'}'] to `
      + `'${raw}', which is not a ladder position — expected one of `
      + `${_positions.join(', ')}. A seam declares a POSITION; the project's `
      + 'ladderTierOrder supplies the tier name it lands on.');
  }
  return want;
}

function resolveTierPosition(position, sourceEnv) {
  const order = declaredTierOrder(sourceEnv);
  if (!order.length) return '';
  const p = String(position || '').trim().toLowerCase();
  // Position -> index in the project's own tier order. The NAMES come from the registry; the
  // mapping is the engine's, and biases low on an even count because over-spending is the more
  // expensive mistake and a seam asking for the middle is not asking for the ceiling.
  // Positions are declared lowest-to-highest, as tiers are, so a position maps to the tier at the
  // same proportion of the order: the first to the first, the last to the last, and anything
  // between to its proportional place. Floor, not round, so an even count biases LOW — a seam
  // asking for the middle is not asking for the ceiling, and over-spending is the more expensive
  // mistake. No count is special-cased: a project declaring two tiers or five gets the same rule.
  const _names = ladderPositions();
  const _i = _names.indexOf(p);
  if (_i >= 0) {
    const _span = _names.length - 1;
    return order[_span ? Math.floor((_i * (order.length - 1)) / _span) : 0];
  }
  // Not a position: a project tier name may still be passed through unchanged, so an older
  // registry keeps working while it is being migrated.
  return order.includes(p) ? p : '';
}

/**
 * THE ITERATION BUDGET THIS RUNG DECLARES.
 *
 * A ladder declares maxIterations per RUNG — ladders.high.rungs[1].maxIterations = 250 — beside the
 * models that rung runs. The seam already resolved its tier and its rung to pick the model; the
 * budget is the field sitting next to it.
 *
 * It used to be looked up only through the project's modelOverrides, matched on a model-name
 * substring. That made the budget a property of the PROJECT while the model is a property of the
 * STACK, so moving a project to another stack silently detached every budget: on 2026-08-27 mock3
 * ran every seam on the engine default because its overrides still named minimax and glm models
 * that the claude ladder never produces.
 *
 * Read where the ladder is read: the project's own declaration first, then the resolved provider
 * set, which is where a project that moved its ladders to the stack now keeps them.
 */
function rungBudget(sourceEnv, tierName, rung) {
  if (!tierName) return '';
  const docs = [];
  const own = projectLadderDecl(sourceEnv);
  if (own) docs.push(own);
  try {
    // eslint-disable-next-line global-require
    const { resolveLlmSettings } = require('./llm-settings-resolve.js');
    const resolved = resolveLlmSettings();
    if (resolved) docs.push(resolved);
  } catch { /* no provider set resolvable here; the project's own declaration stands alone */ }

  for (const doc of docs) {
    const tier = doc && doc.ladders && doc.ladders[tierName];
    const rungs = tier && Array.isArray(tier.rungs) ? tier.rungs : [];
    if (!rungs.length) continue;
    // Past the top rung the ladder is exhausted, not broken: hold the last budget rather than
    // dropping to a default nobody chose — the same rule the model walk follows.
    const at = rungs[Math.min(Math.max(0, rung), rungs.length - 1)];
    if (at && Number.isFinite(at.maxIterations)) return String(at.maxIterations);
  }
  return '';
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

  // 1b. A NAMESPACED KEY IS STILL THIS AGENT'S OWN DECLARATION.
  //
  // The QA gates are declared as `qa-gate:<name>` while everything that calls one names it bare:
  // the roster lists `runtime-boundary`, and profiles.json holds its persona under that name. The
  // exact match above missed, so a gate fell through to the family suffix patterns below — and
  // five of the eight resolved only because their names happen to end in a suffix declared for
  // some OTHER family (-validator, -ranger, -hunter, -weaver, -sentinel). The three whose names do
  // not — sast, e2e, runtime-boundary — resolved to nothing and would have run with no ladder, no
  // effort and no tool grants. runtime-boundary had never once executed.
  //
  // An agent's own declaration must outrank a family rule, whatever namespace it is filed under,
  // so this sits with rule 1 and above the patterns. Two namespaces declaring the same bare name
  // is an ambiguity nobody decided: it is refused rather than guessed.
  const namespaced = Object.keys(profiles).filter((k) => k.slice(k.indexOf(':') + 1) === agent
    && k.includes(':'));
  if (namespaced.length === 1) return namespaced[0];
  if (namespaced.length > 1) {
    throw new Error(`'${agent}' is declared under more than one namespace (${namespaced.join(', ')}); `
      + 'name the seam on the agent\'s roster entry to say which one it enters by');
  }

  // 2. The explicit cross-reference: this agent enters by this seam. Named agents that are
  //    not themselves profiles live here, and an entry always beats a pattern — a family rule
  //    must never override a decision someone made deliberately about one agent.
  // THE AGENT'S OWN ENTRY SAYS WHICH SEAM IT ENTERS BY.
  //
  // This read `reg.agentSeams` — a PER-PROJECT cross-reference stored in the file the ENGINE
  // owns, so one project's minted agents were mapped in a registry every other project reads,
  // and the mint rewrote the engine layer on every run to maintain it.
  //
  // All 55 entries were recorded with origin 'derived': the map was a CACHE of what the patterns
  // below already answer, holding no decision anyone made. What the patterns cannot reach is a
  // minted agent whose name the engine cannot know — and that agent's roster entry names its
  // seam, beside its persona, its kind and what it derives from. One agent, one place.
  if (!_ignoreXref) {
    const projectDir = process.env.EPAM_PROJECT_CONFIG_DIR || '';
    if (projectDir) {
      let entry = null;
      try {
        // eslint-disable-next-line global-require
        const roster = require('./project-roster.js').loadRoster(projectDir);
        entry = (roster.agents || {})[agent] || null;
      } catch { entry = null; }   // no roster yet: the patterns below still answer
      if (entry && typeof entry.seam === 'string' && entry.seam.trim()) {
        if (!profiles[entry.seam]) {
          throw new Error(
            `the roster binds '${agent}' to seam '${entry.seam}', which the registry does not define`);
        }
        return entry.seam;
      }
    }
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
  // Read from the module that OWNS the two registries the kind is recorded in. A roster entry is
  // the brief STRING, so there is no field to read here; the kind is membership of
  // project-roles.json or project-investigators.json. Written against a {kind, brief} fixture at
  // first, which made this inert on real data while a green unit test said otherwise.
  const _kind = (() => {
    try {
      return require('./agent-roster.js').kindOfAgent(agent, (opts && opts.agentsDir) || undefined) || '';
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
    'it. Add a seamPattern for its family, or name the seam on this agent\'s roster entry. Or set ' +
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

  // REASONING EFFORT BELONGS TO THE LADDER, NOT THE SEAM.
  //
  // This exported profile.reasoningEffort, and next_ladder_step then treated the rung's configured
  // level as a floor — so the seam's flat value won whenever it was higher, which for 33 of 41
  // seams meant "high" on every rung. The ladder declares rungs[0].reasoningEffort so the cheap
  // entry rung is cheap; that declaration could never take effect while this line existed.
  //
  // A seam is ASSIGNED to a ladder. It does not renegotiate what that ladder costs — the rule
  // already settled for iterations (no seam carries its own maxIterations literal), now applied to
  // effort. Operator decision 2026-09-01. The field is gone from the seam declarations too: a
  // field that is read by nothing but still written reads as live, which is how base/mid/top
  // survived across all 40 seams unnoticed.
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
      } else {
        // A DECLARED "none" IS A DECISION, NOT AN OMISSION.
        //
        // toolGrantFor('none') returns an empty list, which fell through here and left
        // EPAM_ALLOWED_TOOLS unset — so the agent inherited whatever grant the run had last
        // set. The one seam that declares "none" (topology-router) would have run with the
        // preceding agent's tools, and the preceding agent may hold Bash and WriteFile.
        //
        // The absent-stays-absent rule above is about a profile that CONFIGURES NOTHING. This
        // profile configures zero, and zero has to be enforced or it means nothing.
        env.EPAM_ALLOWED_TOOLS = '';
        env.AI_GATE_ALLOW_TOOLS = '0';
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

  // THE LADDER DEFINES ITERATIONS — set below, from the rung this seam resolves to.
  //
  // This read `profile.maxIterations`: a per-agent literal, declared 22 times, absent 16
  // times, and overriding the ladder wherever present. The budget belongs to the RUNG — a
  // stronger rung is given more room, which is the whole point of escalating (live run
  // 20260821T112857Z: 120 -> 185 -> 280 as the ladder climbed). A literal freezes that.
  //
  // A profile that still carries one is honoured here only so a project mid-migration is
  // not left with none; the invocation-profiles contract forbids it and a test enforces
  // that. See lib/model-settings.js.
  if (profile.maxIterations !== undefined) env.EPAM_MAX_ITERATIONS = String(profile.maxIterations);
  if (profile.maxOutputTokens !== undefined) env.EPAM_MAX_OUTPUT_TOKENS = String(profile.maxOutputTokens);
  if (profile.timeoutSecs !== undefined) {
    // A CEILING FOR RUNS THAT ARE NOT WAITING ON A MODEL.
    //
    // Seam timeouts are sized for real inference — estate-survey declares 900 seconds — which is
    // right when a model is thinking and absurd when nothing is. A rehearsal answers from a local
    // mock in milliseconds, so a seam that has not replied is never going to: the request matched
    // no expectation and the run then sits out the full timeout in silence. One unmatched seam
    // turned a three-minute rehearsal into a fifteen-minute hang tonight, and a hang is
    // indistinguishable from slow work, which is the property that makes a fast loop worth having.
    //
    // Declared, never assumed: the cap applies only where a caller sets it, so real runs keep the
    // budgets their seams declare and only a rehearsal asks for a short fuse.
    const cap = Number(sourceEnv.EPAM_SEAM_TIMEOUT_CAP_SECS || 0);
    const declared = Number(profile.timeoutSecs);
    env.EPAM_TIMEOUT_SECS = String(cap > 0 ? Math.min(declared, cap) : declared);
  }

  // WHERE THE TEMPLATE ZONE IS, for a seam granted the tools to read it. A read grant with no
  // path is useless, and the alternative — a directory named inside a prompt — is exactly the
  // project fact in prompt text that this layer exists to remove. Resolved from the engine's own
  // location, never from a caller's guess.
  if (env.EPAM_ALLOWED_TOOLS && /read_file|list_files/.test(env.EPAM_ALLOWED_TOOLS)) {
    env.EPAM_PROMPT_TEMPLATES_DIR = path.join(__dirname, '..', '..', 'prompts', 'templates');
  }
  // The project's override outranks the registry default; see seamLadderFor.
  const _ladder = seamLadderFor(seam, (sourceEnv && sourceEnv.EPAM_PROJECT_CONFIG_DIR) || '', file);
  if (_ladder) {
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
    const tierName = resolveTierPosition(_ladder, sourceEnv);
    if (!tierName) {
      process.stderr.write(
        "[seam-invocation] seam '" + seam + "' asks for ladder position '" + _ladder +
        "' but EPAM_MODEL_LADDER_TIER_ORDER is unset or empty — the project declares no tier " +
        "order, so no position can be resolved\n");
    }
    const key = 'EPAM_MODEL_LADDER_' + String(tierName || _ladder).toUpperCase().replace(/[^A-Z0-9]/g, '_');
    // ENVIRONMENT FIRST — an exported chain is an operator override and outranks the file, the
    // same precedence model-ladders.sh applies. Then the project's own declaration, so a caller
    // that never sourced that library still gets the ladder its project declares rather than
    // none. `_declared` also supplies the start model for the same reason.
    const _declared = sourceEnv[key] ? null : declaredTierChain(sourceEnv, tierName || _ladder);
    const rungs = sourceEnv[key] || (_declared && _declared.chain) || '';
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
      const declaredStart = (sourceEnv[key + '_START'] || (_declared && _declared.start) || '').trim();
      // A RETRY THAT DOES NOT CLIMB IS THE SAME COIN FLIPPED AGAIN.
      //
      // The chain above was exported on every attempt and walked on none: seams resolve their
      // START model and nothing ever asked for the next rung, so a caller retrying a refused
      // answer re-ran the identical model and got an identical refusal. Live 2026-08-27, run
      // 20260827T092415Z: prompt-builder refused 'tc-writer' three times — attempts 1 and 2
      // dropped the SAME two placeholders, because it was the same model doing the same thing —
      // and the run aborted with sonnet and opus sitting unused in a chain it had already
      // published.
      //
      // The rung is the CALLER'S, because only the caller knows an answer came back wrong. This
      // walks the declared chain from the declared start; it invents no order and names no model.
      // Past the top rung it stays on the top rung: a ladder that runs out is exhausted, not an
      // error, and the caller's own attempt budget decides when to stop.
      // THE CHAIN IS A HOP MAP, NOT A LIST. model-ladders.sh emits
      //   from=to|from=to
      // (e.g. haiku=sonnet|sonnet=opus-5), because a modelLadder has several independent roots
      // and an ordered list could not say which model follows which. Climbing means applying the
      // map, one hop per rung, from the model this seam declares it starts on.
      const _hops = new Map(
        rungs.split('|')
          .map((pair) => { const i = pair.indexOf('='); return i < 1 ? null : [pair.slice(0, i).trim(), pair.slice(i + 1).trim()]; })
          .filter((kv) => kv && kv[0] && kv[1]),
      );
      const _rung = Math.max(0, parseInt(o.rung, 10) || 0);
      let _effectiveStart = declaredStart;
      if (declaredStart && _rung > 0 && _hops.size) {
        // Past the top the chain simply stops: a ladder that runs out is exhausted, not an error,
        // and the caller's attempt budget decides when to give up. A cycle cannot spin forever
        // because the walk is bounded by the rung count.
        for (let i = 0; i < _rung; i += 1) {
          const next = _hops.get(_effectiveStart);
          if (!next) break;
          _effectiveStart = next;
        }
      }
      // What rung this invocation is actually on, stamped so a cost row and a log can say so.
      // Without it an escalation is invisible in the ledger and looks like a seam that always
      // ran the stronger model.
      if (declaredStart) env.EPAM_LADDER_RUNG = String(_rung);
      if (declaredStart) {
        env.EPAM_MODEL = _effectiveStart;
        // THE BUDGET COMES FROM THE RUNG, resolved from the model this seam actually starts
        // on. EPAM_MODEL_ITERATIONS is emitted by lib/model-ladders.sh from the project's
        // own modelOverrides, so the number is the ladder's and is declared once.
        //
        // Absent stays absent, exactly as the start model does: a rung the project declares
        // no budget for is a gap to state, never one to fill with someone else's number.
        // SAME FALLBACK AS THE CHAIN. The map is emitted by model-ladders.sh from the project's
        // own modelOverrides via lib/model-settings.js; a caller that never sourced that library
        // had no map, so the rung's budget was absent for reasons that had nothing to do with the
        // project declaring one. Built here from the same function, so the two cannot disagree.
        const itMap = String(sourceEnv.EPAM_MODEL_ITERATIONS || (() => {
          const dir = (sourceEnv && sourceEnv.EPAM_PROJECT_CONFIG_DIR) || '';
          if (!dir) return '';
          try {
            // eslint-disable-next-line global-require
            const { iterationMap } = require('./model-settings.js');
            return iterationMap(path.join(dir, 'llm-settings.json')) || '';
          } catch { return ''; }
        })());
        // AN EXPLICIT PER-MODEL BUDGET FIRST: a project that named this model on purpose is
        // stating something the rung default cannot know.
        let resolved = '';
        for (const pair of itMap.split('|')) {
          const eq = pair.lastIndexOf('=');
          if (eq < 1) continue;
          const match = pair.slice(0, eq);
          const budget = pair.slice(eq + 1);
          if (match.startsWith('provider:')) continue; // provider rules need the provider, not the model
          if (_effectiveStart.includes(match)) { resolved = budget; break; } // declaration order, first match wins
        }
        // THEN THE RUNG'S OWN. This used to sit inside `if (itMap)`, so a project declaring no
        // modelOverrides at all never reached any budget lookup and was not even told so — the
        // warning below was unreachable for exactly the projects most likely to need it.
        if (!resolved) resolved = rungBudget(sourceEnv, tierName, _rung);
        if (resolved) {
          env.EPAM_MAX_ITERATIONS = resolved;
        } else {
          process.stderr.write(
            "[seam-invocation] seam '" + seam + "' starts on '" + _effectiveStart +
            "' but neither this project nor its ladder declares an iteration budget for that rung " +
            "— the seam will run on the engine default, which is nobody's choice\n");
        }
      } else {
        // Absent stays absent: the seam keeps whatever model it would otherwise resolve, and the
        // gap is stated rather than filled with a root chosen by accident.
        process.stderr.write(
          "[seam-invocation] seam '" + seam + "' climbs ladder '" + _ladder +
          "' which declares no startModel — not inferring one from map order; the seam will start " +
          "on whatever model it resolves for itself\n");
      }
    } else {
      // Not fatal: the seam is resolved and its effort/temperature still apply. But a ladder
      // that cannot be reached is not a ladder assignment, so it is never silent.
      process.stderr.write(
        `[seam-invocation] agent '${agent}' resolved to seam '${seam}' which asks for ladder ` +
        `'${_ladder}', but ${key} is unset in this process — no model or escalation ` +
        'chain will be applied\n');
    }
  }
  return env;
}

// resolveTierPosition is exported because the SHELL side needs the same answer: a profile
// declares a position, and two places must not each decide what a position means.
module.exports = { seamInvocationEnv, resolveSeam, registryPath, resolveTierPosition, seamLadderFor };
