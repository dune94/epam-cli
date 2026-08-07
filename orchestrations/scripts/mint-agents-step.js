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
 * does not exist in the pinned contentstack 3.15.3, because nothing could check.
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
  const builtin = path.join(__dirname, '..', 'plugins', 'codegraph-tools.js');
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
  const READ_ONLY_BUILTINS = ['read_file', 'list_files', 'search'];
  const names = [];
  for (const cl of codelines) {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(cl.path, '.epam', 'settings.json'), 'utf8'));
      for (const entry of (settings.tools || [])) {
        try {
          for (const t of (require(entry).tools || [])) {
            const n = t && (t.name || (t.definition && t.definition.name));
            if (typeof n === 'string' && n) names.push(n);
          }
        } catch { /* one unloadable plugin must not blank the grant */ }
      }
    } catch { /* this codeline has no plugins */ }
  }
  return [...new Set([...READ_ONLY_BUILTINS, ...names])].join(',');
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
  if (!cfg) {
    process.stderr.write(
      '[mint-step] no dependency-check.json for this codeline or project — the mint gets no ' +
      'dependency evidence (the engine will not guess which manifest this project uses)\n');
    return [];
  }
  const manifestFile = typeof cfg.manifestFile === 'string' ? cfg.manifestFile : '';
  const manifestKeys = Array.isArray(cfg.manifestKeys) ? cfg.manifestKeys : [];
  if (!manifestFile || !manifestKeys.length) {
    process.stderr.write('[mint-step] dependency-check.json declares no manifestFile/manifestKeys — no dependency evidence\n');
    return [];
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoPath, manifestFile), 'utf8'));
    const names = [];
    for (const key of manifestKeys) {
      const section = manifest[key];
      if (section && typeof section === 'object') names.push(...Object.keys(section));
    }
    return [...new Set(names)];
  } catch (err) {
    process.stderr.write(`[mint-step] could not read ${manifestFile}: ${err && err.message}\n`);
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

module.exports = { resolveRepoPath, resolveCodelines, declaredDependencies, writeRosterDiff, mintTools, provisionPlugins };

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
  if (existingRoles.length && sameRun && !remint) {
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
    if (existingRoles.length) {
      const cleared = rosterLib.clearProjectRoster(AGENTS_DIR, PROFILES_PATH);
      process.stderr.write(
        `[mint-step] clearing the previous run's roster before minting (${cleared.length}): ` +
        `${cleared.join(', ')}\n`);
    }
    // Agent identity reaches ai-run.sh through EPAM_AGENT_NAME and is what makes a cost row
    // attributable. Two distinct agents run here, so each names itself rather than sharing one
    // label — an anonymous or shared identity is how per-agent spend becomes unreadable.
    process.env.EPAM_AGENT_NAME = 'agent-mint';
    const mint = await spec.mintProjectAgents({
      promptExec,
      tickets: stories,
      referencedDocs: docs,
      declaredDependencies: deps,
      codelines,
      toolGrant,
      profilesPath: PROFILES_PATH,
      agentsDir: AGENTS_DIR,
      logDir: LOG_DIR,
      repoPath: REPO_PATH,
    });
    process.stderr.write(
      `[mint-step] proposed=${mint.proposed} minted=${mint.minted.length} ` +
      `unchanged=${mint.unchanged.length} rejected=${mint.rejected.length}\n`);
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

  process.env.EPAM_AGENT_NAME = 'role-assigner';
  const assignment = await spec.assignAgentRoles({
    promptExec, stories, profilesPath: PROFILES_PATH, logDir: LOG_DIR, repoPath: REPO_PATH,
  });
  for (const a of assignment.assigned) {
    process.stderr.write(`[mint-step]   ${a.storyId} -> ${a.agentRole} (${a.reason})\n`);
  }
  fs.writeFileSync(path.join(LOG_DIR, 'role-assignments.json'), JSON.stringify(assignment.assigned, null, 2));

  // assignAgentRoles mutates the story objects in place; they are the PRD's own objects.
  fs.writeFileSync(PRD_PATH, JSON.stringify(prd, null, 2));
  writeRosterDiff(PROFILES_PATH, AGENTS_DIR, LOG_DIR, _mintedNames, _mintedDetail);
  process.stderr.write(`[mint-step] ✓ roster and assignments written to ${PRD_PATH}\n`);
})().catch((err) => {
  process.stderr.write(`[mint-step] FAILED: ${(err && err.message) || err}\n`);
  process.exit(1);
});
