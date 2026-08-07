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
const REPO_PATH = getArg('--codeline-root', process.env.JIRA_CODELINE_ROOT || '');

if (!PRD_PATH || !fs.existsSync(PRD_PATH)) {
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
  const docs = await referencedDocs(LOG_DIR, stories);

  if (process.env.EPAM_SKIP_AGENT_MINT === '1') {
    process.stderr.write('[mint-step] mint skipped (EPAM_SKIP_AGENT_MINT=1) — resuming from a checkpoint\n');
  } else {
    // Agent identity reaches ai-run.sh through EPAM_AGENT_NAME and is what makes a cost row
    // attributable. Two distinct agents run here, so each names itself rather than sharing one
    // label — an anonymous or shared identity is how per-agent spend becomes unreadable.
    process.env.EPAM_AGENT_NAME = 'agent-mint';
    const mint = await spec.mintProjectAgents({
      promptExec,
      tickets: stories,
      referencedDocs: docs,
      profilesPath: PROFILES_PATH,
      agentsDir: AGENTS_DIR,
      logDir: LOG_DIR,
      repoPath: REPO_PATH,
    });
    process.stderr.write(
      `[mint-step] proposed=${mint.proposed} minted=${mint.minted.length} ` +
      `unchanged=${mint.unchanged.length} rejected=${mint.rejected.length}\n`);
    for (const m of mint.minted) {
      process.stderr.write(`[mint-step]   + ${m.name} (${m.surfaces.join(', ')}) — ${m.rationale}\n`);
    }
    for (const r of mint.rejected) {
      process.stderr.write(`[mint-step]   ! refused ${r.name || '(unnamed)'}: ${r.reason}\n`);
    }
    // Persisted at generation time — an artefact that exists only in a log line is a defect.
    fs.writeFileSync(path.join(LOG_DIR, 'agent-mint.json'), JSON.stringify(mint, null, 2));
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
  process.stderr.write(`[mint-step] ✓ roster and assignments written to ${PRD_PATH}\n`);
})().catch((err) => {
  process.stderr.write(`[mint-step] FAILED: ${(err && err.message) || err}\n`);
  process.exit(1);
});
