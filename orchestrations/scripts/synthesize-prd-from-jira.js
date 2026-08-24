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
// NO TEMPLATE. This read a stored prd.canonical.json and spread the WHOLE FILE into the result,
// so every value in it governed every run. metrolinx's carried outputDirs:[cdts] — one codeline,
// frozen in by hand to unblock a failing launch — and resolve-codeline-scope.sh stands aside when
// a scope is already declared, so discovery never ran and every run was scoped to one repository
// whatever the ticket said. The same file had already been cleaned twice for the same class: it
// once described another project's stack, and once carried eight fabricated acceptance criteria.
//
// A stored file that survives runs and shapes them is a run inheriting a previous run's
// conclusions. The tracker is the source of the work; the project's config is the source of its
// identity; there is no third source.
// NO default. This defaulted to travel-app-prd.json, so omitting --out silently
// overwrote the travel-app PRD with whatever project was being synthesized.
const OUT_PATH             = getArg('--out', '');
if (!OUT_PATH) {
  console.error('[synthesize-prd] --out is required (no default: it used to overwrite whichever PRD the built-in default named)');
  process.exit(2);
}
// THE PROJECT'S OWN NAME, from the flag or from the environment the run already carries. It came
// only from --project-name, and the identity otherwise fell back to a stored template's `title`
// and `project.name` — which is how a run could be labelled with another project's name.
const PROJECT_NAME         = getArg('--project-name', process.env.PROJECT_NAME || '');

// Configurable: the codeline value that means "spans all codelines, split me"
// Keep a spanning story WHOLE (one story, N executions) instead of minting
// per-codeline sub-stories. Off by default so existing projects are untouched.
const MULTI_CODELINE_STORIES = process.env.EPAM_MULTI_CODELINE_STORIES === '1';
const SPLIT_VALUE = process.env.JIRA_SPLIT_CODELINE || 'both';
// Configurable: fallback codeline for stories with no codeline label in Jira
const DEFAULT_CODELINE = process.env.JIRA_DEFAULT_CODELINE || '';

if (!CLASSIFICATIONS_PATH) {
  process.stderr.write('Usage: node synthesize-prd-from-jira.js --classifications <path> [--out <path>]\n');
  process.exit(1);
}

// ── Load inputs ────────────────────────────────────────────────────────────

let classifications = JSON.parse(fs.readFileSync(CLASSIFICATIONS_PATH, 'utf8'));


// ── Codeline discovery ─────────────────────────────────────────────────────
// Derive codelines from the data — no names hardcoded in this script.
// SPLIT_VALUE stories are excluded from the codeline list (they get split).

let allCodelines = [...new Set(
  classifications
    .map(c => c.codeline || DEFAULT_CODELINE)
    .filter(cl => cl && cl !== SPLIT_VALUE)
)];

// Fall back to the codelines DISCOVERY already found. Deriving the list only
// from per-story labels throws that work away: AMSD-2041 was a single story
// marked SPLIT_VALUE, every candidate was filtered out, the list came back
// empty and ingest exited 1 — after discovery had successfully identified the
// repositories and exported them.
if (allCodelines.length === 0 && process.env.JIRA_CODELINES) {
  allCodelines = process.env.JIRA_CODELINES.split(',').map(c => c.trim()).filter(Boolean);
  if (allCodelines.length) {
    process.stderr.write(
      `[synthesize-prd] No per-story codeline labels; using discovered codelines: ` +
      `${allCodelines.join(', ')}\n`);
  }
}

if (allCodelines.length === 0) {
  process.stderr.write('[synthesize-prd] No codelines found in classifications. Check Jira codeline labels or set JIRA_DEFAULT_CODELINE.\n');
  process.exit(1);
}

