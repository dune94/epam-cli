#!/usr/bin/env node
/**
 * mint-agents-step — give this project its own agents, then give every story one.
 *
 * Runs AFTER ingest and BEFORE the spec phase. That position is deliberate: the inputs that
 * make a proposed role project-specific rather than a restatement of the canonical core are
 * the tickets and the documents linked on them, and both exist only once ingest has run.
 * A proposer handed just a repo path proposes roles indistinguishable from the generic core.
 *
 * Two agent calls, both through the pipeline's own seam so they inherit ladder, retry,
 * self-heal, timeout and cost capture like every other agent:
 *
 *   1. mint    — propose this project's engineering roles; merge them additively into the
 *                roster (canonical roles can never be overwritten), seed each one's KB, and
 *                register them as this project's implementation roles.
 *   2. assign  — give every story one of those roles. synthesize-prd-from-jira.js leaves
 *                agentRole null on purpose: at synthesis nothing has analysed the codeline,
 *                so there is no roster to choose from.
 *
 * Exit non-zero on any failure. A story with no role is read as "unknown" by fifteen
 * consumers downstream rather than failing, which is exactly the silence this replaces.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const spec = require('./spec-mode-runner.js');

const argv = process.argv.slice(2);
const getArg = (flag, def = '') => {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : def;
};

const PRD_PATH = getArg('--prd');
const AGENTS_DIR = getArg('--agents-dir', path.join(__dirname, '..', 'agents'));
const PROFILES_PATH = getArg('--profiles', path.join(AGENTS_DIR, 'profiles.json'));
const LOG_DIR = getArg('--log-dir', process.env.OUTPUT_DIR || path.join(__dirname, '..', 'logs'));
const REPO_ARG = getArg('--codeline-root', '');

/**
 * The repo the work actually lands in — NOT the estate root.
 *
 * Live 2026-08-07: this got /projects/<client>, the directory holding 33 repositories, so
 * "read the codeline before you answer" pointed somewhere the answer is not. With no repo and
 * no fetched documents, the mint invented a CMS vendor and briefed all three roles on the
 * wrong product's APIs. A path that is not a repository is worse than no path: it reads as
 * evidence and contains none.
 */
function resolveRepoPath(prd, stories, repoArg) {
  const isRepo = (d) => { try { return !!d && fs.existsSync(path.join(d, '.git')); } catch { return false; } };
  const arg = repoArg !== undefined ? repoArg : REPO_ARG;
  if (isRepo(arg)) return arg;
  const out = prd && prd.project && prd.project.outputDir;
  if (isRepo(out)) return out;
  for (const s of stories) {
    try { const p2 = spec.resolveCodelinePath(s); if (isRepo(p2)) return p2; } catch { /* next */ }
  }
  return '';
}

/**
 * Make the project's plugins reachable BEFORE the mint runs.
 *
 * The orchestrator provisions .epam/settings.json into each codeline inside the codeline
 * loop — which happens after this step. So the mint could not reach dependency_contract or
 * dependency_available even with tools enabled, and had to trust the vendor documentation
 * about what the SDK exposes. Live 2026-08-07: two briefs prescribed `preview_token`, which
 * does not exist in the version of the SDK this estate pins, because nothing could check.
 *
 * Idempotent and identical to what the lane writes later, so provisioning here changes
 * nothing downstream.
 */
function provisionPlugins(codelines) {
  const cfgDir = process.env.EPAM_PROJECT_CONFIG_DIR || '';
  let tools = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cfgDir, 'plugins.json'), 'utf8'));
    if (Array.isArray(parsed.tools)) tools = parsed.tools;
  } catch { /* no project plugins declared */ }
  const builtin = path.join(__dirname, '..', 'plugins', 'codegraph-plugin.js');
  if (fs.existsSync(builtin)) tools = [...new Set([builtin, ...tools])];
  if (!tools.length) return [];

  for (const cl of codelines) {
    try {
      fs.mkdirSync(path.join(cl.path, '.epam'), { recursive: true });
      fs.writeFileSync(path.join(cl.path, '.epam', 'settings.json'), JSON.stringify({ tools }, null, 2));
    } catch { /* a codeline we cannot write to simply has no plugins for the mint */ }
  }
  return tools;
}

/**
 * What the mint may call. READ ONLY, by construction.
 *
 * The user's choice: builtin reads plus the project's dependency plugins — enough to verify
 * that an API exists and a package is installed, across every codeline. No bash and no
 * write_file: this stage has no story scope, and a wide grant at a stage that designs the
 * agents is not a trade worth making.
 */
function mintTools(codelines) {
  // One implementation, shared with specAgentEnv. This used to carry its own
  // READ_ONLY_BUILTINS literal, and the spec pass carried a different one — which is how the
  // mint could see codegraph_query while every spec-mode agent could not. See lib/agent-tools.js.
  return require('./lib/agent-tools.js').readOnlyToolGrant(codelines.map((c) => c && c.path));
}

/**
 * EVERY codeline in scope, not one of them.
 *
 * Operator direction, 2026-08-07: one roster for the whole project, informed by all its
 * codelines. Ingest already discovers them and exports JIRA_CODELINES plus a
 * JIRA_WORKTREE_<NAME> path for each, so this enumerates them generically — no codeline,
 * client or repository is named here.
 *
 * The first run minted against a single repo (the PRD outputDir) while three were in scope,
 * and wrote that one repository's absolute path into every brief.
 */
