#!/usr/bin/env node
/**
 * synthesize-prd-from-jira.js — Build a pipeline-compatible PRD from Jira issues.
 *
 * Reads the AC gate classification results and the canonical PRD template,
 * then emits a new PRD JSON that the existing story loop can consume unchanged.
 *
 * Codelines are entirely data-driven: whatever codeline labels appear on Jira
 * tickets drive the codeline split. No codeline names are hardcoded here.
 *
 * Worktree paths are read from env vars by convention:
 *   JIRA_WORKTREE_<CODELINE_UPPERCASE>  e.g. JIRA_WORKTREE_BE, JIRA_WORKTREE_FE
 *
 * For stories tagged "both" (spans all codelines), ACs are split per codeline
 * using the AC gate's per-codeline fields (e.g. beAcs, feAcs, mobileAcs).
 *
 * Usage:
 *   node synthesize-prd-from-jira.js \
 *     --classifications <ac-gate-output.json> \
 *     --out <synthesized-prd.json>
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Args ───────────────────────────────────────────────────────────────────

const argv   = process.argv.slice(2);
const getArg = (flag, def = '') => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : def; };

const CLASSIFICATIONS_PATH = getArg('--classifications');
const TEMPLATE_PATH        = getArg('--template',
  path.join(__dirname, '..', 'travel-app-prd.canonical.json'));
const OUT_PATH             = getArg('--out',
  path.join(__dirname, '..', 'travel-app-prd.json'));
const PROJECT_NAME         = getArg('--project-name', '');

// Configurable: the codeline value that means "spans all codelines, split me"
const SPLIT_VALUE = process.env.JIRA_SPLIT_CODELINE || 'both';
// Configurable: fallback codeline for stories with no codeline label in Jira
const DEFAULT_CODELINE = process.env.JIRA_DEFAULT_CODELINE || '';

if (!CLASSIFICATIONS_PATH) {
  process.stderr.write('Usage: node synthesize-prd-from-jira.js --classifications <path> [--out <path>]\n');
  process.exit(1);
}

// ── Load inputs ────────────────────────────────────────────────────────────

const classifications = JSON.parse(fs.readFileSync(CLASSIFICATIONS_PATH, 'utf8'));
const template        = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));

// ── Codeline discovery ─────────────────────────────────────────────────────
// Derive codelines from the data — no names hardcoded in this script.
// SPLIT_VALUE stories are excluded from the codeline list (they get split).

const allCodelines = [...new Set(
  classifications
    .map(c => c.codeline || DEFAULT_CODELINE)
    .filter(cl => cl && cl !== SPLIT_VALUE)
)];

if (allCodelines.length === 0) {
  process.stderr.write('[synthesize-prd] No codelines found in classifications. Check Jira codeline labels or set JIRA_DEFAULT_CODELINE.\n');
  process.exit(1);
}

// ── Worktree path helper ───────────────────────────────────────────────────
// Convention: JIRA_WORKTREE_<CODELINE_UPPERCASE>

function getWorktreePath(codeline) {
  return process.env[`JIRA_WORKTREE_${codeline.toUpperCase()}`] || '';
}

// ── Template story map ─────────────────────────────────────────────────────

const templateStoryMap = {};
for (const s of template.stories || []) {
  templateStoryMap[s.id] = s;
}

// ── Map classification → story ─────────────────────────────────────────────

// Single-ticket JQL scopes (e.g. "issue = AMSD-1820") always synthesize
// exactly one story with no real parallelism to gain — defaulting it to
// agentGroup:"primary" put it on a worktree lane whose topology is decided
// by a live, non-deterministic LLM call, exposing it to a worktree-merge
// bug (found 2026-07-22) that a plain main-branch story never hits. Default
// to "main" whenever this run's whole classification set is a single
// story; multi-story runs keep the previous "primary" default so real
// parallel work still gets worktree lanes.
function classificationToStory(c, totalStoryCount) {
  const tmpl = templateStoryMap[c.storyId] || {};
  // AC IMMUTABILITY (AC/VC/TC design, 2026-07-24): for brownfield the story's
  // acceptanceCriteria are the ticket's ORIGINAL ACs — never the ac-gate's
  // description-fabricated enrichedAcs. When a ticket has no ACs, that's fine:
  // ACs stay empty (immutable), and openspec-brownfield derives the VERIFICATION
  // CRITERIA from the description instead. Using enrichedAcs here re-created the
  // exact AC-elaboration the VC layer exists to eliminate, just one stage earlier
  // (found live 2026-07-24: AMSD-1820 had zero ACs, ac-gate fabricated 6 from the
  // description, and those became the "immutable" ACs). Greenfield (no EPAM_
  // BROWNFIELD) keeps the enriched behavior — there, defining new behavior is the job.
  const isBrownfield = process.env.EPAM_BROWNFIELD === '1';
  const acs = isBrownfield
    ? (c.originalAcs || [])
    : (c.enrichedAcs && c.enrichedAcs.length > 0 ? c.enrichedAcs : c.originalAcs);
  const defaultGroup = totalStoryCount <= 1 ? 'main' : 'primary';

  return {
    ...tmpl,
    id:                 c.storyId || c.jiraKey,
    jiraKey:            c.jiraKey,
    title:              c.title,
    description:        tmpl.description || c.title,
    acceptanceCriteria: acs,
    codeline:           c.codeline || DEFAULT_CODELINE,
    status:             'pending',
    completed:          false,
    agentRole:          tmpl.agentRole || 'typescript-engineer',
    agentGroup:         tmpl.agentGroup || defaultGroup,
    effort:             tmpl.effort || c.effort || 'medium',
    estimate:           tmpl.estimate || 10,
    acGateVerdict:      c.verdict,
    acGateReason:       c.reason,
    // Carry the Jira ticket type through to the PRD story so the spec pass can
    // anchor its defect/novel classification to ground truth (Bug → defect).
    issueType:          c.issueType || null,
  };
}

// ── Split a story across all codelines ────────────────────────────────────
// When a story's codeline is SPLIT_VALUE, create one sub-story per codeline.
// Per-codeline ACs are read from c[`${cl}Acs`] (e.g. c.beAcs, c.feAcs).
// Later codeline sub-stories depend on earlier ones — enforces run order.

function splitAcrossCodelines(c, totalStoryCount) {
  const base    = classificationToStory(c, totalStoryCount);
  const allAcs  = base.acceptanceCriteria || [];
  const results = [];

  for (const cl of allCodelines) {
    const clAcs = (c[`${cl}Acs`] && c[`${cl}Acs`].length > 0)
      ? c[`${cl}Acs`]
      : allAcs;
    const prevIds = results.map(s => s.id);

    results.push({
      ...base,
      id:                 `${base.id}-${cl}`,
      title:              `${base.title} — ${cl.toUpperCase()}`,
      codeline:           cl,
      acceptanceCriteria: clAcs,
      agentGroup:         'primary',
      dependencies:       [...(base.dependencies || []), ...prevIds],
    });
  }

  process.stderr.write(
    `[synthesize-prd]   Split ${base.id} across [${allCodelines.join(', ')}]: ` +
    results.map(s => `${s.codeline}=${s.acceptanceCriteria.length} ACs`).join(', ') + '\n'
  );
  return results;
}

// ── Build stories ──────────────────────────────────────────────────────────

const stories = classifications.flatMap(c =>
  c.codeline === SPLIT_VALUE
    ? splitAcrossCodelines(c, classifications.length)
    : [classificationToStory(c, classifications.length)]
);

// ── Build implementation order ─────────────────────────────────────────────

function buildImplementationOrder(stories, template) {
  if (template.implementationOrder) {
    const knownIds = new Set(stories.map(s => s.id));
    const result   = {};
    for (const [phase, ids] of Object.entries(template.implementationOrder)) {
      result[phase] = ids.filter(id => knownIds.has(id));
    }
    const placed   = new Set(Object.values(result).flat());
    const unplaced = stories.filter(s => !placed.has(s.id));
    if (unplaced.length > 0) {
      const lastPhase = Object.keys(result).pop() || 'core';
      result[lastPhase] = [...(result[lastPhase] || []), ...unplaced.map(s => s.id)];
    }
    return result;
  }
  return { core: stories.map(s => s.id) };
}

// ── Build project config ───────────────────────────────────────────────────

const project = { ...template.project };
if (PROJECT_NAME) project.name = PROJECT_NAME;

const outputDirs = allCodelines
  .map(cl => ({ codeline: cl, path: getWorktreePath(cl) }))
  .filter(d => d.path);

// Always write outputDirs so the orch codeline-setup function can read the
// codeline name without needing JIRA_DEFAULT_CODELINE in its environment.
if (outputDirs.length > 0) {
  project.outputDirs = outputDirs;
  project.outputDir  = outputDirs[0].path;
} else if (allCodelines.length === 1) {
  // Worktree path not yet discovered (e.g. codeline has no JIRA_WORKTREE_* set);
  // fall back to outputDir-only so at least the path is present.
  const wt = getWorktreePath(allCodelines[0]);
  if (wt) project.outputDir = wt;
}

// ── Assemble PRD ───────────────────────────────────────────────────────────

const synthesizedPrd = {
  ...template,
  id:            `jira-sourced-${Date.now()}`,
  title:         PROJECT_NAME || template.title,
  lastUpdated:   new Date().toISOString().slice(0, 10),
  source:        'jira',
  sourceProject: process.env.JIRA_PROJECT_KEY || '',
  project,
  implementationOrder: buildImplementationOrder(stories, template),
  stories,
  currentIteration: (template.currentIteration || 0) + 1,
};

// ── Write output ───────────────────────────────────────────────────────────

fs.writeFileSync(OUT_PATH, JSON.stringify(synthesizedPrd, null, 2));

const verdictCounts = stories.reduce((acc, s) => {
  acc[s.acGateVerdict] = (acc[s.acGateVerdict] || 0) + 1;
  return acc;
}, {});

const codelineSummary = allCodelines
  .map(cl => `${cl}=${stories.filter(s => s.codeline === cl).length}`)
  .join(' ');

process.stderr.write(`[synthesize-prd] ✓ PRD written to ${OUT_PATH}\n`);
process.stderr.write(`[synthesize-prd]   Stories: ${stories.length}\n`);
process.stderr.write(`[synthesize-prd]   Verdicts: ${JSON.stringify(verdictCounts)}\n`);
if (allCodelines.length > 1) {
  process.stderr.write(`[synthesize-prd]   Codelines: ${codelineSummary}\n`);
}

process.stdout.write(OUT_PATH + '\n');