// ── Optional single/subset codeline run ────────────────────────────────────
// EPAM_CODELINE_FILTER=<name>[,<name>...] runs only those codelines. Unset or empty
// means ALL — existing projects are untouched, which is why the no-op path is asserted
// first in test/unit/orchestration/codeline-filter.test.ts.
//
// Why here: every lane fact downstream derives from exactly two lists — allCodelines
// (project.outputDirs, and the per-codeline split of a spanning story) and classifications
// (the per-codeline stories). Narrowing BOTH at this single point yields a PRD that is
// coherently single-lane. Filtering only one of them, or filtering later in the
// orchestrator, would leave a PRD claiming N lanes while one ran — and 18 downstream
// consumers read project.outputDirs, so that partial state is a bug generator rather than
// a smaller run.
//
// No codeline name appears here: the value is configuration, and the names come from the
// data, exactly as the rest of this script derives them.
const CODELINE_FILTER = (process.env.EPAM_CODELINE_FILTER || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

if (CODELINE_FILTER.length) {
  const availableCodelines = allCodelines;
  allCodelines = availableCodelines.filter(cl => CODELINE_FILTER.includes(cl));

  if (allCodelines.length === 0) {
    // Loud, never silent. Running ALL lanes would spend several times what was asked for;
    // running NONE would look like a clean no-op. Both are worse than stopping, and the
    // message names the typo and the real options so it is fixable without reading code.
    process.stderr.write(
      `[synthesize-prd] EPAM_CODELINE_FILTER='${CODELINE_FILTER.join(',')}' matched none of ` +
      `the available codelines: ${availableCodelines.join(', ')}. Refusing to guess whether ` +
      `you meant all of them or none.\n`);
    process.exit(1);
  }

  // Drop stories belonging to codelines that are filtered out. A SPLIT_VALUE story is kept
  // whole: it spans codelines and is split across the NARROWED list below, so it needs no
  // filtering of its own.
  const beforeStories = classifications.length;
  classifications = classifications.filter(
    c => c.codeline === SPLIT_VALUE || allCodelines.includes(c.codeline || DEFAULT_CODELINE)
  );

  process.stderr.write(
    `[synthesize-prd] EPAM_CODELINE_FILTER active: running ${allCodelines.join(', ')} ` +
    `(of ${availableCodelines.join(', ')}); ${classifications.length} of ${beforeStories} ` +
    `classification(s) retained.\n`);
}

// ── Worktree path helper ───────────────────────────────────────────────────
// Convention: JIRA_WORKTREE_<CODELINE_UPPERCASE>

function getWorktreePath(codeline) {
  return process.env[`JIRA_WORKTREE_${codeline.toUpperCase()}`] || '';
}

// ── Template story map ─────────────────────────────────────────────────────



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
  // NO STORED STORY. This read a template story with the same id and used it for any field the
  // ticket left blank — a second, older answer that won by default.
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
    id:                 c.storyId || c.jiraKey,
    jiraKey:            c.jiraKey,
    title:              c.title,
    // THE TICKET'S OWN DESCRIPTION WINS. This read `tmpl.description || c.title`: the
    // PRD template's text if it had any, otherwise the ticket's TITLE — the description
    // itself was never consulted. In brownfield the description is the only substantive
    // content a ticket carries (the AC gate skips acceptance criteria entirely and records
    // "VCs are derived from the description"), so every story reached the spec pass
    // described by its own one-line summary. Live 2026-08-06: 43 characters instead of 395.
    // The template is a fallback for a ticket with no description, never a replacement.
    description:        c.description || c.title,
    acceptanceCriteria: acs,
    codeline:           c.codeline || DEFAULT_CODELINE,
    status:             'pending',
    completed:          false,
    // NO DEFAULT ROLE. At synthesis time nothing has analysed this codeline yet, so no
    // roster exists to choose from — a step that cannot know the answer must not invent
    // one. This read `tmpl.agentRole || 'typescript-engineer'`, which put EVERY brownfield
    // ticket without a template role onto a single agent whose system prompt describes
    // epam-cli's own src/cli internals (Commander.js, Repl.ts, SlashCommands.ts). Live
    // 2026-08-07: AMSD-2041 -> typescript-engineer, writing Contentstack code against a
    // Metrolinx Angular codeline. The literal never errored, so it was never noticed; it
    // was just always wrong. null means DEFERRED — assignment happens after the project's
    // roles are minted, against the live roster. Downstream must fail loudly on an
    // unassigned role rather than substitute another literal.
    agentRole:          null,
    agentGroup:         defaultGroup,
    effort:             c.effort || 'medium',
    estimate:           c.estimate || null,
    acGateVerdict:      c.verdict,
    acGateReason:       c.reason,
    // Carry the Jira ticket type through to the PRD story so the spec pass can
    // anchor its defect/novel classification to ground truth (Bug → defect).
    issueType:          c.issueType || null,
    // The tracker's OWN statement of which product areas this ticket touches.
    // Dropped here until 2026-08-06: codeline-discovery calls components "the
    // strongest evidence", and it was present in Jira but null on every story in
    // the PRD, so nothing downstream of ingest could act on it.
    components:         Array.isArray(c.components) ? c.components : [],
    // Comment prose, kept for JUDGEMENT about scope and viability — never routed
    // into the code-search query, where its rare tokens (release names, "cc")
    // would be amplified by IDF and drag the search away from real code. Live
    // AMSD-2041: a stakeholder wrote "no code changes are needed and its more of
    // configure and use" six weeks before two runs built an implementation.
    ticketComments:     Array.isArray(c.comments) ? c.comments : [],
    // URLs found in the description and comments, with provenance. Two vendor
    // docs here refuted the story's central assumption and were destroyed at
    // ingest by an ADF flattener that read text and dropped link marks.
    ticketLinks:        Array.isArray(c.commentLinks) ? c.commentLinks : [],
  };
}