function resolveCodelines(prd, stories, repoArg) {
  const isRepo = (d) => { try { return !!d && fs.existsSync(path.join(d, '.git')); } catch { return false; } };
  const out = [];
  const seen = new Set();
  const add = (name, dir) => {
    if (!isRepo(dir) || seen.has(dir)) return;
    seen.add(dir);
    out.push({ name: name || path.basename(dir), path: dir });
  };

  // THE PERSISTED DISCOVERY ARTEFACT FIRST. Ingest runs as a child process, so the
  // JIRA_CODELINES / JIRA_WORKTREE_* exports it makes die when it exits — which is why this
  // saw one codeline twice while three were in scope. An artefact crosses that boundary.
  try {
    const disc = JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'codeline-discovery.json'), 'utf8'));
    for (const cl of (disc.codelines || [])) add(cl.name, cl.path);
  } catch { /* fall through to the env, then to single-codeline resolution */ }

  for (const name of String(process.env.JIRA_CODELINES || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    add(name, process.env[`JIRA_WORKTREE_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]);
  }
  if (!out.length) {
    // Single-codeline fallback: whatever the run actually points at.
    add('', repoArg);
    add('', prd && prd.project && prd.project.outputDir);
    for (const st of stories) {
      try { add(st.codeline, spec.resolveCodelinePath(st)); } catch { /* next */ }
    }
  }
  return out;
}

/**
 * What this codeline DECLARES it depends on. The single most direct answer to "which vendor
 * is this", and the mint had no access to it: the ticket says only "CMS", and the documents
 * that would have named the SDK failed to fetch. Read from whatever manifest the repo has —
 * no vendor, language or ecosystem is named here.
 */
function declaredDependencies(repoPath) {
  if (!repoPath) return [];
  // WHICH manifest, and WHICH keys inside it, are PROJECT facts — not the engine's to know.
  // This function briefly carried a list of ecosystem manifest filenames, which is stack
  // knowledge hardcoded into the generic pipeline. The project already declares both in
  // .epam/dependency-check.json (provisioned per codeline from the project's own config, and
  // the same file the dependency-contract plugin reads), so there is one declaration and the
  // engine names no ecosystem.
  //
  // Fails CLOSED and SAYS SO: no config means no dependency evidence, never a guessed
  // manifest. A guessed manifest that happens to miss is indistinguishable from a project
  // that genuinely declares nothing.
  // The codeline's provisioned copy first; the project's own config as the fallback. The
  // orchestrator provisions .epam/dependency-check.json into each worktree LATER, inside the
  // codeline loop — after the mint. Live 2026-08-07: "declared dependencies: 0" for a codeline
  // whose project config declares them perfectly well, so the mint lost its second evidence
  // source and the briefs prescribed a package the codeline does not install.
  const candidates = [path.join(repoPath, '.epam', 'dependency-check.json')];
  if (process.env.EPAM_PROJECT_CONFIG_DIR) {
    candidates.push(path.join(process.env.EPAM_PROJECT_CONFIG_DIR, 'dependency-check.json'));
  }
  let cfg = null;
  for (const c of candidates) {
    try { cfg = JSON.parse(fs.readFileSync(c, 'utf8')); break; } catch { /* next */ }
  }
  // THE MANIFEST IS DETECTED, NEVER DECLARED.
  //
  // This required the project to write down manifestFile and manifestKeys in dependency-check.json
  // — so every project had to tell the engine that Node uses package.json and that dependencies
  // live under "dependencies"/"devDependencies". mock3 declared its manifest under a DIFFERENT
  // shape (codelines.<name>.manifest), which this never read, so the mint reported "no dependency
  // evidence" and the agent brief said the codelines "declare no manifest configuration".
  //
  // The roster reviewer then read the repositories, found package.json in both with vitest and
  // typescript, and correctly blocked the roster for describing them wrongly. Two schemas for one
  // fact, and the run died between them.
  //
  // lib/ecosystem-registry.js already answers this for every supported ecosystem: it finds the manifest by
  // PRESENCE and each entry knows how to read its own dependency sections — which is exactly what
  // manifestKeys was spelling out by hand, one project at a time. It extends at runtime through
  // EPAM_CODELINE_MANIFESTS, so a new ecosystem needs no engine change and no project config.
  try {
    const out = execFileSync(process.execPath, [
      path.join(__dirname, 'lib', 'handlers', 'codeline-ecosystem.js'), repoPath,
    ], { encoding: 'utf8', timeout: 20000 });
    const facts = JSON.parse(out);
    if (!facts.manifest) {
      process.stderr.write(
        `[mint-step] ${repoPath} carries no manifest this engine recognises — no dependency ` +
        'evidence. Extend EPAM_CODELINE_MANIFESTS if this ecosystem should be supported.\n');
      return [];
    }
    return facts.declaredDeps || [];
  } catch (err) {
    process.stderr.write(`[mint-step] could not read the ecosystem of ${repoPath}: ${err && err.message}\n`);
    return [];
  }
}

if (require.main === module && (!PRD_PATH || !fs.existsSync(PRD_PATH))) {
  process.stderr.write('[mint-step] --prd <path> is required and must exist\n');
  process.exit(2);
}

/**
 * Documents linked on the tickets, if ingest persisted any. Optional by design: the mint is
 * better with them and must still work without them, so a project whose tickets carry no
 * links is not blocked.
 */
async function referencedDocs(logDir, stories) {
  const candidates = [
    path.join(logDir, 'referenced-docs.json'),
    path.join(logDir, 'ticket-documents.json'),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const docs = Array.isArray(parsed) ? parsed : (parsed && parsed.docs);
      if (Array.isArray(docs) && docs.length) return docs;
    } catch { /* try the next one */ }
  }

  // Nothing persisted yet — fetch from the links ingest put on the stories. ingest carries
  // ticketLinks (url + provenance) for every ticket; the documents behind them are what make
  // a proposed role project-specific, and on 2026-08-06 two of them refuted a story's central
  // assumption. Persisted here so the spec pass and any later reader see the same bytes, and
  // so a run can be audited afterwards.
  const links = [];
  const seen = new Set();
  for (const s of stories) {
    for (const l of (Array.isArray(s.ticketLinks) ? s.ticketLinks : [])) {
      const url = l && (typeof l === 'string' ? l : l.url);
      if (typeof url === 'string' && url && !seen.has(url)) { seen.add(url); links.push(url); }
    }
  }
  if (!links.length) return [];

  let docs = [];
  try {
    docs = await spec.fetchTicketDocuments(links, logDir) || [];
  } catch (err) {
    // The mint is better with documents and must still work without them. A project whose
    // links are unreachable is not blocked from having agents.
    process.stderr.write(`[mint-step] document fetch failed (continuing without): ${err && err.message}\n`);
    return [];
  }
  try {
    fs.writeFileSync(path.join(logDir, 'referenced-docs.json'), JSON.stringify(docs, null, 2));
  } catch { /* the mint still gets them in memory */ }
  const fetched = docs.filter((d) => d && d.fetchStatus === 'fetched').length;
  process.stderr.write(`[mint-step] documents: ${fetched} fetched of ${links.length} link(s)\n`);
  return docs;
}

/**
 * writeRosterDiff — what this run GENERATED, against the canonical baseline.
 *
 * The roster pause is only useful if the operator can see what changed. profiles.json is ~56
 * entries of prose; eyeballing it against profiles.canonical.json is not review, it is
 * hoping. This states it: roles added, roles whose brief differs, and roles present in
 * canonical but missing here.
 */
function writeRosterDiff(profilesPath, agentsDir, logDir, mintedThisRun, mintedDetail) {
  const minted = new Set(Array.isArray(mintedThisRun) ? mintedThisRun : []);
  const detail = new Map((Array.isArray(mintedDetail) ? mintedDetail : []).map((m) => [m.name, m]));
  const kindOf = (n) => (detail.get(n) || {}).kind || 'implementer';
  const codelineOf = (n) => (detail.get(n) || {}).codeline || '';
  const canonicalPath = path.join(agentsDir, 'profiles.canonical.json');
  let live = {}, canonical = {};
  try { live = JSON.parse(fs.readFileSync(profilesPath, 'utf8')); } catch { return null; }
  try { canonical = JSON.parse(fs.readFileSync(canonicalPath, 'utf8')); } catch { canonical = {}; }

  const liveKeys = Object.keys(live), canonKeys = Object.keys(canonical);
  const added = liveKeys.filter((k) => !(k in canonical));
  const removed = canonKeys.filter((k) => !(k in live));
  const changed = liveKeys.filter((k) => k in canonical && live[k] !== canonical[k]);

  const diff = {
    canonicalFile: canonicalPath,
    canonicalRoles: canonKeys.length,
    liveRoles: liveKeys.length,
    generated: added.map((k) => ({
      role: k, briefChars: String(live[k] || '').length, mintedThisRun: minted.has(k),
    })),
    briefChanged: changed.map((k) => ({
      role: k,
      canonicalChars: String(canonical[k] || '').length,
      liveChars: String(live[k] || '').length,
    })),
    missingFromLive: removed,
  };
  try { fs.writeFileSync(path.join(logDir, 'roster-diff.json'), JSON.stringify(diff, null, 2)); } catch {}

  const md = [
    `# Roster diff — generated vs canonical`,
    ``,
    `canonical: ${canonicalPath} (${canonKeys.length} roles)`,
    `live:      ${profilesPath} (${liveKeys.length} roles)`,
    ``,
    `## MINTED BY THIS RUN — IMPLEMENTERS, may author code (${added.filter((k) => minted.has(k) && kindOf(k) !== 'investigator').length})`,
    ...(added.filter((k) => minted.has(k) && kindOf(k) !== 'investigator').length
      ? added.filter((k) => minted.has(k) && kindOf(k) !== 'investigator').map((k) => `- ${k}  [${String(live[k] || '').length} chars]`)
      : ['- (none)']),
    ``,
    `## MINTED BY THIS RUN — INVESTIGATORS, read-only, never own a story (${added.filter((k) => minted.has(k) && kindOf(k) === 'investigator').length})`,
    ...(added.filter((k) => minted.has(k) && kindOf(k) === 'investigator').length
      ? added.filter((k) => minted.has(k) && kindOf(k) === 'investigator')
          .map((k) => `- ${k}  [codeline: ${codelineOf(k) || '(none)'}]  [${String(live[k] || '').length} chars]`)
      : ['- (none)']),
    ``,
    `## In live but not canonical, NOT minted this run (pre-existing drift) (${added.filter((k) => !minted.has(k)).length})`,
    ...(added.filter((k) => !minted.has(k)).length
      ? added.filter((k) => !minted.has(k)).map((k) => `- ${k}`)
      : ['- (none)']),
    ``,
    `## Brief differs from canonical (${changed.length})`,
    ...(changed.length ? changed.map((k) => `- ${k}  canonical ${String(canonical[k] || '').length} -> live ${String(live[k] || '').length} chars`) : ['- (none)']),
    ``,
    `## In canonical but NOT live (${removed.length})`,
    ...(removed.length ? removed.map((k) => `- ${k}`) : ['- (none)']),
    ``,
  ].join('\n');
  try { fs.writeFileSync(path.join(logDir, 'roster-diff.md'), md); } catch {}

  process.stderr.write(`[mint-step] roster diff: ${added.length} generated, ${changed.length} brief-changed, ${removed.length} missing vs canonical\n`);
  return diff;
}

/**
 * THE AGENT→SEAM CROSS-REFERENCE, WRITTEN WHERE THE AGENTS ARE CREATED.
 *
 * Minting is the only moment the pipeline knows what it just made. A run mints ~64 agents
 * whose names cannot exist in a registry written before the project did —
 * gotransit-investigator, contentstack-live-preview-integration-engineer — and until now every
 * one of them resolved to {} at runtime: no ladder, no effort, no temperature, and nothing
 * said so.
 *
 * Operator: "you cannot just say after mint - oh, it has no seam and then treat it as a bug -
 * that will not work at all and is a poor design." And: "Cross reference must be
 * updated/re-created during minting."
 *
 * So every agent in the roster is resolved through THE SAME resolver the runtime uses — two
 * implementations of "which seam is this agent" would be two answers to one question — and the
 * result is recorded. The mapping stops being implicit-by-pattern and becomes a record an
 * operator can read, diff and override.
 *
 * AN AGENT THAT RESOLVES TO NOTHING FAILS THE MINT, and nothing is written. The failure lands
 * before any story runs, where it can be fixed.
 *
 * No agent name and no seam name appears here: the roster supplies the names, the registry
 * supplies the shapes.
 */

/**
 * The roster file exists in TWO shapes in the wild: a flat { agent: brief } map, and a wrapper
 * { runId, _what, profiles: { agent: brief } }. Reading one shape in one function and the other
 * elsewhere is how a validator ends up examining `runId` and `_what` as if they were agents.
 * One reader, both shapes.
 */
function rosterAgents(profilesPath) {
  const parsed = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
  const map = (parsed && typeof parsed.profiles === 'object' && parsed.profiles) ? parsed.profiles : parsed;
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    if (k.startsWith('_') || k === 'runId') continue;
    out[k] = v;
  }
  return out;
}

function writeAgentSeamCrossReference(profilesPath, registryPath) {
  const { resolveSeam } = require('./lib/seam-invocation.js');

  const roster = rosterAgents(profilesPath);
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const profiles = registry.profiles || {};
  const previous = registry.agentSeams || {};
  // Provenance lives BESIDE the map, not inside it: agentSeams stays a plain
  // agent -> seam string, so seam-invocation.js and every other reader is untouched.
  const origin = {};

  // RE-CREATED, not merged: an agent dropped from the roster must not linger. Rebuilt from the
  // roster alone, so the cross-reference always describes the agents that actually exist.
  const next = {};
  const unresolved = [];
  for (const agent of Object.keys(roster)) {
    // An agent that IS a seam already wins at resolution; recording it too would create a
    // second place to drift from.
    if (profiles[agent]) continue;
    // AN OVERRIDE SURVIVES; A DERIVED VALUE DOES NOT.
    //
    // This used to preserve ANY previous mapping, which is right for an operator's deliberate
    // decision and wrong for a value the mint itself derived last time — and it could not tell
    // them apart. Live 2026-08-13: the -engineer rule had pointed ten implementers at the
    // failure analyst; correcting the rule reached none of them, because every stale entry
    // outranked it. The correction had to be applied by hand, and so would the next one.
    //
    // A BARE STRING IS TREATED AS DERIVED. Every entry written before this change is one, and
    // reading them as overrides would freeze today's mappings permanently.
    const _prevOrigin = (registry.agentSeamOrigin || {})[agent];
    if (_prevOrigin === 'override'
        && Object.prototype.hasOwnProperty.call(previous, agent)
        && profiles[previous[agent]]) {
      next[agent] = previous[agent];
      origin[agent] = 'override';
      continue;
    }
    try {
      // From the RULES, not from what we recorded last time — see resolveSeam's ignoreXref.
      next[agent] = resolveSeam(agent, registryPath, { ignoreXref: true });
      origin[agent] = 'derived';
    } catch (e) {
      unresolved.push(`${agent}: ${(e && e.message) || e}`);
    }
  }

  if (unresolved.length) {
    throw new Error(
      `${unresolved.length} minted agent(s) resolve to no seam, so they would run unconfigured. `
      + `Add a seamPattern or a defaultSeam to ${registryPath}:\n  ` + unresolved.join('\n  '));
  }

  registry.agentSeams = next;
  registry.agentSeamOrigin = origin;
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  return next;
}


/**
 * validateWorkflow(profilesPath, registryPath)
 *
 * IS THIS ROSTER BUILDABLE? Every archetype declares what it produces and what it requires, so
 * a roster containing a consumer whose REQUIRED input nobody produces is decidable from the
 * data — before any story runs, with no model involved.
 *
 * That is the shape of every unwinnable story this pipeline has produced: an actor waiting for
 * something nobody was configured to make. The mint already refuses a roster whose agent
 * resolves to no seam, for the same reason and with the same timing — "caught here, before any
 * story runs, not three hours into a run".
 *
 * OPTIONAL INPUTS ARE NOT CHECKED. Optional means the workflow runs without it; requiring a
 * producer for every optional kind would force every roster to carry every archetype, which is
 * the opposite of letting a project mint only what it needs.
 */
function validateWorkflow(profilesPath, registryPath) {
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const roster = rosterAgents(profilesPath);
  const archetypes = registry.profiles || {};
  const { resolveSeam } = require('./lib/seam-invocation.js');

  // What this roster can produce: every archetype an agent resolves to, plus the engine.
  const produced = new Set(registry.engineProduces || []);
  const seamOf = {};
  for (const agent of Object.keys(roster)) {
    const seam = archetypes[agent] ? agent : resolveSeam(agent, registryPath);
    seamOf[agent] = seam;
    const p = archetypes[seam] && archetypes[seam].produces;
    if (p) produced.add(String(p));
  }

  const missing = [];
  for (const agent of Object.keys(roster)) {
    const arch = archetypes[seamOf[agent]];
    if (!arch) continue;
    for (const c of arch.consumes || []) {
      if (!c || !c.required) continue;
      if (!produced.has(String(c.kind))) {
        missing.push(`${agent} (${seamOf[agent]}) requires '${c.kind}', which nothing in this roster produces`);
      }
    }
  }
  if (missing.length) {
    throw new Error(
      `${missing.length} agent(s) in this roster require an input nobody produces, so they would `
      + `wait forever. Mint a producer, or make the input optional:\n  ` + missing.join('\n  '));
  }
  return true;
}

module.exports = { resolveRepoPath, rosterAgents, resolveCodelines, declaredDependencies, writeRosterDiff, mintTools, provisionPlugins, writeAgentSeamCrossReference, validateWorkflow };

if (require.main !== module) return;

(async () => {
  const prd = JSON.parse(fs.readFileSync(PRD_PATH, 'utf8'));
  const stories = Array.isArray(prd.stories) ? prd.stories : [];
  if (!stories.length) {
    process.stderr.write('[mint-step] the PRD has no stories — nothing to mint for or assign\n');
    process.exit(1);
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const aiRunnerCmd = process.env.AI_RUNNER_CMD || path.join(__dirname, 'ai-run.sh');
  const promptExec = spec.resolvePromptExec(aiRunnerCmd);
  // RE-APPLY THIS PROJECT'S BRIEFS FIRST. profiles.json was restored from its canonical
  // original at launch, which deletes anything minted on a previous run while the role
  // registry and the KB files survive. Without this the three disagree: on a resume the
  // registry names roles that have no profile, assignment finds zero candidates and refuses.
  const { applyProjectProfiles, rosterRunId: _rrid } = require('./lib/agent-roster.js');
  // Only for THIS run. Re-applying a previous run's briefs would reinstate the mutated roster
  // the restore just removed — the base must be canonical at the start of every run.
  const reapplied = (_rrid(AGENTS_DIR) && _rrid(AGENTS_DIR) === (process.env.ORCH_RUN_ID || ''))
    ? applyProjectProfiles(PROFILES_PATH, AGENTS_DIR)
    : [];
  if (reapplied.length) {
    process.stderr.write(`[mint-step] re-applied ${reapplied.length} project brief(s) after the per-run restore: ${reapplied.join(', ')}\n`);
  }

  const codelines = resolveCodelines(prd, stories, REPO_ARG);
  if (!codelines.length) {
    process.stderr.write('[mint-step] WARNING: no codeline repository resolved — the mint cannot read the stack\n');
  }
  for (const cl of codelines) {
    cl.dependencies = declaredDependencies(cl.path);
    process.stderr.write(`[mint-step] codeline ${cl.name}: ${cl.path} (${cl.dependencies.length} declared deps)\n`);
  }
  // Tools operate in one working directory; the first codeline is the anchor, and every
  // codeline's path and stack is stated in the prompt.
  const REPO_PATH = codelines.length ? codelines[0].path : '';
  const deps = [...new Set(codelines.flatMap((c) => c.dependencies))];
  const provisioned = provisionPlugins(codelines);
  const toolGrant = mintTools(codelines);
  process.stderr.write(`[mint-step] plugins provisioned: ${provisioned.length} · mint tools: ${toolGrant}\n`);
  // ── THE PROJECT ROSTER ──────────────────────────────────────────────────────
  //
  // Canonical belongs to no project. Running it unchanged gave every project the same personas,
  // which is how a review of a client codeline ran five times with a persona describing this
  // repository. So: canonical is copied into the run, an agent specialises it for THIS project
  // with its own tools, and the result is reviewed against BOTH itself and the source.
  //
  // A FUNCTION, AND NOT PART OF THE MINT. EPAM_SKIP_AGENT_MINT is honoured on every
  // writer-style resume, deliberately: the merge is additive and re-minting accumulated
  // duplicate roles. But deriving the roster is not minting. Skipping the mint means "invent no
  // new agents"; it must never mean "run with no identities", which is what leaving this inside
  // the skipped block would cause the moment consumers stop falling back to the engine roster.
  //
  // Regenerated every launch, resume included.
  const runRosterStage = async (mintedDetail) => {
    const { buildProjectRoster } = require('./lib/project-roster.js');
    const { seamInvocationEnv } = require('./lib/seam-invocation.js');
    const projectConfigDir = process.env.EPAM_PROJECT_CONFIG_DIR || '';
    if (!projectConfigDir) {
      throw new Error(
        'cannot build the project roster: EPAM_PROJECT_CONFIG_DIR is unset. The roster is the '
        + 'only place an agent\'s identity comes from, and there is no engine fallback to read.');
    }
    const canonicalPath = path.join(AGENTS_DIR, 'profiles.canonical.json');

    const renderSpecialisation = (vals) => renderEngineTemplate('roster-specialisation', vals);

    // THE AGENT WRITES THE FILE. The pipeline hands it the canonical copy and a destination,
    // then judges the artefact — it does not compose personas itself, because deciding what an
    // agent must know about a codeline is judgement, not substitution.
    const produce = async ({ canonicalCopyPath, outPath, refusal }) => {
      process.env.EPAM_AGENT_NAME = 'roster-specialiser';
      // The SAME context the prompt builder is given, computed the same way — a derivation that
      // sees different facts than its sibling stage is two projects, not one.
      const prompt = renderSpecialisation({
        __CANONICAL_COPY_PATH__: canonicalCopyPath,
        __OUT_PATH__: outPath,
        __PROJECT_CONTEXT__: [
          `Project config: ${projectConfigDir}`,
          `Tickets in scope: ${stories.map((t) => `${t.jiraKey || t.id}: ${t.title || ''}`).join(' | ')}`,
          mintedDetail.length
            ? `Agents this project minted: ${mintedDetail.map((mm) => `${mm.name} [${mm.kind}]`).join(', ')}`
            : 'Agents this project minted: (none this run)',
        ].join('\n'),
        __CODELINE_CONTEXT__: codelines
          .map((c) => `- ${c.name} (${c.path})${c.dependencies && c.dependencies.length ? ` deps: ${c.dependencies.join(', ')}` : ''}`)
          .join('\n'),
        // __STACK__ is deliberately ABSENT. It is a stack-fact key, and engine-prompt.js injects
        // the ones a template declares — but only when the caller has not supplied them. Passing
        // an empty string here would win, and starve the agent of the codeline's real facts.
        __PREVIOUS_REFUSAL__: refusal
          ? `\n\n## Your previous attempt was REFUSED\n\n${refusal}\n\nProduce the roster again, correcting exactly this.`
          : '',
      });
      await promptExec(prompt, {
        ...seamInvocationEnv('roster-specialiser', LOG_DIR),
        EPAM_AGENT_NAME: 'roster-specialiser',
      });
    };

    // REVIEWED AGAINST BOTH. With only the roster a reviewer can judge plausibility; falsifying
    // "is this ancestor close" and "was inherited structure quietly changed" needs the source.
    const review = async ({ rosterPath, canonicalPath: copyPath }) => {
      // The SEAM's own name. This announced 'roster-review' — a different seam, with a different
      // template and a different job (certifying newly minted agents). The two would have
      // resolved different ladders and filed their cost and KB under the wrong agent, which is
      // the drift this file already warns about where roster-review is invoked properly.
      process.env.EPAM_AGENT_NAME = 'project-roster-review';
      try {
        return await spec.reviewProjectRoster({
          promptExec, rosterPath, canonicalPath: copyPath,
          codelines, tickets: stories, logDir: LOG_DIR, repoPath: REPO_PATH, toolGrant,
        });
      } catch (err) {
        // A review that cannot run must not read as "no defects".
        process.stderr.write(`[mint-step] roster review FAILED: ${err && err.message}\n`);
        return { verdict: 'review_failed', reason: String(err && err.message) };
      }
    };

    const roster = await buildProjectRoster({
      canonicalPath, logDir: LOG_DIR, projectConfigDir, produce, review,
      attempts: Number(process.env.EPAM_ROSTER_ATTEMPTS || 3),
      log: (m2) => process.stderr.write(`[mint-step] ${m2}\n`),
    });
    process.stderr.write(`[mint-step] project roster: ${Object.keys(roster.agents).length} agent(s)\n`);
  };

  // ROSTER-ONLY: derive the roster and stop.
  //
  // A writer-style resume skips the mint on purpose, and every launch runs the pre-run reset.
  // The launcher calls this step in roster-only mode on those paths: identities are derived,
  // nothing is re-minted, and no role accumulates a near-duplicate. Placed here because
  // everything the stage needs is already resolved, and everything below costs model time this
  // path is explicitly avoiding.
  if (String(process.env.EPAM_ROSTER_ONLY || '') === '1') {
    process.stderr.write('[mint-step] roster-only: deriving this project\'s roster, minting nothing\n');
    await runRosterStage([]);
    return { rosterOnly: true };
  }

  const docs = await referencedDocs(LOG_DIR, stories);
  const fetchedDocs = docs.filter((d) => d && d.fetchStatus === 'fetched').length;

  // Surfaced, not buried. 0-of-2 fetched directly weakened the roster and appeared only as a
  // log line; the operator reviewing at the pause must see it without reading the transcript.
  fs.writeFileSync(path.join(LOG_DIR, 'mint-inputs.json'), JSON.stringify({
    codelines: codelines.map((c) => ({ name: c.name, path: c.path, declaredDependencies: c.dependencies.length })),
    codelineRepo: REPO_PATH || null,
    declaredDependencies: deps.length,
    documentsLinked: docs.length,
    documentsFetched: fetchedDocs,
    documentsUnfetched: docs.filter((d) => d && d.fetchStatus !== 'fetched').map((d) => ({ url: d.url, status: d.fetchStatus })),
  }, null, 2));

  // NO ROSTER DRIFT ACROSS RUNS OR CODELINES (operator direction, 2026-08-07).
  //
  // The merge is additive so a brief is never rewritten — but that also means a second mint
  // ADDS whatever it proposes this time. Two runs produced five roles: the three from a run
  // whose vendor was wrong, plus new ones, with one name overlapping. A roster that changes
  // shape every run is not a roster.
  //
  // So the project mints ONCE. Thereafter the stored roster is reused verbatim. Re-minting is
  // possible but must be asked for, and it REPLACES rather than accumulates — otherwise
  // "re-mint" is just another word for drift.
  const rosterLib = require('./lib/agent-roster.js');
  const existingRoles = rosterLib.projectRoles(AGENTS_DIR);
  const storedRunId = rosterLib.rosterRunId(AGENTS_DIR);
  const thisRunId = process.env.ORCH_RUN_ID || '';
  // Fresh every run, fixed within one. A roster carried over from a previous run is a mutated
  // base, and two runs already left five roles behind — including two whose vendor was wrong.
  // Same run means a resume: reuse exactly what the operator reviewed at the pause.
  const sameRun = !!storedRunId && storedRunId === thisRunId;
  const remint = process.env.EPAM_REMINT_AGENTS === '1';
  let _mintedNames = [];
  let _mintedDetail = [];
  if (rosterLib.hasProjectRoster(AGENTS_DIR) && sameRun && !remint) {
    process.stderr.write(
      `[mint-step] roster already minted in THIS run (${thisRunId}): ${existingRoles.join(', ')} ` +
      '— reusing exactly what was reviewed at the pause.\n');
  } else if (process.env.EPAM_SKIP_AGENT_MINT === '1') {
    process.stderr.write('[mint-step] mint skipped (EPAM_SKIP_AGENT_MINT=1) — resuming from a checkpoint\n');
  } else {
    // Start from the BASE roster, never a mutated one. Anything a previous run minted is
    // cleared before this run proposes: registry, stored briefs and live entries. Canonical
    // roles are untouched. The KB files stay — cross-run agent knowledge is the one thing
    // that is meant to persist (879c705).
    // BOTH registries decide this, never the roles list alone — see hasProjectRoster.
    if (rosterLib.hasProjectRoster(AGENTS_DIR)) {
      const cleared = rosterLib.clearProjectRoster(AGENTS_DIR, PROFILES_PATH);
      process.stderr.write(
        `[mint-step] clearing the previous run's roster before minting (${cleared.length}): ` +
        `${cleared.join(', ')}\n`);
    }
    // Agent identity reaches ai-run.sh through EPAM_AGENT_NAME and is what makes a cost row
    // attributable. Two distinct agents run here, so each names itself rather than sharing one
    // label — an anonymous or shared identity is how per-agent spend becomes unreadable.
    // DET-1: LOOK AT THE CODE BEFORE ASSEMBLING THE TEAM.
    //
    // Everything the mint has had until now — the ticket, its documents, the declared
    // dependencies — is a CLAIM about the estate. None of it is an observation of it, which is
    // how briefs came to own modules nobody had searched for, and how scope came to be taken
    // from ticket labels that are routinely wrong about which repositories are involved.
    //
    // The survey is cheap by construction: it decides where to look, not what to change. Its
    // failure is not fatal — an estate that cannot be surveyed is the state the roster was
    // minted in until today.
    process.env.EPAM_AGENT_NAME = 'estate-survey';
    const survey = await spec.surveyEstate({
      promptExec,
      tickets: stories,
      referencedDocs: docs,
      declaredDependencies: deps,
      codelines,
      toolGrant,
      logDir: LOG_DIR,
      repoPath: REPO_PATH,
    });
    if (survey.ran) {
      for (const c of survey.codelines) {
        process.stderr.write(`[mint-step]   survey: ${c.codeline} — ${c.state}` +
          `${c.surfaces && c.surfaces.length ? ` (${c.surfaces.join(', ')})` : ''}\n`);
      }
      for (const r of survey.recommendedInvestigators) {
        process.stderr.write(`[mint-step]   survey recommends an investigator for ${r.codeline}: ${r.focus}\n`);
      }
    } else {
      process.stderr.write('[mint-step]   survey did not run — the roster is minted from the ticket alone\n');
    }
    // FALSIFY THE SURVEY BEFORE ANYTHING IS MINTED FROM IT.
    //
    // The survey seeds every investigator brief and scoped the whole run, and nothing reviewed it
    // — a codeline was reported in_scope on a file it does not contain and an implementer was
    // briefed accordingly. Runs HERE, before mintProjectAgents, because reviewing afterwards
    // reports on claims the roster has already absorbed.
    //
    // Never fatal and never edits the survey: it reports, and the findings travel with it.
    try {
      const _sr = await spec.reviewSurvey({
        promptExec, survey, codelines, tickets: stories, logDir: LOG_DIR,
        repoPath: REPO_PATH, toolGrant,
      });
      if (_sr.ran) {
        process.stderr.write(`[mint-step] survey review: ${_sr.findings.length} finding(s) across `
          + `${_sr.reviewed} codeline(s)\n`);
        for (const f of _sr.findings) {
          process.stderr.write(`[mint-step]   ! survey claim refuted (${f.codeline}): ${f.claim} `
            + `— checked ${f.checked}, found ${f.found}\n`);
        }
        survey.reviewFindings = _sr.findings;
      }
    } catch { /* the survey stands unreviewed; its own reviewer failing is not a finding */ }

    // A boundary crossed is reported, never swallowed: the surveyor is structurally barred
    // from naming fix sites, and an attempt to name one says something about the prompt.
    for (const v of survey.violations || []) {
      process.stderr.write(`[mint-step]   ! survey boundary: ${v}\n`);
    }

    process.env.EPAM_AGENT_NAME = 'agent-mint';
    const mint = await spec.mintProjectAgents({
      promptExec,
      tickets: stories,
      referencedDocs: docs,
      declaredDependencies: deps,
      codelines,
      toolGrant,
      estateSurvey: survey,
      profilesPath: PROFILES_PATH,
      agentsDir: AGENTS_DIR,
      logDir: LOG_DIR,
      repoPath: REPO_PATH,
    });
    // Every proposal in exactly one bucket. `superseded` is a proposal refused on one attempt
    // and corrected on a later one — previously invisible, which left the printed line with a
    // silent remainder on three consecutive runs. `unaccounted` is shown only when the numbers
    // genuinely do not reconcile, rather than being folded into another bucket.
    const _tally = spec.reconcileMintTally(mint);
    process.stderr.write(
      `[mint-step] proposed=${_tally.proposed} minted=${_tally.minted} ` +
      `unchanged=${_tally.unchanged} rejected=${_tally.rejected} superseded=${_tally.superseded}` +
      `${_tally.unaccounted ? ` UNACCOUNTED=${_tally.unaccounted}` : ''}\n`);
    for (const m of mint.minted) {
      const tag = m.kind === 'investigator' ? `investigator:${m.codeline || '(no codeline!)'}` : 'implementer';
      process.stderr.write(`[mint-step]   + [${tag}] ${m.name} (${m.surfaces.join(', ')}) — ${m.rationale}\n`);
    }
    // A codeline with no investigator gets the canonical detective — workable, but the
    // operator should see it at the pause rather than infer it from a log line later.
    for (const cl of codelines) {
      const hasInv = mint.minted.some((m) => m.kind === 'investigator' && m.codeline === cl.name);
      if (!hasInv) {
        process.stderr.write(`[mint-step]   ! no investigator minted for codeline "${cl.name}" — it will use the canonical detective\n`);
      }
    }
    for (const r of mint.rejected) {
      process.stderr.write(`[mint-step]   ! refused ${r.name || '(unnamed)'}: ${r.reason}\n`);
    }
    // Persisted at generation time — an artefact that exists only in a log line is a defect.
    fs.writeFileSync(path.join(LOG_DIR, 'agent-mint.json'), JSON.stringify(mint, null, 2));
    _mintedNames = mint.minted.map((m) => m.name);
    _mintedDetail = mint.minted;
  }

  // THE ROSTER'S ONLY ADVERSARY, AND A LOOP THAT ACTS ON IT.
  //
  // A reviewer whose findings nothing consumes is a critic. Its first live run produced seven
  // blocking defects and the roster reached the pause unchanged — every one of those briefs
  // would have been inherited by an implementer.
  //
  // Same shape as enforceVerificationCriteria: findings feed a regeneration, the regeneration is
  // re-reviewed, and the cycle is capped. Corrective mints REPLACE rather than accumulate, so a
  // correction cannot leave defective briefs behind beside their replacements.
  //
  // The replacement is TARGETED (ARCH-7). This first cleared the whole roster on any blocking
  // finding, so one defective brief took every sound one with it and re-derived them all.
  // Minting is a sampling process — a re-proposal is a fresh draw, so a brief that had just
  // passed adversarial review was as likely to come back subtly wrong as to come back the
  // same, and the reviewer's own capped budget went on re-checking settled work. Only the
  // agents a blocking finding NAMES are replaced.
  const runRosterReview = async () => {
    // Same reason as reviewRoster: nothing was examined, so nothing may be certified.
    if (!_mintedDetail.length) return { verdict: 'nothing_to_review', findings: [], reviewed: 0 };
    process.env.EPAM_AGENT_NAME = 'roster-review';
    try {
      const liveProfiles = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
      return await spec.reviewRoster({
        promptExec, minted: _mintedDetail, profiles: liveProfiles,
        codelines, tickets: stories, referencedDocs: docs,
        logDir: LOG_DIR, repoPath: REPO_PATH, toolGrant,
      });
    } catch (err) {
      // A review that cannot run must not read as "no defects" — that is the fail-open shape
      // these gates exist to prevent.
      process.stderr.write(`[mint-step] roster review FAILED: ${err && err.message}\n`);
      return { verdict: 'review_failed', findings: [], reviewed: 0, error: String(err && err.message) };
    }
  };

  const reportReview = (rv, n) => {
    const blocking = rv.findings.filter((f) => f && f.severity === 'blocking');
    process.stderr.write(
      `[mint-step] roster review (cycle ${n}): ${rv.verdict} — ${rv.findings.length} finding(s), ` +
      `${blocking.length} blocking\n`);
    for (const f of rv.findings) {
      process.stderr.write(`[mint-step]   [${f.severity}] ${f.agent}: ${f.claim}\n`);
      process.stderr.write(`[mint-step]      checked: ${f.checked}\n`);
      process.stderr.write(`[mint-step]      found:   ${f.found}\n`);
      if (f.remedy) process.stderr.write(`[mint-step]      remedy:  ${f.remedy}\n`);
    }
  };

  const maxCycles = Number(process.env.EPAM_ROSTER_REVIEW_CYCLES || '2');
  let cycle = 1;
  let review = { verdict: 'not_run', findings: [], reviewed: 0 };

  while (_mintedDetail.length && cycle <= maxCycles) {
    review = await runRosterReview();
    const blocking = review.findings.filter((f) => f && f.severity === 'blocking');
    reportReview(review, cycle);
    if (!blocking.length || cycle === maxCycles) break;

    // Which agents does the reviewer actually indict? A finding names one in `agent`. A
    // finding that names nothing — or names something not in this roster — is a statement
    // about a GAP ("no one covers this codeline"), which indicts no brief and must remove
    // nothing. Those still feed the corrective prompt, where they read as work to add.
    const { indicted: _indicted, retained: _retained, gaps: _gapFindings } =
      rosterLib.partitionRosterFindings(blocking, _mintedDetail);

    process.stderr.write(
      `[mint-step] cycle ${cycle}: ${blocking.length} blocking finding(s) — ` +
      `${_indicted.length} agent(s) indicted, ${_retained.length} retained` +
      `${_gapFindings ? `, ${_gapFindings} finding(s) name no agent (roster gaps)` : ''}\n`);

    // Nothing indicted and nothing to add would re-mint the same roster forever against the
    // same findings. Stop and let the operator see them rather than burn the budget.
    if (!_indicted.length && !_gapFindings) {
      process.stderr.write(
        '[mint-step]   no blocking finding names an agent in this roster — nothing to correct; ' +
        'surfacing the findings instead of re-minting\n');
      break;
    }

    const cleared = rosterLib.clearProjectRoster(AGENTS_DIR, PROFILES_PATH, _indicted);
    for (const c of cleared) process.stderr.write(`[mint-step]   − ${c} (indicted, being replaced)\n`);
    for (const r of _retained) process.stderr.write(`[mint-step]   = ${r.name} (passed review, kept)\n`);

    const remint = await spec.mintProjectAgents({
      promptExec, tickets: stories, referencedDocs: docs, declaredDependencies: deps,
      codelines, toolGrant, profilesPath: PROFILES_PATH, agentsDir: AGENTS_DIR,
      logDir: LOG_DIR, repoPath: REPO_PATH, correctiveFindings: blocking,
      retainedAgents: _retained,
    });
    // The next review sees the WHOLE roster, not just the replacements: a new brief can
    // duplicate or contradict a retained one, and only a review of both would catch it.
    _mintedDetail = [..._retained, ...remint.minted];
    _mintedNames = _mintedDetail.map((m) => m.name);
    fs.writeFileSync(path.join(LOG_DIR, `agent-mint-cycle${cycle + 1}.json`), JSON.stringify(remint, null, 2));
    for (const m of remint.minted) {
      const tag = m.kind === 'investigator' ? `investigator:${m.codeline || '(no codeline!)'}` : 'implementer';
      process.stderr.write(`[mint-step]   + [${tag}] ${m.name} — ${m.rationale}\n`);
    }


    cycle += 1;
  }

  review.cycles = cycle;
  fs.writeFileSync(path.join(LOG_DIR, 'roster-review.json'), JSON.stringify(review, null, 2));

  // THE REVIEW NOT RUNNING IS AS SERIOUS AS THE REVIEW FAILING THE ROSTER.
  //
  // Live 2026-08-08: the reviewer returned empty output, reviewRoster reported "sound", and
  // this roster reached the operator pause labelled clean while nothing had checked it. The
  // reviewer is the only thing standing between a generated brief and an implementer
  // inheriting it whole, so an absent review gets the SAME treatment as surviving defects:
  // stated loudly, and refused outright when no pause is configured for anyone to see it.
  const _mintWasSkipped = process.env.EPAM_SKIP_AGENT_MINT === '1';
  if (rosterLib.rosterReviewIsRequired({
    verdict: review.verdict,
    mintSkipped: _mintWasSkipped,
    pauseConfigured: /^(1|true|yes)$/i.test(process.env.EPAM_PAUSE_AFTER_AGENT_MINT || ''),
  })) {
    process.stderr.write(
      `[mint-step] ! the roster was NOT reviewed (${review.verdict})` +
      `${review.error ? `: ${review.error}` : ''}\n`);
    throw new Error(
      'roster review did not run, so these briefs are unchecked, and no roster pause is ' +
      'configured for anyone to look at them. An unreviewed roster is not a sound one. ' +
      'See roster-review.json.');
  }
  if (_mintWasSkipped) {
    process.stderr.write(
      '[mint-step] resumed roster — reviewed in the run being resumed, not re-reviewed here\n');
  }

  // Still defective after the full correction budget. With the pause on, the operator sees it
  // and decides. With the pause OFF nothing downstream would ever mention it, so it halts here.
  const _stillBlocking = review.findings.filter((f) => f && f.severity === 'blocking');
  if (_stillBlocking.length) {
    process.stderr.write(
      `[mint-step] ${_stillBlocking.length} blocking finding(s) remain after ${cycle} cycle(s)\n`);
    if (!/^(1|true|yes)$/i.test(process.env.EPAM_PAUSE_AFTER_AGENT_MINT || '')) {
      throw new Error(
        `roster review: ${_stillBlocking.length} blocking finding(s) survive after ${cycle} correction ` +
        'cycle(s), and no roster pause is configured for anyone to see them. Refusing to hand these ' +
        'briefs to implementers. See roster-review.json.');
    }
    process.stderr.write('[mint-step] the roster pause is on — surfacing them for review rather than halting\n');
  }

  // ASSIGNMENT DERIVES FROM THE ROSTER, SO IT RUNS ONCE THE ROSTER IS SETTLED.
  //
  // This used to run BEFORE the review/correction loop. Stories were assigned from the
  // PROPOSED roster; the reviewer then indicted agents, the correction replaced them, and the
  // assignments were never revisited. Live 2026-08-08: all three lanes were assigned
  // 'contentstack-live-preview-engineer' after it had been replaced by
  // 'contentstack-live-preview-integration-engineer' — a role with no profile. Each lane would
  // have invoked an agent with an empty system prompt, and the write perimeter would have
  // refused it, since the name is not in project-roles.json. Exactly the "proposed, briefed,
  // wired, assigned a story — and then unable to write a byte" failure the perimeter exists to
  // make impossible.
  //
  await runRosterStage(_mintedDetail);


  // Targeted correction (ARCH-7) is what made this reachable: a wholesale re-mint would have
  // failed loudly and obviously. A surgical replacement leaves the roster looking healthy and
  // only the assignments stale, which is quieter and worse.
  process.env.EPAM_AGENT_NAME = 'role-assigner';
  const assignment = await spec.assignAgentRoles({
    promptExec, stories, profilesPath: PROFILES_PATH, logDir: LOG_DIR, repoPath: REPO_PATH,
  });
  for (const a of assignment.assigned) {
    process.stderr.write(`[mint-step]   ${a.storyId} -> ${a.agentRole} (${a.reason})\n`);
  }
  fs.writeFileSync(path.join(LOG_DIR, 'role-assignments.json'), JSON.stringify(assignment.assigned, null, 2));

  // A LAST DETERMINISTIC CHECK, BECAUSE THIS IS THE SEAM THAT BROKE.
  //
  // Every assignment must name a role that exists in the settled roster. The check is cheap
  // and mechanical, and it fails the step rather than handing a lane a name with no brief.
  const _finalRoles = new Set(Object.keys(JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'))));
  const _orphaned = assignment.assigned
    .filter((a) => a && a.agentRole && !_finalRoles.has(a.agentRole))
    .map((a) => `${a.storyId}${a.codeline ? `/${a.codeline}` : ''} -> ${a.agentRole}`);
  if (_orphaned.length) {
    throw new Error(
      `${_orphaned.length} assignment(s) name a role that is not in the settled roster: ` +
      `${_orphaned.join('; ')}. A lane would invoke an agent with no brief and no write ` +
      'permission. Refusing to hand stories to roles that do not exist.');
  }

  // assignAgentRoles mutates the story objects in place; they are the PRD's own objects.
  fs.writeFileSync(PRD_PATH, JSON.stringify(prd, null, 2));

  writeRosterDiff(PROFILES_PATH, AGENTS_DIR, LOG_DIR, _mintedNames, _mintedDetail);

  // Record which seam every agent just minted enters the pipeline by. Throws if any of them
  // resolves to nothing, which fails the mint — that is the point: an unconfigured agent is
  // caught here, before any story runs, not three hours into a run.
  const _registryPath = process.env.AGENT_PROFILES_REGISTRY || path.join(AGENTS_DIR, "invocation-profiles.json");
  const _xref = writeAgentSeamCrossReference(PROFILES_PATH, _registryPath);
  process.stderr.write(`[mint-step] agent→seam cross-reference written for ${Object.keys(_xref).length} agent(s)\n`);

  // And that the roster we just minted can actually RUN: every required input of every agent has
  // somebody in this roster — or the engine — producing it. A writer waiting on a plan nobody was
  // minted to make is the shape of every unwinnable story this pipeline has produced, and it is
  // decidable here from the data alone, with no model involved and no tokens spent.
  validateWorkflow(PROFILES_PATH, _registryPath);
  process.stderr.write(`[mint-step] ✓ workflow is buildable: every required input has a producer\n`);

  // ── THE ROSTER IS SETTLED, SO NOW BUILD THIS PROJECT'S PROMPTS ─────────────
  //
  // The agent that minted the roster also builds the prompts, because this is the only stage
  // that knows both what the project is and which roles will work on it — the two things a
  // specialised prompt needs. Nothing generated project prompts before this existed, which is
  // why the repo held a handful of hand-authored ones and a new project had none at all.
  //
  // It runs HERE, after the review/correction loop and after validateWorkflow, for the same
  // reason assignment does: generating against a proposed roster would specialise prompts for
  // roles the reviewer is about to replace.
  //
  // The generator is invoked through runClaude, the same seam every other agent uses, so it
  // inherits ladder, retry, timeout and cost capture rather than being a private call.
  {
    const promptsLib = require('./lib/prompt-library.js');
    const { makePromptReviewer, makePromptRenderer } = require('./lib/prompt-review.js');
    const { seamInvocationEnv } = require('./lib/seam-invocation.js');
    const { buildProjectPrompts } = require('./lib/project-prompt-builder.js');
    const engineRoot = path.join(__dirname, '..', '..');
    const templatesDir = path.join(engineRoot, promptsLib.TEMPLATE_DIR_REL);
    const bootstrapFile = path.join(engineRoot, 'orchestrations', 'prompts', 'bootstrap.json');
    const projectConfigDir = process.env.EPAM_PROJECT_CONFIG_DIR || '';

    // No project dir means nowhere to install them, and prompt-library will not fall back to a
    // template. Guessing a location would provision a project nobody asked for.
    if (!projectConfigDir) {
      throw new Error(
        'cannot build project prompts: EPAM_PROJECT_CONFIG_DIR is unset. The project-authority ' +
        'prompts are the only ones ever rendered, and the template is never executed.');
    }

    // THE PROVISIONING MODE IS THE PROJECT'S DECISION, and no mode was being passed at all —
    // so every project silently got 'generate', including the ones whose prompts are meant to
    // stay identical to the generic text. metrolinx is a copy-mode project that the next mint
    // would have regenerated. A project is data; this is one of its facts.
    const promptMode = process.env.EPAM_PROMPT_PROVISION_MODE || '';
    if (!promptMode) {
      throw new Error(
        'cannot build project prompts: EPAM_PROMPT_PROVISION_MODE is unset. Declare it in the '
        + "project's config.env as 'copy' (install the generic templates as they are) or "
        + "'generate' (specialise each one for this project). There is no engine default: "
        + 'picking one silently is how a project ends up running prompts nobody chose.');
    }

    // Resolved by the generator below, consumed by its reviewer. Declared here so the two
    // cannot be reordered without the reviewer losing it.
    let _promptGeneratorModel = '';

    process.env.EPAM_AGENT_NAME = 'prompt-builder';
    // Opt-in per project; the registry's prompt-review.enabledBy names this variable.
    const _promptReviewEnabled = String(process.env.EPAM_PROMPT_REVIEW_ENABLED || '') === '1';
    // Hoisted so the reviewer is handed exactly the codelines the generator was — a reviewer
    // checking claims against different facts than the writer saw is not a review.
    const _codelineContext = codelines
      .map((c) => `- ${(c && c.name) || c}`).join('\n');
    const _built = await buildProjectPrompts({
      templatesDir,
      bootstrapFile,
      // The seam registry decides what needs a project copy — a seam that runs a template needs
      // one, or it executes the generic parent. bootstrap still supplies auxiliary prompts.
      registryFile: path.join(AGENTS_DIR, 'invocation-profiles.json'),
      projectConfigDir,
      mode: promptMode,
      projectContext: [
        `Project config: ${projectConfigDir}`,
        `Tickets in scope: ${stories.map((t) => `${t.jiraKey || t.id}: ${t.title || ''}`).join(' | ')}`,
      ].join('\n'),
      codelineContext: codelines
        .map((c) => `- ${c.name} (${c.path})${c.dependencies && c.dependencies.length ? ` deps: ${c.dependencies.join(', ')}` : ''}`)
        .join('\n'),
      mintedRoles: _mintedDetail.length
        ? _mintedDetail.map((m) => `- ${m.name} [${m.kind}] — ${m.rationale || ''}`).join('\n')
        : '(none minted this run)',
      // THE BUILDER RUNS AT ITS OWN SEAM, with the grants that seam declares.
      //
      // It passed {} as the environment, so it inherited whatever the mint process happened to
      // have: no tool grant, no iteration budget, and the ladder of whichever agent ran last.
      // The operator's design is that this agent READS the templates and decorates them, which
      // it cannot do without read_file and list_files -- and a declaration that never reaches
      // the invocation is the same defect as a ladder that resolves to nothing.
      //
      // AI_GATE_ALLOW_TOOLS is what actually opens the tool channel; the seam decides WHICH
      // tools. Granting the channel without the list, or the list without the channel, both
      // produce an agent that quietly has nothing.
      runText: (prompt, meta) => {
        const seamEnv = seamInvocationEnv('prompt-builder', path.join(engineRoot, 'orchestrations', 'agents'));
        if (seamEnv.EPAM_ALLOWED_TOOLS) seamEnv.AI_GATE_ALLOW_TOOLS = '1';
        // THE REVIEWER WILL RUN THIS MODEL. Captured at the moment the generator resolves it,
        // because a DECLARED tier and a RESOLVED model are not the same fact: both seams declare
        // ladder=top today, so they match by coincidence, and change either declaration — or let
        // the runner escalate one on an empty response — and they diverge with nothing to say so.
        // A prompt is the contract every agent in the run executes against; a reviewer that
        // cannot reproduce the generator's reasoning is reviewing text it could not have written.
        _promptGeneratorModel = seamEnv.EPAM_MODEL || '';
        // The identity travels WITH the seam. It was set on process.env far above, so the two could
        // drift apart without either looking wrong — and elsewhere in this stage they already had.
        seamEnv.EPAM_AGENT_NAME = 'prompt-builder';
        return spec.runClaude(
          promptExec, prompt,
          path.join(LOG_DIR, `prompt-build-${(meta && meta.id) || 'unknown'}.log`),
          seamEnv, { costAgent: 'prompt-builder' });
      },
      // THE REVIEWER, WHEN THE PROJECT ASKS FOR ONE.
      //
      // prompt-review is a full seam — its own template, three required inputs, a declared
      // produces — invoked behind this optional parameter, which no caller supplied. So the one
      // artefact every downstream agent inherits WHOLE was the only generated thing installed
      // unexamined, while its sibling roster-review ran on every mint.
      //
      // Opt-in, because turning it on costs a model call per generated prompt (35 last run) and
      // can block provisioning: the project says EPAM_PROMPT_REVIEW_ENABLED=1. The registry marks
      // the seam optIn and names this variable, so the two cannot drift.
      // THE REVIEWER, WHEN THE PROJECT ASKS FOR ONE — lib/prompt-review.js.
      //
      // It lived here as an anonymous closure, which no test could reach: on 2026-08-18 its
      // ability to REJECT was disabled by hand and all 268 tests passed. It fails open by design
      // (a reviewer that cannot run must not condemn the artefact), so every internal defect looks
      // exactly like approval — which is precisely why the body has to be executable by a test.
      // Every dependency is injected here; the paths are covered by
      // the-prompt-reviewer-was-never-executed.test.ts.
      reviewPrompt: _promptReviewEnabled ? makePromptReviewer({
        render: makePromptRenderer(promptsLib),
        invoke: (prompt, logPath) => {
          const seamEnv = seamInvocationEnv('prompt-review', path.join(engineRoot, 'orchestrations', 'agents'));
          if (seamEnv.EPAM_ALLOWED_TOOLS) seamEnv.AI_GATE_ALLOW_TOOLS = '1';
          seamEnv.EPAM_AGENT_NAME = 'prompt-review';
          // THE GENERATOR'S RUNG, not this seam's. No fallback: if the generator never resolved a
          // model there is nothing to review against, and quietly using the reviewer's own is how
          // a code reviewer judged kimi-k3's work from glm-5.2 for three cycles.
          if (!_promptGeneratorModel) {
            throw new Error(
              '[prompt-review] the generator resolved no model, so there is no rung to review on. '
              + 'Refusing to judge a prompt from a model that did not write it.');
          }
          seamEnv.EPAM_MODEL = _promptGeneratorModel;
          return spec.runClaude(promptExec, prompt, logPath, seamEnv, { costAgent: 'prompt-review' });
        },
        values: ({ id, template, generated }) => ({
          // The reviewer's own brief, from the canonical roster it is registered in. Absent is
          // fine — the template's persona section is then simply empty.
          __PERSONA__: (() => {
            try {
              return JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, 'profiles.json'), 'utf8'))['prompt-review'] || '';
            } catch { return ''; }
          })(),
          __PROMPT_ID__: id,
          __TEMPLATE_BODY__: (template && template.body) || '',
          __GENERATED_BODY__: (generated && generated.body) || '',
          __CODELINE_BLOCK__: _codelineContext,
          __TICKET_BLOCK__: (Array.isArray(stories) ? stories : [])
            .map((t) => `- ${t.id || ''}: ${t.title || ''}`).join('\n'),
          __TOOL_LINE__: toolGrant || '',
        }),
        logPathFor: (id) => path.join(LOG_DIR, `prompt-review-${id}.log`),
        projectConfigDir,
      }) : undefined,
      log: (m) => process.stderr.write(`${m}\n`),
    });
    process.stderr.write(
      `[mint-step] ✓ prompts provisioned (${promptMode}): ${_built.copied.length} copied (bootstrap), ` +
      `${_built.generated.length} generated → ${path.join(projectConfigDir, 'prompts')}\n`);

    // ── LINK THE PROMPTS TO THE AGENTS JUST MINTED ────────────────────────────
    //
    // Provisioning and minting ran in the same stage and knew nothing about each other: the
    // builder walked a static list, the mint separately resolved agents to seams, and nobody
    // asked whether the seam a minted agent enters at has a prompt in THIS project. The answer
    // arrived at that agent's first invocation instead, hours in, with the run already spending.
    //
    // Decidable from data — roster, registry, installed library — so it costs nothing and lands
    // here, where a gap is one line to fix.
    const { linkPromptsToRoster } = require('./lib/prompt-agent-link.js');
    const _link = linkPromptsToRoster({
      projectConfigDir,
      registryFile: _registryPath,
      // rosterAgents returns agent -> brief; the link step wants the NAMES. Passing the object
      // made the roster look empty, which the step correctly refused rather than linking nothing
      // and reporting success.
      agents: Object.keys(rosterAgents(PROFILES_PATH)),
    });
    process.stderr.write(
      `[mint-step] ✓ prompts linked: ${Object.keys(_link.agents).length} agent(s) across ` +
      `${_link.seamsInUse.length} seam(s) → ${path.join(projectConfigDir, 'prompt-agent-link.json')}\n`);

  }

  process.stderr.write(`[mint-step] ✓ roster and assignments written to ${PRD_PATH}\n`);
})().catch((err) => {
  process.stderr.write(`[mint-step] FAILED: ${(err && err.message) || err}\n`);
  process.exit(1);
});