// ── Split a story across all codelines ────────────────────────────────────
// When a story's codeline is SPLIT_VALUE, create one sub-story per codeline.
// Per-codeline ACs are read from c[`${cl}Acs`] (e.g. c.beAcs, c.feAcs).
// Later codeline sub-stories depend on earlier ones — enforces run order.

/**
 * A story that spans codelines stays ONE story and records where it belongs.
 *
 * The orchestrator already loops per codeline with PROJECT_ROOT set per
 * iteration, so a whole story simply participates in N of those iterations —
 * each execution still single-repo, which is what keeps worktrees, git, lint
 * baselines and the writer manifest working unchanged.
 *
 * Splitting into `${id}-${cl}` sub-stories (splitAcrossCodelines below) was
 * ruled out for brownfield: verification criteria carry the meaning downstream,
 * and splitting at ingest widens a surface that has to be narrowed again later.
 */
function spanningStory(c, totalStoryCount) {
  const base = classificationToStory(c, totalStoryCount);
  process.stderr.write(
    `[synthesize-prd]   ${base.id} spans [${allCodelines.join(', ')}] — kept as ONE story\n`);
  return [{
    ...base,
    codeline:  allCodelines[0],   // the lane it starts in; codelines[] is authoritative
    codelines: [...allCodelines],
  }];
}

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
    ? (MULTI_CODELINE_STORIES
        ? spanningStory(c, classifications.length)
        : splitAcrossCodelines(c, classifications.length))
    : [classificationToStory(c, classifications.length)]
);

// ── Build implementation order ─────────────────────────────────────────────

// THE ORDER IS THE TICKETS'. It used to come from a stored template's implementationOrder, which
// listed story ids from an earlier run; ids that no longer existed were filtered out and whatever
// remained decided the order of work.
function buildImplementationOrder(stories) {
  return { core: stories.map((s) => s.id) };
}

// ── Build project config ───────────────────────────────────────────────────

// IDENTITY FROM THE PROJECT'S OWN CONFIG. Not a stored file: PROJECT_NAME and JIRA_PROJECT_KEY
// are what the project declares about itself, and they are already required for the run to
// address the right tracker and the right estate.
//
// NO STACK. It used to arrive from the template — one language, runtime, framework and test
// runner asserted for a whole estate, and get_project_context() flattens it into every agent's
// prompt. metrolinx is 33 repositories, including .NET ones. Stack is a per-codeline fact and the
// engine already derives it per codeline (codeline-facts.json, lib/handlers/stack-facts.js).
//
// NO SCOPE. outputDirs below is written only from codelines this run actually resolved.
const project = {};
if (PROJECT_NAME) project.name = PROJECT_NAME;
if (process.env.PROJECT_DESCRIPTION) project.description = process.env.PROJECT_DESCRIPTION;

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
  id:            `jira-sourced-${Date.now()}`,
  title:         PROJECT_NAME || '',
  version:       '1.0.0',
  lastUpdated:   new Date().toISOString().slice(0, 10),
  source:        'jira',
  sourceProject: process.env.JIRA_PROJECT_KEY || '',
  project,
  implementationOrder: buildImplementationOrder(stories),
  stories,
  // FRESH EVERY RUN. This was (template.currentIteration || 0) + 1, so the count advanced from
  // whatever a stored file happened to hold — 7, when this was found. The PRD is ingested and
  // does not survive the run, so its first iteration is its first.
  currentIteration: 1,
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
