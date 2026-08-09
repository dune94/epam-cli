#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// spec-mode-runner.js — Collaborative specification elaboration pipeline
//
// Architecture:
//   coordinator  →  assigns agents per story
//   openspec     →  elaborates AC, proposes splits, adds technical depth
//   speckit      →  reviews openspec output, adds testability/security/edge-case
//                   criteria, flags gaps, may refine splits
//   coordinator  →  final review pass with verdict + quality score
//
// Agent collaboration is SEQUENTIAL, not parallel:
//   openspec runs first per story, then speckit receives openspec's output
//   and builds on it. Each agent's contribution is tracked independently.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execSync } = require('node:child_process');
// Lazily loaded: this file is executed from an ISOLATED COPY by some callers
// (see guarded-step-retry-history.test.ts), so a hard top-level require of a
// sibling lib would break them at load time rather than at use.
let _gv = null;
function _guardVocabLib() {
  if (!_gv) _gv = require('./lib/guard-vocabulary');
  return _gv;
}

// Schema for the ticket-link agent. Structured because its output enters an evidence path:
// a prose answer cannot be persisted, diffed, or acted on, and a paraphrase of an API
// contract is how a wrong contract propagates (live: a callback signature was assumed,
// asserted in the story's criteria, and refuted by a doc nobody read).
const TOOL_TICKET_LINKS = {
  name: 'submit_ticket_links',
  description:
    'Classify every URL found in the ticket, judge its relevance to this story, and for a ' +
    'relevant document you could actually fetch, quote what it says about the implementation. ' +
    'Do not answer in prose.',
  parameters: {
    type: 'object',
    required: ['links'],
    properties: {
      links: {
        type: 'array',
        items: {
          type: 'object',
          required: ['url', 'classification', 'relevant', 'fetchStatus', 'quotes'],
          properties: {
            url: { type: 'string' },
            classification: {
              type: 'string',
              enum: ['vendor_documentation', 'internal_wiki', 'ticket_or_board',
                     'meeting_or_email', 'source_code', 'unreachable', 'unknown'],
            },
            relevant: { type: 'boolean', description: 'Does it bear on THIS story?' },
            // WHETHER IT WAS ACTUALLY OPENED. Without this, "I read it and it says nothing
            // relevant" and "I never opened it" are the same answer — and on 2026-08-06 a
            // bound reply returned two bare classifications that read exactly like a
            // completed review. An agent that could not reach a page must say so.
            fetchStatus: {
              type: 'string',
              enum: ['fetched', 'unreachable', 'not_attempted'],
              description:
                'Did you actually open this URL? "fetched" means you read the document and '
                + 'the quotes below come from it. Never say "fetched" for a page you did not read.',
            },
            reason: { type: 'string', description: 'Why relevant or not — one clause.' },
            quotes: {
              type: 'array',
              // AT LEAST ONE. Optional quotes let a strict binding return two URLs and
              // nothing else — structurally perfect, evidentially empty. A fetched document
              // must yield a quote; an unreachable one must say why here.
              minItems: 1,
              description:
                'VERBATIM quotes from the document that bear on the implementation — the real ' +
                'signature or contract of an API the story depends on, required configuration, ' +
                'or whether the work is code or configuration. Quote, never paraphrase.',
              items: { type: 'string' },
            },
            scopeCaveat: {
              type: 'string',
              description:
                'If the document targets a different framework variant, router, or version ' +
                'than the codeline uses, say so — following it literally would be wrong.',
            },
            contradictsStory: {
              type: 'string',
              description:
                'If the document contradicts an assumption visible in this story, state both ' +
                'sides. This is the single most valuable thing to return.',
            },
          },
        },
      },
    },
  },
};

const TOOL_GUARD_VOCABULARY = (() => { try { return require('./lib/guard-vocabulary').TOOL_GUARD_VOCABULARY; } catch { return null; } })();
const normaliseVocabulary = (...a) => _guardVocabLib().normaliseVocabulary(...a);
const isVocabularyUsable  = (...a) => _guardVocabLib().isVocabularyUsable(...a);
const applyVocabulary     = (...a) => _guardVocabLib().applyVocabulary(...a);
// Cost emission for every agent this file drives — see lib/cost-emitter.js for
// why (spec-mode previously emitted no cost at all, hiding ~68% of run spend).
// Loaded DEFENSIVELY: cost tracking is observability, never a hard dependency of
// running an agent. A hard require made this whole module unloadable wherever
// lib/ isn't alongside it (e.g. tests that copy the script to a temp dir), which
// is exactly the kind of self-inflicted breakage observability must not cause.
let emitCostSnapshot = () => null;
try {
  ({ emitCostSnapshot } = require('./lib/cost-emitter'));
} catch {
  /* cost emitter unavailable — agents still run, cost simply isn't recorded */
}

// Semble code-context retrieval — loaded lazily so the module is optional.
// When SEMBLE_ENABLED=1 and the binary is present, fetchSembleContext() returns
// a formatted block of existing-code snippets to inject into the spec prompt.
// ── Code context injection ─────────────────────────────────────────────────
// Brownfield: CodeGraph (deterministic AST graph — exact symbols + callers +
//   blast radius).  Falls back to Semble if CodeGraph is unavailable/unindexed.
// Greenfield: Semble only (no graph needed; semantic similarity finds analogues).

let _semble;
let _codegraph;

function fetchCodeGraphContext(story) {
  if (process.env.CODEGRAPH_ENABLED !== '1') return null;
  try {
    if (!_codegraph) _codegraph = require('./lib/codegraph-context');
    const repoPath = resolveCodelinePath(story);
    if (!repoPath || !fs.existsSync(repoPath)) return null;
    if (!_codegraph.isCodeGraphIndexed(repoPath)) {
      // Self-heal at the point of use instead of trusting a run-start
      // preflight to still hold by the time the spec pass actually needs
      // it. Found live 2026-07-23: a valid index existed right after
      // preflight passed, but was gone minutes later by the time this
      // function ran — something between the two silently invalidated it.
      // Re-index on demand here so CodeGraph's contribution never silently
      // degrades to null regardless of what happened in between.
      console.log(`spec-mode: CodeGraph index missing/invalid for ${repoPath} at point of use — re-indexing now`);
      try {
        _codegraph.initCodeGraph(repoPath, { quiet: true });
      } catch (err) {
        console.warn(`spec-mode: CodeGraph re-index failed for ${repoPath}: ${err.message}`);
        return null;
      }
      if (!_codegraph.isCodeGraphIndexed(repoPath)) return null;
    }

    const domainTerms = story.title
      .replace(/\b(the|a|an|is|not|for|in|of|and|or|to|as|at|by|be|was|are|it|its|that|this|with)\b/gi, '')
      .trim()
      .slice(0, 200);
    const query = `applies handles processes resolves ${domainTerms}`.slice(0, 300);
    const output = _codegraph.exploreCodeGraph(query, repoPath, { maxFiles: 4, maxChars: 12000 });
    return output || null;
  } catch { return null; }
}

function fetchSembleContext(story) {
  if (process.env.SEMBLE_ENABLED !== '1') return '';
  try {
    if (!_semble) _semble = require('./lib/semble-context');
    const repoPath = resolveCodelinePath(story);
    if (!repoPath || !fs.existsSync(repoPath)) return '';

    const isBrownfield = process.env.EPAM_BROWNFIELD === '1';

    // Symptom query — same in both modes; finds code near the described behavior
    const symptomQuery = [story.title, ...(story.acceptanceCriteria || []).slice(0, 3)].join(' ').slice(0, 400);
    const symptomResult = _semble.sembleSearch(symptomQuery, repoPath, 8, 20);

    if (!isBrownfield) {
      if (!symptomResult.results || symptomResult.results.length === 0) return '';
      const block = _semble.formatAsText(symptomResult);
      return `\nEXISTING CODE CONTEXT (from semble semantic search — use this to write precise, grounded ACs):\n${block}\n`;
    }

    // Brownfield Semble fallback: two queries (symptom + service-boundary).
    const domainTerms = story.title
      .replace(/\b(the|a|an|is|not|for|in|of|and|or|to|as|at|by|be|was|are|it|its|that|this|with)\b/gi, '')
      .trim()
      .slice(0, 200);
    const pathQuery = `applies handles processes calculates resolves ${domainTerms}`.slice(0, 400);
    const pathResult = _semble.sembleSearch(pathQuery, repoPath, 5, 30);

    const seen = new Set();
    const combined = [];
    for (const r of [...(symptomResult.results || []), ...(pathResult.results || [])]) {
      const key = `${r.file_path}:${r.start_line}`;
      if (!seen.has(key)) { seen.add(key); combined.push(r); }
    }
    if (combined.length === 0) return '';
    const block = _semble.formatAsText({ results: combined });
    return `\nEXISTING CODE (brownfield fallback via Semble — identify the code path that handles this behavior, then specify how to fix it; do not propose new abstractions):\n${block}\n`;
  } catch { return ''; }
}

// getDeterministicCandidateFiles(story, topN) — brownfield only. Runs the
// EXACT same Semble query fetchSembleContext uses, but returns raw
// deduped file paths (ranked) instead of a formatted text block, for
// deterministic merging into locationHint/technicalNotes.files.
//
// Root cause this closes (found live 2026-07-23, AMSD-1820): Semble search
// itself reliably surfaced the real fix site (apply-report-discounts.service.ts)
// in its top 1-2 results across multiple different real AC wordings — but
// the MODEL's own selection of which candidates to report as locationHint
// varied run to run even at temperature=0 (a known characteristic of many
// hosted inference backends — batching/MoE routing/floating-point
// non-associativity in parallel decode — not something fixable in this
// codebase). Rather than trying to make an LLM more deterministic, remove
// its discretion from the one step that doesn't need judgment: the top-N
// search candidates are injected directly, unconditionally, regardless of
// what the model itself reports. The model's own locationHint still adds
// anything beyond the top-N (its real judgment is still used for that).
// buildBrownfieldSearchQuery(story) — builds the code-search query from a
// brownfield story's DOMAIN nouns, deliberately dropping symptom/presentation
// words.
//
// Root cause this closes (proven live 2026-07-23, AMSD-1820, 3x reproducible):
// a bug ticket describes a SYMPTOM ("promo code amount is NOT displayed as
// expected ... in the email confirmation"), but the fix lives in the CAUSE —
// a discount-matching service (apply-report-discounts.service.ts) whose code
// says nothing about "display" or "email". Searching Semble with the raw
// title+ACs put presentation words ("displayed", "email confirmation",
// "as expected") at the front of the query, which pulled the ranking toward
// the display/mapper layer and buried the actual fix site past rank 20.
// Stripping those symptom/presentation words and keeping only the domain
// nouns ("promo code discount amount return trip mozio dispatch report")
// ranks the real fix site #1, deterministically. This is a general property,
// not overfit to this ticket: for ANY "output field X is wrong" bug, the
// causal fix site is where X is COMPUTED, and that code is described by X's
// domain terms — never by the presentation verb ("displayed"/"shown") that
// only the symptom uses.
// The symptom-word list that used to live here is GONE (2026-08-08). It was unreferenced —
// dead code — but a baked word list sitting in the engine is something the next person
// reaches for. Word lists are DERIVED here: the guard-vocabulary agent returns them per
// ticket, in context, and codeline discovery already reports which terms 'carry no selection
// signal'. Where no list is needed at all, prefer the plan-alignment check's approach: look
// only at identifier-shaped tokens, which are distinctive without any vocabulary.
function buildBrownfieldSearchQuery(story, vocabulary) {
  // Seeds the code-graph detective's FIRST `explore` — the query that starts the whole
  // chain (fix sites -> manifest -> ACs -> VCs). Everything downstream inherits it.
  //
  // READS EVERYTHING THE STORY CARRIES. It used to read the title and the first three
  // acceptance criteria. In brownfield the ACs are empty by design (the AC gate skips them
  // and says "VCs are derived from the description") and technicalNotes does not exist yet,
  // so the query was built from a headline alone while the description — the only
  // substantive content a brownfield ticket has — was never read. Live 20260806T134550Z the
  // detective was seeded with "go up mx live preview of content in cms".
  //
  // TERM SELECTION IS NOT DONE HERE. A hardcoded stopword list used to filter these tokens;
  // it is gone. But removing filtering altogether is worse, not better: BM25/IDF demotes
  // terms that are COMMON in the corpus and AMPLIFIES terms that are RARE, so a bracketed
  // brand tag like "mx" — rare in any codebase — is promoted to a top discriminator.
  // Frequency cannot separate "rare and meaningful" from "rare and meaningless".
  //
  // So the caller supplies a vocabulary derived by the guard-vocabulary agent and verified
  // against the CodeGraph index (a candidate resolving to no symbol is noise however rare).
  // With no vocabulary the query is unfiltered — this function makes no judgement of its own.
  const parts = [story.title, story.description, ...(Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [])];
  const raw = parts.filter(Boolean).join(' ');
  const tokens = raw.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter(Boolean);

  const excluded = new Set(
    (vocabulary && Array.isArray(vocabulary.blacklist) ? vocabulary.blacklist : [])
      .map((b) => String((b && b.term) || '').toLowerCase()).filter(Boolean));

  // De-dupe, preserving order. Not a judgement — it just avoids sending a token twice.
  const seen = new Set();
  const ordered = [];
  for (const w of tokens) {
    if (excluded.has(w) || seen.has(w)) continue;
    seen.add(w); ordered.push(w);
  }
  // Bounded by the search backend's own query limit, not by a number picked here.
  const cap = Number(process.env.CODEGRAPH_QUERY_MAX_CHARS || '2000');
  let query = ordered.join(' ');
  if (query.length > cap) query = query.slice(0, cap);
  return query || (story.title || '');
}

function getDeterministicCandidateFiles(story, topN = 3) {
  if (process.env.EPAM_BROWNFIELD !== '1') return [];
  const repoPath = resolveCodelinePath(story);
  if (!repoPath || !fs.existsSync(repoPath)) return [];
  const symptomQuery = buildBrownfieldSearchQuery(story);
  const ordered = [];
  const seen = new Set();
  const add = (f) => { if (f && !seen.has(f)) { seen.add(f); ordered.push(f); } };

  // PRIMARY: CodeGraph. Deterministic (static FTS5 symbol index), structural
  // (ranks by symbol relevance + blast radius), and — with the domain-noun
  // query above — lands the true CAUSAL fix site at rank #1 (proven 3x live,
  // AMSD-1820). This is the demotion of Semble from primary to fallback: it
  // only ever carried fix-site discovery because CodeGraph was silently
  // returning null (unindexed) for months.
  try {
    if (!_codegraph) _codegraph = require('./lib/codegraph-context');
    if (process.env.CODEGRAPH_ENABLED === '1') {
      for (const f of _codegraph.exploreCandidateFiles(symptomQuery, repoPath, topN)) add(f);
    }
  } catch { /* CodeGraph unavailable — Semble fallback below still applies */ }

  // FALLBACK/SUPPLEMENT: Semble. Semantic (embedding) search catches concepts
  // that aren't in any symbol name — useful when CodeGraph's lexical index is
  // thin or unindexed. Fills remaining slots after CodeGraph's picks.
  if (ordered.length < topN && process.env.SEMBLE_ENABLED === '1') {
    try {
      if (!_semble) _semble = require('./lib/semble-context');
      // Semble's ranking is NOT stable across different -k values — always
      // request a fixed larger k (8) and slice in JS, never pass topN as -k.
      const result = _semble.sembleSearch(symptomQuery, repoPath, 8, 5);
      for (const r of (result.results || [])) add(r.file_path);
    } catch { /* both retrievers unavailable — return whatever CodeGraph gave */ }
  }

  return ordered.slice(0, topN);
}

// Returns the code context block to inject into the spec prompt.
// Brownfield: runs BOTH CodeGraph and Semble and includes whatever each
// finds — NOT CodeGraph-with-Semble-as-fallback. Live bug (AMSD-1820,
// 2026-07-22): CodeGraph's FTS5/BM25 keyword search matches on symbol names,
// so a natural-language bug title ("promo code amount NOT displayed...")
// reliably surfaces generic files sharing common terms ("mozio", "email")
// but not the actual fix site (apply-report-discounts.service.ts, whose
// relevant symbols are named applyReportDiscountsService/getDiscountName —
// none of which appear in the bug title). CodeGraph still returned SOME
// output (16 symbols across other files), so the old "fall through to
// Semble only when CodeGraph found nothing" logic never gave Semble a
// chance — even though Semble's embedding search correctly ranked the real
// fix file 3rd. Confirmed live: the agent never saw apply-report-discounts.
// service.ts existed and wrote a brand-new, disconnected module instead.
// Greenfield: Semble only (no existing code to search).
/**
 * A constraint for services this project has declared it cannot reach.
 *
 * Returns '' unless the project declares one, so every other project — and every
 * run with reachable infrastructure — is completely unaffected. Narrowing what
 * "done" means is only correct when the narrowing is true.
 *
 * Consumed where verification criteria are WRITTEN, not only by the test writer.
 * A criterion demanding live behaviour cannot be satisfied by a mocked test: the
 * writer would do as instructed and the validator would correctly report the
 * criterion unmet — two agents in conflict, both behaving correctly, because the
 * constraint arrived downstream of the thing that defines done.
 *
 * The engine never learns what any of these services ARE. It reads a flag and a
 * host list; the vendor lives in per-project config.
 */
/**
 * publishedContracts(repoPath, story) — the exported API surface of codelines
 * that already ran, for a story that spans several.
 *
 * Run 9 blamed the function that DISPLAYED a value instead of the one that
 * COMPUTED it, inside a single repository with full CodeGraph access. Across a
 * repo boundary that failure becomes structural: for the classic FE/BE bug the
 * frontend detective finds "we read a field and it is undefined" and prescribes
 * a defensive check — plausible, verbatim-quotable, and papering over a cause it
 * cannot see. The backend detective finds nothing wrong. Both succeed; the bug
 * survives.
 *
 * Completed codelines already publish their surface to .contracts/<storyId>.md
 * for STORY agents. The detective was never given it. It does not need the
 * neighbouring codebase — only the neighbouring surface.
 */
function publishedContracts(repoPath, story) {
  // A story whose codeline cannot be resolved is ordinary — mocks, greenfield,
  // a lane not yet created. path.join(null, ...) throws, and this is called
  // while building a prompt, so that throw takes the whole spec pass down.
  if (!repoPath) return '';
  const dir = path.join(repoPath, '.contracts');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch { return ''; }
  if (!files.length) return '';

  const done = Array.isArray(story && story.codelines) ? story.codelines : [];
  const parts = [];
  for (const f of files.slice(0, 4)) {
    let body = '';
    try { body = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 4000); } catch { continue; }
    if (body.trim()) parts.push(`### ${f.replace(/\.md$/, '')}\n${body}`);
  }
  if (!parts.length) return '';

  return `

## Published contracts from codelines that already ran
${done.length ? `This story spans ${done.length} codelines (${done.join(', ')}). ` : ''}\
The following is the exported surface of work already completed elsewhere for this story.

${parts.join('\n\n')}

THE CAUSE MAY NOT BE IN THIS REPOSITORY. When a value arrives here already wrong,
the defect is upstream and the fix belongs there — a defensive check at this
boundary hides it and will pass every test you can write here. If what you see
contradicts a contract above, say so and name the other codeline rather than
prescribing a local workaround. There is always SOME line in this repository that
consumes the wrong value; naming it is not the same as finding the cause.`;
}

/**
 * _specAgentFailed — what to do when a spec agent throws.
 *
 * Both call sites used to catch the error and assign null without looking at
 * it. The error object was discarded, so a spec agent that crashed and a
 * provider that timed out were indistinguishable, and both were treated as
 * transient: four
 * attempts, then a FATAL message telling the operator to check SPEC_MODE_*
 * models and RUNCLAUDE_TIMEOUT_MS.
 *
 * Live mock1 run 8: the cause was `ReferenceError: repoPath is not defined` in
 * the prompt builder. Unconditional, identical every attempt, and nowhere in any
 * log. The retry budget bought nothing but four times the delay.
 *
 * So: always surface the error, and distinguish the two cases. A provider
 * failure is worth retrying. A programming error is not — it will fail the same
 * way forever, and the honest response is to stop immediately with the actual
 * stack rather than three more attempts and a misleading diagnosis.
 */
const _PROGRAMMING_ERRORS = [ReferenceError, TypeError, SyntaxError, RangeError];

function _specAgentFailed(agent, story, err, attemptLabel) {
  const storyId = (story && story.id) || 'unknown';
  const isBug = _PROGRAMMING_ERRORS.some((E) => err instanceof E);

  console.error(
    `spec-mode: ${agent} threw for ${storyId} (${attemptLabel}) — ` +
    `${err && err.name ? err.name : 'Error'}: ${err && err.message ? err.message : String(err)}`
  );
  if (err && err.stack) console.error(err.stack);

  if (isBug) {
    // Not a provider problem, and no number of retries changes it. Fail with the
    // real cause instead of laundering it into "transient failure".
    console.error(
      `spec-mode: this is a defect in the orchestrator, not a provider failure — ` +
      `retrying cannot help. Aborting immediately.`
    );
    throw err;
  }
  return null;
}

function unreachableExternalsConstraint(env = process.env) {
  if (env.EPAM_MOCK_EXTERNAL_CMS_APIS !== '1') return '';
  const hosts = String(env.EPAM_MOCK_EXTERNAL_CMS_HOSTS || '')
    .split(',').map((h) => h.trim()).filter(Boolean);
  if (!hosts.length) return '';
  return `

UNREACHABLE EXTERNAL SERVICE — write criteria to the boundary, not past it.
This project cannot reach the following hosts at test time: ${hosts.join(', ')}.
There are no credentials for them and no local substitute, so any criterion that
asserts their real behaviour is unprovable and will fail verification no matter
how correct the code is.

Write criteria that stop at OUR side of that boundary and are therefore provable:
what request our code makes, with what parameters, under what conditions; how it
handles the responses and failures those services can return; what it renders or
returns given a known response. State the assumption explicitly, e.g. "given the
<service> client is mocked, ...", so a reader knows the claim's limits.

SCOPE — this applies ONLY to the hosts listed above. Every other integration
keeps its real coverage: internal APIs, this codeline's own services, databases,
and anything else reachable are exercised for real exactly as normal. Do NOT mock
a dependency merely because mocking it would be more convenient. Removing
coverage from something we CAN test trades a real defect for a green tick, which
is the opposite of why this constraint exists.`;
}

function fetchExistingCodeContext(story) {
  const isBrownfield = process.env.EPAM_BROWNFIELD === '1';
  if (isBrownfield) {
    const cgOutput = fetchCodeGraphContext(story);
    const sembleOutput = fetchSembleContext(story);
    const blocks = [];
    if (cgOutput) {
      blocks.push(`\nEXISTING CODE — CodeGraph static analysis (exact symbols, callers, blast radius):\n${cgOutput}\n`);
    }
    if (sembleOutput) {
      blocks.push(sembleOutput);
    }
    return blocks.join('\n');
  }
  return fetchSembleContext(story);
}

function resolveCodelinePath(story) {
  // Prefer story-level codeline → JIRA_WORKTREE_<UPPER> → JIRA_WORKTREE_<DEFAULT>
  const cl = story.codeline || process.env.JIRA_DEFAULT_CODELINE || '';
  if (cl) {
    const key = `JIRA_WORKTREE_${cl.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    if (process.env[key]) return process.env[key];
  }
  // Last resort: find any JIRA_WORKTREE_* that is set
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('JIRA_WORKTREE_') && v) return v;
  }
  // Brownfield fallback (live bug, 2026-07-22): brownfield runs never set
  // JIRA_WORKTREE_* at all — the codeline path is discovered dynamically by
  // codeline-discovery.js and exported as PROJECT_ROOT by
  // run-agent-orchestration.sh instead. Without this fallback,
  // fetchExistingCodeContext() always got an empty path here, so CodeGraph/
  // Semble never had anything to inject — confirmed live on AMSD-1820, where
  // the spec pass's own note read "No existing code block was injected via
  // CodeGraph or Semble, so locationHint is empty," and the agent then wrote
  // a brand-new, disconnected module instead of fixing the real file
  // (apply-report-discounts.service.ts) because it never saw it existed.
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;
  return '';
}
let _jsonrepair;
try { _jsonrepair = require('jsonrepair').jsonrepair; } catch { _jsonrepair = null; }

// acquireFileLock/releaseFileLock — a bash-`flock`-equivalent for this file's
// two PRD write sites (run() and validateMidExecutionSplits()). Node has no
// built-in flock; this uses exclusive file creation (O_EXCL via the 'wx'
// flag) as the mutual-exclusion primitive, with a stale-lock timeout so a
// killed process's abandoned lock file doesn't block every future run
// forever. Added 2026-07-11 alongside the equivalent bash-side flock wraps in
// claude.sh/run-agent-orchestration.sh -- the atomic write-then-rename fix
// from earlier the same day prevents CORRUPTION from a killed process, but
// does not prevent a LOST UPDATE when two processes (e.g. parallel worktree
// stories) both read-modify-write the same PRD file around the same time.
// staleMs is intentionally a SEPARATE threshold from timeoutMs: timeoutMs is
// how long THIS caller is willing to wait before giving up; staleMs is how
// old an abandoned lock file must be before we assume its owner is dead and
// steal it. Reusing one value for both would mean a caller that waits past
// its own timeout would end up STEALING the lock from a still-live holder
// instead of throwing -- defeating the mutual exclusion the lock exists for.
function acquireFileLock(lockPath, timeoutMs = 30000, staleMs = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath); // stale lock from a killed process -- steal it
          continue;
        }
      } catch {
        continue; // lock file vanished between EEXIST and stat -- retry immediately
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      try { execSync('sleep 0.05'); } catch { /* ignore */ }
    }
  }
}

function releaseFileLock(lockPath) {
  try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
}

// ─── MiniMax tool-use definitions ────────────────────────────────────────────
// Tool-use produces API-enforced valid JSON arguments — eliminates the M3
// unescaped-char / truncation parse failures seen with raw JSON output.

const MINIMAX_BASE_URL = 'https://api.minimaxi.chat/v1';

const TOOL_SPEC_ASSIGNMENTS = {
  name: 'submit_assignments',
  description: 'Submit agent assignment decisions for each story in the phase.',
  parameters: {
    type: 'object',
    required: ['assignments'],
    properties: {
      assignments: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['storyId', 'agents'],
          properties: {
            storyId: { type: 'string' },
            agents: { type: 'array', items: { type: 'string' } },
            notes: { type: 'string' },
            priority: { type: 'string' },
          },
        },
      },
    },
  },
};

const TOOL_SPEC_AGENT = {
  name: 'submit_spec_result',
  description: 'Submit the specification analysis result for one story.',
  parameters: {
    type: 'object',
    required: ['storyId', 'agent', 'acceptanceCriteria'],
    properties: {
      storyId: { type: 'string' },
      agent: { type: 'string' },
      notes: { type: 'string' },
      storyKind: { type: 'string', enum: ['defect', 'novel'] },
      // WHO OBSERVES IT, AND ON WHAT.
      //
      // Two rounds of instruction did not stop criteria that assert internal structure or an
      // internal call path — rules produced them, and contrast pairs naming those exact shapes
      // as forbidden produced them again on the next run. The producer is grounded in vendor
      // documentation and source code, both implementation-shaped, and then asked to write
      // external observations about that material. Prose could not win that argument.
      //
      // A declaration can. "Given the Stack initialization options object, it contains a
      // live_preview property" has to name a person who observes an options object; "the SDK
      // query includes those parameters" has to name a person who observes a query. Neither
      // can be answered honestly, so the criterion is visibly wrong rather than arguably wrong.
      //
      // `setup` also ends a disagreement the pipeline was having with itself: the producer's
      // samples treat "given the client is mocked ..." as acceptable while the reviewer flagged
      // it as "prescribes mocking setup". Declared here, a precondition is a precondition.
      verificationCriteriaDetail: {
        type: 'array',
        description:
          'One entry per verification criterion, declaring who observes it and where. A '
          + 'criterion whose observer would have to be the application itself is not observable.',
        items: {
          type: 'object',
          required: ['criterion', 'observer', 'surface'],
          properties: {
            criterion: { type: 'string', description: 'The observable check, as a sentence.' },
            observer: {
              type: 'string',
              enum: ['end user', 'tester', 'api client', 'operator'],
              description: 'WHO sees it. If no human or client can see it, the criterion is not observable.',
            },
            surface: {
              type: 'string',
              description:
                'WHAT they look at — the rendered page, the API response, the CLI output, the '
                + 'generated file. Never an internal object, argument, query or call.',
            },
            setup: {
              type: 'string',
              description:
                'Optional precondition the test establishes before observing — for example a '
                + 'mocked client signalling a change. Preconditions are allowed and are NOT '
                + 'implementation prescription; state them here rather than inside the criterion.',
            },
          },
        },
      },
      acceptanceCriteria: { type: 'array', items: { type: 'string' }, minItems: 1 },
      description: { type: 'string' },
      title: { type: 'string' },
      acAddedBySpeckit: { type: 'array', items: { type: 'string' } },
      acModifiedBySpeckit: { type: 'array', items: { type: 'object' } },
      acFlagged: { type: 'array', items: { type: 'object' } },
      splitStories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            description: { type: 'string' },
            acceptanceCriteria: { type: 'array', items: { type: 'string' }, minItems: 1 },
            agentRole: { type: 'string' },
            technicalNotes: { type: 'object' },
          },
        },
      },
    },
  },
};

const TOOL_SPEC_REVIEW = {
  name: 'submit_spec_review',
  description: 'Submit coordinator quality review results for all stories.',
  parameters: {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['storyId', 'verdict'],
          properties: {
            storyId: { type: 'string' },
            verdict: { type: 'string' },
            reviewNotes: { type: 'string' },
            qualityScore: { type: 'number' },
            // FLAGS CARRY SEVERITY, because presence alone cannot gate.
            //
            // Every flag this reviewer has ever emitted is an uncertainty disclosure —
            // api_shape_uncertainty, human_review_recommended_by_agent,
            // unverified_cx_shared_assumptions. It never returns "approved" on a brownfield
            // ticket either. So a rule built on the verdict blocks every run, and a rule built
            // on flag presence blocks every run, and the only remaining signal was a scalar
            // nobody can interrogate. Three rules failed in turn for one reason: the reviewer
            // had no way to say "this is a defect" as distinct from "I was not certain".
            //
            // Strings are still accepted so an older reviewer's output keeps parsing; a bare
            // string is treated as advisory, because that is what all of them have been.
            flags: {
              type: 'array',
              description:
                'Each flag is either a bare string (advisory) or an object carrying severity. ' +
                'Severity RANKS your objections for the human reading them; it does not decide ' +
                'whether the run stops. Mark blocking when an implementer following this spec ' +
                'would produce work that cannot function, and advisory for uncertainty about ' +
                'what you could not see. What halts a run is a computed check or a flag this ' +
                'project has declared blocking — not your assessment of your own output.',
              items: {
                oneOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    required: ['flag', 'severity'],
                    properties: {
                      flag: { type: 'string', description: 'Short slug naming the objection.' },
                      severity: { type: 'string', enum: ['blocking', 'advisory'] },
                      why: { type: 'string', description: 'What you checked, and what you found.' },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
};

const TOOL_MODEL_REVIEW = {
  name: 'submit_model_review',
  description: 'Submit final model assignment decisions for all stories.',
  parameters: {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['storyId', 'finalModel'],
          properties: {
            storyId: { type: 'string' },
            finalModel: { type: 'string' },
            override: { type: 'boolean' },
            confidence: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
    },
  },
};

// Call MiniMax API directly with a tool definition — arguments are API-enforced JSON.
// itemsKey: if set, extracts result[itemsKey] (for array-returning tools); otherwise returns full args.
const MINIMAX_TOOL_TIMEOUT_MS = parseInt(process.env.MINIMAX_TOOL_TIMEOUT_MS || '180000', 10);

async function callMiniMaxWithTool(prompt, toolDef, logPath, itemsKey) {
  const apiKey = process.env.MINIMAX_API_KEY || process.env.EPAM_API_KEY_MINIMAX;
  if (!apiKey) throw new Error('callMiniMaxWithTool: no API key (MINIMAX_API_KEY / EPAM_API_KEY_MINIMAX)');
  const model = process.env.AI_MODEL || process.env.ORCH_GATE_MODEL || 'MiniMax-M3';
  const baseURL = process.env.MINIMAX_BASE_URL || MINIMAX_BASE_URL;

  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 4096,
    temperature: 0.2,
    tools: [{ type: 'function', function: toolDef }],
    tool_choice: { type: 'function', function: { name: toolDef.name } },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MINIMAX_TOOL_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`MiniMax API error: ${res.status} ${await res.text()}`);

  const data = await res.json();
  const rawText = data.choices?.[0]?.message?.content || '';
  const tc = data.choices?.[0]?.message?.tool_calls?.[0];
  const argsRaw = tc?.function?.arguments || '{}';

  if (logPath) {
    fs.writeFileSync(logPath, `# Prompt\n${prompt}\n\n# Tool call args (raw)\n${argsRaw}\n\n# Text output\n${rawText}\n`);
  }

  // Parse args — fall back to jsonrepair on truncated/malformed output from M3
  let args;
  try {
    args = JSON.parse(argsRaw);
  } catch (parseErr) {
    if (_jsonrepair) {
      try {
        args = JSON.parse(_jsonrepair(argsRaw));
        console.warn(`callMiniMaxWithTool: jsonrepair recovered truncated args for tool ${toolDef.name}`);
      } catch {
        console.warn(`callMiniMaxWithTool: failed to parse tool args even with jsonrepair (tool=${toolDef.name}): ${parseErr.message}`);
        return null;
      }
    } else {
      console.warn(`callMiniMaxWithTool: failed to parse tool args (tool=${toolDef.name}): ${parseErr.message}`);
      return null;
    }
  }

  return itemsKey ? (args[itemsKey] ?? null) : args;
}

// Unified agent runner: tool-use for MiniMax, raw JSON for all other providers.
// Ladder: if minimax times out or returns null, escalates to SPEC_PASS_LADDER_PROVIDER
// (default: openai via OpenRouter) using the raw JSON + jsonrepair path.
//
// Fast-path: set SPEC_MODE_PROVIDER=qwen to skip MiniMax entirely.
//   SPEC_MODE_OPENSPEC_MODEL — model for openspec calls (default: z-ai/glm-5.2)
//   SPEC_MODE_SPECKIT_MODEL  — model for speckit calls  (default: z-ai/glm-5.2)
//   SPEC_MODE_MODEL          — fallback for all other spec-mode calls (default: z-ai/glm-5.2)
// storyId: cost attribution. Without it every cost_snapshot carried storyId:''
// and spend could not be grouped by story (backlog B6).
/**
 * Environment for a spec-pass agent.
 *
 * FILESYSTEM ACCESS. openspec/speckit/coordinator decide the manifest — which files a
 * story will touch — and then review it. They had no tools at all, so they reviewed a
 * list of paths having never seen the repository: a manifest naming a file that does not
 * exist reads as a perfectly reasonable path, and the reviewer can only agree. That is
 * how a wrong-cased path reached the writer on 2026-08-04 and cost a ~2M-input-token
 * non-converging loop. No reviewer missed it; no reviewer could look.
 *
 * READ-ONLY. The question a spec reviewer must answer — does this path exist, is it the
 * right file — needs reading, not shell. Withholding bash/write keeps a review pass from
 * mutating what it reviews. Gate agents get bash because they run checks; reviewers do not.
 *
 * CONFIGURABLE: SPEC_MODE_ALLOWED_TOOLS overrides the default, so a project that needs a
 * different set changes config rather than this engine.
 */
/**
 * Telling a reviewer the tools exist is only half of it — team-lead-review.sh's own note:
 * "Both halves are required: the BLOCK tells the reviewer the tools exist, and the
 * [instruction] makes it use them." A reviewer that MAY look will sometimes not.
 *
 * Every declared path is machine-checkable, so the reviewer is required to check rather
 * than judge. Nothing here names a project, codeline or filename.
 */
/**
 * Path existence is DETERMINISTIC — so a script answers it, not a model.
 *
 * The reviewer was given EPAM_ALLOWED_TOOLS and told to verify paths with list_files.
 * That set an env var; it did not put the reviewer on a tool-executing path.
 * runAgentForJson's direct-exec route is a single-shot text call with no tool loop, so the
 * model emitted tool calls that nobody ran and never produced a verdict at all:
 *
 *     <tool_call>list_files path="."</arg_value><tool_call>list_files path="src"</arg_value>
 *
 * 87 bytes, no <SPEC_REVIEW>. Three consecutive live runs lost their review that way, and
 * the spec-review gate downstream guarded nothing.
 *
 * So the facts are computed HERE and handed to the reviewer as evidence. It judges what a
 * script cannot — whether the ACs are testable, whether the manifest is plausible for the
 * change — and never has to discover what the filesystem already knows.
 */
/**
 * Stat every declared path once. ONE source of truth for both the evidence text the
 * reviewer reads and the missing-path list the gate enforces — two independent
 * implementations would eventually disagree, and the gate would be enforcing something
 * different from what the reviewer was shown.
 *
 * Returns [{ storyId, file, exists, neighbour, unreadable }].
 */
function manifestPathStatus(stories, prd) {
  const root = (prd && prd.project && prd.project.outputDir) || process.env.PROJECT_ROOT || '.';
  const out = [];
  for (const story of stories || []) {
    const files = (story.technicalNotes && story.technicalNotes.files) || [];
    for (const f of files) {
      const abs = path.isAbsolute(f) ? f : path.join(root, f);
      const rec = { storyId: story.id, file: f, exists: false, neighbour: null, unreadable: false };
      try {
        if (fs.existsSync(abs)) rec.exists = true;
        else {
          // Name the real neighbour when one differs only by case or extension — that is
          // the actionable half of a missing-path report.
          const dir = path.dirname(abs);
          const base = path.basename(abs).toLowerCase();
          const stem = base.replace(/\.[^.]+$/, '');
          rec.neighbour = fs.existsSync(dir)
            ? (fs.readdirSync(dir).find((e) => {
              const el = e.toLowerCase();
              return el === base || el.replace(/\.[^.]+$/, '') === stem;
            }) || null)
            : null;
        }
      } catch { rec.unreadable = true; }
      out.push(rec);
    }
  }
  return out;
}

/**
 * The paths that genuinely are not there — computed, never asserted by a model.
 *
 * Measured 2026-08-04: in one of four samples the reviewer returned the flag
 * "missing_manifest_path" while the evidence block listed EXISTS for every path. That flag
 * is a hard blocker, so a hallucination would halt a run whose manifest was perfectly
 * valid, indistinguishable from a real defect. fs.existsSync cannot hallucinate, so the
 * gate enforces THIS and treats the model's flag as corroboration.
 */
function manifestMissingPaths(stories, prd) {
  return manifestPathStatus(stories, prd)
    .filter((r) => !r.exists)
    .map((r) => ({ storyId: r.storyId, file: r.file }));
}

/**
 * The CONTENTS of the files a story declares, for the agent that has to reason about them.
 *
 * The spec agent used to receive file NAMES and a call graph, never the code. Its own
 * output said so on every lane — "could not read the actual file contents", flagged as
 * speckit_unread_files_caveat / derived_without_source_inspection — and it is why the VC
 * producer wrote criteria naming mechanisms it could only guess at, which the observability
 * guard then correctly rejected. Live 20260804T162414Z, one lane lost 4 of its 5 criteria
 * that way.
 *
 * We already resolve and stat exactly these paths for manifestEvidence; reading them is the
 * same operation.
 *
 * BUDGETED, because a prompt is not free. Per-file and total byte caps are configurable and
 * a zero budget switches the block off entirely:
 *   SPEC_FILE_EXCERPT_BYTES        per file   (default 4000)
 *   SPEC_FILE_EXCERPT_TOTAL_BYTES  all files  (default 24000)
 * `opts` overrides the environment, for callers that know better.
 */
function manifestFileExcerpts(story, prd, opts = {}, env = process.env) {
  const perFile = opts.perFileBytes !== undefined
    ? Number(opts.perFileBytes)
    : Number(env.SPEC_FILE_EXCERPT_BYTES !== undefined ? env.SPEC_FILE_EXCERPT_BYTES : 4000);
  const total = opts.totalBytes !== undefined
    ? Number(opts.totalBytes)
    : Number(env.SPEC_FILE_EXCERPT_TOTAL_BYTES !== undefined ? env.SPEC_FILE_EXCERPT_TOTAL_BYTES : 24000);
  if (!(perFile > 0) || !(total > 0)) return '';

  // WHERE THE FILE LIST COMES FROM.
  //
  // This read story.technicalNotes.files only — which is populated from the spec agent's OWN
  // answer (mergeLocationHintFiles(payload.locationHint), further down this file). So on a
  // first pass the list is empty and this block never renders: the mechanism for showing an
  // agent the code it must reason about only worked after that agent had already reasoned
  // about it. Measured on run 20260806T213050Z — DECLARED FILES absent from both agents'
  // prompts, while 92% of the prompt was an undifferentiated CodeGraph dump.
  //
  // The DETECTIVE runs BEFORE the spec agent and has already located the fix site, so its
  // findings are a first-pass source. Declared files come first when they exist; located
  // files fill the gap when they do not.
  const declared = (story && story.technicalNotes && story.technicalNotes.files) || [];
  // opts.located — the detective's findings, passed IN by the caller.
  //
  // This first read story.fixSiteAnalysis, which is assigned ~160 lines AFTER the prompt is
  // built (guarded by `if (detectiveFindings.length)`), so at prompt time it is empty and the
  // block still never rendered. The unit test passed because its fixture handed the function
  // a story that already had the field — more convenient than reality. Third time in one
  // session that reading a later-populated field produced a green test and a dead feature.
  const located = ((opts.located && opts.located.length ? opts.located : (story && story.fixSiteAnalysis)) || [])
    .map((f) => (typeof f === 'string' ? f : f && f.file))
    .filter((f) => typeof f === 'string' && f);
  const files = [...declared, ...located];
  if (!files.length) return '';
  const unreadable = [];

  const root = (prd && prd.project && prd.project.outputDir) || env.PROJECT_ROOT || '.';
  const parts = [];
  let spent = 0;
  const seen = new Set();
  for (const f of files) {
    if (spent >= total) break;
    if (seen.has(f)) continue;
    seen.add(f);
    const abs = path.isAbsolute(f) ? f : path.join(root, f);
    let body;
    try {
      // REPORTED, never silently skipped. A `continue` here is how an empty DECLARED FILES
      // block went unnoticed: the prompt simply had no section, which reads identically to
      // "this story declares no files".
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { unreadable.push(f); continue; }
      body = fs.readFileSync(abs, 'utf8');
    } catch { unreadable.push(f); continue; }
    const budget = Math.min(perFile, total - spent);
    let excerpt = body;
    let truncated = false;
    if (excerpt.length > budget) { excerpt = excerpt.slice(0, budget); truncated = true; }
    spent += excerpt.length;
    parts.push(`--- ${f}${truncated ? ' (truncated)' : ''}\n${excerpt}`);
  }
  const missingNote = unreadable.length
    ? `\n(could not be read at the stated path — do not reason about them: ${unreadable.join(', ')})\n`
    : '';
  if (!parts.length) return unreadable.length
    ? `\n\nDECLARED FILES — nothing available.${missingNote}`
    : '';
  return '\n\nDECLARED FILES — the actual contents of the files this story names or the detective located. '
    + 'Base every observable criterion on what THIS code does, not on what the title suggests:\n'
    + parts.join('\n') + missingNote + '\n';
}

function manifestEvidence(stories, prd) {
  const status = manifestPathStatus(stories, prd);
  const lines = [];
  for (const story of stories || []) {
    const mine = status.filter((r) => r.storyId === story.id);
    if (!mine.length) {
      lines.push(`  ${story.id}: NO FILES DECLARED — nothing for a writer to change`);
      continue;
    }
    for (const r of mine) {
      let mark;
      if (r.exists) mark = 'EXISTS';
      else if (r.unreadable) mark = 'MISSING — could not read the directory';
      else if (r.neighbour) mark = `MISSING — the directory holds "${r.neighbour}" instead`;
      else mark = 'MISSING';
      lines.push(`  ${story.id}: ${mark}  ${r.file}`);
    }
  }
  return lines.join('\n');
}

/**
 * What the coordinator is shown for each story.
 *
 * verificationCriteria USED TO BE ABSENT. They live on the story root, not inside
 * .specification, so the reviewer received {id, title, acceptanceCriteria, specification}
 * — and on a brownfield ticket the AC array is empty BY POLICY. It was being asked to
 * score a specification while the only substantive artefact in it was invisible. The
 * reviewer reported this itself: one lane's flag was "vc_not_visible_in_notes".
 *
 * Measured effect of adding them, same prompt four times: score spread 0.17 -> 0.08, mean
 * 0.65 -> 0.70.
 */
function buildReviewPayload(stories, isBrownfieldReview, allStories = [], logDir = null, phase = 'unknown') {
  return JSON.stringify((stories || []).map((s) => {
    // PLAN/EXECUTION EVIDENCE — precomputed, deterministic, and NOT the verdict. A bare
    // term-overlap check cannot tell a JUSTIFIED pivot ("useContent turned out to be a
    // dead end; the real integration point is X") from genuine unexplained drift — only
    // judgment can. So this hands the reviewer the raw plan text plus the deterministic
    // signal (same architecture as MANIFEST EVIDENCE above: "it has been checked, you
    // decide what it means") instead of asking a second, differently-fallible LLM call to
    // re-derive what is already on disk, or asking a regex to be the final arbiter.
    const _plan = (isBrownfieldReview && logDir) ? readLatestDetectivePlan(logDir, phase, s.id) : null;
    const _fixSiteAnalysis = Array.isArray(s.fixSiteAnalysis) ? s.fixSiteAnalysis : [];
    const planAlignmentEvidence = _plan
      ? { detectivePlan: _plan, ...checkPlanExecutionAlignment(_plan, _fixSiteAnalysis) }
      : null;
    return {
      id: s.id,
      title: s.title,
      acceptanceCriteria: s.acceptanceCriteria,
      // The observable checks — on brownfield these ARE the deliverable under review.
      verificationCriteria: s.verificationCriteria || [],
      // The manifest is part of what is being reviewed; the evidence block above the prompt
      // reports whether each of these exists.
      technicalNotes: s.technicalNotes,
      specification: s.specification,
      fixSiteAnalysis: _fixSiteAnalysis,
      planAlignmentEvidence,
      ...(isBrownfieldReview ? {} : {
        splitChildren: (allStories || [])
          .filter((c) => c.specification && c.specification.createdFrom === s.id)
          .map((c) => ({ id: c.id, title: c.title, acceptanceCriteria: c.acceptanceCriteria })),
      }),
    };
  }), null, 2);
}

const MANIFEST_GROUNDING_BLOCK = [
  'ANSWER IN THIS RESPONSE. Your <SPEC_REVIEW> verdict must appear in THIS reply — an',
  'empty <SPEC_REVIEW></SPEC_REVIEW>, or a promise to verify and answer later, is',
  'discarded and the review does not happen. There is no follow-up turn to come back in.',
  '',
  'You DO have read-only tools this turn (read_file, list_files, search). Use them for',
  'real if something is genuinely unclear — but never narrate an imagined tool result,',
  'and never spend the whole turn exploring and run out before writing the verdict.',
  'Budget is small and the verdict is mandatory: gather at most what you need, then answer.',
  '',
  'MANIFEST EVIDENCE has already been gathered from the repository for you and appears',
  'above. Every declared path was checked with a real filesystem stat, so re-checking',
  'paths is wasted budget — that part is done and is more reliable than a tool call.',
  '  - A story with any MISSING path CANNOT be implemented: the writer is sent to edit a',
  '    file that is not there, and every retry reproduces that. Mark it needs_review, name',
  '    the exact path in reviewNotes, and add the flag "missing_manifest_path".',
  '  - Where the evidence names a real neighbour ("the directory holds X instead"), say so',
  '    — that is what makes the report actionable.',
  '  - Never silently correct a path. The manifest is the artefact under review; a',
  '    correction living only in your prose reaches nobody.',
  '',
  'Judge what the evidence cannot: are the acceptance criteria testable, is the declared',
  'file set plausible for this change, is anything obviously missing. If you are unsure,',
  'lower qualityScore and add a flag — do not withhold the verdict. A missing review is',
  'EVERY FLAG CARRIES A SEVERITY. It ranks your objections for whoever reads them; it does not',
  'decide whether the run stops — a computed check or a project-declared flag does that. Mark',
  'blocking when an implementer following this spec would produce work that CANNOT FUNCTION,',
  'and advisory for uncertainty about what you could not see. Report both honestly: nothing is',
  'gained by inflating uncertainty into a defect, and nothing is lost by naming a real one.',
  'worse than an uncertain one: it means nothing was checked at all.',
].join('\n');

// Root cause fixed 2026-08-06, in two parts:
//
// 1. This granted a tool LIST (EPAM_ALLOWED_TOOLS) without ever setting
//    AI_GATE_ALLOW_TOOLS, so every spec-mode call actually ran with
//    --no-tools underneath it while being told tools existed.
//
// 2. Separately, and more fundamentally: the shared spawn helper never set
//    `cwd`, so even a genuinely tool-enabled call (AI_GATE_ALLOW_TOOLS=1)
//    resolved read_file/list_files/search against wherever the ORCHESTRATOR
//    happened to be running from, not the target codeline — none of those
//    tools consult PROJECT_ROOT (only the unrelated EscalateDefect.ts does).
//    Verified live with a real fixture file: identical tool grant returned
//    "file does not exist" without cwd set, and the file's real,
//    unguessable content with it set (see the spawn-cwd fix docstring).
//
// Both together explain the fabricated <tool_call>/<tool_result> text found
// live in a vc-agent plan for a real brownfield story — its "tool_result"
// described a source file's contents that bore no resemblance to the real
// file on disk. The model was told tools existed, and even when they were
// nominally enabled they could never have found the real file.
//
// repoPath is REQUIRED to actually enable tools: a phase-level call
// (SPEC_ASSIGNMENTS, SPEC_REVIEW, MODEL_REVIEW) reviews potentially many
// stories across many codelines at once — there is no single repo a cwd
// could correctly point at, so those stay tool-less and keep relying on
// manifestEvidence()'s deterministic per-path checks, which is the
// architecturally correct answer for a multi-story call, not a workaround.
// Only a SINGLE-story, single-codeline call (SPEC_AGENT for openspec/
// speckit) has one real repoPath to hand it, so only those get real tools.
/**
 * How many tool calls an ESTATE SURVEY may spend, scaled to the ground it must cover.
 *
 * Every spec-mode agent shared one ceiling of 8. That is a sane budget for an agent looking at
 * one codeline and an impossible one for a survey whose own prompt says "For EVERY codeline
 * above, OPEN IT". Live 2026-08-08 the survey ran seven distinct search patterns against three
 * separate repositories under that ceiling, saw nothing conclusive, and reported "no existing
 * live preview infrastructure — this is greenfield work" about a brownfield estate with 243
 * matching source files in the first codeline alone. That verdict went into estate-survey.json,
 * which the investigators and the detective read next.
 *
 * The rate is per codeline and the count comes from the caller's own list, so no estate size
 * is written here. An explicit SPEC_MODE_MAX_TOOL_CALLS still wins — an operator capping cost
 * must not be silently overridden.
 */
/**
 * Spec-pass defaults, read from orchestrations/config beside the other operator knobs.
 *
 * NOT cached across calls with a baked fallback: a missing or unusable value THROWS. Falling
 * back to a literal would put the number back in the engine and would do it silently on the
 * one run the config failed to load — the shape of every fail-open gate found in this pipeline.
 * Same stance as protectedRoles(): refuse rather than proceed on an assumed value.
 */
function specModeDefaults() {
  const file = process.env.EPAM_SPEC_MODE_DEFAULTS_FILE
    || path.join(__dirname, '..', 'config', 'spec-mode-defaults.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`[spec-mode] cannot read tool-call budgets from ${file}: ${e.message}`);
  }
  const tc = (cfg && cfg.toolCalls) || {};
  const need = (key) => {
    const v = tc[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`[spec-mode] ${file} — toolCalls.${key} must be a positive number, got ${JSON.stringify(v)}`);
    }
    return v;
  };
  const perSeam = tc.perSeam && typeof tc.perSeam === 'object' ? tc.perSeam : {};
  return { perAgent: need('perAgent'), perCodelineSurvey: need('perCodelineSurvey'), perSeam };
}

function surveyToolBudget(codelines, env = process.env) {
  if (env.SPEC_MODE_MAX_TOOL_CALLS) return String(env.SPEC_MODE_MAX_TOOL_CALLS);
  const n = Math.max(1, (Array.isArray(codelines) ? codelines : []).filter(Boolean).length);
  const declared = parseInt(env.EPAM_SURVEY_TOOL_CALLS_PER_CODELINE || '', 10);
  const rate = Number.isFinite(declared) && declared > 0
    ? declared
    : specModeDefaults().perCodelineSurvey;
  return String(n * rate);
}

function specAgentEnv(env = process.env, repoPath = '') {
  const out = {};
  if (env.SPEC_MODE_MAX_OUTPUT_TOKENS) out.EPAM_MAX_OUTPUT_TOKENS = env.SPEC_MODE_MAX_OUTPUT_TOKENS;
  // DERIVED from the codeline, not listed here. The literal that used to sit on this line
  // granted read_file,list_files,search and nothing else, so every spec-mode agent — openspec,
  // speckit, the reviewers — did brownfield archaeology with text search only and had no
  // access to the symbol index, while that text search was returning "(no matches found)" for
  // everything. A codeline provisioned with the codegraph plugin now grants codegraph_query
  // automatically. See lib/agent-tools.js.
  out.EPAM_ALLOWED_TOOLS = env.SPEC_MODE_ALLOWED_TOOLS
    || require('./lib/agent-tools.js').readOnlyToolGrant([repoPath || env.PROJECT_ROOT || env.JIRA_CODELINE_ROOT || '']);
  // Granted to every spec-mode agent. An agent told a tool list without
  // AI_GATE_ALLOW_TOOLS runs with --no-tools underneath it (ai-run.sh's
  // default) — it believes it can look, cannot, and fabricates
  // <tool_call>/<tool_result> text describing files it never read. That is
  // what produced invented source contents in a vc-agent plan.
  //
  // Writes are NOT prevented here. They are prevented at the filesystem by
  // lib/codeline-write-perimeter.sh: a codeline on its baseline branch is
  // chmod'd read-only, and only agents whose job is to author code may write
  // at all. That holds for `bash` and for any tool added later, which a
  // per-tool allowlist cannot. Removing tools from these agents was tried as
  // an incident response and was the wrong layer — six other agents hold
  // `bash` against the same repo.
  out.AI_GATE_ALLOW_TOOLS = env.SPEC_MODE_ALLOW_TOOLS || '1';
  out.EPAM_MAX_TOOL_CALLS = env.SPEC_MODE_MAX_TOOL_CALLS || String(specModeDefaults().perAgent);
  // Tools resolve paths against the process cwd (see runClaude's spawn cwd).
  // A single-story call knows its codeline; a phase-level call spans stories,
  // so it falls back to the run's codeline root.
  const root = repoPath || env.PROJECT_ROOT || env.JIRA_CODELINE_ROOT || '';
  if (root) out.PROJECT_ROOT = root;
  return out;
}

/**
 * Refuse an answer that does not have the shape its tag promised, and say why.
 *
 * runAgentForJson's direct-exec path tag-parses the model's text; nothing checked the
 * result conformed. Live 2026-08-04 a reviewer answered in prose inside an empty
 * <SPEC_REVIEW></SPEC_REVIEW>, the parse returned null, the review was discarded, and all
 * three retries reproduced it because nothing told the model it had failed. The reason
 * this returns is the only thing that makes attempt 2 different from attempt 1.
 */
function _validatedOrNull(parsed, tag) {
  let v;
  try {
    // eslint-disable-next-line global-require
    v = require('./lib/agent-output-schema.js').validateTaggedOutput(tag, parsed);
  } catch (e) {
    // A missing validator must not silently disable validation — say so, loudly.
    console.warn(`spec-mode: output validator unavailable (${e.message}) — ${tag} NOT validated`);
    return parsed;
  }
  if (v.ok) return parsed;
  console.warn(`spec-mode: ${v.reason}`);
  // Diagnostic by default: a shape mismatch is reported and the payload still flows, so
  // the pipeline's own recovery decides. Only a FATAL refusal (no parseable answer, or
  // EPAM_SCHEMA_STRICT=1) drops it — an unproven validator must not halt a run.
  return v.fatal ? null : parsed;
}

async function runAgentForJson(execSpec, prompt, toolDef, tag, logPath, itemsKey, storyId = '', repoPath = '', envOverride = null) {
  // envOverride: per-agent tool grant. Most spec-mode agents share specAgentEnv's
  // read-only set; an agent with a different need (the ticket-link agent must FETCH a
  // document, not just read the repo) supplies its own here rather than widening the
  // shared grant for everyone.
  const provider = (process.env.AI_PROVIDER || process.env.EPAM_ORCHESTRATION_PROVIDER || '').toLowerCase();
  const ladderProvider = (process.env.SPEC_PASS_LADDER_PROVIDER || 'qwen').toLowerCase();

  // Fast-path: bypass MiniMax entirely when SPEC_MODE_PROVIDER is set.
  // Detects openspec vs speckit from logPath to pick the right model.
  const specModeProvider = (process.env.SPEC_MODE_PROVIDER || '').toLowerCase();
  if (specModeProvider) {
    const logName = (logPath || '').toLowerCase();
    let specModel;
    if (logName.includes('speckit')) {
      specModel = process.env.SPEC_MODE_SPECKIT_MODEL || 'z-ai/glm-5.2';
    } else if (logName.includes('openspec') || logName.includes('-openspec-') || logName.includes('-spec.log')) {
      // Brownfield investigation requires tracing call chains through unfamiliar code —
      // use the HIGH model as the base so archaeology doesn't fall back to generation.
      specModel = (process.env.EPAM_BROWNFIELD === '1' && process.env.SPEC_MODE_OPENSPEC_MODEL_HIGH)
        ? process.env.SPEC_MODE_OPENSPEC_MODEL_HIGH
        : process.env.SPEC_MODE_OPENSPEC_MODEL || 'z-ai/glm-5.2';
    } else {
      specModel = process.env.SPEC_MODE_MODEL || process.env.SPEC_MODE_OPENSPEC_MODEL || 'z-ai/glm-5.2';
    }
    console.log(`spec-mode: fast-path ${specModeProvider}/${specModel} (skipping MiniMax)`);
    const directExec = { cmd: execSpec.cmd, args: ['--provider', specModeProvider, '--model', specModel] };
    // Spec-mode responses are large JSON blobs — use a higher output-token budget
    // than the implementation default (4096) so speckit never truncates mid-JSON.
    // SPEC_MODE_MAX_OUTPUT_TOKENS is spec-only; it doesn't affect implementation runs.
    const specEnv = Object.assign(specAgentEnv(process.env, repoPath), envOverride || {});
    const output = await runClaude(directExec, prompt, logPath, specEnv, { costAgent: tag, costStoryId: storyId });
    return _validatedOrNull(extractTaggedJson(output, tag), tag);
  }

  if (provider === 'minimax') {
    let result = null;
    try {
      result = await callMiniMaxWithTool(prompt, toolDef, logPath, itemsKey);
    } catch (err) {
      const isTimeout = err.name === 'AbortError' || /aborted/i.test(err.message);
      console.warn(`spec-mode: minimax tool-use failed (${err.message})${isTimeout ? ' — laddering to ' + ladderProvider : ''}`);
      if (!isTimeout) throw err; // hard failure (no API key etc.) — don't ladder, surface the error
    }
    if (result !== null) return result;
    // null = parse failed or aborted — ladder to fallback provider only if fast
    // NOTE: OpenAI ladder via epam CLI spawns detached grandchildren that survive
    // the 120s SIGKILL, causing indefinite hangs. Skip ladder when disabled.
    if (process.env.SPEC_PASS_SKIP_LADDER === '1') {
      console.warn(`spec-mode: minimax returned null — ladder disabled, using fallback spec`);
      return null;
    }
    console.warn(`spec-mode: minimax returned null — laddering to ${ladderProvider}`);
    const ladderTimeout = parseInt(process.env.SPEC_PASS_LADDER_TIMEOUT_MS || String(runClaudeTimeoutMs()), 10);
    // FIX: build a new execSpec for the ladder. The original execSpec has
    // '--provider minimax' baked into its args. Passing AI_PROVIDER=openai via
    // env overrides is insufficient — ai-run.sh reads the --provider CLI flag,
    // which always wins. Without this fix the ladder calls MiniMax again.
    const ladderExec = { cmd: execSpec.cmd, args: ['--provider', ladderProvider] };
    const output = await Promise.race([
      runClaude(ladderExec, prompt, logPath, envOverride || {}, { costAgent: tag, costStoryId: storyId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`ladder hard-timeout after ${ladderTimeout}ms`)), ladderTimeout + 5000))
    ]);
    return _validatedOrNull(extractTaggedJson(output, tag), tag);
  }

  // Non-minimax: existing raw text path with tag extraction + jsonrepair
  //
  // envOverride MUST be forwarded here. It used to be honoured on the SPEC_MODE_PROVIDER
  // fast-path only, and dropped on this path and on the minimax ladder — so an agent that
  // supplies its own tool grant (the ticket-link agent needs fetch_url) silently got none,
  // and ai-run.sh forces --no-tools without AI_GATE_ALLOW_TOOLS. The agent could then only
  // classify a URL from its address; its `quotes` field could never be populated, which is
  // the whole reason the step exists. Silent, and invisible in the output.
  const output = await runClaude(execSpec, prompt, logPath, envOverride || {}, { costAgent: tag, costStoryId: storyId });
  return _validatedOrNull(extractTaggedJson(output, tag), tag);
}

const args = process.argv.slice(2);
function parseArgs(list) {
  const parsed = { phase: null, dryRun: false };
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg === '--phase' && list[i + 1]) {
      parsed.phase = list[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
  }
  return parsed;
}

function usage() {
  console.log(`Usage: npm run spec-mode -- --phase <phase>
Options:
  --phase <id>   Phase to run specification mode against (required)
  --dry-run      Evaluate coordinator assignments without applying PRD changes
`);
}

async function run() {
  const opts = parseArgs(args);
  if (opts.help || !opts.phase) {
    usage();
    if (!opts.phase) process.exitCode = 1;
    return;
  }

  const scriptDir = __dirname;
  const automationDir = path.resolve(scriptDir, '..');
  const prdPath = process.env.PRD_FILE
    ? path.resolve(process.env.PRD_FILE)
    : path.join(automationDir, 'prd.json');
  const logDir = process.env.OUTPUT_DIR
    ? path.resolve(process.env.OUTPUT_DIR)
    : path.join(automationDir, 'logs');
  const aiRunnerCmd = process.env.AI_RUNNER_CMD || path.join(scriptDir, 'ai-run.sh');
  const monitorScript = path.join(scriptDir, 'update-monitor.sh');
  const promptExec = resolvePromptExec(aiRunnerCmd);
  if (!fs.existsSync(prdPath)) {
    console.error('spec-mode-runner: prd.json not found at', prdPath);
    process.exit(1);
  }
  fs.mkdirSync(logDir, { recursive: true });

  const prd = JSON.parse(fs.readFileSync(prdPath, 'utf8'));
  const _initialStoryIds = new Set((prd.stories || []).map((s) => s.id));

  // Load agent profiles — spec-coordinator-agent provides the system-level role instruction
  const profilesPath = path.join(automationDir, 'agents', 'profiles.json');
  let profiles = {};
  try { profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')); } catch { /* no profiles */ }
  const specCoordinatorProfile = profiles['spec-coordinator-agent'] || '';

  const phaseStories = Array.isArray(prd.implementationOrder?.[opts.phase])
    ? prd.implementationOrder[opts.phase]
    : [];
  if (!phaseStories.length) {
    console.log(`spec-mode: phase ${opts.phase} has no stories; skipping.`);
    return;
  }

  const storiesById = new Map();
  (Array.isArray(prd.stories) ? prd.stories : []).forEach((story) => {
    if (story && story.id) storiesById.set(story.id, story);
  });
  const stories = phaseStories
    .map((id) => storiesById.get(id))
    .filter((story) => story && story.completed !== true);
  if (!stories.length) {
    console.log(`spec-mode: phase ${opts.phase} has no pending stories.`);
    return;
  }

  // B5: prefer the pipeline's ONE run id. Minting a second one here split a
  // single run across two identities in guarded-step-retries.jsonl and broke
  // every join on runId (cost roll-ups, retry history, Langfuse sessions).
  const runId = process.env.ORCH_RUN_ID || new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z');
  const specRunDir = path.join(logDir, 'spec-runs', runId);
  fs.mkdirSync(specRunDir, { recursive: true });
  const baselinePath = path.join(specRunDir, 'prd.before.json');
  fs.writeFileSync(baselinePath, JSON.stringify(prd, null, 2));
  const baselineLatest = path.join(logDir, 'spec-baseline.json');
  fs.copyFileSync(baselinePath, baselineLatest);

  const pointerPath = path.join(logDir, 'spec-run-latest.json');
  fs.writeFileSync(
    pointerPath,
    JSON.stringify(
      {
        runId,
        phase: opts.phase,
        baseline: path.relative(logDir, baselinePath),
        baselineCopy: 'spec-baseline.json',
        createdAt: new Date().toISOString()
      },
      null,
      2
    )
  );

  // ── Step 1: Coordinator assigns agents ─────────────────────────────────
  const storiesPayload = JSON.stringify(
    stories.map((story) => ({
      id: story.id,
      title: story.title,
      description: story.description,
      acceptanceCriteria: story.acceptanceCriteria,
      technicalNotes: story.technicalNotes,
      agentRole: story.agentRole,
      agentGroup: story.agentGroup,
      dependencies: story.dependencies || [],
      spec: story.specification || null
    })),
    null,
    2
  );

  const coordinatorPrompt = `${specCoordinatorProfile ? specCoordinatorProfile + '\n\n' : ''}You are the EPAM CLI specification coordinator agent for phase ${opts.phase}.

Decide which specification agents should run for each story below.
Available agents and their roles:
  - openspec: Elaborates requirements — refines AC, proposes story splits, adds technical depth
  - speckit: Reviews & hardens — adds testability criteria, security checks, edge cases, flags gaps

Agent collaboration model:
  - If both are assigned, openspec runs FIRST, then speckit reviews openspec's output
  - Assign both for complex/critical stories
  - Assign only openspec for simple elaboration
  - Assign only speckit for stories that just need test/security hardening

Respond with raw JSON only (no XML tags, no markdown fences, no preamble) using this schema:
[
  {"storyId":"EPAM-123","agents":["openspec","speckit"],"notes":"reason","priority":"high"}
]
If a story does not need spec work, provide an empty agents array.

Stories JSON:
${storiesPayload}
`;

  let assignments = null;
  try {
    assignments = await runAgentForJson(
      promptExec,
      coordinatorPrompt,
      TOOL_SPEC_ASSIGNMENTS,
      'SPEC_ASSIGNMENTS',
      path.join(logDir, `spec-coordinator-${opts.phase}.log`),
      'assignments',
      `phase:${opts.phase}`   // phase-level agent — no single story owns it
    );
  } catch (error) {
    console.warn('spec-mode: coordinator failed, falling back to default agent pair:', error.message);
  }
  const assignmentsMap = buildAssignments(assignments, stories, runId);

  if (opts.dryRun) {
    console.log(JSON.stringify(Object.fromEntries(assignmentsMap), null, 2));
    return;
  }

  // ── Step 2: Sequential agent collaboration per story ───────────────────
  const specLogPath = path.join(logDir, 'spec-phase.jsonl');
  const summary = {
    runId,
    phase: opts.phase,
    startedAt: new Date().toISOString(),
    stories: [],
    stats: { acceptanceUpdated: 0, splits: 0, agents: {}, agentFailures: 0, agentAttempts: 0 }
  };
  const newStories = [];

  for (const story of stories) {
    const assigned = assignmentsMap.get(story.id);
    if (!assigned || !assigned.agents.length) {
      continue;
    }

    const agentContributions = [];
    const appliedAgents = [];
    let openspecPayload = null;
    const codeRefs = extractCodeRefs(story);
    const codeHint = codeRefs.length ? ` files=${codeRefs.join(',')}` : '';
    // Captured BEFORE either agent runs — the split-mandate check (after the
    // agent loop below) needs the story's ORIGINAL shape, not an intermediate
    // one, since openspec+speckit can both mutate it across two iterations.
    const originalStorySnapshot = captureStorySnapshot(story);
    let totalSplitCountForStory = 0;

    // Run agents SEQUENTIALLY: openspec first, then speckit with openspec's output
    for (const agent of assigned.agents) {
      summary.stats.agentAttempts += 1;
      const beforeSnapshot = captureStorySnapshot(story);
      await emitMonitorEvent({
        monitorScript,
        type: 'spec_update',
        message: `[${opts.phase}] ${agent} started on ${story.id} (${story.title || 'story'})${codeHint}`,
        storyId: story.id,
        role: agent
      });

      let agentResult;
      try {
        if (agent === 'speckit' && openspecPayload) {
          // Speckit receives openspec's output for collaborative review
          agentResult = await runSpeckitReview({
            promptExec, story, openspecOutput: openspecPayload,
            phase: opts.phase, runId, logDir
          });
        } else {
          agentResult = await runSpecAgent({
            promptExec, agent, story, phase: opts.phase, runId, logDir
          });
        }
      } catch (err) { agentResult = _specAgentFailed(agent, story, err, 'initial'); }

      // Retry on transient failure (timeout, provider outage).
      // For openspec (the sole split authority), use a HIGH ladder:
      //   retry 1  — same model (transient-timeout recovery)
      //   retry 2+ — escalate to SPEC_MODE_OPENSPEC_MODEL_HIGH if configured
      // SPEC_AGENT_MAX_RETRIES defaults to 3 for openspec, 1 for other agents.
      const _isOpenspec = agent === 'openspec';
      // openspec and speckit are both critical — neither may fail. Both agents get the
      // same 3-retry budget (+ model escalation on attempt 2+). "Failures are not permitted"
      // means: retry to success, or abort the pipeline with exit(1). Never continue silently.
      const _specMaxRetries = parseInt(process.env.SPEC_AGENT_MAX_RETRIES || '3', 10);
      const _openspecHighModel = process.env.SPEC_MODE_OPENSPEC_MODEL_HIGH || process.env.SPEC_MODE_OPENSPEC_MODEL || '';
      const _openspecBaseModel = process.env.SPEC_MODE_OPENSPEC_MODEL || '';
      const _speckitHighModel = process.env.SPEC_MODE_SPECKIT_MODEL_HIGH || process.env.SPEC_MODE_SPECKIT_MODEL || '';
      const _speckitBaseModel = process.env.SPEC_MODE_SPECKIT_MODEL || '';
      let _specRetry = 0;
      // Retry exactly when we would otherwise ABORT. These two conditions used
      // to disagree: the loop tested `!agentResult` while the abort below tests
      // `!agentResult || !agentResult.payload`.
      //
      // An unparseable answer returns a result OBJECT with no payload — live
      // AMSD-2041 run 7, speckit replied in prose ("It seems t...") instead of
      // JSON. That failed the abort test but never satisfied the retry test, so
      // all three retries were skipped and the run died on the first bad roll.
      // The budget had been inert for the single most common failure mode there
      // is; earlier runs only recovered from this because the model happened to
      // fail in a way that returned nothing at all.
      const _specNeedsRetry = (r) => !r || !r.payload;
      while (_specNeedsRetry(agentResult) && _specRetry < _specMaxRetries) {
        _specRetry++;
        // WHAT did it do wrong? The payload is all that comes back through the
        // call stack, so on a parse failure the log runAgentForJson wrote is the
        // only surviving record of the model's actual words. A contract
        // violation is deterministic — carry a correction into the next attempt
        // rather than re-asking the identical question, which on AMSD-2041
        // bought three identical answers and a ladder escalation.
        const _specRawLog = path.join(
          logDir,
          agent === 'speckit' ? `${story.id}-speckit-review.log` : `${story.id}-${agent}-spec.log`
        );
        const _specFailureKind = classifySpecFailure(readAgentRawOutput(_specRawLog));
        const _specNote = specCorrectiveNote(_specFailureKind);
        // For retry 2+, escalate to the HIGH model if it differs from base — both agents.
        const _escalateOpenspec = _isOpenspec && _specRetry >= 2 && _openspecHighModel && _openspecHighModel !== _openspecBaseModel;
        const _escalateSpeckit = !_isOpenspec && agent === 'speckit' && _specRetry >= 2 && _speckitHighModel && _speckitHighModel !== _speckitBaseModel;
        const _escalate = _escalateOpenspec || _escalateSpeckit;
        const _prevModel = _isOpenspec ? _openspecBaseModel : _speckitBaseModel;
        const _nextModel = _isOpenspec ? _openspecHighModel : _speckitHighModel;
        if (_escalate) {
          console.warn(
            `spec-mode: ${agent} ladder escalation for ${story.id} (attempt ${_specRetry + 1}/${_specMaxRetries + 1}) — model ${_prevModel} → ${_nextModel}`
          );
          appendSpecPassEvent(logDir, {
            storyId: story.id,
            phase: opts.phase,
            event: 'spec_timeout_escalation',
            decision: 'escalating',
            details: { agent, prevModel: _prevModel, newModel: _nextModel, retry: _specRetry }
          });
        } else {
          console.warn(
            `spec-mode: ${agent} returned null for ${story.id} (attempt ${_specRetry + 1}/${_specMaxRetries + 1})` +
            (_specFailureKind === 'empty'
              ? ' — retrying transient failure'
              : ` — ${_specFailureKind} contract violation, retrying WITH a correction`)
          );
        }
        summary.stats.agentAttempts += 1;
        try {
          if (_escalateOpenspec) {
            const _savedModel = process.env.SPEC_MODE_OPENSPEC_MODEL;
            process.env.SPEC_MODE_OPENSPEC_MODEL = _openspecHighModel;
            try {
              agentResult = await runSpecAgent({ promptExec, agent, story, phase: opts.phase, runId, logDir, forcedRetryNote: _specNote });
            } finally {
              if (_savedModel !== undefined) process.env.SPEC_MODE_OPENSPEC_MODEL = _savedModel;
              else delete process.env.SPEC_MODE_OPENSPEC_MODEL;
            }
          } else if (_escalateSpeckit) {
            const _savedModel = process.env.SPEC_MODE_SPECKIT_MODEL;
            process.env.SPEC_MODE_SPECKIT_MODEL = _speckitHighModel;
            try {
              agentResult = await runSpeckitReview({ promptExec, story, openspecOutput: openspecPayload, phase: opts.phase, runId, logDir, forcedRetryNote: _specNote });
            } finally {
              if (_savedModel !== undefined) process.env.SPEC_MODE_SPECKIT_MODEL = _savedModel;
              else delete process.env.SPEC_MODE_SPECKIT_MODEL;
            }
          } else {
            agentResult = agent === 'speckit' && openspecPayload
              ? await runSpeckitReview({ promptExec, story, openspecOutput: openspecPayload, phase: opts.phase, runId, logDir, forcedRetryNote: _specNote })
              : await runSpecAgent({ promptExec, agent, story, phase: opts.phase, runId, logDir, forcedRetryNote: _specNote });
          }
        } catch (err) { agentResult = _specAgentFailed(agent, story, err, `retry ${_specRetry}`); }
      }

      if (!agentResult || !agentResult.payload) {
        // openspec/speckit failures are not permitted — hard abort so the run is clearly
        // contaminated and must be relaunched rather than proceeding with an unreviewed PRD.
        await emitMonitorEvent({
          monitorScript,
          type: 'error',
          message: `[${opts.phase}] FATAL — ${agent} produced no parsable output for ${story.id} after ${_specRetry + 1} attempt(s)`,
          storyId: story.id,
          role: agent
        });
        console.error(
          `spec-mode: FATAL — ${agent} returned null for ${story.id} after ${_specRetry + 1} attempt(s). ` +
          `openspec/speckit failures are not permitted. Aborting pipeline. ` +
          `Check SPEC_MODE_SPECKIT_MODEL/SPEC_MODE_OPENSPEC_MODEL and RUNCLAUDE_TIMEOUT_MS.`
        );
        process.exit(1);
      }

      let { payload } = agentResult;

      // Track openspec output so speckit can use it
      if (agent === 'openspec') {
        openspecPayload = payload;
      }

      payload.runId = runId;

      // AMSD-2041 (2026-07-31): a content-quality rejection of the AC/
      // description rewrite below reverts story.technicalNotes wholesale back
      // to beforeSnapshot — but technicalNotes.files here is populated from
      // payload.locationHint, which the code-graph-detective computed
      // independently of whatever the reviewer objected to (a symptom-worded
      // AC, a vague description). AMSD-2041's openspec rewrite was rejected
      // 3/3 tries; the revert below erased the detective's grounded fix-site
      // file list along with it, leaving the implementer a rich root-cause
      // narrative (fixSiteAnalysis, which is NOT part of this snapshot and
      // survives) naming exact files, but an empty "Files to Create/Modify"
      // and no injected file content — 8 attempts across 2 ladder rungs spent
      // rediscovering by hand what was already known, each attempt allowed
      // more iterations than the last, ballooning input tokens 32K -> 339K.
      // Re-merged after each revert below, reusing the exact same helper
      // applySpecChanges itself uses, so a rejected AC rewrite can never take
      // the file list down with it.
      const _restoreDetectiveFiles = () => {
        story.technicalNotes = mergeLocationHintFiles(story.technicalNotes, payload.locationHint);
      };

      // Deterministic split-authority check (2026-07-13, user request):
      // speckit no longer owns splitting — openspec is the sole authority,
      // and checkSplitMandateViolation's forced-retry on openspec is the
      // real backstop if it misses a mandatory split (a code-level count,
      // not an LLM's "independent obligation" prose instruction, which is
      // what used to grant speckit this power and is exactly the kind of
      // unenforced instruction this pipeline replaces with deterministic
      // checks everywhere else). This is not just a prompt update — the
      // prompt can be ignored, so it's enforced here in code: ANY
      // splitStories speckit emits is unconditionally dropped, regardless of
      // whether openspec already split this story or not. This is the exact
      // collision class (two independently-split, competing child sets for
      // the same parent, rejected by the same-file coherence check, forcing
      // the parent to fall back to an oversized unsplit story) that hit
      // SKY-002 (2026-07-10) and SKY-003 (2026-07-13) live.
      if (agent === 'speckit' && Array.isArray(payload.splitStories) && payload.splitStories.length) {
        console.warn(`spec-mode: speckit proposed splitStories for ${story.id} — dropping (splitting is openspec's decision alone, enforced deterministically, not just by prompt instruction)`);
        delete payload.splitStories;
      }

      // Brownfield: no agent may split, not even openspec. Guarding the split
      // MANDATE (storyRequiresSplit) only stops the pipeline from DEMANDING a
      // child — an agent can still volunteer one, and the result is identical:
      // a story id that exists nowhere in the client's tracker, cannot be
      // written back, and fragments a minimal fix across children that each
      // fail their own deliverable check (live AMSD-2041-A, 2026-07-30).
      // Deterministic drop, same as the speckit rule above — prompt
      // instruction alone has already been shown insufficient here.
      if (process.env.EPAM_BROWNFIELD === '1' && Array.isArray(payload.splitStories) && payload.splitStories.length) {
        console.warn(`spec-mode: ${agent} proposed splitStories for ${story.id} — dropping (brownfield stories are tickets and are never split; multi-codeline work is one story with N executions)`);
        delete payload.splitStories;
      }

      const newStoriesCountBefore = newStories.length;
      let changes = applySpecChanges(story, payload, newStories, prd, opts.phase, runId, logDir);

      let afterSnapshot = captureStorySnapshot(story);

      // Reviewer gate — validates the AC/description/title rewrite (and any
      // split children just created) before it's accepted. Runs every phase,
      // every story: this is the spec pass's only content-quality check, since
      // applySpecChanges itself only enforces structural caps (AC count, split
      // depth), not whether the rewritten content is actually good.
      // NOTE: applySpecChanges can rewrite description/title/technicalNotes
      // independently of acceptanceChanged (that flag only tracks the AC
      // array). Check the full snapshot, not just changes.acceptanceChanged,
      // so a description/title-only rewrite doesn't slip through unreviewed.
      const anyFieldChanged =
        changes.acceptanceChanged ||
        changes.splitCount > 0 ||
        afterSnapshot.description !== beforeSnapshot.description ||
        afterSnapshot.title !== beforeSnapshot.title ||
        JSON.stringify(afterSnapshot.technicalNotes) !== JSON.stringify(beforeSnapshot.technicalNotes);
      // A split whose ONLY substantive effect is the deterministic "Delegated
      // to split children" placeholder has nothing left for a content
      // reviewer to assess — applySpecChanges already verified the split's
      // structural correctness (file coherence, depth, budget). Skip the
      // review call entirely rather than asking an LLM to judge a
      // machine-generated marker it has no way to recognize as one.
      if (anyFieldChanged && isSplitDelegationOnlyChange(beforeSnapshot, afterSnapshot, changes.splitCount)) {
        console.log(`spec-mode: skipping prd-change-reviewer for ${story.id} — split-only change (delegation marker is deterministic, already structurally verified)`);
      } else if (anyFieldChanged) {
        let reviewResult = await reviewPrdChange({
          aiRunnerCmd, profiles, storyId: story.id, changeType: 'spec_pass',
          before: beforeSnapshot, after: afterSnapshot, logDir,
          splitOccurred: changes.splitCount > 0
        });

        // Retry-on-violation (2026-07-13): a content-quality rejection here
        // used to just revert and move on — never tell the SAME agent what
        // was actually wrong and let it try again. Same "detect, explain,
        // retry" shape as checkSplitMandateViolation's existing precedent
        // below, but an INDEPENDENT 2-attempt budget: that check catches a
        // different violation class (a mandatory split that was skipped
        // entirely), while this one catches rejected AC/description/title
        // content — seeding both in the same test must show 2+1 attempts
        // total, not one shared counter.
        let acReviewAttempts = 1;
        while (reviewResult.verdict === 'fail' && acReviewAttempts < 3) {
          acReviewAttempts += 1;
          const correctiveNote =
            `CRITICAL — YOUR PREVIOUS OUTPUT WAS REJECTED BY REVIEW: ${reviewResult.issues.join('; ') || 'quality issues found'}. ` +
            `Fix this and try again. Do not repeat the same mistake.`;
          let retryResult;
          try {
            retryResult = agent === 'speckit'
              ? await runSpeckitReview({ promptExec, story, openspecOutput: openspecPayload, phase: opts.phase, runId, logDir, forcedRetryNote: correctiveNote })
              : await runSpecAgent({ promptExec, agent, story, phase: opts.phase, runId, logDir, forcedRetryNote: correctiveNote });
          } catch (err) {
            retryResult = null;
          }
          if (!retryResult || !retryResult.payload) break; // nothing to re-apply — fall through to revert below

          // Undo the rejected attempt's effects before reapplying, so a
          // retry never compounds on top of a rejected write.
          story.acceptanceCriteria = beforeSnapshot.acceptanceCriteria;
          story.description = beforeSnapshot.description;
          story.title = beforeSnapshot.title;
          story.technicalNotes = beforeSnapshot.technicalNotes;
          _restoreDetectiveFiles();
          if (newStories.length > newStoriesCountBefore) {
            newStories.splice(newStoriesCountBefore, newStories.length - newStoriesCountBefore);
          }

          retryResult.payload.runId = runId;
          payload = retryResult.payload;
          if (agent === 'openspec') openspecPayload = payload;
          changes = applySpecChanges(story, payload, newStories, prd, opts.phase, runId, logDir);
          afterSnapshot = captureStorySnapshot(story);

          reviewResult = await reviewPrdChange({
            aiRunnerCmd, profiles, storyId: story.id, changeType: 'spec_pass',
            before: beforeSnapshot, after: afterSnapshot, logDir,
            splitOccurred: changes.splitCount > 0
          });
        }

        if (reviewResult.verdict === 'fail') {
          console.warn(`spec-mode: prd-change-reviewer REJECTED ${agent}'s changes to ${story.id} after ${acReviewAttempts} attempt(s): ${reviewResult.issues.join('; ') || 'no details'} — reverting`);
          story.acceptanceCriteria = beforeSnapshot.acceptanceCriteria;
          story.description = beforeSnapshot.description;
          story.title = beforeSnapshot.title;
          story.technicalNotes = beforeSnapshot.technicalNotes;
          _restoreDetectiveFiles();
          if (newStories.length > newStoriesCountBefore) {
            newStories.splice(newStoriesCountBefore, newStories.length - newStoriesCountBefore);
          }
          changes.acceptanceChanged = false;
          changes.splitCount = 0;
          afterSnapshot = captureStorySnapshot(story);
          appendSpecPassEvent(logDir, { storyId: story.id, phase: opts.phase, event: 'reviewer_rejected', decision: 'rejected', details: { agent, attempts: acReviewAttempts, reasons: reviewResult.issues } });
        } else {
          appendSpecPassEvent(logDir, { storyId: story.id, phase: opts.phase, event: 'reviewer_accepted', decision: 'accepted', details: { agent, attempts: acReviewAttempts } });
        }

        logGuardedStepRetry(logDir, {
          timestamp: new Date().toISOString(),
          step: 'ac-review',
          storyId: story.id,
          runId,
          agent,
          attempts: acReviewAttempts,
          outcome: reviewResult.verdict === 'fail' ? 'reverted' : 'pass',
          reason: (reviewResult.issues || []).join('; '),
          // content_quality is the only vocabulary entry here — reviewPrdChange's
          // verdict is itself an LLM judgment call over free-text issues, not a
          // mechanical diff, so it can't be reliably subdivided further without
          // a second LLM call.
          violationTypes: reviewResult.verdict === 'fail' ? ['content_quality'] : []
        });
      }

      // Log each agent's contribution as a separate JSONL entry
      appendJsonl(specLogPath, {
        timestamp: new Date().toISOString(),
        phase_id: opts.phase,
        run_id: runId,
        story_id: story.id,
        agent,
        before: beforeSnapshot,
        after: afterSnapshot,
        notes: payload.notes || '',
        splitStories: payload.splitStories || [],
        acceptanceChanged: changes.acceptanceChanged
      });
      await emitMonitorEvent({
        monitorScript,
        type: 'spec_update',
        message:
          `[${opts.phase}] ${agent} updated ${story.id}` +
          ` acChanged=${changes.acceptanceChanged ? 'yes' : 'no'}` +
          ` splitCount=${changes.splitCount}${codeHint}`,
        storyId: story.id,
        role: agent
      });

      appliedAgents.push(agent);

      // Build contribution record with actual diff data
      const contrib = {
        agent,
        applied: true,
        notes: payload.notes || '',
        acceptanceChanged: changes.acceptanceChanged,
        splitCount: changes.splitCount,
        timestamp: new Date().toISOString()
      };
      if (changes.acceptanceChanged) {
        contrib.acBefore = beforeSnapshot.acceptanceCriteria;
        contrib.acAfter = afterSnapshot.acceptanceCriteria;
        contrib.acAdded = afterSnapshot.acceptanceCriteria.filter(
          ac => !beforeSnapshot.acceptanceCriteria.includes(ac)
        );
        contrib.acRemoved = beforeSnapshot.acceptanceCriteria.filter(
          ac => !afterSnapshot.acceptanceCriteria.includes(ac)
        );
        summary.stats.acceptanceUpdated += 1;
      }
      if (changes.splitCount > 0) {
        contrib.splitIds = (payload.splitStories || []).map(
          (s, i) => s.id || `${story.id}-SPEC-${i + 1}`
        );
      }
      agentContributions.push(contrib);

      summary.stats.splits += changes.splitCount;
      totalSplitCountForStory += changes.splitCount;
      summary.stats.agents[agent] = (summary.stats.agents[agent] || 0) + 1;
    }

    // Deterministic split-MANDATE check — see checkSplitMandateViolation()'s
    // comment for the live defect this catches: openspec's prompt already
    // said "MANDATORY split required" and was ignored, so a same-run reject-
    // and-retry is needed (user directive, 2026-07-06: "check number of ACs —
    // if > 12 then reject and send back to coordinator" — this is the
    // deterministic gate, not just another round of unenforced prose).
    let mandateCheck = checkSplitMandateViolation(originalStorySnapshot, totalSplitCountForStory);
    if (mandateCheck.violated) {
      console.warn(
        `spec-mode: split MANDATE violation for ${story.id}: ${mandateCheck.reason} ` +
        `— openspec was instructed to split but did not; forcing an immediate retry`
      );
      appendSpecPassEvent(logDir, { storyId: story.id, phase: opts.phase, event: 'mandate_violation', decision: 'pending_retry', details: { reason: mandateCheck.reason } });
      const forcedRetryNote =
        `CRITICAL — YOUR PREVIOUS OUTPUT VIOLATED A MANDATORY RULE. This story ${mandateCheck.reason}, ` +
        `which REQUIRES a split, and you did not produce one. This is NOT optional and NOT a suggestion. ` +
        `You MUST output a non-empty "splitStories" array in your response this time.`;
      summary.stats.agentAttempts += 1;
      let retryResult;
      try {
        retryResult = await runSpecAgent({ promptExec, agent: 'openspec', story, phase: opts.phase, runId, logDir, forcedRetryNote });
      } catch (err) {
        retryResult = null;
      }
      if (retryResult && retryResult.payload) {
        retryResult.payload.runId = runId;
        const childrenCountBefore = newStories.length;
        const retryChanges = applySpecChanges(story, retryResult.payload, newStories, prd, opts.phase, runId, logDir);
        summary.stats.splits += retryChanges.splitCount;
        totalSplitCountForStory += retryChanges.splitCount;

        // Root cause of a live cascade defect (2026-07-06): a split "counts"
        // by splitCount alone, but a LAZY/non-compliant split — every child
        // inheriting the FULL original acceptanceCriteria array verbatim,
        // instead of an actual partition — technically produces
        // splitStories.length > 0 while leaving every child STILL over the
        // AC threshold. Each child then re-triggers its OWN split-mandate
        // violation on its own turn, recursively splitting again and again
        // until the max-split-depth cap — SKY-001 (a simple scaffold story)
        // cascaded into 4 stories in one run this way. Verify the CHILDREN
        // are actually compliant, not just that splitCount > 0. If they are
        // NOT, do not attempt a second forced retry (that's how the cascade
        // started) — fall back to flagging, same as any other unresolved
        // violation.
        const newChildren = newStories.slice(childrenCountBefore).map((ns) => ns.story);
        const nonCompliantChildren = newChildren.filter((child) => storyRequiresSplit(captureStorySnapshot(child)).required);
        mandateCheck = checkSplitMandateViolation(originalStorySnapshot, totalSplitCountForStory);
        if (!mandateCheck.violated && nonCompliantChildren.length > 0) {
          console.warn(
            `spec-mode: forced retry for ${story.id} produced a LAZY split — ${nonCompliantChildren.map((c) => c.id).join(', ')} ` +
            `still violate(s) the split mandate (likely inherited the full AC list verbatim) — treating as unresolved, not retrying again`
          );
          mandateCheck = { violated: true, reason: `split produced non-compliant child/children: ${nonCompliantChildren.map((c) => c.id).join(', ')}` };
        }
        if (!mandateCheck.violated) {
          console.log(`spec-mode: forced retry resolved the split MANDATE violation for ${story.id}`);
          appendSpecPassEvent(logDir, { storyId: story.id, phase: opts.phase, event: 'mandate_violation', decision: 'resolved', details: { reason: mandateCheck.reason } });
        } else {
          console.warn(
            `spec-mode: forced retry did NOT resolve the split MANDATE violation for ${story.id} ` +
            `— flagging for the next specification pass`
          );
          appendSpecPassEvent(logDir, { storyId: story.id, phase: opts.phase, event: 'mandate_violation', decision: 'unresolved', details: { reason: mandateCheck.reason } });
        }
      } else {
        summary.stats.agentFailures += 1;
        console.warn(`spec-mode: forced split-mandate retry produced no parsable output for ${story.id} — flagging for the next specification pass`);
        appendSpecPassEvent(logDir, { storyId: story.id, phase: opts.phase, event: 'mandate_violation', decision: 'unresolved', details: { reason: mandateCheck.reason } });
      }
    }

    const specStatus = appliedAgents.length ? 'completed' : 'assigned';
    const existingSpec = story.specification || {};
    const existingReview = existingSpec.coordinatorReview || {};
    const existingFlags = Array.isArray(existingReview.flags) ? existingReview.flags : [];
    story.specification = {
      ...existingSpec,
      runId,
      assignedAgents: assigned.agents,
      coordinatorNotes: assigned.notes,
      status: specStatus,
      updatedAt: new Date().toISOString(),
      appliedAgents,
      agentContributions,
      ...(mandateCheck.violated
        ? {
            coordinatorReview: {
              ...existingReview,
              flags: [...existingFlags, `MANDATORY split was required (${mandateCheck.reason}) but was not performed — split this story now`]
            }
          }
        : {})
    };
    summary.stories.push({
      storyId: story.id,
      assignedAgents: assigned.agents,
      appliedAgents,
      notes: assigned.notes,
      acceptanceUpdated: appliedAgents.length > 0,
      status: specStatus,
      agentContributions
    });

    // Token-budget pass: check each split child created this story iteration.
    // If a child's estimated baseline prompt exceeds the budget, request a
    // further split via a fresh openspec call — same forced-retry shape as the
    // split-mandate gate above, but triggered by token count rather than AC count.
    // Respects the global SPEC_MAX_SPLIT_DEPTH cap (no infinite re-split chains).
    const _tokenBudget = parseInt(process.env.EPAM_TOKEN_BUDGET_PER_STORY || '100000', 10);
    const _contractDir = path.join(path.dirname(prdPath), '.contracts');
    const _tokenSplitMax = parseInt(process.env.SPEC_MAX_SPLIT_DEPTH || '2', 10);
    const _childrenThisStory = newStories.filter((ns) => ns.parentId === story.id);
    for (const { story: child } of _childrenThisStory) {
      const _est = estimateStoryTokens(child, _contractDir);
      if (_est <= _tokenBudget) continue;
      if (splitDepth(child, prd) >= _tokenSplitMax) {
        console.warn(
          `spec-mode: token-budget: ${child.id} ~${Math.round(_est / 1000)}K tokens but at max split depth — proceeding at risk`
        );
        continue;
      }
      console.warn(
        `spec-mode: token-budget: ${child.id} ~${Math.round(_est / 1000)}K tokens (budget ${Math.round(_tokenBudget / 1000)}K) — requesting further split`
      );
      const _tokenNote =
        `IMPORTANT — Story ${child.id} is estimated at ~${Math.round(_est / 1000)}K tokens, ` +
        `exceeding the ${Math.round(_tokenBudget / 1000)}K token budget. ` +
        `It has ${(child.acceptanceCriteria || []).length} ACs. ` +
        `YOU MUST split it further, separating distinct concerns (e.g. frontend/template ` +
        `work from build/configuration work), targeting ≤8 ACs and ≤${Math.round(_tokenBudget / 1000)}K tokens per child.`;
      summary.stats.agentAttempts += 1;
      let _tokenRetry = null;
      try {
        _tokenRetry = await runSpecAgent({
          promptExec, agent: 'openspec', story: child,
          phase: opts.phase, runId, logDir, forcedRetryNote: _tokenNote
        });
      } catch (err) { _tokenRetry = null; }
      if (_tokenRetry?.payload?.splitStories?.length) {
        _tokenRetry.payload.runId = runId;
        const _trc = applySpecChanges(child, _tokenRetry.payload, newStories, prd, opts.phase, runId, logDir);
        summary.stats.splits += _trc.splitCount;
        totalSplitCountForStory += _trc.splitCount;
        if (_trc.splitCount > 0) {
          console.log(`spec-mode: token-budget retry split ${child.id} into ${_trc.splitCount} child/children`);
        }
      }
    }
  }

  // ── Step 3: Insert split stories into PRD ──────────────────────────────
  if (newStories.length) {
    const parentInsertOffsets = {};
    for (const insert of newStories) {
      prd.stories.push(insert.story);
      const order = prd.implementationOrder?.[opts.phase];
      if (Array.isArray(order)) {
        const parentIndex = order.indexOf(insert.parentId);
        const offset = parentInsertOffsets[insert.parentId] || 0;
        const targetIndex = parentIndex === -1 ? order.length : parentIndex + 1 + offset;
        order.splice(targetIndex, 0, insert.story.id);
        parentInsertOffsets[insert.parentId] = offset + 1;
      }
    }
    // Remove successfully-delegated parents from the active phase list — every
    // parentId here had its children genuinely accepted (rejected splits are
    // spliced out of newStories earlier, in applySpecChanges), so its own
    // status was just marked 'deprecated' above. Leaving it in
    // implementationOrder made downstream consumers (TC writer, the main
    // implementation loop) treat it as still-active work with real source
    // files, when its implementation is now entirely delegated to children.
    const delegatedParentIds = new Set(Object.keys(parentInsertOffsets));
    const order = prd.implementationOrder?.[opts.phase];
    if (Array.isArray(order)) {
      prd.implementationOrder[opts.phase] = order.filter((id) => !delegatedParentIds.has(id));
    }

    // Wire test-child dependencies onto impl siblings from the SAME split —
    // must run after ALL children for a parent are inserted so basename
    // matching sees every sibling, not just the first processed.
    const byParentForWiring = new Map();
    for (const insert of newStories) {
      if (!byParentForWiring.has(insert.parentId)) byParentForWiring.set(insert.parentId, []);
      byParentForWiring.get(insert.parentId).push(insert.story);
    }
    const wiringOrder = prd.implementationOrder?.[opts.phase];
    for (const siblings of byParentForWiring.values()) {
      wireSplitSiblingDependencies(siblings, prd);
      reorderSiblingsByDependency(siblings, wiringOrder);
    }
  }

  // ── Step 4: Coordinator review pass ────────────────────────────────────
  const specifiedStories = stories.filter(
    s => s.specification && s.specification.appliedAgents && s.specification.appliedAgents.length > 0
  );
  if (specifiedStories.length > 0) {
    // Brownfield: no agent may split (any splitStories payload is dropped
    // deterministically before this point — see the EPAM_BROWNFIELD guard in
    // applySpecChanges' caller above), and preserveDefectAcceptanceCriteria
    // forces story.acceptanceCriteria back to the ticket's immutable original
    // on every merge regardless of what openspec/speckit proposed. So for a
    // brownfield run, "are the ACs complete/non-overlapping" and "are splits
    // logical" are both grading things the code already guarantees didn't
    // happen — real agent audit, 2026-07-31 (mock1 cycle-time investigation:
    // this call's wall time varied 17s-4m36s across otherwise-identical runs).
    // Dropping the two moot criteria (and the always-empty splitChildren
    // payload) narrows the prompt to what brownfield can actually judge —
    // real technical-depth value-add and whether a story needs human eyes —
    // without losing any judgment brownfield ever used.
    const isBrownfieldReview = process.env.EPAM_BROWNFIELD === '1';
    const reviewPayload = buildReviewPayload(specifiedStories, isBrownfieldReview, prd.stories || [], logDir, opts.phase);

    const reviewCriteria = isBrownfieldReview
      ? `For each story, evaluate the quality of the collaborative spec work:
1. Did both agents add meaningful, non-overlapping value?
2. Flag any story needing human review.
3. PLAN ALIGNMENT — where planAlignmentEvidence is present, it tells you what the
   code-graph-detective SAID it would investigate (detectivePlan) and a deterministic,
   cheap signal (aligned: true/false) for whether the final fixSiteAnalysis shares any
   named symbol/file with that plan. This signal is NOT your verdict — it is evidence, the
   same as MANIFEST EVIDENCE below. A plan can legitimately turn out wrong once real
   exploration starts. Read detectivePlan and fixSiteAnalysis yourself and judge: did the
   detective explain WHY it moved from its plan to its final answer (a stated pivot,
   reasoning that connects the two), or did the answer just change with no explanation?
   The latter is a real defect (a fix has shipped that shared no term with the detective's
   own stated plan, with no explanation, more than once on the same ticket) — set
   planAlignment to justified_deviation when the detective justifies its pivot, or
   unexplained_mismatch when it does not, and say why in reviewNotes. aligned:true needs
   no action.

(Brownfield tickets never split and their acceptance criteria are immutable —
do not evaluate split quality or AC completeness; there is nothing there for
either agent to have changed.

EXPECTED, NOT A DEFECT: an agent's notes may describe acceptance criteria it
authored while the story's acceptanceCriteria array is empty, and report
acceptanceChanged=false. That is this pipeline REDACTING them on purpose: on a
brownfield ticket the ACs are the ticket's own, and a thin ticket legitimately
has none. The observable checks live in verificationCriteria — judge THOSE.
Do not report the mismatch as a hallucination, a persistence failure or a
metadata inconsistency, and do not lower qualityScore for it. An empty
acceptanceCriteria array on a brownfield story is correct by policy.)`
      : `For each story, evaluate the quality of the collaborative spec work:
1. Did both agents add meaningful, non-overlapping value?
2. Are the acceptance criteria complete, testable, and non-overlapping?
3. Are story splits logical and properly scoped?
4. Flag any story needing human review.`;

    const reviewPrompt = `${specCoordinatorProfile ? specCoordinatorProfile + '\n\n' : ''}You are the EPAM CLI specification coordinator reviewing the completed spec outputs for phase ${opts.phase}.

Each story was processed by a sequential agent pipeline:
  1. openspec elaborated requirements (AC refinement, story splits, technical depth)
  2. speckit reviewed openspec's output (testability, security, edge cases, gap analysis)

${reviewCriteria}

MANIFEST EVIDENCE (checked against the repository, not asserted):
${manifestEvidence(specifiedStories, prd)}
${codelineScopeBlock(prd, specifiedStories)}

${MANIFEST_GROUNDING_BLOCK}

QUALITY SCORE — what the number has to mean. It is enforced: below 0.7 halts the run
before implementation, so an unanchored guess stops real work.
  0.9-1.0  the spec is ready to implement; criteria are observable and the file set fits.
  0.7-0.89 ready to implement, with ordinary open questions a competent writer resolves.
  0.5-0.69 NOT ready: something concrete is wrong or missing — criteria that cannot be
           observed, a file set that cannot deliver what is described, contradictions.
  below 0.5 the spec would send a writer somewhere useless.
Score what IS in front of you. Do NOT lower the score because an agent could not read the
source files, or because a human "might want to check" — that is true of every ticket and
is not a defect in this spec. If your notes cannot name something concretely wrong, the
score belongs at 0.7 or above.

Respond with JSON between <SPEC_REVIEW> and </SPEC_REVIEW> using this schema:
[
  {"storyId":"REM-xxx","verdict":"approved|needs_review","reviewNotes":"coordinator observations","qualityScore":0.0-1.0,"flags":[{"flag":"short-slug","severity":"blocking|advisory","why":"what you checked and what you found"}],"planAlignment":"aligned|justified_deviation|unexplained_mismatch|not_applicable"}
]

Stories to review:
${reviewPayload}

<SPEC_REVIEW>
</SPEC_REVIEW>`;

    let reviews = null;
    try {
      reviews = await runAgentForJson(
        promptExec,
        reviewPrompt,
        TOOL_SPEC_REVIEW,
        'SPEC_REVIEW',
        path.join(logDir, `spec-coordinator-review-${opts.phase}.log`),
        'items',
        `phase:${opts.phase}`   // phase-level agent — no single story owns it
      );
    } catch (error) {
      console.warn('spec-mode: coordinator review failed:', error.message);
    }
    if (Array.isArray(reviews)) {
      const reviewMap = new Map();
      reviews.forEach(r => { if (r && r.storyId) reviewMap.set(r.storyId, r); });
      for (const story of specifiedStories) {
        const review = reviewMap.get(story.id);
        if (review) {
          // The computed truth about the manifest, recorded next to the verdict. The gate
          // blocks on THIS; the model's missing_manifest_path flag is corroboration only
          // (measured: hallucinated in 1 of 4 samples against an all-EXISTS evidence
          // block). Persisted, not merely logged — a fact the gate needs must be on disk.
          story.specification.manifestCheck = {
            missing: manifestMissingPaths([story], prd),
            checkedAt: new Date().toISOString()
          };
          story.specification.coordinatorReview = {
            verdict: review.verdict || 'approved',
            reviewNotes: review.reviewNotes || '',
            qualityScore: typeof review.qualityScore === 'number' ? review.qualityScore : null,
            flags: Array.isArray(review.flags) ? review.flags : [],
            planAlignment: review.planAlignment || 'not_applicable',
            reviewedAt: new Date().toISOString()
          };

          // ONE bounded corrective re-invocation of the detective — not a loop, not a
          // pipeline abort. The reviewer judged (not a regex) that the detective's answer
          // diverged from its own plan with no stated reason; feed that judgment back as
          // corrective context, mirroring the existing PRIOR COORDINATOR FLAGS pattern
          // already used for openspec/speckit re-elaboration. Best-effort: a failed
          // correction keeps the original (already-persisted) fixSiteAnalysis rather than
          // losing it — a flagged hypothesis still beats none.
          const _correction = detectiveCorrectionNeeded({
            review,
            coverage: story.fixSiteAnalysisCoverage,
            brownfield: process.env.EPAM_BROWNFIELD === '1',
          });
          if (_correction.correct) {
            console.warn(`spec-mode: re-invoking the detective once for ${story.id} — ${_correction.reasons.join('; ')}.`);
            advanceAgentLadderEscalation(logDir, 'code-graph-detective', story.id);
            try {
              const _priorPlan = readLatestDetectivePlan(logDir, opts.phase, story.id);
              const _priorFindings = Array.isArray(story.fixSiteAnalysis) ? story.fixSiteAnalysis : [];
              const _corrected = await runCodeGraphDetective(story, logDir, {
                correctiveContext: {
                  priorPlan: _priorPlan,
                  priorFindings: _priorFindings,
                  reviewNotes: review.reviewNotes || '',
                  // Named, not merely counted: a re-invocation told only "try again" re-samples
                  // the same answer. These are the criteria no site addressed.
                  uncoveredCriteria: _correction.uncovered,
                },
              });
              if (Array.isArray(_corrected) && _corrected.length) {
                story.fixSiteAnalysis = _corrected.filter((f) => f.reason);
                story.fixSiteAnalysisCoverage = coverageForStory(story);
                console.warn(`spec-mode: ${story.id} — detective correction produced ${story.fixSiteAnalysis.length} revised fix-site(s).`);
              }
            } catch (err) {
              console.warn(`spec-mode: detective correction failed for ${story.id} (${err && err.message}) — keeping the original fixSiteAnalysis.`);
            }
          }

          const summaryEntry = summary.stories.find(s => s.storyId === story.id);
          if (summaryEntry) {
            summaryEntry.coordinatorReview = story.specification.coordinatorReview;
          }
        }
      }
      summary.stats.coordinatorReviewCompleted = true;
      summary.stats.approved = reviews.filter(r => r.verdict === 'approved').length;
      summary.stats.needsReview = reviews.filter(r => r.verdict === 'needs_review').length;
    }
  }

  // ── Step 5: Model adequacy re-assessment ──────────────────────────────
  // Pass A (rule-based): score every story against measurable complexity signals.
  // Pass B (LLM review): coordinator reviews all scores — confirms, overrides, or
  //   catches false negatives the rules missed. LLM decision is final.
  // Both passes write to story.specification.modelUpgrade for full auditability.
  // Fallback default MUST stay within this pipeline's configured model ladder
  // (MiniMax/qwen-routed models only — Anthropic models are never permitted
  // here). A prior default of 'anthropic/claude-sonnet-4-6' meant ANY
  // invocation that forgot to export ORCH_UPGRADE_MODEL (e.g. a hand-rolled
  // launcher that didn't replicate tier3-travel-app-run.sh's full env-var
  // set) silently got an Anthropic model assigned — and because
  // buildKnownValidModels() below includes whatever this resolves to,
  // isValidModelString() accepted it as "known valid" by construction, so no
  // validation ever caught it (found live 2026-07-13: SKY-001 assigned
  // anthropic/claude-sonnet-4-6, failed 8/8 attempts, aborted the phase).
  const upgradeModel = process.env.ORCH_UPGRADE_MODEL || 'MiniMax-M3';
  const miniModel    = process.env.ORCH_MINI_MODEL    || 'MiniMax-M2.5';
  // Ceiling model for veryHighComplexity stories — "the most appropriate
  // high model," reusing the SAME strongest-configured-model concept the
  // Rung3+ watchdog fallback already uses (EPAM_FINAL_FALLBACK_MODEL), so
  // there's one source of truth for "what is our ceiling model" rather than
  // two independently-configured ceilings that could drift apart. A
  // dedicated EPAM_VERY_HIGH_COMPLEXITY_MODEL override exists for projects
  // that want a different ceiling here than the watchdog-timeout fallback.
  const veryHighModel    = process.env.EPAM_VERY_HIGH_COMPLEXITY_MODEL    || process.env.EPAM_FINAL_FALLBACK_MODEL    || upgradeModel;
  const veryHighProvider = process.env.EPAM_VERY_HIGH_COMPLEXITY_PROVIDER || process.env.EPAM_FINAL_FALLBACK_PROVIDER || '';
  const allPhaseStories = [...stories, ...newStories.map((ns) => ns.story)];

  // Pass A — rule-based signals for every story that has a model assigned
  const ruleAssessments = [];
  for (const story of allPhaseStories) {
    if (!story.model) continue;
    const signals = modelComplexitySignals(story);
    ruleAssessments.push({
      storyId: story.id,
      currentModel: story.model,
      isMini: isMiniTierModel(story.model),
      ruleRecommendation: signals.veryHighComplexity ? veryHighModel : (signals.needsUpgrade ? upgradeModel : story.model),
      ruleUpgrade: signals.needsUpgrade,
      ruleReason: signals.reason || 'no upgrade signal detected',
      veryHighComplexity: signals.veryHighComplexity,
      veryHighReason: signals.veryHighReason,
      signals: {
        acCount: signals.acCount,
        singleFile: signals.isSingleFile,
        htmlOutput: signals.hasHtmlOutput,
        selfContained: signals.hasSelfContainedKeyword
      }
    });
  }

  // Pass B — LLM coordinator reviews all rule assessments
  let finalAssessments = ruleAssessments.map((a) => ({ ...a, finalModel: a.ruleRecommendation, llmOverride: false, llmReason: '' }));
  try {
    const storyContextForReview = allPhaseStories
      .filter((s) => s.model)
      .map((s) => {
        const ra = ruleAssessments.find((a) => a.storyId === s.id);
        return {
          id: s.id,
          title: s.title,
          description: (s.description || ''),
          acCount: Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria.length : 0,
          outputFiles: (s.technicalNotes?.files || []).filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.spec.ts')),
          currentModel: s.model,
          ruleUpgrade: ra ? ra.ruleUpgrade : false,
          ruleReason: ra ? ra.ruleReason : '',
          signals: ra ? ra.signals : {}
        };
      });

    const modelReviewPrompt = `${specCoordinatorProfile ? specCoordinatorProfile + '\n\n' : ''}You are the EPAM CLI model assignment coordinator for phase ${opts.phase}.

A rule-based pass has already assessed every story's model assignment. Your job is to make the FINAL decision on each story's model — confirming rule recommendations, overriding them when wrong, and catching any false negatives the rules missed.

## Available model tiers
- **mini-tier** (fast, lower cost): ${miniModel}
  Best for: simple tasks, small outputs, <8 ACs, modifying existing code, writing single focused functions
  Risk: will timeout or fail on large generation tasks (>1500 output tokens in one turn)

- **standard-tier** (higher capability): ${upgradeModel}
  Best for: large single-file generation, 10+ ACs, HTML/UI files, self-contained complete modules
  Use when: story needs to generate >1000 tokens reliably in one turn

## Your decision criteria
UPGRADE to standard-tier when:
- Story must generate a large, complete artifact (full HTML page, large TypeScript module) in one agent turn
- Story has >12 ACs targeting a single file output — generation load exceeds mini-tier reliability
- Description uses "self-contained", "complete", "no build step" — indicates large monolithic output
- Story involves HTML/CSS/JS UI generation — models smaller than standard-tier produce inconsistent results

KEEP mini-tier when:
- Story modifies existing code or adds small targeted functions
- Output is small (<500 tokens estimated), well-scoped, and narrowly defined
- Story primarily writes tests against already-specified contracts
- AC count is high but spread across multiple small files, not one large generation

IMPORTANT: A false negative (keeping mini when standard is needed) wastes 5+ minutes per attempt and burns 2 retries. A false positive (upgrading when mini would work) costs ~$0.01 extra. Err toward upgrading for borderline cases.

## Stories to assess
${JSON.stringify(storyContextForReview, null, 2)}

Respond with JSON between <MODEL_REVIEW> and </MODEL_REVIEW>:
[
  {
    "storyId": "...",
    "finalModel": "keep-current | <model-string>",
    "override": true/false,
    "confidence": "high|medium|low",
    "reason": "one sentence"
  }
]
Use "keep-current" to accept the current (possibly rule-upgraded) model. Only provide a model string when changing it.

<MODEL_REVIEW>
</MODEL_REVIEW>`;

    let llmDecisions = null;
    try {
      llmDecisions = await runAgentForJson(
        promptExec,
        modelReviewPrompt,
        TOOL_MODEL_REVIEW,
        'MODEL_REVIEW',
        path.join(logDir, `spec-model-review-${opts.phase}.log`),
        'items',
        `phase:${opts.phase}`   // phase-level agent — no single story owns it
      );
    } catch (err) { llmDecisions = null; }
    if (Array.isArray(llmDecisions)) {
      // Tier label → canonical model ID (LLM sometimes echoes the tier label instead of a real model string)
      const TIER_LABEL_MAP = {
        'standard-tier': upgradeModel,
        'mini-tier':     miniModel,
        'nano-tier':     miniModel,
        'premium-tier':  process.env.ORCH_PREMIUM_MODEL || upgradeModel,
      };
      const resolveTierLabel = (m) => (m && TIER_LABEL_MAP[m]) ? TIER_LABEL_MAP[m] : m;

      const knownValidModels = buildKnownValidModels(upgradeModel, miniModel);
      const isValidModel = (m, currentModel) => isValidModelString(m, currentModel, knownValidModels);

      const decisionMap = new Map();
      llmDecisions.forEach((d) => { if (d && d.storyId) decisionMap.set(d.storyId, d); });
      finalAssessments = finalAssessments.map((fa) => {
        // veryHighComplexity is a deterministic, code-level classification —
        // the LLM coordinator has no concept of "ceiling model, skip the
        // ladder" and could talk itself into downgrading a story that
        // genuinely needs it (same "code-level checks > LLM persuasion"
        // principle already applied elsewhere in this pipeline). Bypass
        // Pass B entirely for these stories; the rule-based ceiling
        // assignment from Pass A is final.
        if (fa.veryHighComplexity) return fa;
        const decision = decisionMap.get(fa.storyId);
        if (!decision) return fa;
        const rawModel = decision.finalModel && decision.finalModel !== 'keep-current'
          ? decision.finalModel
          : fa.ruleRecommendation;
        let llmModel = resolveTierLabel(rawModel);
        let rejectedInvalidModel = false;
        if (!isValidModel(llmModel, fa.currentModel)) {
          console.warn(
            `spec-mode: LLM model review for ${fa.storyId} returned unrecognized model "${llmModel}" — ` +
            `ignoring and using rule-based recommendation "${fa.ruleRecommendation}" instead`
          );
          llmModel = fa.ruleRecommendation;
          rejectedInvalidModel = true;
        }
        return {
          ...fa,
          finalModel: llmModel,
          llmOverride: decision.override === true && !rejectedInvalidModel,
          llmReason: decision.reason || '',
          llmConfidence: decision.confidence || 'medium'
        };
      });
      console.log(`spec-mode: LLM model review completed for ${llmDecisions.length} stories`);
    }
  } catch (err) {
    console.warn('spec-mode: LLM model review failed, using rule-based decisions only:', err.message);
  }

  // Apply final decisions
  const modelChanges = [];
  for (const fa of finalAssessments) {
    const story = allPhaseStories.find((s) => s.id === fa.storyId);
    if (!story) continue;
    // veryHighComplexity: mark skipLadder regardless of whether the model
    // string itself changed (e.g. it was already assigned the ceiling
    // model by an earlier pass) — the flag is what tells claude.sh's
    // InferenceLadder to stop reassigning models on retry, not the model
    // value alone.
    if (fa.veryHighComplexity && !story.skipLadder) {
      story.skipLadder = true;
      console.log(`spec-mode: ${story.id} marked skipLadder=true (${fa.veryHighReason})`);
    }
    if (fa.finalModel !== story.model) {
      const prev = story.model;
      story.model = fa.finalModel;
      // Keep aiProvider in sync with the new model — see resolveModelProvider's
      // docstring for the live bug this fixes (stale provider + new model
      // silently misrouting requests, causing an indefinite hang).
      const newProvider = resolveModelProvider(fa.finalModel) || (fa.veryHighComplexity ? veryHighProvider : '');
      if (newProvider && newProvider !== story.aiProvider) {
        const prevProvider = story.aiProvider;
        story.aiProvider = newProvider;
        console.log(
          `spec-mode: provider set ${story.id}: ${prevProvider} → ${newProvider} (model changed to ${fa.finalModel})`
        );
      }
      if (!story.specification) story.specification = {};
      story.specification.modelUpgrade = {
        from: prev,
        to: fa.finalModel,
        ruleSignals: fa.signals,
        ruleReason: fa.ruleReason,
        llmOverride: fa.llmOverride,
        llmReason: fa.llmReason,
        llmConfidence: fa.llmConfidence || null,
        veryHighComplexity: fa.veryHighComplexity || false,
        veryHighReason: fa.veryHighReason || '',
        upgradedAt: new Date().toISOString()
      };
      modelChanges.push({ storyId: story.id, from: prev, to: fa.finalModel, llmOverride: fa.llmOverride, veryHighComplexity: fa.veryHighComplexity || false });
      console.log(`spec-mode: model set ${story.id}: ${prev} → ${fa.finalModel}${fa.llmOverride ? ' [LLM override]' : ''}${fa.veryHighComplexity ? ' [VERY HIGH COMPLEXITY — ceiling model, skipLadder]' : ''}`);
    }
  }
  if (modelChanges.length > 0) {
    summary.stats.modelUpgrades = modelChanges;
  }

  // Story-ID-loss invariant — see assertNoStoryIdsLost's docstring.
  assertNoStoryIdsLost(_initialStoryIds, new Set((prd.stories || []).map((s) => s.id)), 'run()');

  // Atomic write (write to a temp file, then rename): writeFileSync alone
  // truncates the target before writing, so a kill mid-write leaves the PRD
  // empty/corrupted — the same class of incident found live 2026-07-11 (a
  // "Bad control character in string literal" PRD corruption). Locked
  // against concurrent writers (e.g. a parallel worktree story patching the
  // same PRD) so two writes can't interleave at the disk-write moment.
  const _prdLockPath = `${prdPath}.lock`;
  acquireFileLock(_prdLockPath);
  try {
    const _tmpPrdPath = `${prdPath}.tmp`;
    fs.writeFileSync(_tmpPrdPath, JSON.stringify(prd, null, 2));
    fs.renameSync(_tmpPrdPath, prdPath);
  } finally {
    releaseFileLock(_prdLockPath);
  }
  summary.completedAt = new Date().toISOString();
  summary.storyCount = summary.stories.length;
  fs.writeFileSync(path.join(specRunDir, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(logDir, 'spec-summary.json'), JSON.stringify(summary, null, 2));
  await emitMonitorEvent({
    monitorScript,
    type: 'spec_update',
    message: `[${opts.phase}] specification completed run=${runId} stories=${summary.storyCount}`,
    role: 'spec-coordinator'
  });
  console.log(`spec-mode: completed for phase ${opts.phase} (run ${runId})`);

  // Abort pipeline if every agent invocation failed — indicates a broken provider/runner
  if (summary.stats.agentAttempts > 0 && summary.stats.agentFailures === summary.stats.agentAttempts) {
    console.error(
      `spec-mode: FATAL — all ${summary.stats.agentAttempts} agent invocations failed for phase ${opts.phase}. ` +
      `Check EPAM_ORCHESTRATION_PROVIDER is set and supported by ai-run.sh.`
    );
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent prompt builders
// ─────────────────────────────────────────────────────────────────────────────

// Brownfield archaeology block — must fire for EPAM_BROWNFIELD=1 regardless of
// which spec agent (openspec or speckit) is running the prompt. Whichever
// agent runs must identify the existing change site before writing any AC;
// locationHint feeds directly into the story agent's context so it opens the
// right file. Extracted as a pure, exported function (rather than left inline
// as a private ternary) specifically so this condition can be tested by
// calling it, not by grepping source text for a string pattern — a static
// regex assertion is exactly what let the original bug ship silently.
//
// Root cause fix (2026-07-23, live AMSD-1820 failure): this used to also
// require `agent === 'openspec'`. The coordinator can legitimately assign
// ONLY speckit to a story (openspec ran "0 stories" that phase) — when that
// happens, this block never fired for that story at all: no locationHint
// request, no CodeGraph/Semble grounding instruction, nothing. The story
// then went to execution with zero file guidance in a large real repo, and
// 8 real agent attempts never found the actual fix site.
// Deterministic backstop to openspec's own defect/novel classification (STEP 3
// of the brownfield archaeology block). When openspec classifies a story as a
// "defect", its acceptance criteria must pass through UNCHANGED — rewriting a
// bug's ACs bakes in a guessed fix mechanism that misdirects the implementer
// (live AMSD-1820). This restores the story's original ACs onto the payload,
// enforcing the instruction even when the model ignores it.
//
// Greenfield-safe: no-op unless env.EPAM_BROWNFIELD === '1'. "novel" brownfield
// stories are left fully elaborated (a brownfield story is not always a bug).
// Returns true iff openspec had actually altered the ACs (i.e. an edit was
// redacted) — purely so the caller can log it.
// Verify the detective's prescribed helper actually EXISTS in the repo before we
// inject its fix as "AUTHORITATIVE — the plan of record". The detective is an LLM
// and can hallucinate a plausible-sounding helper/symbol; making a hallucinated
// fix authoritative misdirects harder than no fix at all. Deterministic + cheap:
// grep the repo for a definition of the named symbol.
//   returns true  — a helper was named AND a definition exists (trust it)
//   returns false — a helper was named but NOT found anywhere (likely invented)
//   returns null  — no helper named (nothing to verify; not every fix needs one)
function verifyDetectiveHelper(helper, repoPath) {
  if (!helper || typeof helper !== 'string') return null;
  const sym = helper.trim().replace(/[^A-Za-z0-9_].*$/, ''); // first identifier only
  if (!/^[A-Za-z_][A-Za-z0-9_]+$/.test(sym)) return null;
  if (!repoPath) return null;
  try {
    const res = require('child_process').spawnSync(
      'grep',
      ['-rEl', '--include=*.ts', '--include=*.tsx',
        '--exclude-dir=node_modules', '--exclude-dir=.git',
        `(function|const|class|type|interface|enum)[[:space:]]+${sym}\\b`, repoPath],
      { encoding: 'utf8', timeout: 15000 }
    );
    return res.status === 0 && String(res.stdout || '').trim().length > 0;
  } catch { return null; }
}

// precomputeDetectiveExplore(repoPath, story, toolPath, env)
// Runs the detective's own step-1 `explore` for it, deterministically, before
// the model is invoked.
//
// The prompt says "First call: explore with the DOMAIN NOUNS only" — and that
// call needs no judgement at all: buildBrownfieldSearchQuery() already computes
// exactly that noun set (the stopword-stripped query proven to rank the real
// fix site #1 rather than the display layer the symptom words describe).
//
// The scarce resource here is the iteration budget, not intelligence. glm-5.1
// exhausted the cap at 10, 20, 25 and 40 — every turn spent re-deriving a query
// we can compute for free is a turn not spent tracing callers, which is the
// part that actually needs a model. Best-effort by construction: a missing
// tool, a broken index or a slow query degrades to "no pre-seed" and never
// breaks the spec pass.
const DETECTIVE_PRESEED_MAX_CHARS = 8000;
function precomputeDetectiveExplore(repoPath, story, toolPath, env = process.env, vocabulary = null) {
  if (env.CODEGRAPH_DETECTIVE_PRESEED === '0') return '';
  if (!repoPath || !toolPath || !story) return '';
  let query = '';
  try { query = buildBrownfieldSearchQuery(story, vocabulary) || ''; } catch { return ''; }
  const terms = String(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return '';
  try {
    if (!fs.existsSync(toolPath)) return '';
    const res = require('child_process').spawnSync(
      'bash', [toolPath, 'explore', ...terms],
      {
        encoding: 'utf8',
        timeout: Number(env.CODEGRAPH_DETECTIVE_PRESEED_TIMEOUT_MS || '60000'),
        env: Object.assign({}, env, { PROJECT_ROOT: repoPath }),
      },
    );
    if (res.status !== 0) return '';
    const out = String(res.stdout || '').trim();
    if (!out) return '';
    if (out.length <= DETECTIVE_PRESEED_MAX_CHARS) return out;
    // Say so — a silently truncated ranking reads as a complete one. The notice
    // counts against the cap: the point is a bounded block, not a bounded body
    // with an unbounded footer.
    const notice = '\n… (truncated — re-run explore yourself if you need the rest)';
    return out.slice(0, DETECTIVE_PRESEED_MAX_CHARS - notice.length) + notice;
  } catch { return ''; }
}

// verifyDetectiveEvidence(brokenLine, file, repoPath)
// Does the code the detective claims is broken actually EXIST in the file it
// named? true = quoted and found, false = quoted and NOT found (the diagnosis
// is about code that isn't there), null = nothing quoted / too short to prove
// anything.
//
// Live metrolinx 2026-07-26. The detective returned clean JSON naming the right
// file and a confident root cause — "the discount is applied at full value to
// each leg, halve it with getPreciseFloatNumber". Wrong. The real defect is the
// matcher: dispatch line-item ids are built by getDispatchLineItemKey as
// `"<id>#return"`, so `lineItem.id === discount.lineItemId` never matches for a
// return trip, discountsForDispatch comes back empty, the function returns
// early and NO discount is ever set — which is precisely the ticket's symptom
// (amount NOT DISPLAYED; a doubled amount would show a wrong number, not
// nothing).
//
// Every existing guard passed it. `helper` was getPreciseFloatNumber, which
// really exists, so verifyDetectiveHelper said true; the JSON parsed, so the
// attempt counted as success. This agent was scored on "emitted valid JSON",
// never on "the claim is true of the code" — the same PRODUCED-vs-VALID gap
// behind every escaped defect here.
//
// So: a fix that changes existing code must quote the expression it changes,
// and that expression must be in the file. The wrong prescription invents new
// logic and can quote nothing; the correct one quotes a line that is really
// there. A check, not more prompt text.
function verifyDetectiveEvidence(brokenLine, file, repoPath) {
  if (!brokenLine || typeof brokenLine !== 'string') return null;
  // Strip the backticks the prompt's own example uses, then normalise
  // whitespace: the model reformats what it quotes, and a formatting
  // difference must never reject a genuine quote.
  const norm = (s) => s.replace(/`/g, ' ').replace(/\s+/g, ' ').trim();
  const needle = norm(brokenLine);
  // A quote too short to be distinctive (`}`, `=>`) proves nothing — treat it
  // as no claim rather than as evidence.
  if (needle.length < minEvidenceChars()) return null;
  if (!file || typeof file !== 'string' || !repoPath) return false;
  try {
    const rel = file.replace(/^\.?\//, '');
    const abs = path.resolve(repoPath, rel);
    // Never read outside the repo under diagnosis.
    if (abs !== repoPath && !abs.startsWith(repoPath + path.sep)) return false;
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
    return norm(fs.readFileSync(abs, 'utf8')).includes(needle);
  } catch { return false; }
}

// AC IMMUTABILITY (VC model): the acceptanceCriteria are the ticket's intent and
// are NEVER mutated by the spec pass for a brownfield story — all verification
// lives in the separate verificationCriteria (VC) layer, so ACs can't be poisoned
// with a guessed implementation mechanism. Restores the story's original ACs onto
// the payload. (Was defect-only; now every brownfield story per the VC design,
// 2026-07-24.) Returns true iff openspec had altered the ACs (so the caller logs).
function preserveDefectAcceptanceCriteria(payload, story, env = process.env) {
  if (!payload || env.EPAM_BROWNFIELD !== '1') return false;
  if (!story || !Array.isArray(story.acceptanceCriteria)) return false;
  const original = story.acceptanceCriteria.slice();
  const changed = JSON.stringify(payload.acceptanceCriteria) !== JSON.stringify(original);
  payload.acceptanceCriteria = original;
  return changed;
}

// SHARED verification-criteria rules — the SINGLE source of truth used verbatim by
// BOTH the producer (openspec: archaeology STEP 3 + regenerate) AND the reviewer
// (speckit). Keeping one text means the producer and reviewer can never disagree
// about what counts as "observable" — the disagreement that made AMSD-1820 loop
// forever (producer emitted an internal "confirmation data" response field as a VC;
// reviewer flagged that same field as a mechanism; regen re-emitted it; → fallback).
const AC_PRESCRIPTIVENESS_RULE = `An acceptance criterion states WHAT MUST BE TRUE for the story to be done, observed from outside the implementation. It NEVER dictates the code that produces it.
An acceptance criterion is FORBIDDEN if it names a specific library, framework, test double, API call, import, or code construct the implementation must use. Naming a required OUTCOME is correct; naming the machinery that achieves it is not.`;

const SEARCH_TERM_RULE = `A search term is USEFUL when it names something that exists in the repository being searched — a symbol, function, file, module, or a domain noun the code itself uses. It is NOISE when it names the ticket's packaging rather than its subject: routing tags, brand or product labels, ticket prefixes, status words, people, or generic prose.
Return as BLACKLIST every candidate that names packaging rather than subject, or that resolves to nothing in the index. Return as WHITELIST the terms that name the capability or code under discussion.`;

/**
 * vcFormSamples(env) — worked examples of FORM for the VC producer, supplied PER PROJECT.
 *
 * Rules alone did not stop the same three shapes being produced and then deleted across the
 * runs of 2026-08-06/07: an assertion about internal structure, an assertion about an internal
 * call path, and a criterion beginning outside the boundary a test can drive. Contrast pairs
 * teach those shapes in a way a prohibition does not.
 *
 * They are NOT written here. Authored examples in engine code are content in the generic
 * pipeline — wrong for the next project, and maintained by nobody. They live in the project's
 * own config directory, where a project's specifics belong, and a project that supplies none
 * simply gets no examples section.
 *
 * EVERY NOUN IN THEM MUST BE A PLACEHOLDER. The guard-vocabulary agent's persona carried one
 * worked example naming a real vendor callback, and the guard deleted criteria quoting that
 * callback on three consecutive runs. An example is the strongest line in a prompt, so it is
 * the worst place to put a real name — see the test that enforces this on whatever file a
 * project supplies.
 *
 * PRODUCER ONLY. The guard derives what it enforces from VC_OBSERVABILITY_RULES plus this
 * story's own evidence; authored examples must never reach an enforcement path.
 */
function vcFormSamples(env = process.env) {
  const explicit = env.VC_FORM_SAMPLES_FILE;
  const projectDir = env.EPAM_PROJECT_CONFIG_DIR;
  const candidate = explicit || (projectDir ? path.join(projectDir, 'vc-form-samples.md') : '');
  if (!candidate) return '';
  try {
    const text = fs.readFileSync(candidate, 'utf8').trim();
    return text || '';
  } catch {
    // A project without samples is the normal case, not an error.
    return '';
  }
}

const VC_OBSERVABILITY_RULES = `A verification criterion states WHAT AN END USER OR TESTER OBSERVES on the user-facing surface THE TICKET IS ABOUT — the rendered output for an output ticket, the displayed screen for a UI ticket, the response a CLIENT receives for an API ticket. It is a BLACK-BOX check on that surface. It NEVER describes HOW the value is produced.
A verification criterion is FORBIDDEN if it:
- prescribes HOW to implement — any algorithm, mechanism, approach, or the addition/reading of any new field, flag or service;
- references an INTERNAL structure that merely FEEDS the ticket's surface — an intermediate payload, a data-transfer object, or a specific response field used to BUILD the output. Verify the surface the ticket names, NOT the data structure behind it;
- makes a CROSS-COMPARISON that presumes a mechanism — never assert one value "must equal" / "matches" / "is the same as" another; that presumes a shared derivation. Assert the required value is present and correct ON ITS OWN.
Every verification criterion must be observable, testable, and tied to the ticket's stated symptom/intent.`;

// Validate + normalize the verification criteria openspec produced: an array of
// non-empty strings. Kept separate so a malformed payload never corrupts the story.
function normalizeVerificationCriteria(payload) {
  // The DETAIL is the richer answer, so it wins when present. What is persisted stays an array
  // of strings: the guard, coverage checking, the writer prompt and claude.sh all read that
  // shape, and changing it here would be a rewrite of the contract rather than an addition.
  const detail = vcDeclarations(payload);
  if (detail.length) return detail.map((d) => d.criterion);
  const vc = payload && Array.isArray(payload.verificationCriteria) ? payload.verificationCriteria : [];
  return vc.filter((v) => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

/**
 * vcDeclarations(payload) -> [{ criterion, observer, surface, setup }]
 *
 * The per-criterion standard, normalised. Kept on the story rather than consumed and thrown
 * away: "who observes this, and on what" is the most useful thing a reviewer or a human can be
 * shown when deciding whether a criterion is worth verifying, and it is exactly what was
 * missing when the pipeline argued with itself about whether a mocked precondition was a
 * violation.
 *
 * An older string-only payload yields NOTHING here rather than fabricated declarations: an
 * invented observer would be worse than an absent one.
 */
function vcDeclarations(payload) {
  const raw = payload && Array.isArray(payload.verificationCriteriaDetail)
    ? payload.verificationCriteriaDetail : [];
  return raw
    .map((d) => (d && typeof d === 'object' ? d : null))
    .filter(Boolean)
    .map((d) => ({
      criterion: String(d.criterion || '').trim(),
      observer: String(d.observer || '').trim(),
      surface: String(d.surface || '').trim(),
      setup: String(d.setup || '').trim(),
    }))
    .filter((d) => d.criterion);
}

// Thin-context signal for the sufficiency gate (step 3): a ticket has too little
// to work with when it has NO meaningful acceptance criterion AND a short
// description. Combined with "the detective found no fix site", this is the
// autonomous "insufficient context — fail early" condition (no human halt).
function isThinContext(story, env = process.env) {
  const minAcLen = Number(env.VC_MIN_MEANINGFUL_AC_LEN || '20');
  const minDescLen = Number(env.VC_MIN_DESCRIPTION_LEN || '120');
  const acs = Array.isArray(story && story.acceptanceCriteria) ? story.acceptanceCriteria : [];
  const meaningful = acs.filter((a) => typeof a === 'string' && a.trim().length >= minAcLen);
  const descLen = String((story && story.description) || '').trim().length;
  return meaningful.length < 1 && descLen < minDescLen;
}

// DETERMINISTIC VC guard (step 2 of the AC/VC/TC design). A VC must describe WHAT
// a tester observes, never HOW to implement it. These patterns catch the exact
// domain-mechanism phrasing that misdirected the fix live (AMSD-1820: "split",
// "halve/×0.5", "calculate independently", "per segment/leg") plus new-code-
// structure directives. Distinct from the AC prescriptiveness guard (which catches
// test/code mechanics like vi.mock/import). Returns the flagged VCs with reasons.
function findVcMechanism(vc, storyId, vocabulary) {
  // PURE APPLIER — holds no terms, no patterns, no domain nouns, no stack assumptions.
  // What counts as a violation is DERIVED per story by the guard-vocabulary agent
  // (deriveGuardVocabulary) from VC_OBSERVABILITY_RULES plus the detective's real file
  // reads, and persisted so a re-run applies the identical vocabulary.
  //
  // A hardcoded list used to live here: six regexes reverse-engineered from five sentences
  // in one fare-discount bug, carrying client-domain nouns. It reported "clean" on VCs that
  // plainly prescribed mechanism, because its vocabulary was about splitting and halving.
  //
  // NO VOCABULARY IS NOT "NOTHING TO FLAG". The caller must have aborted before reaching
  // here; returning [] would recreate the exact silence that hid the old guard.
  const flagged = applyVocabulary(vc, vocabulary).map((f) => ({ criterion: f.item, reason: f.reason }));
  if (storyId) {
    for (const f of flagged) {
      console.warn(`spec-mode: VC guard flagged mechanism in ${storyId} VC: [${f.reason}] "${String(f.criterion).slice(0, 80)}"`);
    }
  }
  return flagged;
}

// Conservative, guaranteed-mechanism-free fallback VC derived purely from the
// ticket symptom — the never-fail branch of the autonomous flag loop (no human).
//
// `findings` (optional): the code-graph-detective's fixSiteAnalysis, already
// available at the call site (runCodeGraphDetective runs BEFORE VC enforcement
// specifically so downstream stages can ground on it — see the comment at its
// call site). Before this fix, this was the one branch that never received it:
// the regenerate path threads `findings` into regenerateVcViaOpenspec's prompt,
// but the true last-resort fallback took only `story` (title/description) and
// produced pure boilerplate even when the detective had already located a real
// fix site with detailed reasoning, with zero reference to it in the persisted
// VCs. A bare file-path parenthetical (no verb, no mechanism) keeps this
// passing findVcMechanism — see vc-fallback-grounded-in-detective.test.ts.
function safeFallbackVc(story, findings) {
  const subject = String((story && (story.title || story.description)) || 'the behavior described in the ticket')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
  const located = Array.isArray(findings) ? findings.find((f) => f && f.file) : null;
  const locationNote = located ? ` (located near ${located.file}${located.function ? `, ${located.function}` : ''})` : '';
  return [
    `The behavior described in the ticket is observed to be correct after the change: "${subject}"${locationNote}.`,
    `Existing behavior related to this area is unchanged (no regression).`,
  ];
}

// Attribute each flag to the criterion it names, so a partly-flagged set can keep its
// clean criteria instead of being discarded whole.
//
// WHY. The enforcement loop was all-or-nothing: one surviving flag replaced every
// criterion with safeFallbackVc()'s two lines. Live 2026-08-04 (all three lanes) a set of
// six lost five clean, detective-grounded criteria to punish the sixth, and the writer got
// two tautologies that cannot fail.
//
// THE MAPPING IS THE REVIEWER'S OWN DECLARED FORMAT, not a guess. reviewVcViaSpeckit's
// prompt says: `Output ONLY a JSON array of short flag strings, e.g. ["VC 2 prescribes
// halving — ..."]`, and numbers the criteria `${i + 1}. ${v}` — so "VC <n>" is the
// contract and n is 1-based. findVcMechanism's flags instead carry the criterion text
// quoted (first 80 chars), so both forms are attributable.
//
// A flag matching NEITHER form is a set-level objection ("the criteria do not cover the
// acceptance criterion"). It names no criterion, so nothing can be safely retained:
// `unattributable` is reported and the caller falls back. Guessing there would let a real
// coverage gap through, which is the failure this guard exists to prevent.
function partitionFlaggedVc(vc, flags) {
  const list = Array.isArray(vc) ? vc : [];
  const drop = new Set();
  let unattributable = false;
  for (const f of (Array.isArray(flags) ? flags : [])) {
    const s = String(f || '');
    const byIndex = s.match(/\bVC\s*#?\s*(\d+)/i);
    if (byIndex) {
      const i = Number(byIndex[1]) - 1;                 // 1-based, as the prompt numbers them
      if (i >= 0 && i < list.length) { drop.add(i); continue; }
      unattributable = true;                            // out of range names no real criterion
      continue;
    }
    // The deterministic guard's form: the criterion itself, quoted and truncated.
    const quoted = s.match(/"([^"]{8,})"/);
    const idx = quoted ? list.findIndex((c) => String(c).startsWith(quoted[1])) : -1;
    if (idx >= 0) drop.add(idx); else unattributable = true;
  }
  if (unattributable) {
    return { clean: [], flagged: list.slice(), unattributable: true };
  }
  return {
    clean: list.filter((_, i) => !drop.has(i)),
    flagged: list.filter((_, i) => drop.has(i)),
    unattributable: false,
  };
}

// Enforce clean, mechanism-free VCs with an AUTONOMOUS loop (no human):
// deterministic guard + speckit strict review → if flagged, regenerate (with the
// flag reasons; the caller ladder-escalates the model per cycle) → re-check → up
// to maxCycles → if still flagged, a conservative safe-fallback VC. `regenerateVc`
// and `reviewVc` are injected so the orchestration is unit-testable without an LLM.
// Returns { vc, source: 'clean'|'regenerated'|'fallback', cycles, flags }.
// deriveGuardVocabulary — the guard-vocabulary agent, invoked at a guard seam.
//
// Replaces the literal term lists guards used to carry. See lib/guard-vocabulary.js for
// the full rationale; the short version is that a hardcoded list catches exactly the one
// incident it was built from while reporting "clean" forever.
//
// INPUTS ARE STATE-DEPENDENT AND MANDATORY. A guard agent that is not shown what the guard
// will actually check cannot derive anything real — it guesses from the ticket, which is
// how fabricated file contents entered the pipeline before. For the VC guard that means
// the criteria themselves AND the story's declared manifest, plus the detective's real
// file findings as ground truth. Callers at other seams must pass their own equivalents.
//
// Runs through runAgentForJson, so it inherits exactly what every other agent gets: model
// ladder escalation across attempts, retries, provider fallback and self-heal. Nothing
// about resilience is re-implemented here.
//
// Returns a normalised vocabulary, or null. NULL IS NOT "NOTHING TO FLAG" — callers must
// treat it as "the guard could not be armed" and say so loudly.
async function deriveGuardVocabulary({ promptExec, rule, statements, story, findings, manifestFiles, logDir, seam, repoPath, codegraphTool, referencedDocs }) {
  const _statements = (Array.isArray(statements) ? statements : []).filter(Boolean);
  if (!_statements.length) return null;

  const evidence = (Array.isArray(findings) ? findings : []).slice(0, 8)
    .map((f) => `- ${f.file || ''}${f.function ? ` :: ${f.function}` : ''}${f.reason ? ` — ${String(f.reason).slice(0, 300)}` : ''}${f.helper ? ` [existing helper: ${f.helper}]` : ''}`)
    .join('\n');
  const manifest = (Array.isArray(manifestFiles) ? manifestFiles : []).map((f) => `- ${f}`).join('\n');

  // DOCUMENTATION LINKED ON THIS TICKET — evidence for a judgement no rule can make.
  //
  // A term the vendor publishes is a contract, not a choice this team made, so flagging it as
  // "mechanism" deletes the sharpest criteria a story has. But that cuts only so far: on
  // 20260806T204217Z a criterion asserted that "the options object passed to
  // the SDK client constructor includes a live_preview key" — `live_preview` is in the vendor's
  // guide, and the assertion is still about the shape of an internal object rather than
  // anything observable. The reviewer said so and the spec gate halted the run at 0.68.
  //
  // Which of those two a criterion is doing requires reading it. A structural rule cannot
  // tell them apart, and a list of allowed words is the thing this pipeline does not do. So
  // the agent gets the documents and makes the call, with its reason recorded per term.
  const docBlock = (Array.isArray(referencedDocs) ? referencedDocs : [])
    .filter((d) => d && d.fetchStatus === 'fetched' && Array.isArray(d.quotes) && d.quotes.length)
    .map((d) => `- ${d.url}\n${d.quotes.map((q) => `    "${String(q).replace(/\s+/g, ' ')}"`).join('\n')}`)
    .join('\n');

  const profiles = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(automationDirFromLogDir(logDir), 'agents', 'profiles.json'), 'utf8'));
    } catch { return {}; }
  })();
  const persona = profiles['guard-vocabulary-agent'] || '';

  const prompt = `${persona ? persona + '\n\n' : ''}GUARD SEAM: ${seam || 'unspecified'}

THE RULE THIS GUARD ENFORCES:
${rule}

THE STATEMENTS THE GUARD WILL CHECK:
${_statements.map((c, i) => `${i + 1}. ${c}`).join('\n')}

DECLARED MANIFEST (the files this story says it will touch):
${manifest || '- (none declared)'}

${docBlock ? `DOCUMENTATION LINKED ON THIS TICKET (fetched and quoted verbatim — the vendor's published contract):
${docBlock}

A name that appears above is something the VENDOR publishes, not something this team chose.
Do NOT flag it when a statement uses it to describe OBSERVABLE behaviour — what a user or a
test can see happen. DO still flag it when the statement asserts the shape or contents of an
INTERNAL object, argument or call, even if the name itself is documented: that is an
implementation detail wearing a published name.

` : ''}CODE EVIDENCE (real findings from this repository — ground truth; derive from these, not from your own knowledge of any library):
${evidence || '- (none available)'}

STORY CONTEXT:
Title: ${(story && story.title) || ''}
Description: ${String((story && story.description) || '')}
${codegraphTool && repoPath ? `
VERIFY BEFORE YOU ANSWER — you have a real index of this repository.

  PROJECT_ROOT="${repoPath}" bash "${codegraphTool}" query <SymbolName>
  PROJECT_ROOT="${repoPath}" bash "${codegraphTool}" explore <terms>

Run it via Bash. A candidate term that resolves to NOTHING in this index is noise and
belongs in the blacklist, however unusual the word looks. Do not assert that a term is
meaningful — check it.

WHY THIS MATTERS HERE: the list you return feeds a BM25/IDF ranker. That ranker DEMOTES
terms which are common in the corpus and AMPLIFIES terms which are rare. So a rare,
meaningless token — a bracketed brand tag, a ticket label, a person's name — is not
diluted, it is promoted to a top discriminator and drags the search away from the real
code. Rare-and-meaningless is the failure mode you exist to prevent; do not mistake
rarity for signal.
` : ''}`;

  // Real tools when there is a repo to check against — the agent must VERIFY a candidate
  // term, not assert it. Inherits ladder/retry/self-heal from runAgentForJson like every
  // other agent; nothing about resilience is re-implemented here.
  const _repo = repoPath || resolveCodelinePath(story);
  // BIND THE SHAPE. This agent's answers came back as `submit_guard_vocabulary\n{...}` and
  // as `<tool_call>` markup on the live run of 2026-08-06 — unparseable, so the guard
  // reported "no usable terms after its full retry/ladder budget" and ABORTED the spec pass
  // on every lane. The guards are right to refuse to run unarmed; the answer should never
  // have been lost in the first place. The schema the agent is asked for is now the schema
  // the provider enforces, from the same object.
  const payload = await runAgentForJson(
    promptExec, prompt, TOOL_GUARD_VOCABULARY, 'GUARD_VOCABULARY',
    logDir ? path.join(logDir, `${(story && story.id) || 'phase'}-guard-vocabulary.log`) : null,
    null, (story && story.id) || '', _repo,
    { EPAM_RESPONSE_SCHEMA: schemaEnv(TOOL_GUARD_VOCABULARY),
      ...seamInvocationEnv('guard-vocabulary', logDir) },
  );
  if (!payload) return null;
  const vocab = normaliseVocabulary(payload);
  return isVocabularyUsable(vocab) ? vocab : null;
}

// ── DET-1: the estate survey — breadth before the roster ───────────────────
//
// The roster is minted from the ticket, the documents linked on it, and each codeline's
// declared dependencies. Nothing has looked at the CODE. Two live consequences: briefs named
// files the model believed should exist ("the Stack initialization module", proposed by a run
// that had searched for nothing), and scope came from ticket labels — AMSD-2041 is titled
// [GO, UP, MX] with four components, and nothing verified which codelines the work truly
// touches.
//
// The detective already answers both questions, but it runs inside the per-story spec pass,
// i.e. AFTER the roster it should inform. This is a cheap holistic pass that runs BEFORE.
//
// TWO OUTPUTS, STRUCTURALLY SEPARATE. Survey findings are evidence about the estate;
// recommendedInvestigators is a recommendation about the TEAM. A recommendation arriving in
// the same blob as evidence gets read as something discovered about the code.
//
// THE HARD CONSTRAINT: this agent reports ABOUT the estate. It may never supply a FIX SITE
// for a codeline. A finding today carries {file, function, reason, fix} and no codeline, so
// if this output could become one, four contamination routes open at once — a file found in
// codeline A entering B's writer manifest, checkFixSiteCoverage passing on another repo's
// evidence, locationHint pointing into the wrong repository, and reviewers rejecting correct
// work over a file that is a phantom there. The schema therefore has no such fields, and
// sanitizeSurvey() strips them if a model volunteers them anyway. Its remedy is always
// "investigate this codeline", never "here is the answer for it".
const SURVEY_STATES = ['in_scope', 'no_work_found', 'not_investigated', 'failed'];

// Fix-site vocabulary. Present so the sanitizer can PROVE the parent never emitted one —
// three states are not enough if a fourth arrives smuggled inside a survey entry.
const FIX_SITE_KEYS = ['file', 'files', 'function', 'fix', 'patch', 'locationHint', 'lineRange', 'diff'];

const TOOL_ESTATE_SURVEY = {
  name: 'submit_estate_survey',
  description:
    'Report which codelines of this estate the described work actually touches, and which ' +
    'per-codeline investigators the team needs. Breadth, not depth: you are deciding where ' +
    'to look, not what to change. Do not answer in prose.',
  parameters: {
    type: 'object',
    required: ['codelines', 'recommendedInvestigators'],
    properties: {
      codelines: {
        type: 'array',
        minItems: 1,
        description: 'One entry per codeline offered to you. Never omit one — silence is not a state.',
        items: {
          type: 'object',
          required: ['codeline', 'state', 'evidence', 'filesRead'],
          properties: {
            codeline: { type: 'string', description: 'Exactly as named in the scope list.' },
            state: {
              type: 'string',
              enum: SURVEY_STATES,
              description:
                'in_scope = you looked and the work reaches this codeline. no_work_found = you ' +
                'looked and it does not — that is EVIDENCE, and it is not the same as having ' +
                'skipped it. not_investigated = you did not look. failed = you tried and could ' +
                'not. Never report no_work_found for a codeline you did not open.',
            },
            evidence: {
              type: 'string',
              description:
                'What you actually checked and what you saw — a path you listed, a symbol you ' +
                'searched for. Not an inference from the ticket text.',
            },
            surfaces: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Areas of the repository involved: directories or modules. Breadth only. NOT a ' +
                'fix and NOT which file to change — deciding that is the per-codeline ' +
                'investigator\'s job, working in that repository.',
            },
            filesRead: {
              type: 'array',
              items: { type: 'string' },
              description:
                'The exact files you OPENED, as repository-relative paths. This is EVIDENCE — ' +
                'an observation of what is there, which a later check can verify — not a list ' +
                'of files to change. Report what you read even when you conclude the work does ' +
                'not reach this codeline.',
            },
          },
        },
      },
      recommendedInvestigators: {
        type: 'array',
        description:
          'Which codelines need their own investigator agent, and what each should concentrate ' +
          'on. A recommendation about the TEAM — deliberately not mixed into the findings above.',
        items: {
          type: 'object',
          required: ['codeline', 'focus', 'why'],
          properties: {
            codeline: { type: 'string' },
            focus: { type: 'string', description: 'What this investigator should concentrate on.' },
            why: { type: 'string', description: 'What you saw that makes this codeline need one.' },
          },
        },
      },
    },
  },
};

/**
 * sanitizeSurvey — enforce the parent/child boundary in code, not in the prompt.
 *
 * Returns { codelines, recommendedInvestigators, violations }. Any fix-site-shaped key on a
 * survey entry is REMOVED and recorded: the parent may report about an investigation, never
 * supply findings for a codeline it did not investigate. A codeline that was offered but not
 * reported is filled in as not_investigated — an absent entry must never read as a clean bill
 * of health, which is the whole reason "no_work_found" and "not_investigated" are different.
 */
function sanitizeSurvey(payload, codelines) {
  const offered = (Array.isArray(codelines) ? codelines : [])
    .map((c) => (typeof c === 'string' ? c : c && c.name))
    .filter(Boolean);
  const violations = [];
  const byName = new Map();

  for (const raw of (payload && Array.isArray(payload.codelines) ? payload.codelines : [])) {
    if (!raw || typeof raw.codeline !== 'string') continue;
    // A codeline the survey invented is not a codeline. Reporting on a repository that is not
    // in scope is the same contamination as reporting a file from the wrong one.
    if (offered.length && !offered.includes(raw.codeline)) {
      violations.push(`survey reported on "${raw.codeline}", which is not in scope`);
      continue;
    }
    const stripped = FIX_SITE_KEYS.filter((k) => raw[k] !== undefined);
    if (stripped.length) {
      violations.push(
        `survey entry for "${raw.codeline}" carried fix-site field(s) ${stripped.join(', ')} — ` +
        'the estate survey reports WHERE TO LOOK, never what to change; dropped');
    }
    const _state = SURVEY_STATES.includes(raw.state) ? raw.state : 'not_investigated';
    const _read = Array.isArray(raw.filesRead)
      ? raw.filesRead.filter((f) => typeof f === 'string' && f.trim())
      : [];
    byName.set(raw.codeline, {
      codeline: raw.codeline,
      state: _state,
      evidence: typeof raw.evidence === 'string' ? raw.evidence : '',
      surfaces: Array.isArray(raw.surfaces) ? raw.surfaces.filter((s) => typeof s === 'string') : [],
      // Evidence, kept separate from breadth: a directory exists in every codeline and proves
      // nothing about any of them, so a brief grounded on one cannot really be checked.
      filesRead: _read,
      // An in_scope claim with nothing opened is an assertion, not an observation. Looking and
      // finding nothing (no_work_found) is a real answer and is NOT flagged; neither is
      // not_investigated, which never claimed to have looked.
      evidenceGap: _state === 'in_scope' && _read.length === 0,
    });
  }

  // Silence is not a state. Anything offered and unreported is explicitly not_investigated.
  for (const name of offered) {
    if (!byName.has(name)) {
      byName.set(name, {
        codeline: name, state: 'not_investigated',
        evidence: 'the survey returned no entry for this codeline', surfaces: [], filesRead: [],
      });
    }
  }

  const recommendedInvestigators =
    (payload && Array.isArray(payload.recommendedInvestigators) ? payload.recommendedInvestigators : [])
      .filter((r) => r && typeof r.codeline === 'string'
        && (!offered.length || offered.includes(r.codeline)))
      .map((r) => ({
        codeline: r.codeline,
        focus: typeof r.focus === 'string' ? r.focus : '',
        why: typeof r.why === 'string' ? r.why : '',
      }));

  return { codelines: [...byName.values()], recommendedInvestigators, violations };
}

/**
 * surveyEstate — the holistic pass that runs BEFORE the roster.
 *
 * Runs through runAgentForJson like every other agent, so it inherits the ladder, retries,
 * self-heal, timeout profile and cost capture. Read tools are granted over the estate root so
 * it can VERIFY rather than infer — that grant is the entire point of running it at all.
 *
 * Cheap by construction: it decides WHERE to look. Deep investigation is then skipped for the
 * codelines it reports as no_work_found, which is what keeps investigations from scaling as
 * codelines x stories.
 *
 * A failure here must never stop the run. An estate that could not be surveyed is an estate
 * the roster is minted without — exactly the state before this existed — so the caller gets
 * an all-'failed' survey and proceeds, with the reason recorded.
 */
/**
 * The estate-survey prompt, built where a test can execute it.
 *
 * Extracted for the same reason as buildAssignmentPrompt: this prompt's defect was in its own
 * wording — it forbade naming a file at all, conflating evidence with prescription — and no
 * test could see that while the string was welded inside a 150-line function.
 */
function buildSurveyPrompt({ codelines, tickets, referencedDocs, declaredDependencies } = {}) {
  const _cls = (Array.isArray(codelines) ? codelines : []).filter(Boolean);
  const _named = _cls.map((c) => (typeof c === 'string' ? { name: c } : c)).filter((c) => c && c.name);
  const ticketBlock = (Array.isArray(tickets) ? tickets : []).map((t) =>
    // WHOLE, never clipped. In brownfield the description is the only source of the
    // verification criteria — cutting it removes the contract and the agent invents the rest.
    // It was once cut at five different lengths across the pipeline; there is a guard test.
    `- ${t.jiraKey || t.id || '(no key)'}: ${t.title || ''}\n    ${String(t.description || '').replace(/\s+/g, ' ')}`
  ).join('\n');

  // A FETCHED DOCUMENT IS {url, fetchStatus, path} — THE TEXT IS ON DISK.
  //
  // Live 2026-08-08: both vendor documents on AMSD-2041 arrived here with no quotes and no
  // inline body, so this rendered a URL and a blank line and the surveyor was handed nothing.
  // mintProjectAgents already reads d.path; this did not. Empty documents are exactly what
  // led a mint to invent a vendor on 2026-08-07.
  const docBlock = (Array.isArray(referencedDocs) ? referencedDocs : []).map((d) => {
    if (Array.isArray(d.quotes) && d.quotes.length) {
      return `- ${d.url || '(no url)'} [${d.fetchStatus || 'unknown'}]\n` +
        d.quotes.map((q) => `      "${String(q).replace(/\s+/g, ' ')}"`).join('\n');
    }
    let body = typeof d.body === 'string' ? d.body : '';
    if (!body && d.path) { try { body = fs.readFileSync(d.path, 'utf8'); } catch { body = ''; } }
    // Not truncated: this is the vendor's published contract, and a cut copy is how an agent
    // ends up inferring the rest.
    return body
      ? `- ${d.url || '(no url)'} [${d.fetchStatus || 'unknown'}]\n${body}`
      : `- ${d.url || '(no url)'} (retrieved, no readable text)`;
  }).join('\n\n');

  // declaredDependencies is a FLAT ARRAY of package names, the union across the estate — the
  // same value mintProjectAgents receives and renders as a list. Enumerating it with
  // Object.entries produced "- 0: (none declared)" through "- 9:" on 2026-08-08, so the
  // surveyor got zero dependency facts about an estate whose ticket turns entirely on which
  // CMS packages are declared.
  const depBlock = (Array.isArray(declaredDependencies) ? declaredDependencies : [])
    .map((d) => `- ${d}`).join('\n');

  return `You are surveying an estate of repositories BEFORE its agent team is assembled.

THE WORK (real tickets from the tracker):
${ticketBlock || '- (no tickets available)'}

${docBlock ? `DOCUMENTS LINKED ON THOSE TICKETS:\n${docBlock}\n` : ''}
${depBlock ? `WHAT EACH CODELINE DECLARES IT DEPENDS ON (its own manifest — ground truth about\nthe stack, not inference from ticket text):\n${depBlock}\n` : ''}
THE CODELINES IN SCOPE, and where each is checked out:
${_named.map((c) => `- ${c.name}: ${c.path || '(path unknown)'}`).join('\n')}

HOW TO LOOK — USE THE SYMBOL INDEX, NOT TEXT SEARCH.

Every codeline above is already indexed in CodeGraph. Use codegraph_query as your PRIMARY
instrument, and call it iteratively — 5-10 calls is normal:
  - codegraph_query explore "<domain nouns from the ticket>"  — START HERE, per codeline
  - codegraph_query query|callers|callees "<symbol>"          — trace what explore surfaced
  - codegraph_query show "<file> [start] [end]"               — read the real lines before
                                                                quoting anything as evidence
It returns real symbols, their definition sites, who calls them, and which have tests. That is
the question you are actually asking: where does this codeline wire the thing the ticket is
about. Text search cannot answer it and ranks a vendored copy of a package alongside the one
line that initialises it.

Reserve 'search' for what a symbol index cannot hold — a config key, an environment variable
name, a literal string. Then treat its result with suspicion:

  A SEARCH THAT RETURNS NOTHING IS NOT EVIDENCE THAT NOTHING IS THERE.

On 2026-08-08 this survey reported "searched for seven patterns, all returned zero matches, no
existing infrastructure was found, meaning this is greenfield work" about three codelines
holding 243, 102 and 158 matching source files. The search tool was silently broken and every
call returned "(no matches found)". The reasoning was sound and the premise was false. If a
search comes back empty, confirm with codegraph_query before concluding absence — and if the
two disagree, say so in your evidence rather than picking one.

YOUR JOB, and its limits:

1. For EVERY codeline above, OPEN IT and decide whether this work reaches it. The ticket's
   labels and components are a claim, not evidence — they are frequently wrong about which
   repositories are involved, which is why you exist. Report what you actually looked at.

2. "I looked and this work does not reach this codeline" is a VALUABLE answer. Report it as
   no_work_found, with the evidence. It is not the same as not having looked, and reporting
   the two as one is how an unexamined repository comes to read as a clean bill of health.

3. Recommend which codelines need their own investigator agent, and what each should focus on.
   Keep that recommendation OUT of your findings: findings are what you saw, recommendations
   are about the team.

REPORT THE EXACT FILES YOU OPENED, in "filesRead". If you report a codeline as in_scope you
must name AT LEAST ONE FILE you opened in it: saying the work reaches a repository you did not
read is an assertion, and an assertion of exactly that kind produced "no existing
infrastructure, this is greenfield work" about an estate with 243 matching source files.
Looking and finding nothing is different, and is a valuable answer — report that as
no_work_found with what you read. A directory tells a later reader almost
nothing — src/context/ exists in most codelines — and a claim about it cannot be checked. A
file path can be verified, and a brief built on one is grounded. Report what you read even
where you conclude the work does not reach that codeline.

WHAT YOU MUST NOT DO. You are not fixing anything and you are not choosing files to change.
Do not say which file to edit, which function to patch, or what the change should be. Naming a
file as something you READ is evidence and is wanted; naming one as the place to fix is a
decision that is not yours. Each codeline gets its own investigator working inside that
repository, and it decides. A fix site you supply for a repository you swept from the outside
is how one codeline's file ends up in another's work — so report what you saw, state where to
look, and let the investigator look.

Respond with ONLY valid JSON (no markdown fences, no report, no commentary before or after):
{
  "codelines": [
    {
      "codeline": "<exactly as named in scope above>",
      "state": "in_scope | no_work_found | not_investigated | failed",
      "evidence": "<what you opened and what you saw>",
      "surfaces": ["<directory or module>"],
      "filesRead": ["<exact path of a file you opened>"]
    }
  ],
  "recommendedInvestigators": [
    { "codeline": "<name>", "focus": "<what it should concentrate on>", "why": "<what you saw>" }
  ]
}

One entry in "codelines" for EVERY codeline listed in scope. Everything you want to say goes
inside these fields — a prose report outside this JSON is discarded unread, however good it is.`;
}

async function surveyEstate({
  promptExec, tickets, referencedDocs, codelines, logDir, repoPath, toolGrant, declaredDependencies,
}) {
  const _cls = (Array.isArray(codelines) ? codelines : []).filter(Boolean);
  const _named = _cls.map((c) => (typeof c === 'string' ? { name: c } : c)).filter((c) => c && c.name);
  if (!_named.length) return { codelines: [], recommendedInvestigators: [], violations: [], ran: false };

  const prompt = buildSurveyPrompt({ codelines: _named, tickets, referencedDocs, declaredDependencies });

  const _env = { EPAM_AGENT_NAME: 'estate-surveyor', EPAM_SEAM: 'estate-survey' };
  if (toolGrant) {
    _env.AI_GATE_ALLOW_TOOLS = '1';
    _env.EPAM_ALLOWED_TOOLS = toolGrant;
  }
  // Scaled to the number of codelines this survey must open. specAgentEnv's flat ceiling of 8
  // is a single-codeline budget; applied to an estate it produced a "greenfield" verdict about
  // a brownfield estate because the sweep could not finish. See surveyToolBudget.
  _env.EPAM_MAX_TOOL_CALLS = surveyToolBudget(_named, process.env);

  let payload = null;
  try {
    payload = await runAgentForJson(
      promptExec, prompt, TOOL_ESTATE_SURVEY, 'ESTATE_SURVEY',
      logDir ? path.join(logDir, 'estate-survey.log') : null,
      null, '', repoPath || '', _env,
    );
  } catch (err) {
    // Never fatal: the roster was minted without any of this until today.
    const reason = `estate survey failed: ${err && err.message}`;
    process.stderr && process.stderr.write(`[survey] ${reason}\n`);
    return {
      codelines: _named.map((c) => ({ codeline: c.name, state: 'failed', evidence: reason, surfaces: [] })),
      recommendedInvestigators: [], violations: [], ran: false, error: String(err && err.message),
    };
  }

  const clean = sanitizeSurvey(payload, _named);
  const result = { ...clean, ran: true };

  // Persisted at generation time. What the roster was grounded in has to outlive the process
  // that produced it, or the pause has nothing to show and a later run cannot tell whether a
  // codeline was cleared or simply skipped.
  if (logDir) {
    try {
      fs.writeFileSync(path.join(logDir, 'estate-survey.json'), JSON.stringify(result, null, 2));
    } catch { /* the run must not die for want of an audit file */ }
  }
  return result;
}

// ── Project agent roster ───────────────────────────────────────────────────
//
// The shape of a proposal. The SDK's proposeAgents() asks for exactly these three fields;
// this binds them so the answer arrives parsed instead of as prose the pipeline has to
// guess at (the failure that lost the guard-vocabulary answer on 2026-08-06).
const TOOL_PROJECT_AGENTS = {
  name: 'submit_project_agents',
  description:
    'Propose the project-specific engineering agent roles this codeline needs, on top of ' +
    'the canonical core. One role per distinct domain of the project. Do not answer in prose.',
  parameters: {
    type: 'object',
    required: ['proposedAgents'],
    properties: {
      proposedAgents: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['name', 'kind', 'codeline', 'systemPrompt', 'rationale'],
          properties: {
            name: { type: 'string', description: 'kebab-case role name, e.g. "<domain>-engineer"' },
            kind: {
              type: 'string',
              enum: ['implementer', 'investigator'],
              description:
                'implementer = authors code and can own a story. investigator = reads code and ' +
                'reports what is there; never writes, never owns a story.',
            },
            codeline: {
              type: 'string',
              description:
                'ALWAYS required. For an investigator: the ONE codeline it investigates, named ' +
                'exactly as listed in scope above — the lane looks its investigator up by codeline ' +
                'and cannot find one that names none. For an implementer, which spans the project, ' +
                'use "*". Never leave it out: a proposal without it is rejected.',
            },
            systemPrompt: {
              type: 'string',
              description:
                "The role's full briefing: its expertise, the conventions of THIS codeline, the " +
                'files and directories it owns, the patterns it follows and the tools it uses.',
            },
            rationale: {
              type: 'string',
              // THE PROMPT IS THE CONTRACT. mergeProjectAgents refuses a rationale carrying
              // fewer than EPAM_ROSTER_RATIONALE_MIN_CHARS letters/digits, so the model is told
              // that here rather than discovering it as a rejection. Live 2026-08-07: all five
              // agents came back with "...", which satisfied "required" and said nothing.
              description:
                'One sentence: why THIS project needs THIS role, referring to something stated ' +
                'in the ticket, the documents or the declared dependencies above. A placeholder ' +
                `("...", "-", "n/a") is refused, as is anything under ` +
                `${Number(process.env.EPAM_ROSTER_RATIONALE_MIN_CHARS || '24')} letters and ` +
                'digits. This is what a human reads when reviewing the roster before it is ' +
                'given any work.',
            },
          },
        },
      },
    },
  },
};

/**
 * mintProjectAgents — derive this project's own engineering roles, and wire them in.
 *
 * WHY IT RUNS HERE, THROUGH THIS SEAM. proposeAgents() in the SDK calls an LLMProvider
 * directly. That is correct for `epam new`, where a human is watching the output, and wrong
 * here: it would put the single call that decides the whole roster outside the invocation
 * gateway — no ladder, no retry, no self-heal, no timeout budget, no cost capture. The one
 * agent whose failure silently degrades every downstream agent would be the only agent with
 * no resilience. So the SDK's PROMPT is reused verbatim (single definition of what a project
 * role is) and driven through runAgentForJson, exactly like deriveGuardVocabulary.
 *
 * WHY IT RUNS AFTER INGEST. The inputs that make a role project-specific rather than a
 * restatement of the canonical core are the tickets and the documents linked on them. Both
 * exist only once ingest has run. A proposer given just a repo path proposes generic roles.
 *
 * Read tools are granted (repoPath) so the proposer can VERIFY the codeline's shape instead
 * of asserting it from the ticket text alone.
 */
/**
 * One survey entry, as the minter sees it.
 *
 * filesRead is rendered SEPARATELY from areas because they carry different weight: an area is
 * breadth ("src/context/ is involved") and a file is an observation the reader can verify. A
 * field collected and never shown is inert — this pipeline has produced several — so the
 * rendering is here, where a test executes it.
 */
function surveyLineFor(c) {
  const areas = c.surfaces && c.surfaces.length ? ` — areas: ${c.surfaces.join(', ')}` : '';
  const read = c.filesRead && c.filesRead.length
    ? `\n    files it opened: ${c.filesRead.join(', ')}`
    : (c.evidenceGap ? '\n    files it opened: NONE — in scope is asserted, not observed here' : '');
  return `- ${c.codeline}: ${c.state}${areas}${read}\n    evidence: ${String(c.evidence || '').replace(/\s+/g, ' ')}`;
}

/**
 * The mint tally, reconciled so every proposal lands in exactly one bucket.
 *
 * The mint retries when proposals are refused. Across attempts `minted` and `unchanged`
 * accumulate but `rejected` was replaced by the last attempt's list, so a proposal refused on
 * attempt 1 and corrected on attempt 2 was counted in `proposed`, counted again in `minted`,
 * and its rejection erased. Three consecutive runs printed a tally with a silent remainder
 * (6/3/0/1, 8/5/0/0, 7/5/0/0) — the roster was right each time, the account of how it was
 * reached was not, and the missing numbers sent me looking for agents that had never gone
 * missing.
 *
 * `unaccounted` is reported rather than absorbed: padding a bucket to make the line add up
 * would recreate the same defect more quietly.
 */
function reconcileMintTally(r) {
  const res = r || {};
  const len = (x) => (Array.isArray(x) ? x.length : 0);
  const proposed = Number.isFinite(res.proposed) ? res.proposed : 0;
  const minted = len(res.minted);
  const unchanged = len(res.unchanged);
  const rejected = len(res.rejected);
  // Refused at some point, but not still refused: corrected on a later attempt.
  const stillRejected = new Set((res.rejected || []).map((x) => x && x.name));
  const superseded = (res.rejectedAcrossAttempts || [])
    .filter((x) => x && !stillRejected.has(x.name)).length;
  const unaccounted = Math.max(0, proposed - minted - unchanged - rejected - superseded);
  return { proposed, minted, unchanged, rejected, superseded, unaccounted };
}

async function mintProjectAgents({
  promptExec, tickets, referencedDocs, profilesPath, agentsDir, logDir, repoPath,
  declaredDependencies, codelines, toolGrant, correctiveFindings, retainedAgents, estateSurvey,
}) {
  const { mergeProjectAgents } = require('./lib/agent-roster.js');

  let basePrompt = '';
  let fixedRoles = [];
  try {
    const sdk = require(path.join(automationDirFromLogDir(logDir), '..', 'dist', 'sdk.js'));
    basePrompt = sdk.getAgentProposalPrompt();
    fixedRoles = sdk.FIXED_AGENT_ROLES || [];
  } catch (_) {
    try {
      const sdk = require(path.join(__dirname, '..', '..', 'dist', 'sdk.js'));
      basePrompt = sdk.getAgentProposalPrompt();
      fixedRoles = sdk.FIXED_AGENT_ROLES || [];
    } catch (e) {
      // Loud. Minting silently from a locally-invented prompt would produce a roster that
      // looks right and was derived from different instructions than the scaffold path.
      throw new Error(`[mint] cannot load the agent proposal prompt from dist/sdk.js: ${e && e.message}`);
    }
  }

  const ticketBlock = (Array.isArray(tickets) ? tickets : []).map((t) => {
    const comps = Array.isArray(t.components) && t.components.length ? `\nComponents: ${t.components.join(', ')}` : '';
    // THE LINK IS EVIDENCE EVEN WHEN THE FETCH FAILED. Live 2026-08-07: both linked documents
    // came back empty, so they were dropped entirely — and the URLs themselves named the
    // vendor the tickets never mentioned. The mint then invented a different one.
    const links = (Array.isArray(t.ticketLinks) ? t.ticketLinks : [])
      .map((l) => (typeof l === 'string' ? l : (l && l.url)))
      .filter(Boolean);
    const linkLine = links.length ? `\n  Links on this ticket: ${links.join(' , ')}` : '';
    return `- ${t.jiraKey || t.id || ''}: ${t.title || ''}${comps}\n  ${String(t.description || '').replace(/\s+/g, ' ')}${linkLine}`;
  }).join('\n');

  // The vendor's own published contract, quoted verbatim by the link agent. This is the
  // sharpest signal about which domains this work actually spans.
  // QUOTES OR THE DOCUMENT ITSELF.
  //
  // This required d.quotes, which only the ticket-link AGENT produces — it runs in the spec
  // pass, after this. fetchTicketDocuments returns {url, fetchStatus, path} and no quotes, so
  // every successfully fetched document was filtered straight back out: 25KB of vendor
  // documentation retrieved, named the real product, and reached the proposer as nothing.
  // Verified before the run rather than discovered by it.
  const docBlock = (Array.isArray(referencedDocs) ? referencedDocs : [])
    .filter((d) => d && d.fetchStatus === 'fetched')
    .map((d) => {
      if (Array.isArray(d.quotes) && d.quotes.length) {
        return `- ${d.url}\n${d.quotes.map((q) => `    "${String(q).replace(/\s+/g, ' ')}"`).join('\n')}`;
      }
      // Not truncated: this is the authoritative statement of what the work involves, and a
      // cut copy is how a proposer ends up inferring the rest.
      let body = typeof d.body === 'string' ? d.body : '';
      if (!body && d.path) { try { body = fs.readFileSync(d.path, 'utf8'); } catch { body = ''; } }
      return body ? `- ${d.url}\n${body}` : `- ${d.url} (retrieved, no readable text)`;
    })
    .join('\n\n');

  // WHAT THE CODELINE DECLARES IT USES. Ground truth about the stack, and the correction for
  // a specific live failure: on 2026-08-07 the tickets said only "CMS", both linked documents
  // came back empty, and the repo path given was the estate root rather than a repository —
  // so the mint invented a vendor and briefed every role on the wrong product's APIs.
  const depBlock = (Array.isArray(declaredDependencies) ? declaredDependencies : [])
    .slice(0, 300).map((d) => `- ${d}`).join('\n');

  // ONE ROSTER, ALL CODELINES. The first mint saw a single repository while three were in
  // scope, and wrote that one repository's absolute path into every brief.
  const _cls = Array.isArray(codelines) && codelines.length
    ? codelines
    : (repoPath ? [{ name: '', path: repoPath, dependencies: declaredDependencies }] : []);
  const codelineBlock = _cls.length
    ? `THE CODELINES IN SCOPE (${_cls.length}) — one roster covers all of them:\n` + _cls.map((c) => {
        const d = Array.isArray(c.dependencies) ? c.dependencies : [];
        return `- ${c.name || '(unnamed)'}  at ${c.path}\n` + (d.length
          ? `    declares: ${d.join(', ')}`
          : '    declares: (no manifest configuration for this codeline — no dependency evidence)');
      }).join('\n')
    : 'THE CODELINES IN SCOPE: (none resolved)';

  // A CORRECTIVE PASS IS TOLD WHAT WAS WRONG, IN THE REVIEWER'S OWN WORDS.
  //
  // Not "try again" — the previous roster was confident and specific, and a re-proposal with no
  // account of the defect tends to reproduce it in new wording. Each finding carries the claim,
  // what was checked and what was found, so the correction has the evidence rather than a verdict.
  const _cf = Array.isArray(correctiveFindings) ? correctiveFindings : [];
  const correctiveBlock = _cf.length
    ? ['A PREVIOUS ROSTER FOR THIS PROJECT WAS REVIEWED AND REJECTED. These defects were found by',
       'checking the briefs against the repositories themselves. Do not repeat them, and do not',
       'merely reword them — a convention that is true of some codelines and not others must be',
       'stated only for the ones that hold it, or not stated at all:',
       '',
       ..._cf.map((f) => [
         `- ${f.agent || '(unnamed role)'} claimed: "${String(f.claim || '').replace(/\s+/g, ' ')}"`,
         `    checked: ${String(f.checked || '').replace(/\s+/g, ' ')}`,
         `    found:   ${String(f.found || '').replace(/\s+/g, ' ')}`,
         f.remedy ? `    remedy:  ${String(f.remedy).replace(/\s+/g, ' ')}` : '',
       ].filter(Boolean).join('\n')),
       ''].join('\n')
    : '';

  // WHAT THE CORRECTION IS KEEPING. A targeted correction replaces only the indicted briefs,
  // so the roles that survived are already in the roster — and a proposer not told about them
  // re-proposes the same coverage under a new name. mergeProjectAgents is convergent and would
  // refuse the duplicate, but the proposal budget is spent either way and the real gap goes
  // uncovered. Naming them also lets the correction position its replacement against what
  // already exists rather than overlapping it.
  const _ra = Array.isArray(retainedAgents) ? retainedAgents.filter((a) => a && a.name) : [];
  const retainedBlock = _ra.length
    ? ['THESE ROLES ALREADY EXIST IN THIS ROSTER AND ARE BEING KEPT — they passed review. Do NOT',
       'propose them again, and do not propose a role whose remit overlaps one of them. Propose',
       'only what is missing or what replaces a defect named above:',
       ..._ra.map((a) => `- ${a.name}${a.codeline && a.codeline !== '*' ? ` (codeline: ${a.codeline})` : ''}` +
                         `${a.rationale ? ` — ${String(a.rationale).replace(/\s+/g, ' ')}` : ''}`),
       ''].join('\n')
    : '';

  // WHAT THE SURVEY ACTUALLY FOUND IN THE CODE (DET-1).
  //
  // The two halves stay separated exactly as the surveyor emitted them: evidence about the
  // estate, and a recommendation about the team. Merged into one block they read as one kind
  // of thing, and a recommendation would be inherited as a discovery.
  //
  // This is the only input here derived from opening the repositories. Everything else — the
  // ticket, its documents, the declared dependencies — is a claim about the code rather than
  // an observation of it, which is how briefs came to name modules that do not exist.
  const _sv = estateSurvey && Array.isArray(estateSurvey.codelines) ? estateSurvey : null;
  const _svLines = _sv ? _sv.codelines.map(surveyLineFor) : [];
  const surveyBlock = _svLines.length
    ? ['WHAT A SURVEY OF THESE REPOSITORIES REPORTED. These are LEADS, not settled facts.',
       '',
       'A single pass swept the whole estate with limited tools, and it has been wrong: on',
       '2026-08-08 it reported that a repository contained no reference to a package that its',
       'own source uses in twenty files, and a roster was minted on that. Treat every line',
       'below as what the survey BELIEVES, to be confirmed by the investigator that owns the',
       'codeline. Do NOT restate any of it in a brief as established, verified, or confirmed —',
       'a brief is inherited whole and re-checked by nothing, so a wrong lead written as a fact',
       'becomes an instruction.',
       '',
       'Propose roles for the codelines the work appears to REACH. A codeline reported',
       'no_work_found is not confirmed clear, and one reported not_investigated or failed was',
       'not established either way — do not treat any of the three as proof about that repo:',
       '',
       ..._svLines,
       '',
       ...(_sv.recommendedInvestigators.length
         ? ['SEPARATELY — and this is a recommendation about the TEAM, not something discovered',
            'about the code: a survey of the estate suggests these codelines need their own',
            'investigator. Propose one per codeline named here, with the stated focus:',
            '',
            ..._sv.recommendedInvestigators.map((r) =>
              `- ${r.codeline}: focus on ${String(r.focus || '').replace(/\s+/g, ' ')}` +
              `${r.why ? ` (because ${String(r.why).replace(/\s+/g, ' ')})` : ''}`),
            '']
         : [])].join('\n')
    : '';

  // WHO OWNS THE TESTS. The roster does not, and a brief that says otherwise is inherited
  // whole by an implementer that is simultaneously forbidden from writing tests.
  //
  // Live AMSD-2041: a minted brief read "You write Jest tests using ts-jest... Test files are
  // colocated alongside the modules you edit", while the writer seam told that same agent
  // "Do NOT write, edit, or create any test file". One agent, two contradictory instructions,
  // and six consecutive quality failures were once spent fighting a test the implementer
  // should never have written. Authorship belongs to a pipeline SEAM (repro-test-writer),
  // which takes its own turn after the fix commits — not to any role proposed here.
  //
  // Stated as a rule about this pipeline, naming no framework and no file convention: which
  // tools a project tests with is the project's business, and this says nothing about it.
  // A BRIEF MAY NOT ASSERT A VENDOR'S API AS ITS OWN KNOWLEDGE.
  //
  // On 2026-08-03 a brief stated which token key a vendor's API accepts, in the form "use X,
  // NOT Y". The claim was invented, contradicted the installed package's own types, and made a
  // reviewer reject correct work across three codelines. On 2026-08-08 a minted brief said
  // "preview_token (not management_token)" and named a concrete API host — the same shape,
  // reached again by a different route, and caught by the shipped-config guard.
  //
  // A brief is inherited WHOLE and is not re-checked against anything, so an invented API
  // detail in one becomes an instruction. What a repository declares is verifiable and welcome;
  // what a remote API accepts is not, unless a fetched document says so and is credited.
  const vendorClaimRule = [
    'WHAT YOU MAY STATE AS FACT.',
    '',
    'What a repository contains or declares — you or a survey read it, and the next agent can',
    'read it too. State it freely.',
    '',
    'What an external API, SDK or service accepts — its option names, field names, endpoints,',
    'hosts, token kinds — you may NOT state as your own knowledge. If a document quoted above',
    'says it, attribute it ("the linked documentation states..."). Otherwise instruct the role',
    'to verify it against the installed package before relying on it.',
    '',
    'Never write that one API key, field or option is correct and another is wrong. A claim of',
    'that shape is inherited as an instruction, is not re-checked by anything, and has already',
    'caused correct work to be rejected across three codelines.',
    '',
  ].join('\n');

  const testOwnershipRule = [
    'WHO WRITES THE TESTS — NOT THESE ROLES.',
    '',
    'A dedicated agent of this pipeline writes the tests. It takes its own turn after the fix',
    'is committed and owns the reproducing test, and the roles you propose are separately',
    'FORBIDDEN from creating or editing any test file.',
    '',
    'So: do not propose a test-writing, QA or test-automation role — that work is already owned.',
    'And a brief must not say the role writes, owns, colocates or maintains tests, in any words.',
    'A role whose brief claims test authorship is handed two contradictory instructions and',
    'spends its turns fighting itself. Describe what the role BUILDS.',
    '',
  ].join('\n');

  const prompt = `${correctiveBlock}${retainedBlock}${surveyBlock}${vendorClaimRule}${testOwnershipRule}${basePrompt}

THE WORK THIS PROJECT HAS BEEN ASKED TO DO (real tickets from the tracker):
${ticketBlock || '- (no tickets available)'}

${depBlock ? `WHAT THIS CODELINE DECLARES IT DEPENDS ON (from its own manifest — ground truth
about the stack, not inference from the ticket text). Where a ticket names a category
generically, these names say which product is actually in use. Do NOT propose a role built
around a product that does not appear here:
${depBlock}

` : ''}
${docBlock ? `DOCUMENTATION LINKED ON THESE TICKETS (fetched, quoted verbatim — the vendor's published contract):
${docBlock}

` : ''}${codelineBlock}
${toolGrant ? `You have READ-ONLY tools (${toolGrant}). Use them: open the manifests, find the modules
this work touches, and VERIFY any API or package you are about to name in a brief actually
exists in these repositories. A vendor's documentation describes its current product; these
codelines pin the versions they pin, and where the two disagree the repository wins. A brief
that names a symbol the installed package does not export sends an implementer to write code
against something that is not there.` : `You have NO tools on this call — you cannot open these
repositories. Reason only from what is written above, and say in the rationale when a claim
rests on documentation rather than on this codebase.`}

Propose ONE roster for the project as a whole: roles for the
domains this work and these codebases actually span, not the domains you would expect a
project like this to have. Where the codelines share a stack, one role covers all of them —
do not mint near-duplicate roles per codeline.

Write each brief so it stays true wherever the project is checked out. Refer to a codeline by
its NAME, exactly as listed above, and to locations inside it by paths relative to its root.

Never identify a codeline by POSITION — not "the first", not "the second", not "the one listed
above". The order codelines are listed in is not stable between runs, so a brief written that
way points at a different repository the moment the order changes, and nothing detects it: the
sentence still reads correctly. Never write an absolute filesystem path either; it is specific
to one machine. A name is the only reference that stays true.

A brief may only rely on what the codelines actually declare above. If the work plainly needs
something that is not declared, say so in the rationale rather than assuming it is present.

EVERY ROLE MUST BE ABLE TO AUTHOR CODE. Each brief must name the files or directories, relative
to a codeline root, that the role edits. A role whose work happens only in a vendor's web
console, or only in prose, cannot implement a story: this pipeline's agents change files in a
repository, and a story assigned to such a role produces a configuration note and no working
software. If part of the work genuinely is console-only, that belongs in one role's brief as
context it must WRITE CODE around — never as a role of its own.

TEST RESPONSIBILITY MUST BE OWNED, EXPLICITLY. Say in the brief, for whichever role owns it,
how this codeline's tests are written: where test files live, how they are named, and which
runner executes them — taken from what the codelines declare above, not from habit. Work with
no named owner for its tests arrives at review untested and cannot be approved.

PROPOSE TWO CLASSES OF AGENT.

IMPLEMENTERS (kind: "implementer") author code, as described above. One roster of them spans
every codeline.

Every proposal states a "codeline". An implementer spans the project and uses "*". An
investigator names the ONE codeline it reads, exactly as spelled in scope above. There is no
third option and no omitting it.

INVESTIGATORS (kind: "investigator") read code and report what is there — they never write and
never own a story. Propose EXACTLY ONE per codeline listed in scope. Its brief should describe how to find things
in THAT codebase: where the modules relevant to this work live, what the layout and naming
conventions are, and which of its declared dependencies matter here. An investigator that
merely restates the ticket adds nothing — its value is knowing one repository well.

Keep each investigator to its own codeline. It reports on the repository it was briefed for and
says nothing about the others; a claim about a repository it has not read is a guess wearing the
authority of an investigation.

Do not propose a role that duplicates one of the canonical roles already listed above.`;

  // TOOLS, OR THE INSTRUCTION TO READ IS A LIE.
  //
  // This ran with no tools at all: ai-run.sh forces --no-tools unless AI_GATE_ALLOW_TOOLS=1,
  // and only EPAM_RESPONSE_SCHEMA was passed. So the agent that designs the entire roster
  // could not open a file, while the prompt told it to read the codelines before answering —
  // an instruction it could not follow, and an invitation to narrate an inspection that never
  // happened. Live 2026-08-07: two briefs prescribed `preview_token`, absent from the pinned
  // SDK, taken on the vendor documentation's word because nothing could check it.
  //
  // Read-only by construction: no bash, no write_file. This stage has no story scope.
  const _mintEnv = { EPAM_RESPONSE_SCHEMA: schemaEnv(TOOL_PROJECT_AGENTS) };
  if (toolGrant) {
    _mintEnv.AI_GATE_ALLOW_TOOLS = '1';
    _mintEnv.EPAM_ALLOWED_TOOLS = toolGrant;
  }
  const payload = await runAgentForJson(
    promptExec, prompt, TOOL_PROJECT_AGENTS, 'PROJECT_AGENTS',
    logDir ? path.join(logDir, 'project-agents-mint.log') : null,
    null, '', repoPath || '',
    _mintEnv,
  );

  const proposals = (payload && Array.isArray(payload.proposedAgents)) ? payload.proposedAgents : [];

  // PERSIST WHAT WAS PROPOSED, NOT A COUNT OF IT.
  //
  // The merged result records `proposed: 5` and the briefs themselves land in profiles.json —
  // which is ephemeral by design and restored from canonical at the next run's start. So the
  // full text of what the model proposed, system prompts included, survived nowhere, and a
  // refused proposal left no trace of what it had actually said. Written BEFORE the merge, so
  // a merge that throws still leaves the evidence behind.
  const _persistProposals = (attempt, list, merged) => {
    if (!logDir) return;
    try {
      fs.writeFileSync(
        path.join(logDir, `agent-mint-proposals${attempt > 1 ? `-attempt${attempt}` : ''}.json`),
        JSON.stringify({ attempt, proposed: list.length, proposals: list, refused: merged || [] }, null, 2));
    } catch { /* the run must not die for want of an audit file */ }
  };

  _persistProposals(1, proposals);
  let result = mergeProjectAgents({ profilesPath, agentsDir, proposals, codelines });
  _persistProposals(1, proposals, result.rejected);
  let attempts = 1;

  // ONE REFUSAL IS NOT A DEAD RUN.
  //
  // Every validation here is a contract the prompt states, so a refusal means the model did not
  // follow it — which is what a retry is for. Without this a single lazy field (the "..."
  // rationale, a missing codeline) empties the roster, and role assignment then has no
  // candidates at all: the failure surfaces far downstream of its cause. The re-proposal is told
  // exactly what was refused and why. Merging is additive and convergent, so anything minted on
  // the first attempt is kept and only the gap is re-proposed.
  const _maxAttempts = Math.max(1, Number(process.env.EPAM_ROSTER_MINT_ATTEMPTS || '2'));
  while (result.rejected.length && attempts < _maxAttempts) {
    attempts += 1;
    const refusedBlock = [
      'YOUR PREVIOUS PROPOSAL WAS PARTLY REFUSED. Each line is a proposal that was NOT accepted,',
      'and the reason it failed the roster contract. Re-propose those roles correcting exactly',
      'that, and do not re-propose any role that was already accepted:',
      '',
      ...result.rejected.map((r) => `- ${r.name || '(unnamed)'}: ${r.reason}`),
      '',
    ].join('\n');

    const retryPayload = await runAgentForJson(
      promptExec, `${refusedBlock}${prompt}`, TOOL_PROJECT_AGENTS, 'PROJECT_AGENTS',
      logDir ? path.join(logDir, `project-agents-mint-attempt${attempts}.log`) : null,
      null, '', repoPath || '',
      _mintEnv,
    );
    const retryProposals =
      (retryPayload && Array.isArray(retryPayload.proposedAgents)) ? retryPayload.proposedAgents : [];
    if (!retryProposals.length) break;

    _persistProposals(attempts, retryProposals);
    const retryResult = mergeProjectAgents({ profilesPath, agentsDir, proposals: retryProposals, codelines });
    _persistProposals(attempts, retryProposals, retryResult.rejected);

    result = {
      ...retryResult,
      minted: [...result.minted, ...retryResult.minted],
      unchanged: [...result.unchanged, ...retryResult.unchanged],
      // Accumulated, unlike `rejected`, which is deliberately the LAST attempt's list — what
      // is still refused. Without this a rejection corrected on a later attempt disappears
      // from the tally and the printed numbers stop adding up.
      rejectedAcrossAttempts: [...(result.rejectedAcrossAttempts || result.rejected || []), ...retryResult.rejected],
    };
    proposals.push(...retryProposals);
  }

  return {
    ...result,
    proposed: proposals.length,
    rejectedAcrossAttempts: result.rejectedAcrossAttempts || result.rejected || [],
    attempts,
    protectedRoles: fixedRoles.length,
  };
}

const TOOL_ROLE_ASSIGNMENTS = {
  name: 'submit_role_assignments',
  description:
    'Assign exactly one implementation agent role to every story, chosen from the roles ' +
    'offered. Do not answer in prose and do not invent a role.',
  parameters: {
    type: 'object',
    required: ['assignments'],
    properties: {
      assignments: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['storyId', 'agentRole', 'reason'],
          properties: {
            storyId: { type: 'string' },
            codeline: {
              type: 'string',
              description:
                'The codeline this assignment is for. A story that spans codelines gets ONE ' +
                'assignment PER codeline — the repositories differ, so the right owner can differ ' +
                'too. Omit only for a story that spans none.',
            },
            agentRole: { type: 'string', description: 'MUST be one of the offered roles, verbatim.' },
            reason: { type: 'string', description: 'One sentence: why this role owns this story.' },
          },
        },
      },
    },
  },
};

/**
 * candidateRoles — which roles may implement a story.
 *
 * Read from the mint's registry (agents/project-roles.json), intersected with the roster so
 * a registered role with no profile is never offered — the writer would run with an empty
 * system prompt.
 *
 * NOT "the roster minus the canonical core". That derivation was tried and is wrong: a live
 * roster has 38 non-canonical roles of which only about nine implement anything, the rest
 * being engine machinery (doc-*, failure-analyst, the vocabulary agents, code-graph-detective).
 * Offering those as implementation roles is the same class of error as offering one that does
 * not exist — and the identical mistake in the write perimeter handed the detective write
 * access, which the perimeter suite caught.
 */
function candidateRoles(profiles, agentsDir) {
  let registered = [];
  try { registered = require('./lib/agent-roster.js').projectRoles(agentsDir); } catch { registered = []; }
  return registered.filter((r) => Object.prototype.hasOwnProperty.call(profiles || {}, r));
}

/**
 * assignAgentRoles — give every story a role that actually exists.
 *
 * Runs after minting, because until the project's roles exist there is nothing to choose
 * from. Synthesis deliberately leaves agentRole null; this is the only step that fills it.
 *
 * Refuses rather than repairs. A hallucinated role, a process role, or a story the agent
 * simply skipped all throw — because the alternative is a story that runs with an empty
 * system prompt or the string "unknown", which is what the 15 `.agentRole // "unknown"`
 * consumers downstream would silently do with a null.
 */
// Delegates to lib/seam-invocation.js so every seam — shell or JS — resolves its ladder,
// effort and temperature through one implementation.
function seamInvocationEnv(seam, logDir) {
  try {
    return require('./lib/seam-invocation.js')
      .seamInvocationEnv(seam, path.join(automationDirFromLogDir(logDir), 'agents'));
  } catch { return {}; }
}

const TOOL_ROSTER_REVIEW = {
  name: 'submit_roster_review',
  description:
    'Report defects in a generated agent roster. Every finding must be grounded in something you ' +
    'checked with your tools. Do not answer in prose.',
  parameters: {
    type: 'object',
    required: ['verdict', 'findings'],
    properties: {
      verdict: {
        type: 'string',
        enum: ['sound', 'defects_found'],
        description: 'sound = every checkable claim held. defects_found = at least one did not.',
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['agent', 'severity', 'claim', 'checked', 'found'],
          properties: {
            agent: { type: 'string', description: 'The minted agent whose brief carries the defect.' },
            severity: {
              type: 'string',
              enum: ['blocking', 'advisory'],
              description:
                'blocking = an implementer following this brief would write code that cannot work. ' +
                'advisory = worth fixing, but the work can proceed.',
            },
            claim: { type: 'string', description: "The brief's own words, quoted." },
            checked: { type: 'string', description: 'What you did to test it — the tool and the target.' },
            found: { type: 'string', description: 'What you actually found.' },
            remedy: { type: 'string', description: 'What the brief should say instead.' },
            verification: {
              type: 'object',
              description:
                'When your finding rests on whether a NAMED THING is present in a codeline, state it ' +
                'here as well as in prose, so the pipeline can re-run exactly that check itself. ' +
                'Omit when the finding is a judgement no mechanical check settles — an ownership ' +
                'overlap, work nobody owns, a brief that is merely vague.',
              properties: {
                kind: {
                  type: 'string',
                  enum: ['dependency_declared', 'path_exists', 'not_mechanically_checkable'],
                  description:
                    'dependency_declared = the subject is a dependency name. path_exists = the ' +
                    'subject is a path relative to the codeline root. Otherwise the third.',
                },
                codeline: { type: 'string', description: 'Which codeline, named exactly as listed.' },
                subject: { type: 'string', description: 'The dependency or path, exactly as it would be written.' },
                expected: {
                  type: 'string',
                  enum: ['present', 'absent'],
                  description: 'What YOU FOUND: is the subject present in that codeline, or absent?',
                },
                briefAsserts: {
                  type: 'string',
                  enum: ['present', 'absent'],
                  description:
                    'What THE BRIEF claims about the subject — which may differ from what you ' +
                    'found. That difference IS the defect. If the brief turns out to be right, ' +
                    'there is nothing to report and you should not raise a finding at all.',
                },
              },
              // TWO facts, deliberately separate, because one field cannot carry both and a
              // live run proved it: 2026-08-07 the reviewer used this slot for what it found
              // (claiming absent what the manifest declared — a careless read the re-check
              // must refute), and 2026-08-08 it used the same slot for what the BRIEF asserted.
              // Splitting them lets the pipeline catch a misread AND drop a confirmation.
              //
              // Required, because nothing was: live output carried only {codeline, expected},
              // and verifyFindings' `!v.kind` bail-out then kept every finding UNCHECKED. The
              // whole mechanical re-check was inert in production until 2026-08-08.
              required: ['kind', 'codeline', 'subject', 'expected', 'briefAsserts'],
            },
          },
        },
      },
    },
  },
};

/**
 * reviewRoster — the only adversary the roster has.
 *
 * Every other stage of this pipeline has one: the spec pass has a reviewer and a guard, the
 * writer has team-lead review and the gates, the verification criteria have a vocabulary guard
 * that refuses to run unarmed. The roster had none — and it decides who does all the subsequent
 * work and what they believe about the codebase.
 *
 * Live 2026-08-07, both from an unreviewed roster: a brief prescribed `preview_token`, absent
 * from the version of the SDK this estate pins; and another labelled an installed utilities
 * package as the vendor's preview SDK and told an implementer to call its init(). It is not that
 * package — the preview entry points appear nowhere in it. The second is the dangerous shape: a
 * missing package fails loudly at install, a mislabelled one resolves, builds, and does nothing.
 *
 * Read-only tools, the same grant as the mint. It exists to falsify claims, so it must be able to
 * check them; it must never be able to change what it reviews.
 */
async function reviewRoster({
  promptExec, minted, profiles, codelines, tickets, referencedDocs, logDir, repoPath, toolGrant,
}) {
  const _minted = Array.isArray(minted) ? minted : [];
  if (!_minted.length) return { verdict: 'sound', findings: [], reviewed: 0 };

  const briefBlock = _minted.map((m) => {
    const brief = (profiles && profiles[m.name]) || '';
    const tag = m.kind + (m.codeline ? ': ' + m.codeline : '');
    return ['--- ' + m.name + '  [' + tag + ']', brief].join('\n');
  }).join('\n\n');

  const clBlock = (Array.isArray(codelines) ? codelines : []).map((c) => {
    const d = Array.isArray(c.dependencies) ? c.dependencies : [];
    return '- ' + c.name + ' at ' + c.path + '\n    declares: '
      + (d.length ? d.join(', ') : '(no manifest configuration)');
  }).join('\n');

  // THE WHOLE TICKET, not a summary. The reviewer decides whether a brief serves the work that
  // was actually asked for, so it needs the same view of the request the mint had: components
  // (which say how far the work reaches), the links, and the untruncated description.
  const ticketBlock = (Array.isArray(tickets) ? tickets : []).map((t) => {
    const head = '- ' + (t.jiraKey || t.id || '') + ': ' + (t.title || '');
    const comps = Array.isArray(t.components) && t.components.length
      ? '\n  Components: ' + t.components.join(', ') : '';
    const links = (Array.isArray(t.ticketLinks) ? t.ticketLinks : [])
      .map((l) => (typeof l === 'string' ? l : (l && l.url))).filter(Boolean);
    const linkLine = links.length ? '\n  Links: ' + links.join(' , ') : '';
    return head + comps + '\n  ' + String(t.description || '').replace(/\s+/g, ' ') + linkLine;
  }).join('\n');

  // THE DOCUMENTS THE BRIEFS WERE DERIVED FROM. Without them the reviewer can tell that a brief
  // disagrees with the repository, but not WHY — and the why decides the remedy. A brief that
  // followed the vendor's current guide into a symbol this pinned version lacks needs the
  // version-correct instruction; one that simply invented something needs deleting.
  const docBlock = (Array.isArray(referencedDocs) ? referencedDocs : [])
    .filter((d) => d && d.fetchStatus === 'fetched')
    .map((d) => {
      if (Array.isArray(d.quotes) && d.quotes.length) {
        return '- ' + d.url + '\n' + d.quotes.map((q) => '    "' + String(q).replace(/\s+/g, ' ') + '"').join('\n');
      }
      let body = typeof d.body === 'string' ? d.body : '';
      if (!body && d.path) { try { body = fs.readFileSync(d.path, 'utf8'); } catch { body = ''; } }
      return body ? '- ' + d.url + '\n' + body : '- ' + d.url + ' (retrieved, no readable text)';
    }).join('\n\n');

  const persona = (profiles && profiles['roster-reviewer']) || '';
  const toolLine = toolGrant
    ? 'Your tools: ' + toolGrant + '. Open the repositories. Resolve the packages and symbols these '
      + 'briefs name. Confirm the files and directories they claim to own exist.'
    : 'You have NO tools on this call. Report only what the text above lets you establish, and say so.';

  const prompt = [
    persona,
    '',
    'THE ROSTER JUST MINTED FOR THIS PROJECT — review every brief below:',
    '',
    briefBlock,
    '',
    'THE CODELINES THESE BRIEFS DESCRIBE, and what each one declares:',
    clBlock || '- (none resolved)',
    '',
    'THE WORK THE PROJECT WAS ASKED TO DO:',
    ticketBlock || '- (no tickets available)',
    '',
    docBlock
      ? 'THE DOCUMENTATION THESE BRIEFS WERE DERIVED FROM (fetched from the ticket\'s own links):\n'
        + docBlock
        + '\n\nWhere a brief follows this documentation into something the pinned version does not '
        + 'have, the documentation is right about the product and wrong about these repositories. '
        + 'Say which, so the remedy is the version-correct instruction rather than a deletion.'
      : 'No documentation was fetched for this ticket — briefs resting on vendor knowledge have '
        + 'nothing here to be checked against, and any such claim must be verified against the '
        + 'repositories or reported as unverifiable.',
    '',
    toolLine,
    '',
    'Return every defect you can evidence, and nothing you cannot.',
    '',
    'Where a finding turns on whether a named dependency or path is present in a codeline, fill in',
    'the verification field as well as writing the prose. The pipeline re-runs that exact check',
    'against the repository and DISCARDS any finding the check refutes — so a careless reading',
    'costs nothing, and a correct one is confirmed independently of how convincingly you argued it.',
  ].join('\n');

  const env = {
    EPAM_RESPONSE_SCHEMA: schemaEnv(TOOL_ROSTER_REVIEW),
    ...seamInvocationEnv('roster-review', logDir),
  };
  if (toolGrant) { env.AI_GATE_ALLOW_TOOLS = '1'; env.EPAM_ALLOWED_TOOLS = toolGrant; }

  const payload = await runAgentForJson(
    promptExec, prompt, TOOL_ROSTER_REVIEW, 'ROSTER_REVIEW',
    logDir ? path.join(logDir, 'roster-review.log') : null,
    null, '', repoPath || '', env,
  );

  // A REVIEW THAT DID NOT RUN IS NOT A CLEAN REVIEW.
  //
  // Live 2026-08-08: the reviewer returned completely empty output — 47KB of prompt in, 10
  // bytes out — and this roster reached the operator pause labelled "sound", unreviewed. A
  // null payload became an empty finding list, and an empty finding list is exactly what a
  // genuine clean review looks like, so "produced nothing" and "found nothing wrong" were the
  // same value. There IS a guard for this a few lines up in the caller, but it only catches a
  // thrown error and runAgentForJson returns null on unparseable output rather than throwing.
  //
  // Deriving the verdict from the findings instead of taking the model's word stays. What was
  // missing is a third state: the payload must carry a findings ARRAY to count as a review at
  // all. This is the only agent standing between a generated brief and an implementer
  // inheriting it whole, so its silence must never read as approval.
  if (!payload || !Array.isArray(payload.findings)) {
    return {
      verdict: 'review_failed',
      findings: [],
      refuted: [],
      reviewed: 0,
      error: 'the roster reviewer returned no usable findings — the tag was missing, empty, or ' +
             'not the reviewed shape. The roster is UNREVIEWED, which is not the same as sound.',
    };
  }
  const raw = payload.findings;

  // RE-RUN THE REVIEWER'S OWN CHECK. A finding that turns on whether a named dependency or
  // path is present is mechanically settleable, and the reviewer states it in a structured
  // field for exactly that reason. Live 2026-08-07: it reported a package absent from a
  // codeline that declares it in devDependencies and has it installed — a careless read that
  // a retry reproduces and a stronger model does not reliably prevent. Refuted findings are
  // dropped; judgements it cannot settle are kept untouched.
  let findings = raw;
  let refuted = [];
  try {
    const v = require('./lib/verify-findings.js').verifyFindings(raw, codelines);
    findings = v.kept;
    refuted = v.refuted;
    for (const f of refuted) console.warn(`spec-mode: roster finding DISCARDED — ${f._refutedBy}`);
    // Unsettled findings are NOT silently gone. A malformed one is dropped (an unverifiable
    // claim must not halt a run), and that is exactly how a reviewer could disable this gate
    // by omitting fields — so every one is named, with why, where an operator will see it.
    for (const f of (v.unsettled || [])) {
      console.warn(`spec-mode: roster finding UNSETTLED — ${f._why} — agent=${f.agent || '?'} claim=${JSON.stringify(f.claim || '')}`);
    }
  } catch (err) {
    console.warn(`spec-mode: could not verify roster findings (${err && err.message}) — keeping all of them`);
  }

  // The verdict is DERIVED, never taken on the model's word: a reviewer that lists defects and
  // then calls the roster sound is the fail-open shape these gates exist to prevent.
  const verdict = findings.length ? 'defects_found' : 'sound';
  return { verdict, findings, refuted, reviewed: _minted.length };
}

/**
 * The assignment prompt, built where a test can execute it.
 *
 * Extracted because its defect was a self-contradiction in the text itself, which no test
 * could see while the string was welded inside a 200-line function.
 */
function buildAssignmentPrompt(stories, roles) {
  const _stories = Array.isArray(stories) ? stories : [];
  const roleBlock = (Array.isArray(roles) ? roles : [])
    .map((r) => `- ${r.name}\n    ${String(r.brief || '').replace(/\s+/g, ' ').slice(0, 320)}`)
    .join('\n');
  const storyBlock = _stories
    .map((s) => {
      const cls = Array.isArray(s.codelines) && s.codelines.length ? s.codelines : (s.codeline ? [s.codeline] : []);
      const clLine = cls.length > 1
        ? `\n    codelines — ${cls.length} assignments required, one for EACH of: ${cls.join(', ')}`
        : (cls.length ? `\n    codeline: ${cls[0]}` : '');
      return `- ${s.id}: ${s.title || ''}${clLine}\n    ${String(s.description || '').replace(/\s+/g, ' ')}`;
    })
    .join('\n');

  // THE PROMPT USED TO CONTRADICT ITSELF. It required "ONE ASSIGNMENT PER CODELINE" and then,
  // four lines later, "Every story must be assigned exactly one role" — a sentence written
  // before stories could span codelines. One needs three assignments, the other needs one.
  // Live 2026-08-09 a model resolved it by returning a single assignment for a three-codeline
  // story; the run aborted with two lanes unowned after spending its entire retry and ladder
  // budget re-answering a question that had no consistent answer. The old wording is NOT
  // quoted in the prompt below: restating a rejected instruction to the model reintroduces it.
  return `Assign an implementation agent role to every story below.

AVAILABLE ROLES — these are this project's own engineering roles. Choose from these and
nothing else; the name you return must match one of them verbatim:
${roleBlock}

STORIES — a story listing more than one codeline needs ONE ASSIGNMENT PER CODELINE:
${storyBlock}

Pick the role whose stated expertise actually covers the work the story describes. If two
roles could plausibly own a story, prefer the one whose brief names the surface the story
touches.

THE UNIT OF ASSIGNMENT IS A (STORY, CODELINE) PAIR, NOT A STORY. A story listing three
codelines needs THREE assignments — the repositories differ, so the right owner can differ.
Count the codelines listed against each story and return exactly that many assignments for it,
naming the codeline on every one. A story is not assigned until every codeline it lists is.

THE OWNER MUST AUTHOR THE CODE. Assign the role that will EDIT THE FILES this story changes —
the one whose brief names those files or directories. A role whose brief is about settings in
a vendor's console, or about documentation, cannot deliver a story here: the agent's output is
a change in a repository. Live 2026-08-07: this story went to the one role of three that owned
no source files, and all such a role can produce is a configuration note. Where the story needs
both console configuration and code, the code owner is the assignee.`;
}

async function assignAgentRoles({ promptExec, stories, profilesPath, logDir, repoPath, validateOnly }) {
  const _stories = Array.isArray(stories) ? stories : [];
  if (!_stories.length) return { assigned: [], stories: [] };

  let profiles = {};
  try { profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')); } catch (e) {
    throw new Error(`[assign] cannot read the roster at ${profilesPath}: ${e && e.message}`);
  }

  let fixedRoles = [];
  try {
    fixedRoles = require(path.join(__dirname, '..', '..', 'dist', 'sdk.js')).FIXED_AGENT_ROLES || [];
  } catch (e) {
    throw new Error(`[assign] cannot read FIXED_AGENT_ROLES from dist/sdk.js: ${e && e.message}`);
  }

  const candidates = candidateRoles(profiles, path.dirname(profilesPath));
  if (!candidates.length) {
    throw new Error(
      '[assign] no project implementation roles are registered for this project — nothing was ' +
      'minted, so there is no role any story could honestly be assigned.',
    );
  }

  const prompt = buildAssignmentPrompt(
    _stories,
    candidates.map((r) => ({ name: r, brief: profiles[r] || '' })),
  );

  // VALIDATE, DO NOT REGENERATE. On a resume the operator has inspected the roster at the
  // pause and may have edited profiles.json, the project-roles registry, or the stories'
  // agentRole directly. Re-running the assignment agent would silently discard exactly the
  // judgement the pause exists to capture. So when every story already carries a role, the
  // existing assignment is checked against the same rules a fresh one would face and kept.
  const preassigned = _stories.every((s) => typeof s.agentRole === 'string' && s.agentRole.trim()
                                            && s.agentRole !== 'unknown');
  let rows;
  if (preassigned || validateOnly) {
    rows = _stories.map((s) => ({
      storyId: s.id, agentRole: String(s.agentRole || '').trim(), reason: 'pre-assigned (validated, not regenerated)',
    }));
  } else {
    const payload = await runAgentForJson(
      promptExec, prompt, TOOL_ROLE_ASSIGNMENTS, 'ROLE_ASSIGNMENTS',
      logDir ? path.join(logDir, 'role-assignments.log') : null,
      null, '', repoPath || '',
      { EPAM_RESPONSE_SCHEMA: schemaEnv(TOOL_ROLE_ASSIGNMENTS) },
    );
    rows = (payload && Array.isArray(payload.assignments)) ? payload.assignments : [];
  }
  // KEYED BY STORY AND CODELINE. One story spanning three repositories is three assignments:
  // the repositories differ in tooling, so the right owner can differ too. Assigning one role
  // to the story and handing it to every lane is how a role briefed for one codeline ends up
  // working in another.
  const byStory = new Map();
  const fixed = new Set(fixedRoles);
  const allowed = new Set(candidates);

  for (const row of rows) {
    if (!row || typeof row.storyId !== 'string' || typeof row.agentRole !== 'string') continue;
    const role = row.agentRole.trim();
    if (fixed.has(role)) {
      throw new Error(
        `[assign] ${row.storyId} was assigned "${role}", a canonical process role — it is not an ` +
        'implementation role and cannot own a story.',
      );
    }
    if (!allowed.has(role)) {
      throw new Error(
        `[assign] ${row.storyId} was assigned "${role}", which is not in the roster — it has no ` +
        'profile entry, so the writer would run with an empty system prompt.',
      );
    }
    const key = row.storyId + '\u0000' + (typeof row.codeline === 'string' ? row.codeline.trim() : '');
    byStory.set(key, { storyId: row.storyId, codeline: (row.codeline || '').trim(), role, reason: row.reason || '' });
  }

  // Every (story, codeline) pair must be covered. A story spanning three codelines with one
  // assignment leaves two lanes with no owner — and a null role is read as "unknown" downstream
  // rather than failing.
  const _pairs = [];
  for (const s of _stories) {
    const cls = Array.isArray(s.codelines) && s.codelines.length ? s.codelines : (s.codeline ? [s.codeline] : ['']);
    for (const cl of cls) _pairs.push({ story: s, codeline: cl });
  }
  const _lookup = (storyId, cl) =>
    byStory.get(storyId + '\u0000' + cl) || (cl ? byStory.get(storyId + '\u0000' + '') : null);
  const missing = _pairs.filter((x) => !_lookup(x.story.id, x.codeline))
    .map((x) => x.story.id + (x.codeline ? ' @ ' + x.codeline : ''));
  if (missing.length) {
    throw new Error(
      `[assign] unassigned after the agent's full retry/ladder budget: ${missing.join(', ')}. ` +
      'A null agentRole is read as "unknown" by every consumer downstream rather than failing.',
    );
  }

  const assigned = [];
  for (const s of _stories) {
    const cls = Array.isArray(s.codelines) && s.codelines.length ? s.codelines : (s.codeline ? [s.codeline] : ['']);
    const perCodeline = {};
    for (const cl of cls) {
      const a = _lookup(s.id, cl);
      if (cl) perCodeline[cl] = a.role;
      assigned.push({ storyId: s.id, codeline: cl, agentRole: a.role, reason: a.reason });
    }
    // agentRoles is authoritative for a spanning story; agentRole stays as the primary so every
    // existing consumer keeps working until each is taught to read per codeline.
    if (Object.keys(perCodeline).length) s.agentRoles = perCodeline;
    const primary = _lookup(s.id, s.codeline || cls[0]);
    s.agentRole = (primary && primary.role) || _lookup(s.id, cls[0]).role;
  }
  return { assigned, stories: _stories };
}

async function enforceVerificationCriteria(story, initialVc, opts = {}) {
  const { regenerateVc = null, reviewVc = null, findings = null, deriveVocabulary = null,
          maxCycles = Number(process.env.VC_MAX_CYCLES || '2') } = opts;
  let vc = Array.isArray(initialVc) ? initialVc.slice() : [];
  let lastFlags = [];

  // ARM THE GUARD, OR ABORT. The vocabulary this guard applies is derived per story; it is
  // not written down anywhere. If derivation fails the guard cannot check anything, and a
  // guard that silently checks nothing is worse than no guard — it reports "clean" and
  // nobody looks again. That is precisely how the previous hardcoded guard passed VCs
  // which plainly prescribed mechanism. So: no vocabulary, no run.
  let vocabulary = null;
  if (deriveVocabulary) {
    try { vocabulary = await deriveVocabulary(vc); } catch (err) {
      throw new Error(`VC guard could not be armed for ${(story && story.id) || 'story'}: guard-vocabulary agent failed (${err && err.message}). A guard with no vocabulary checks nothing; refusing to proceed.`);
    }
  }
  if (!isVocabularyUsable(vocabulary)) {
    throw new Error(`VC guard could not be armed for ${(story && story.id) || 'story'}: the guard-vocabulary agent returned no usable terms after its full retry/ladder budget. A guard with no vocabulary checks nothing; refusing to proceed.`);
  }
  // Persisted so a re-run applies the identical vocabulary — derivation is agentic,
  // enforcement is reproducible.
  if (story) {
    story.specification = story.specification || {};
    story.specification.guardVocabulary = vocabulary;
  }

  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    const mech = findVcMechanism(vc, story && story.id, vocabulary).map((f) => f.reason + `: "${String(f.criterion).slice(0, 80)}"`);
    let speckitFlags = [];
    if (reviewVc) {
      try { speckitFlags = (await reviewVc(vc, cycle)) || []; } catch { speckitFlags = []; }
    }
    lastFlags = [...mech, ...speckitFlags];
    if (lastFlags.length === 0) {
      return { vc, source: cycle === 1 ? 'clean' : 'regenerated', cycles: cycle, flags: [] };
    }
    if (cycle === maxCycles || !regenerateVc) break; // out of cycles → fall back below
    let regenerated = null;
    try { regenerated = await regenerateVc(lastFlags, cycle + 1); } catch { regenerated = null; }
    vc = Array.isArray(regenerated) && regenerated.length ? regenerated : vc;
  }
  // PARTIAL RETENTION before the last resort. Discarding criteria that were never flagged
  // costs more than it protects: the fallback's two lines are tautologies the writer
  // cannot fail, so a whole-set discard leaves the story effectively unverified.
  //
  // TWO CLASSES OF FLAG, AND THEY ARE NOT EQUAL.
  //
  // findVcMechanism is deterministic: what it flags IS mechanism, and it is always dropped.
  // The LLM reviewer adds judgement a regex cannot, so its flags are ADVISORY — and
  // measured live 2026-08-04, six full loops over four criteria the deterministic guard
  // certified clean, one run had the reviewer flag THREE of the four (including "When
  // preview mode is active, the page displays the draft version of the entry" — plainly
  // observable) and retention kept a single criterion.
  //
  // A review that condemns most of a set is far more likely to be an outlier than the set
  // is to be worthless. So advisory drops are applied only while the surviving set stays
  // above a usable floor; below it, the deterministically-clean work is KEPT and the
  // dispute recorded for a human. This never rescues a criterion the guard rejected.
  //
  // CONFIGURABLE: VC_MIN_RETAINED (absolute floor, default 2),
  //               VC_MIN_RETAINED_FRACTION (share of the original set, default 0.5).
  const mechCriteria = findVcMechanism(vc, null, vocabulary).map((f) => f.criterion);
  const guardClean = vc.filter((c) => !mechCriteria.includes(c));

  const { clean, flagged, unattributable } = partitionFlaggedVc(vc, lastFlags);

  // AN ADVISORY DROP MUST BE A CLEAR MINORITY.
  //
  // The reviewer's flags may delete — a modest, well-aimed objection is worth acting on, and
  // this function's own tests rightly insist on that. But the rule was "at least half
  // survive", which lets a review condemning exactly half delete half. Live 2026-08-07 (run
  // 20260807T010410Z) it deleted two of four, including "the preview page updates ... without
  // requiring a manual page refresh" — the central behaviour of the feature, naming no
  // mechanism at all. The story reached the writer with that unverified.
  //
  // Deleting half a set is a rewrite, not a correction, and this function already holds the
  // instinct that a review condemning most of a set is more likely an outlier than the set is
  // to be worthless. Half counts as most.
  //
  // The deterministic guard is untouched: what it flags is mechanism by construction and is
  // always dropped, above. Regeneration still acts on reviewer flags every cycle; this only
  // decides what happens once the cycles are spent.
  const absFloor = Number(process.env.VC_MIN_RETAINED || '2');
  const fraction = Number(process.env.VC_MIN_RETAINED_FRACTION || '0.5');
  const floor = Math.max(Math.min(absFloor, vc.length), Math.ceil(fraction * vc.length));
  const isMinority = flagged.length * 2 < vc.length;

  if (!unattributable && isMinority && clean.length >= floor && clean.length < vc.length) {
    console.warn(`spec-mode: \u26a0\ufe0f VC still flagged for ${story && story.id} after ${maxCycles} cycle(s) — dropping ${flagged.length} flagged criterion/criteria, retaining ${clean.length} clean. Dropped: ${flagged.map((c) => `"${String(c).slice(0, 60)}"`).join(' | ')}`);
    return { vc: clean, source: 'partial', cycles: maxCycles, flags: lastFlags, dropped: flagged };
  }

  // Not a minority (or unattributable): keep what the deterministic guard certified and
  // record the disagreement on the story.
  if (guardClean.length) {
    console.warn(`spec-mode: ⚠️ VC review DISPUTED for ${story && story.id} — the reviewer flagged ${unattributable ? 'the set' : `${flagged.length}/${vc.length}`} criteria, not a clear minority. Keeping the ${guardClean.length} the deterministic guard certified; deleting half a set is a rewrite, not a correction. Flags: ${lastFlags.slice(0, 3).join(' | ')}`);
    return {
      vc: guardClean,
      source: 'disputed',
      cycles: maxCycles,
      flags: lastFlags,
      dropped: vc.filter((c) => !guardClean.includes(c)),
    };
  }
  console.warn(`spec-mode: ⚠️ VC could not be made mechanism-free for ${story && story.id} after ${maxCycles} cycle(s) — using conservative fallback VC${unattributable ? ' (a flag named no specific criterion, so nothing could be safely retained)' : ''}. Last flags: ${lastFlags.slice(0, 3).join(' | ')}`);
  return { vc: safeFallbackVc(story, findings), source: 'fallback', cycles: maxCycles, flags: lastFlags };
}

// Shared LLM call for the VC loop — ladder-escalates the model per cycle (base
// HIGH model → kimi-k3), reusing runClaude's salvage + tight timeout (same
// resilience as the detective, so a VC regen/review can't stall the pipeline).
//
// `role` selects which agent's model-tier env vars apply. Full agent audit,
// 2026-07-31: this always resolved openspec's SPEC_MODE_OPENSPEC_MODEL_HIGH,
// even when called FROM reviewVcViaSpeckit (speckit's own review role) —
// speckit's dedicated SPEC_MODE_SPECKIT_MODEL_HIGH was silently never
// consulted for VC review, despite existing and being used everywhere else
// speckit runs (see the escalation ladder at line ~968).
async function _vcLlmCall(prompt, cycle, logPath, storyId = '', role = 'openspec', repoPath = '') {
  const baseModel = role === 'speckit'
    ? (process.env.SPEC_MODE_SPECKIT_MODEL_HIGH || process.env.SPEC_MODE_SPECKIT_MODEL || process.env.ESCALATION_MODEL_HIGH || 'z-ai/glm-5.1')
    : (process.env.SPEC_MODE_OPENSPEC_MODEL_HIGH || process.env.ESCALATION_MODEL_HIGH || 'z-ai/glm-5.1');
  const escalated = ladderNextModel(baseModel, process.env);
  const useEsc = cycle >= 2 && escalated;
  const model = useEsc ? escalated : baseModel;
  const provider = useEsc ? (resolveModelProvider(model, process.env) || resolvePromptProvider(process.env)) : resolvePromptProvider(process.env);
  const exec = { cmd: process.env.AI_RUNNER_CMD || path.join(__dirname, 'ai-run.sh'), args: ['--provider', provider, '--model', model] };
  // Real tools + correct cwd when a single story's codeline resolves. Writes
  // are prevented by the filesystem perimeter, not by withholding tools —
  // see specAgentEnv's docstring.
  const toolEnv = repoPath ? {
    AI_GATE_ALLOW_TOOLS: process.env.SPEC_MODE_ALLOW_TOOLS || '1',
    EPAM_ALLOWED_TOOLS: process.env.SPEC_MODE_ALLOWED_TOOLS || 'read_file,list_files,search',
    EPAM_MAX_TOOL_CALLS: process.env.SPEC_MODE_MAX_TOOL_CALLS || String(specModeDefaults().perAgent),
    PROJECT_ROOT: repoPath,
  } : {};
  return runClaude(exec, prompt, logPath, {
    EPAM_MAX_OUTPUT_TOKENS: process.env.CODEGRAPH_DETECTIVE_MAX_OUTPUT_TOKENS || '24576',
    EPAM_MAX_ITERATIONS: '2',
    // VC production is a RESTATE task, not a reasoning task: describe the observable
    // outcome faithfully, do NOT reason toward an implementation. High reasoning
    // effort is what drives the prescriptive drift (the model "solves" the bug and
    // bakes the mechanism into the VC); non-zero temperature adds the variance that
    // occasionally lands on a forbidden mechanism. Pin both DOWN for VC calls only
    // (scoped to this child env, so the wider run's temperature/effort are untouched).
    EPAM_TEMPERATURE: process.env.VC_LLM_TEMPERATURE || '0',
    EPAM_REASONING_EFFORT: process.env.VC_LLM_REASONING_EFFORT || 'low',
    ...toolEnv,
  }, { costAgent: 'vc-agent', costStoryId: storyId, salvageOutputOnFailure: true, timeoutMs: Number(process.env.CODEGRAPH_DETECTIVE_TIMEOUT_MS || '450000') });
}
function _firstJsonArray(out) {
  const m = out && out.match(/\[[\s\S]*?\]/);
  if (!m) return null;
  try { const a = JSON.parse(m[0]); return Array.isArray(a) ? a : null; } catch { return null; }
}

// speckit-brownfield: STRICT, flag-only VC review (never rewrites). Flags a VC
// that prescribes HOW (mechanism), isn't observable/testable, or fails to cover
// an AC's intent. Returns an array of flag strings ([] = all clean).
async function reviewVcViaSpeckit({ story, vc, cycle, logDir }) {
  const prompt = `You are a STRICT verification-criteria reviewer for a brownfield fix. REVIEW ONLY — do NOT rewrite anything.

Acceptance criteria (IMMUTABLE ticket intent):
${(story.acceptanceCriteria || []).map((a) => '- ' + a).join('\n') || '- (none)'}
Description: ${String(story.description || '')}

Proposed verification criteria:
${vc.map((v, i) => `${i + 1}. ${v}`).join('\n')}

Apply these rules EXACTLY (the producer is held to the same text — do not invent stricter or looser criteria):
${VC_OBSERVABILITY_RULES}

A criterion may declare a PRECONDITION the test establishes (for example a mocked client
signalling a change). A declared precondition is NOT implementation prescription — do not flag
it. Flag what the criterion ASSERTS, not what it sets up.

FLAG any verification criterion that violates ANY rule above, OR that fails to cover the intent of an acceptance criterion.
Output ONLY a JSON array of short flag strings, e.g. ["VC 2 prescribes <an approach> — restate as observable outcome"]. Output [] if every VC is clean. No prose, no markdown.`;
  const out = await _vcLlmCall(prompt, cycle, logDir ? path.join(logDir, `${story.id}-vc-review.log`) : null, story.id, 'speckit', resolveCodelinePath(story));
  const arr = _firstJsonArray(out);
  return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
}

// openspec-brownfield: regenerate the VCs addressing the flags (producer side of
// the autonomous loop). Returns a fresh VC array, or null if it couldn't produce one.
async function regenerateVcViaOpenspec({ story, flags, cycle, logDir, findings = [] }) {
  // Ground the regeneration in the LOCATED fix site. Without this the model has
  // only ticket prose to work from and drifts to whatever the words suggest —
  // live, "station names" for a promo-code-in-email ticket. The detective already
  // knows the file and function; withholding it is what makes the criteria
  // unanchored.
  const siteBlock = Array.isArray(findings) && findings.length
    ? `\nTHE FIX SITE (located by the code-graph detective — anchor every criterion to the behaviour THIS code produces):\n`
      + findings.slice(0, 5).map((f) => `- ${f.file}${f.function ? ` :: ${f.function}` : ''}${f.reason ? ` — ${f.reason}` : ''}`).join('\n')
      + `\nDo NOT write criteria about areas unrelated to this code.\n`
    : '';

  const prompt = `Regenerate the VERIFICATION CRITERIA for this brownfield story. Your previous verification criteria were FLAGGED and must be fixed:
${flags.map((f) => '- ' + f).join('\n')}
${siteBlock}

Acceptance criteria (IMMUTABLE — the intent to verify; do NOT restate as-is, VERIFY them):
${(story.acceptanceCriteria || []).map((a) => '- ' + a).join('\n') || '- (none)'}
Description: ${String(story.description || '')}

${VC_OBSERVABILITY_RULES}
${vcFormSamples() ? `\n${vcFormSamples()}\n` : ''}
Do NOT restate an acceptance criterion as-is — express what a tester OBSERVES that confirms it. Address every flag above.
Output ONLY a JSON array of verification-criterion strings. No prose, no markdown.`;
  const out = await _vcLlmCall(prompt, cycle, logDir ? path.join(logDir, `${story.id}-vc-regen.log`) : null, story.id, 'openspec', resolveCodelinePath(story));
  const arr = _firstJsonArray(out);
  if (!arr) return null;
  const cleaned = arr.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  return cleaned.length ? cleaned : null;
}

/**
 * opts.hasAcceptanceCriteria / opts.hasReferencedDocs — what this STORY actually has.
 *
 * STEP 3 used to open with three sentences about acceptance criteria unconditionally. A
 * brownfield ticket has none — the AC gate skips them by design and records "VCs are derived
 * from the description" — so the model was given ceremony about an empty array and then told
 * to derive verification from a description that, on AMSD-2041, was 395 characters including
 * estimate boilerplate. Four thin criteria came out.
 *
 * Meanwhile the same prompt carries the documentation fetched from the ticket's own links,
 * under a header calling it "authoritative over assumption". STEP 3 never named it, so it
 * informed the implementation and not the verification. The instruction predates that source
 * by months; nothing updated it when the source arrived.
 *
 * A prompt should name the sources this story HAS. Nothing else.
 */
function buildBrownfieldArchaeologyBlock(env = process.env, opts = {}) {
  const isBrownfield = env.EPAM_BROWNFIELD === '1';
  const hasAcs = opts.hasAcceptanceCriteria !== false;
  const hasDocs = opts.hasReferencedDocs === true;

  // Only sources that exist are offered. Inviting derivation from documents that were never
  // fetched, or from criteria the ticket never had, is an invitation to invent one.
  const _sources = [
    hasAcs ? 'the acceptance criteria' : '',
    'the description',
    hasDocs ? 'the REFERENCED DOCUMENTATION quoted above (authoritative: where a linked document states what the system does observably, derive the check from THAT rather than from a one-line description)' : '',
  ].filter(Boolean);
  const _vcSourceValues = [hasAcs ? 'acceptance' : '', 'description', hasDocs ? 'documentation' : '', 'both']
    .filter(Boolean).join('|');
  const _acPreamble = hasAcs
    ? `STEP 3 — VERIFICATION CRITERIA (do NOT touch the acceptance criteria).
The acceptanceCriteria are the IMMUTABLE ticket intent — copy the existing array through VERBATIM: never reword, split, add, remove, re-scope, or inject any implementation mechanism into them.
Instead, PRODUCE`
    // Silence, not a disclaimer. Saying "this ticket has no acceptance criteria" is still a
    // dependency on them: it spends the model's attention on an absent artefact and invites
    // it to compensate. A prompt names what exists.
    : `STEP 3 — VERIFICATION CRITERIA.
PRODUCE`;
  const archaeologyBlock = isBrownfield
    ? `\n\nBROWNFIELD MODE — answer as JSON.
You MAY use read_file on any path named in this prompt (declared files, located fix sites, and any
document persisted under the run's docs/ directory) when you need more than the excerpt shown.
Looking is allowed; inventing is not — a file you have neither been shown nor read is a fabrication.

STEP 1 — CLASSIFY THIS STORY. Set "storyKind":
- "defect" if it reports that EXISTING behavior is wrong, broken, or produces an incorrect/missing result (a bug).
- "novel" if it asks for a NEW capability that does not exist in the codebase yet. A brownfield story is not always a bug — genuinely new work is "novel".

STEP 2 — LOCATE (always, for both kinds — but the question differs).
Use ONLY the EXISTING CODE block already present in this prompt (injected above via CodeGraph or Semble).

- If storyKind is "defect": find the FIX SITE — the file/function that COMPUTES the wrong value, not the one that displays it.
- If storyKind is "novel": there is no fix site, and inventing one produces a confident wrong answer. Find the ATTACHMENT POINT instead — the existing file/function this new capability plugs INTO (the provider, hook, route, config or component it must integrate with), plus anything already present that the implementation should REUSE rather than rewrite. This is what keeps the change as small as possible: you cannot reuse what you have not found.

Set "locationHint" to [{"file":"<repo-relative path>","function":"<function name>","reason":"<why this location — the fix site for a defect, the attachment point for a novel story>"}].
If no relevant code appears above, set locationHint to []. Do NOT invent a plausible file: a named file whose contents you cannot see in this prompt is a fabrication, and an empty locationHint is a usable answer while a fabricated one is not.

For EACH criterion also declare WHO observes it (end user, tester, api client, operator) and
WHAT SURFACE they look at — the rendered page, the API response, the CLI output, a generated
file. If no person or client can see it, it is not a verification criterion. A precondition
the test establishes (for example a mocked client signalling a change) goes in "setup": that
is allowed and is not implementation prescription.

${_acPreamble} a "verificationCriteriaDetail" array — concrete, OBSERVABLE checks that confirm the change is correct — derived from ${_sources.join(' AND ')}. Apply these rules to EVERY verification criterion (a strict reviewer holds you to this SAME text, so a VC that breaks any rule will be flagged and rejected):
${VC_OBSERVABILITY_RULES}${vcFormSamples(env) ? `\n\n${vcFormSamples(env)}\n` : ''}
- If the ticket describes a SYMPTOM, the VCs verify that symptom is resolved AND that related existing behavior does not regress.
Set "vcSource" to one of ${_vcSourceValues.split('|').map((v) => `"${v}"`).join(', ')} — where you actually derived the VCs from.${unreachableExternalsConstraint()}
`
    : '';
  const schemaLine = isBrownfield
    ? `\n  "storyKind":"defect|novel",\n  "verificationCriteriaDetail":[{"criterion":"<observable check>","observer":"end user|tester|api client|operator","surface":"<what they look at>","setup":"<optional precondition, e.g. a mocked client signalling a change>"}],\n  "vcSource":"${_vcSourceValues}",\n  "locationHint":[{"file":"path/relative/to/repo","function":"functionName","reason":"why this location — the fix site for a defect, the attachment point it integrates with for a novel story"}],`
    : '';
  return { archaeologyBlock, schemaLine };
}

// recordDetectiveRound — per-round telemetry for the spec pass's dominant cost.
//
// Measured 2026-07-30 across three lanes of one run: the spec pass is ~16 min
// and the detective is 61-72% of it (11.6 / 9.8 / 9.4 min), while openspec and
// speckit together take ~1.5 min. Every lane took roughly the same time on a
// one-line ticket, which is the signature of a fixed exploration budget rather
// than work proportional to the story.
//
// Before capping CODEGRAPH_DETECTIVE_MAX_TOOL_CALLS (currently 7) we need to
// know whether the later rounds FIND anything or merely re-read: starving the
// detective degrades fixSiteAnalysis, which is what the write-time reuse guard
// now depends on. Cutting the wrong knob would trade cycle time for exactly the
// prescription quality we just built enforcement around.
//
// Writes one line per attempt to detective-rounds.jsonl. Never throws — this is
// measurement, and measurement must not be able to fail a run.
function recordDetectiveRound(logDir, row) {
  try {
    if (!logDir) return;
    fs.appendFileSync(path.join(logDir, 'detective-rounds.jsonl'),
      JSON.stringify({ ...row, timestamp: new Date().toISOString() }) + '\n');
  } catch { /* telemetry must never break the pass */ }
}

// checkFixSiteCoverage(findings, verificationCriteria) — deterministic (no
// LLM) check: does ANY finding's file/function/reason/fix text share a
// meaningful term with each verification criterion, or does a VC describe
// something no finding touches at all?
//
// The detective's prompt is single-causal-site framed ("PRESCRIBE THE
// MINIMAL FIX" against a "bug ticket") — correct for a one-line defect, but
// it under-scopes a multi-layer feature. Live AMSD-2041, 2026-08-01: the
// detective named only 2 files (an SDK client's config + a context provider's
// reactive rewiring) while team-lead review caught 6+ more blockers sharing
// no term with either finding — an uninstalled dependency, new fields on
// query/entry interfaces, a missing API route, missing page-level wiring, and
// missing tests. None of that was ever flagged as missing; the implementer
// was handed a prescription that was silently incomplete, then given the
// tiny "prescribed fix" iteration floor on top of it (see
// resolve_brownfield_effort_floor).
//
// This does not try to re-diagnose the story — it only flags VCs whose
// wording is entirely absent from what the detective found, so downstream
// budget/prompt logic can react to a known gap instead of an invisible one.
// readLatestDetectivePlan(logDir, phase, storyId) — best-effort read of the plan the
// code-graph-detective wrote for THIS story via ai-run.sh's plan-execute mechanism
// (ai-run.sh:298-374, plans-<phase>.jsonl). Takes the LATEST matching entry so a
// ladder-escalated retry's plan is what gets checked against the final answer, not a
// stale first attempt. Returns null on any failure (file absent — plan-execute disabled
// or Langfuse-only fallback path; nothing parses) — this must never break the detective
// pass it is only auditing.
function readLatestDetectivePlan(logDir, phase, storyId) {
  try {
    if (!logDir) return null;
    const p = require('path').join(logDir, `plans-${phase || 'unknown'}.jsonl`);
    const lines = require('fs').readFileSync(p, 'utf8').split('\n').filter(Boolean);
    let latest = null;
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row && row.agent === 'code-graph-detective' && row.story === storyId && typeof row.plan === 'string') {
        latest = row.plan;
      }
    }
    return latest;
  } catch { return null; }
}

// checkPlanExecutionAlignment(planText, findings) — deterministic (no LLM), term-overlap
// check: does the detective's OWN stated plan share vocabulary with its OWN final answer?
//
// Confirmed empirically 2026-08-05 on AMSD-2041: three separate detective runs each
// planned to investigate `useContent` ("I'll trace useContent to its definition and
// callees... the fix likely belongs in the content-fetching layer"), then landed on
// completely different final files — none of them useContent — sharing no term with the
// plan. The execute-phase prompt explicitly permits abandoning the plan ("If carrying out
// the plan showed it to be wrong, say so and answer correctly rather than following it"),
// but nothing checked whether that happened, so the drift was invisible. This does not
// try to force the model to follow its plan — a plan legitimately can turn out wrong once
// real exploration starts, and a plan that says so ("useContent turned out to be wrong,
// pivoting to X") is aligned by construction, since X then appears in the plan text too.
// It only makes an UNEXPLAINED divergence observable.
function checkPlanExecutionAlignment(planText, findings) {
  const plan = String(planText || '').trim();
  const findingList = Array.isArray(findings) ? findings : [];
  if (!plan || findingList.length === 0) return { aligned: true, planTerms: [], findingTerms: [] };

  // High-signal terms only — the detective's own prompt style consistently backtick-quotes
  // the symbols/files it names ("I'll trace `useContent` to its definition"), and a
  // camelCase/PascalCase identifier is itself distinctive. Generic prose words (the plan's
  // and the finding's "reason" text both being about the same feature) trivially share
  // topic vocabulary ("content", "preview") and would false-positive on every comparison —
  // this is the same reason checkFixSiteCoverage filters recurring topic terms, just done
  // here by only ever looking at identifier-shaped tokens in the first place.
  const backticked = (s) => [...String(s || '').matchAll(/`([A-Za-z_][A-Za-z0-9_.]*)`/g)].map((m) => m[1]);
  const camelOrPathLike = (s) => (String(s || '').match(/\b[A-Za-z_][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*\b|[A-Za-z0-9_-]+\.[a-z]{2,4}\b/g) || []);
  const norm = (t) => t.toLowerCase().replace(/\.[a-z]{2,4}$/i, '').replace(/[^a-z0-9]/g, '');

  const planIdents = [...new Set([...backticked(plan), ...camelOrPathLike(plan)].map(norm).filter((t) => t.length >= 4))];
  const findingIdents = [...new Set(
    findingList.flatMap((f) => [
      ...backticked(f.file), ...camelOrPathLike(f.file),
      ...backticked(f.function), ...camelOrPathLike(f.function),
      f.function || '',
      (f.file || '').split('/').pop() || '',
    ]).map(norm).filter((t) => t.length >= 4)
  )];
  // A plan with no identifiable symbol/file names (pure prose) has nothing concrete to
  // check — that is not evidence of misalignment, only of an unstructured plan.
  if (!planIdents.length) return { aligned: true, planTerms: planIdents, findingTerms: findingIdents };

  const aligned = planIdents.some((pt) =>
    findingIdents.some((ft) => ft === pt || ft.includes(pt) || pt.includes(ft))
  );
  return { aligned, planTerms: planIdents, findingTerms: findingIdents };
}

/**
 * The coverage check as the pipeline actually calls it: findings, criteria and the derived
 * vocabulary, pulled off one story.
 *
 * This exists because the argument list was written out twice and the two copies disagreed.
 * The main path was missing a comma between the second and third arguments, so it read as
 * `verificationCriteria || ([](...).guardVocabulary)` — valid JavaScript that silently passed
 * TWO arguments. With no vocabulary checkFixSiteCoverage returns `complete: null`, and
 * claude.sh maps null to true, so the coverage gate was fail-open on every run while
 * appearing to work. With no criteria at all the same expression CALLS the array literal and
 * throws. One call site, executed by a test, instead of two hand-written argument lists.
 */
function coverageForStory(story) {
  const s = story || {};
  return checkFixSiteCoverage(
    s.fixSiteAnalysis || [],
    s.verificationCriteria || [],
    (s.specification || {}).guardVocabulary,
  );
}

function checkFixSiteCoverage(findings, verificationCriteria, vocabulary) {
  // THE WORD LIST IS DERIVED, NOT BAKED.
  //
  // This filtered "unimportant" words with a hardcoded English stopword list living in the
  // engine — the hardcoding rule's named example, and the thing that decided which criteria
  // counted as addressed. It also could not work: a list written in English scores criteria
  // phrased in a project's own domain language by raw word overlap.
  //
  // This pipeline already derives word lists with an agent, in context, per ticket — codeline
  // discovery reports terms that "carry no selection signal", and the guard-vocabulary agent
  // returns {blacklist, whitelist} at each guard seam. That derived vocabulary is the input
  // here.
  //
  // With no vocabulary there is NO VERDICT. Falling back to a guessed list would produce a
  // confident answer from nothing, and something downstream would trust it.
  const noise = new Set(
    (vocabulary && Array.isArray(vocabulary.blacklist) ? vocabulary.blacklist : [])
      .map((b) => String((b && b.term) || b || '').toLowerCase())
      .filter(Boolean),
  );
  if (!noise.size) {
    return {
      complete: null,
      uncoveredVerificationCriteria: [],
      reason: 'no derived vocabulary available — coverage not computed rather than guessed',
    };
  }

  const tokenize = (str) => (String(str || '').toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || [])
    .filter((t) => !noise.has(t));

  const findingList = Array.isArray(findings) ? findings : [];
  const findingTermSets = findingList.map((f) =>
    new Set(tokenize(`${f.file || ''} ${f.function || ''} ${f.reason || ''} ${f.fix || ''}`)),
  );
  const numFindings = findingList.length;
  const dfFindings = new Map();
  for (const set of findingTermSets) for (const t of set) dfFindings.set(t, (dfFindings.get(t) || 0) + 1);
  // A term in EVERY finding is the prescription's own recurring topic vocabulary — it cannot
  // prove a SPECIFIC criterion is addressed, since it would match almost anything about the
  // same work. Only meaningful once there are 2+ findings to compare.
  const isTopicNoise = (t) => numFindings >= 2 && dfFindings.get(t) === numFindings;

  const uncovered = [];
  for (const vc of (Array.isArray(verificationCriteria) ? verificationCriteria : [])) {
    const vcTerms = tokenize(vc).filter((t) => !isTopicNoise(t));
    if (!vcTerms.length) continue;
    const covered = findingTermSets.some((set) => vcTerms.some((t) => set.has(t)));
    if (!covered) uncovered.push(vc);
  }
  return { complete: uncovered.length === 0, uncoveredVerificationCriteria: uncovered };
}


// inferStoryKindHint(story) — a cheap, deterministic, zero-LLM-cost PRE-classification
// signal for the code-graph-detective, which runs BEFORE the real storyKind
// classification exists (see the comment at runCodeGraphDetective's call site: it runs
// early so downstream stages can ground on its findings). Reuses the exact trust
// direction already established downstream (line ~3273: "anchoring storyKind=defect...
// Jira ground truth") — a ticket Jira itself typed as "Bug" is almost always a genuine
// defect; anything else defaults to novel rather than guessing wrong in the more
// expensive direction (inventing a nonexistent "cause" for new work). This is a HINT the
// detective's own prompt tells it to trust ticket content over, not an override of the
// later authoritative SPEC_AGENT classification.
function inferStoryKindHint(story) {
  // WHICH TRACKER TYPES MEAN "DEFECT" IS PROJECT DATA, DECLARED WHERE THE PROJECT'S OTHER
  // FACTS ARE. This read `t === 'bug'`. That is this Jira's word; another says "Defect",
  // "Fault", "Incident", or a localised name — and there EVERY story classified novel, so the
  // detective was never asked for a causal site or a quoted broken line, real defects got the
  // feature contract, and grounding dropped from quotation to provenance. Silently: no gate,
  // no warning, just worse answers. That is the failure this step was built to prevent,
  // reachable through a config mismatch nobody would see.
  //
  // Undeclared means NOVEL, deliberately: inventing a cause for work that has none is the more
  // expensive error, and the one the reality anchor exists to prevent.
  const declared = String(process.env.EPAM_DEFECT_ISSUE_TYPES || '')
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!declared.length) return 'novel';
  const t = String((story && (story.issueType || story.issuetype)) || '').toLowerCase().trim();
  return t && declared.includes(t) ? 'defect' : 'novel';
}

/**
 * minEvidenceChars() — how short a quote stops being evidence.
 *
 * `if (needle.length < 8)` decided this. `a === b` is 7 characters and `x != y` is 6, so a
 * defect whose broken expression is genuinely short had every finding scored null, was judged
 * UNGROUNDED, and retried three times before passing through flagged — no config mismatch
 * required. Declared now, defaulting to the previous value so nothing changes silently.
 *
 * A malformed or zero declaration falls back to the default rather than to zero: zero would
 * accept "}" as evidence, which is worse than the constant it replaced.
 */
function minEvidenceChars() {
  const DEFAULT = 8;
  const n = Number(process.env.EPAM_MIN_EVIDENCE_CHARS);
  return Number.isFinite(n) && n > 1 ? n : DEFAULT;
}

// A rejection-driven re-invocation (the SPEC_REVIEW corrective re-call below)
// must count against the agent's own inference ladder, exactly like Step
// 3.6's writer re-implementation and team-lead-review.sh's own review-agent
// ladder now do (2026-08-06, "the ladder logic applies to ALL agents, not
// only Step 3.6"). ai-run.sh resumes an agent's ladder across separate
// process invocations automatically (see lib/story-retry-state.sh), but only
// for escalations IT decided on internally (a transport-level failure) — it
// has no way to know a reviewer rejected a call that technically succeeded.
// Shells out to the real bash helper (not a JS reimplementation) so the key
// derivation can never drift from what ai-run.sh itself reads.
function advanceAgentLadderEscalation(logDir, agentName, storyId) {
  if (!logDir) return;
  try {
    const lib = path.join(__dirname, 'lib', 'story-retry-state.sh');
    execSync(
      `source ${JSON.stringify(lib)}; ` +
      `key="$(ai_ladder_state_key ${JSON.stringify(agentName)} ${JSON.stringify(storyId || 'global')})"; ` +
      `advance_ladder_escalation ${JSON.stringify(logDir)} "$key"`,
      { shell: '/bin/bash', stdio: 'ignore' },
    );
  } catch { /* best-effort — a failed advance must never block the corrective call itself */ }
}

/**
 * detectivePrescription(kind) — what the detective is asked to PRODUCE.
 *
 * A defect and a feature need different answers, and asking a feature for a defect's answer
 * gets half the work. Live 2026-08-08 (AMSD-2041): the detective returned ONE fix site — the
 * SDK init — for a story that also needs a provider wrapped around the app and a refresh
 * callback wired into every fetch surface. The pipeline flagged it ("Single fix site
 * prescribed but work spans 5+ files across 3 codelines") and proceeded anyway.
 *
 * That was the CONTRACT, not the model. The prompt demanded "the MINIMAL FIX", "the SMALLEST
 * change", "STOP as soon as you identify the file that computes the wrong value", and a
 * machine-verified brokenLine quoted from the file. Nothing is broken in a feature, so the
 * only site expressible under those rules is the one place existing code is touched — every
 * other layer is unsayable.
 *
 * A kind hint already existed and the prompt branched on it for ONE paragraph; the forty
 * lines after it applied unconditionally, so the defect contract won on a story already
 * classified novel.
 *
 * Unknown kinds take the NOVEL contract: inventing a cause for work that has none is the more
 * expensive error, and the one the reality anchor exists to prevent.
 */
function detectivePrescription(kind) {
  if (kind === 'defect') {
    return `CONVERGE FAST — HARD LIMIT: 6 tool calls total. This is not a suggestion.
By your 6th tool call you MUST stop querying and emit the JSON answer with your BEST current hypothesis. Exploring past 6 calls WITHOUT emitting the JSON means you FAIL and every bit of your investigation is thrown away — a best-guess fix site is infinitely better than no answer. If you are unsure, pick the single most likely file/function from what you have seen and emit it now; do NOT keep exploring to be "sure".
1. First call: \`explore\` with the DOMAIN NOUNS only (drop symptom/presentation words like displayed/shown/email/confirmation/expected).
2. Look at the top-ranked symbols. If the top hit's file only READS the wrong field (a mapper/sanitizer/display file), do ONE \`callers\` or \`callees\` (or one more \`explore\` toward the mechanism) to reach the code that COMPUTES/ASSIGNS it.
3. As SOON as you identify a file whose function body actually computes/assigns the wrong value, STOP tracing and switch to prescribing the fix (step 4). Aim to finish tracing in 2-4 tool calls, never more than 6.
4. PRESCRIBE THE MINIMAL FIX. This is the most important output. For the causal site:
   - Name the EXACT broken line/expression (e.g. \`lineItem.id === discount.lineItemId\`) and why it is wrong.
   - State the SMALLEST change that corrects it. Do NOT describe a re-architecture, a new abstraction, or a "split/recalculate/add-a-field" scheme unless the code genuinely has no simpler fix. Prefer a one-line/one-expression change.
   - LOCATE AN EXISTING HELPER instead of inventing new logic. Before proposing any new function, use \`explore\` (and \`callers\`/\`callees\`) to search for an already-present util/helper/parser in this repo that does the needed transform (e.g. a key parser, id normalizer, formatter). If one exists, your fix MUST name it (exact symbol + its import path) and reuse it. Writing novel code when a helper already exists is a defect.


SHOW THE BROKEN CODE — "brokenLine" is REQUIRED and is machine-verified. Quote the EXACT source expression, copied verbatim from the file you name, that is wrong today. It is checked against that file's real contents: if what you quote is not in the file, your answer is rejected as ungrounded and you will be asked again. This is the difference between a diagnosis and a guess — a confident story about code that is not there reads exactly like a correct one until this check runs. If you cannot point at a real line that is wrong, you have not found the cause yet: go back to the tool and trace further.

`;
  }
  return `CONVERGE FAST — HARD LIMIT: 6 tool calls total. This is not a suggestion.
By your 6th tool call you MUST stop querying and emit the JSON answer. A partial map of the attachment points is infinitely better than no answer.
1. First call: \`explore\` with the DOMAIN NOUNS only (drop symptom/presentation words).
2. NOTHING IS BROKEN HERE. This story asks for a capability that does not exist yet, so there is no wrong value to trace and no line to quote. Do not hunt for a cause — you will invent one.
3. FIND EVERY PLACE THIS WORK MUST TOUCH. This is the most important output, and returning only ONE is the known failure of this step. A new capability almost never lands in a single file. Trace the SHAPE of it through this repository, in whatever terms this repository uses:
   - WHERE IT IS SET UP — the place the thing being enabled is created, configured or registered. Start here.
   - WHAT CARRIES IT — anything between that setup and the code that uses it: a shared module, a wrapper, an app-wide registration, a passed-down value. There may be none; there may be several.
   - EVERYWHERE IT IS USED — every place that reads the affected data or must react when it changes. There is usually MORE THAN ONE. Name them all.
   Do not force this repository into a shape it does not have, and do not skip a place because it has no obvious name. Describe each site in the vocabulary the codebase itself uses, which you have seen in the tool output — not in the vocabulary of some other project's architecture.
4. COVER THE ACCEPTANCE CRITERIA. Read them again and check your site list against them: every criterion describing observable behaviour needs a site where that behaviour becomes possible. A criterion with no corresponding site means your map is incomplete — go back and find it.
5. NAME WHAT TO REUSE at each site — whatever already exists there that the implementation should build on rather than duplicating. Use \`explore\`/\`callers\`/\`callees\` to find it; you cannot reuse what you have not found.
6. \`brokenLine\` is NOT required for this story and must be left "" — there is no broken expression to quote.
7. DO NOT INVENT A PATH OR A SYMBOL. Your grounding here is provenance, not a quoted line: every file and symbol you name must have been returned to you by a tool. If you believe something exists and the tools did not show it, PROVE it with ripgrep-search.sh before naming it, or report it absent.

`;
}

/**
 * detectiveCorrectionNeeded({review, coverage, brownfield}) — should the detective be
 * re-invoked once, and what should it be told?
 *
 * Two signals, one bounded correction:
 *
 *   1. The reviewer judged the detective's answer diverged from its own plan with no stated
 *      reason. This trigger already existed and works.
 *   2. Verification criteria that NO prescribed fix site addresses. This was computed, stored
 *      next to the verdict, and consumed by nothing. Live 2026-08-08 (AMSD-2041): three lanes
 *      reported uncovered criteria — including the real-time subscription the whole feature
 *      depends on — and the run reached the writer gate with a manifest missing it. The
 *      observation surfaced only as a line item in the COST estimate.
 *
 * Same lesson as the roster reviewer: findings nothing consumes make a critic, not a gate.
 *
 * An UNMEASURED gap is not a gap. coverage.complete === null means no derived vocabulary was
 * available so coverage was never computed; correcting against that spends a model call
 * chasing nothing.
 *
 * The uncovered criteria travel WITH the decision: "try again" re-samples the same answer,
 * and the detective can only close a gap it is told about.
 */
function detectiveCorrectionNeeded({ review, coverage, brownfield } = {}) {
  const none = { correct: false, reasons: [], uncovered: [] };
  if (!brownfield) return none;

  const reasons = [];
  if (review && review.planAlignment === 'unexplained_mismatch') {
    reasons.push('the answer diverged from its own plan with no stated reason');
  }

  const uncovered = (coverage && coverage.complete === false
    && Array.isArray(coverage.uncoveredVerificationCriteria))
    ? coverage.uncoveredVerificationCriteria
    : [];
  if (uncovered.length) {
    reasons.push(`${uncovered.length} verification criterion/criteria have no prescribed fix site`);
  }

  return { correct: reasons.length > 0, reasons, uncovered };
}

/**
 * renderDetectiveCorrection(ctx) — what a re-invoked detective is TOLD.
 *
 * Two kinds of correction, and the second was missing entirely: the block rendered the prior
 * plan, the prior findings and the reviewer's note, and dropped the uncovered criteria on the
 * floor. Carrying them in the decision object is not enough — a correction the agent is never
 * told about is a re-sample of the same answer.
 *
 * The uncovered criteria are quoted VERBATIM, and the instruction is additive: keep the sites
 * already found and add the ones that close these gaps. A correction that starts over trades
 * one gap for another.
 */
function renderDetectiveCorrection(ctx) {
  if (!ctx) return '';
  const uncovered = Array.isArray(ctx.uncoveredCriteria) ? ctx.uncoveredCriteria.filter(Boolean) : [];

  const planPart = (ctx.reviewNotes || ctx.priorPlan)
    ? `\nYOUR PREVIOUS ANSWER FOR THIS TICKET WAS REJECTED. Your previous plan was:\n"${ctx.priorPlan || '(no plan recorded)'}"\nYour previous final answer was:\n${JSON.stringify(ctx.priorFindings || [], null, 2)}\n${ctx.reviewNotes ? `The reviewer's reason: "${ctx.reviewNotes}"\nAddress this explicitly: either explain why your plan was wrong and justify the new direction, or return to what your plan identified. Do not silently repeat the same unexplained jump.\n` : ''}`
    : '';

  const coveragePart = uncovered.length
    ? `\nYOUR PREVIOUS ANSWER LEFT WORK UNACCOUNTED FOR. These verification criteria describe behaviour that NO site you named would produce:\n${uncovered.map((c) => `  - ${String(c)}`).join('\n')}\n\nEach one needs a place where that behaviour becomes possible. KEEP the sites you already found — they were not rejected — and ADD the ones that close these gaps. If a criterion genuinely needs no code change, say which and why; do not silently drop it. If it needs something that does not exist yet, name where it must be created and what it attaches to.\n`
    : '';

  return planPart + coveragePart;
}

/**
 * detectiveAnswerIsGrounded({findings, kind}) — is this answer backed by real code?
 *
 * GROUNDING MEANS DIFFERENT THINGS FOR THE TWO CONTRACTS, and the validator did not know that.
 * It required `evidenceVerified === true` — a quoted expression found in the named file — for
 * every story. The novel prescription tells the detective to leave `brokenLine` empty, because
 * a feature has nothing broken to quote. So a CORRECT novel answer scored zero grounded
 * findings, was rejected as UNGROUNDED, and was re-tried three times before being passed
 * through flagged. Live 2026-08-08 on AMSD-2041, three model calls per story to fail a check
 * that could not pass.
 *
 * That is the same defect as the prompt had, committed while fixing it: the demand was moved
 * out of the instructions and left in the enforcement.
 *
 * A feature IS groundable, just not by quotation:
 *   - defect: a quoted expression that really is in the file it names.
 *   - novel:  PROVENANCE — the files it names exist. That is what the novel prompt asks for
 *             ("every file and symbol you name must have been returned to you by a tool"), so
 *             it is what this checks. A verified quote also grounds a novel answer; it is
 *             welcome, merely not required.
 *
 * Unknown kind is judged as novel: demanding a quote for work that has none is the failure
 * this exists to prevent.
 */
function detectiveAnswerIsGrounded({ findings, kind } = {}) {
  const list = Array.isArray(findings) ? findings : [];
  if (!list.length) return { grounded: false, reason: 'no findings at all' };

  if (kind === 'defect') {
    const quoted = list.filter((f) => f && f.evidenceVerified === true);
    return quoted.length
      ? { grounded: true, reason: `${quoted.length} finding(s) quote code verified in the file they name` }
      : {
        grounded: false,
        reason: list.some((f) => f && f.evidenceVerified === false)
          ? 'the quoted code is not in the file it names — a diagnosis about code that is not there'
          : 'no finding quoted an existing broken expression, and a defect must name the wrong line',
      };
  }

  // novel (and anything unrecognised)
  if (list.some((f) => f && f.evidenceVerified === true)) {
    return { grounded: true, reason: 'a finding quotes code verified in the file it names' };
  }
  const phantom = list.filter((f) => f && f.fileVerified === false);
  if (phantom.length) {
    return {
      grounded: false,
      reason: `${phantom.length} finding(s) name a file that does not exist in this codeline — invented, not investigated`,
    };
  }
  const real = list.filter((f) => f && f.fileVerified === true);
  return real.length
    ? { grounded: true, reason: `${real.length} finding(s) name files that exist — provenance, the grounding a feature has` }
    : { grounded: false, reason: 'no finding names a file that could be confirmed to exist' };
}

// runCodeGraphDetective(story, logDir) — invokes the code-graph-detective
// agent: a tool-using LLM (GLM-5.1, upper-tier ladder) that iterates CodeGraph
// queries and traces callers to find the CAUSAL fix site for a symptom-worded
// bug ticket. This is the ROBUST path (proven live 2026-07-23, AMSD-1820):
// deterministic single/union queries reliably surface only the display layer
// the symptom words describe; only judgment-driven iteration + caller-tracing
// converges on the cause. Returns an array of repo-relative fix-site files
// (may be empty). Best-effort: any failure (no repo, tool unavailable, parse
// error, timeout) returns [] so the spec pass proceeds unblocked.
async function runCodeGraphDetective(story, logDir, opts = {}) {
  if (process.env.EPAM_BROWNFIELD !== '1') return [];
  const repoPath = resolveCodelinePath(story);
  if (!repoPath || !fs.existsSync(repoPath)) return [];
  // Ensure the index exists (and is git-clean-protected) before the agent queries it.
  try { if (!_codegraph) _codegraph = require('./lib/codegraph-context'); _codegraph.ensureIndexed(repoPath); } catch { /* tool self-heals too */ }

  const profiles = (() => {
    try {
      const p = path.join(automationDirFromLogDir(logDir), 'agents', 'profiles.json');
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { return {}; }
  })();
  // THE CODELINE'S OWN DETECTIVE, WHEN ONE WAS MINTED FOR IT.
  //
  // The roster mints one investigator per codeline, briefed on that repository's layout,
  // conventions and the dependencies that matter in it. A lane uses its own; the canonical
  // code-graph-detective remains the fallback for a codeline with none, and for greenfield.
  //
  // Looked up BY CODELINE, never by position: two lanes running the same story must not be
  // able to pick up each other's investigator. A detective briefed on another repository is
  // the contamination this per-codeline split exists to prevent.
  const _mintedDetective = (() => {
    try {
      const agentsDir = path.join(automationDirFromLogDir(logDir), 'agents');
      // The lane's own codeline first. The lane PRD now stamps story.codeline with the lane
      // it belongs to, so both agree — but EPAM_CODELINE is set by the lane loop itself and
      // cannot be stale, and this is the seam where reading the wrong one silently briefs an
      // investigator on another repository.
      const cl = process.env.EPAM_CODELINE
        || (story && story.codeline)
        || process.env.JIRA_DEFAULT_CODELINE || '';
      const _roster = require('./lib/agent-roster.js');
      const name = _roster.investigatorForCodeline(agentsDir, cl);
      if (name && profiles[name]) return { name, brief: profiles[name] };

      // A MISS HERE IS NOT THE SAME AS "NONE WAS MINTED", AND IT USED TO LOOK IDENTICAL.
      //
      // The caller falls back to the generic code-graph-detective, which is correct when this
      // project minted no investigators at all. It is a DEFECT when investigators exist and
      // none of them answers to this codeline — that means the registry and the lane disagree
      // about what the codeline is called. Live 2026-08-08: the mint keyed the registry one
      // way, discovery re-ran across a pause and rewrote the PRD another way, and all three
      // lanes fell through to the generic detective. Nothing said so; the only signal was the
      // ABSENCE of a log line, and three freshly minted per-codeline briefs went unused.
      const _registered = _roster.projectInvestigators(agentsDir);
      if (_registered.length) {
        console.warn(
          `spec-mode: NO INVESTIGATOR for codeline '${cl}' — ${_registered.length} investigator(s) ` +
          `are registered (${_registered.join(', ')}) but none is bound to this codeline. ` +
          'Falling back to the generic detective, so this lane runs WITHOUT its per-codeline ' +
          'brief. This is a codeline-naming mismatch between the roster and the run.',
        );
      } else if (name) {
        console.warn(
          `spec-mode: investigator '${name}' is registered for codeline '${cl}' but has no brief ` +
          'in profiles.json — falling back to the generic detective.',
        );
      }
      return null;
    } catch { return null; }
  })();
  const detectiveProfile = _mintedDetective
    ? _mintedDetective.brief
    : (profiles['code-graph-detective'] || '');
  if (_mintedDetective) {
    console.log(`spec-mode: detective for ${(story && story.codeline) || 'story'} = ${_mintedDetective.name} (minted for this codeline)`);
  }
  const scriptDir = path.join(__dirname); // orchestrations/scripts
  const toolPath = path.join(scriptDir, 'codegraph-agent-query.sh');

  // Activity emit — the detective is a first-class agent (it picks the fix site + helper) and
  // MUST be visible in agent-activity.html like every other agent. It emitted nothing before,
  // so it was invisible in the dashboard (found 2026-07-24). Start now; complete/fail at the returns.
  const _detMon = path.join(scriptDir, 'update-monitor.sh');
  const _detPhase = process.env.PHASE || story.codeline || 'spec';
  const _detEmit = (type, message) => emitMonitorEvent({ monitorScript: _detMon, type, message, storyId: story.id, role: 'code-graph-detective' });
  await _detEmit('spec_update', `[${_detPhase}] code-graph-detective started on ${story.id} — tracing the causal fix site`);

  // Step 1 of the method below needs no judgement, so it is already done — see
  // precomputeDetectiveExplore(). Spending a scarce iteration on a query we can
  // compute deterministically is pure waste on a model that keeps exhausting
  // its budget.
  // Derive the search vocabulary before seeding: the agent proposes candidate terms from
  // the ticket and VERIFIES each against this repo's CodeGraph index, so a rare-but-
  // meaningless token (a brand tag, a label) cannot be amplified by IDF into a top
  // discriminator. Best-effort at THIS seam only: unlike the VC/AC guards, a missing
  // vocabulary here does not check nothing — it means an unfiltered query, which is the
  // pre-existing behaviour. Aborting a run because a search hint could not be refined
  // would be a worse failure than a noisier first explore.
  let _searchVocab = null;
  try {
    _searchVocab = await deriveGuardVocabulary({
      promptExec: opts.promptExec || null,
      rule: SEARCH_TERM_RULE,
      statements: [story.title || '', String(story.description || '')].filter(Boolean),
      story,
      findings: [],
      manifestFiles: [],
      logDir,
      seam: 'search-query',
      repoPath,
      codegraphTool: toolPath,
    });
  } catch (err) {
    console.warn(`spec-mode: search-term vocabulary unavailable for ${story.id} (${err && err.message}) — seeding with an unfiltered query`);
  }
  const preseed = precomputeDetectiveExplore(repoPath, story, toolPath, process.env, _searchVocab);
  const preseedBlock = preseed
    ? `\nYOUR FIRST \`explore\` HAS ALREADY BEEN RUN FOR YOU — these are its real results (domain nouns only, symptom/presentation words stripped). Treat this as call 1 of your budget; do NOT re-run it. Start from step 2: decide whether the top hit COMPUTES the wrong value or only READS it, and trace from there.\n\n=== PRE-COMPUTED \`explore\` RESULTS ===\n${preseed}\n=== END PRE-COMPUTED RESULTS ===\n`
    : '';

  const _kindHint = inferStoryKindHint(story);
  const _kindHintBlock = _kindHint === 'defect'
    ? `\nJIRA CLASSIFIES THIS AS A DEFECT (issue type: Bug). This is a HINT, not a certainty — if the ticket's own text below clearly describes a capability that does not exist yet rather than broken existing behavior, trust the ticket over this hint. Assuming defect: there IS an existing bug and an existing symptom. Your job is the CAUSE, not the symptom (see CORE PRINCIPLE below).\n`
    : `\nJIRA DOES NOT CLASSIFY THIS AS A BUG (issue type: ${story.issueType || story.issuetype || 'unset'}). This is a HINT, not a certainty — if the ticket's own text below clearly describes existing behavior that is wrong, trust the ticket over this hint. Assuming novel: there is likely NO existing bug and no wrong value to trace. Inventing a "cause" for a capability that does not exist yet produces a confident wrong answer. Your job is the ATTACHMENT POINT — the existing file/function/provider/hook/route/component this new capability must plug into, and anything already present the implementation should REUSE — not a fix site.\n`;

  // CORRECTIVE CONTEXT — set only on a Step 4 re-invocation after SPEC_REVIEW flagged
  // planAlignment: "unexplained_mismatch" for this story's FIRST answer. Mirrors the
  // existing PRIOR COORDINATOR FLAGS pattern (openspec/speckit re-elaboration, line
  // ~3273) — the same feedback shape this file already trusts, applied to the detective.
  const correctiveContext = renderDetectiveCorrection(opts.correctiveContext);

  const prompt = `${detectiveProfile ? detectiveProfile + '\n\n' : ''}You are investigating this ticket. The repository is at: ${repoPath}
${_kindHintBlock}${correctiveContext}
TICKET (read it, then decide for YOURSELF which few domain nouns matter — do not treat every word as a search term):
Title: ${story.title || ''}
${story.description ? 'Description: ' + String(story.description) + '\n' : ''}Acceptance criteria:
${(story.acceptanceCriteria || []).map((a) => '- ' + String(a)).join('\n')}

Your CodeGraph tool is the shell script at: ${toolPath}
Invoke it with the Bash tool, always passing PROJECT_ROOT:
  PROJECT_ROOT="${repoPath}" bash "${toolPath}" explore <domain nouns>
  PROJECT_ROOT="${repoPath}" bash "${toolPath}" callers <SymbolName>
  PROJECT_ROOT="${repoPath}" bash "${toolPath}" callees <SymbolName>
  PROJECT_ROOT="${repoPath}" bash "${toolPath}" show <file> [startLine] [endLine]

${preseedBlock}
${detectivePrescription(_kindHint)}
READ THE FILE BEFORE YOU QUOTE IT. Once you have a candidate file, run \`show <file>\` and look at the real lines. Your "brokenLine" must be COPIED EXACTLY from that output — it is checked character-for-character against the file, after whitespace normalisation. Do NOT reconstruct the line from symbol names: on 2026-07-26 that produced \`lineItemKey === orderLineItem.id\`, a plausible-looking expression using an identifier that exists nowhere in the repository, and the answer was rejected. \`show\` accepts a line range so you can read just the region you care about.

CRITICAL REALITY ANCHOR: if the CodeGraph tool does not return a file or symbol, it does NOT exist in this codebase. Do not infer, assume, or extrapolate file paths, function signatures, or variable names from naming patterns — that is exactly how \`lineItemKey\` was invented. The index answers only for what it parsed, so a miss is a question, not an answer. If you believe something exists and CodeGraph did not return it, PROVE it before reasoning about it:

    bash orchestrations/scripts/ripgrep-search.sh --string "<exact symbol>" [--glob "*.ts"]
    bash orchestrations/scripts/ripgrep-search.sh --file "<part of a filename>"

If your fix calls a method or function from a THIRD-PARTY package (not this repo's own code), a name existing somewhere in that package is not the same as it being the RIGHT way to call it — a symbol can be a real, internal implementation detail the package's own docs never call directly, or a static class method vs. an instance method, and picking the wrong one produces code that type-checks and fails at runtime. PROVE the real shape before naming it:

    bash orchestrations/scripts/resolve-package-symbol.sh "<package name>" "<method or function name>"

It reports whether the symbol is a direct/static call or needs an instance, and surfaces the package's own documented usage examples (README and JSDoc) so you can prefer the intended pattern over an internal detail that happens to exist.

That searches the real working tree, so a hit is ground truth and "NOT FOUND" is definitive absence. If both tools come back empty, the thing does not exist — say so and revise your hypothesis. Never write a name into your answer that no tool has shown you.

CRITICAL — HOW TO ANSWER: Emit the JSON array as TEXT directly in your reply. Do NOT call WriteFile and do NOT write your answer to any file — the pipeline reads your reply text, not a file. If you write your answer to a file, it is LOST and the whole investigation is wasted. Use the Bash tool ONLY to run the CodeGraph query script above (including its \`show\` subcommand, which you MUST use before quoting a line); use no other tool.

NAME THE FORMAT, DO NOT DESCRIBE IT. If your fix depends on the SHAPE of a string — a prefix, suffix, separator, delimiter — you must QUOTE THE EXACT LITERAL (e.g. '#') or name the constant that defines it (e.g. DIVIDER). Saying "a prefix match that accounts for the suffix" without stating the suffix is not implementable: on 2026-07-26 exactly that wording made the implementer guess '-' where the repository uses '#', and the fix could never match. This is machine-checked.

PREFER THE PARSER OVER THE WRITER. If a helper CONSTRUCTS the value (getX/buildX/toX) and another READS it (parseX/fromX), prescribe the reader. Naming the writer invites the implementer to reconstruct the format by hand — which is how the above happened. The best fix does no string surgery at all, because the helper owns the format.

VERIFY THIRD-PARTY METHOD CALLS with resolve-package-symbol.sh before prescribing them (see above) — a name existing in a package is not proof it is called the way you assume.

DECLARE ANY PACKAGE YOUR FIX NEEDS — "requiredPackages" is REQUIRED and is machine-verified. List the BARE package names, exactly as they appear in this project's manifest (e.g. "some-sdk", "@scope/pkg"), for every third-party package your fix imports or configures. Use [] when the fix needs none — that is the common case and is not a failure. Each name is checked against what this codeline actually declares and installs: a package that is not there means your fix CANNOT be implemented as written, and prescribing it produces a change that type-checks, passes tests, and fails for a real user. Prefer a fix built on what is already installed; if the work genuinely requires a package this project does not have, still declare it — that is the honest answer and the pipeline needs to see it, whereas an approach invented to avoid naming it is the failure this field exists to prevent.

Output ONLY a JSON array (no prose, no markdown fences), then stop. The "fix" field is REQUIRED and must be a concrete, minimal instruction naming the exact change and any existing helper to reuse. The "helper" field must be the BARE SYMBOL NAME of the existing function you are telling the implementer to reuse (so it can be machine-verified to actually exist) — leave it "" if the fix genuinely needs no existing helper. Do NOT invent a helper name; only put a symbol you actually saw in the tool output:
[{"file":"<repo-relative path>","function":"<symbol>","reason":"<why THIS computes the value, not just displays it>","brokenLine":"<the exact existing expression that is wrong, copied verbatim from that file>","fix":"<the exact minimal change: which line/expression to change, to what, and which EXISTING helper (symbol + import path) to reuse — never 'write a new function' if one already exists>","helper":"<bare existing symbol name to reuse, or empty>","requiredPackages":["<bare package name this fix needs>"]}]`;

  // Model ladder — cohesive with openspec/speckit (which escalate to their HIGH
  // model on retry). Attempt 1 uses the base HIGH model (glm-5.1); a retry
  // escalates up the HIGH ladder (glm-5.1 → kimi-k3 per EPAM_MODEL_LADDER_HIGH),
  // resolving that model's provider from EPAM_MODEL_PROVIDER_MAP. This is the fix
  // for the detective hanging on one model in-pipeline (a slow/stuck glm-5.1
  // endpoint no longer dead-ends — the retry moves to a stronger model on
  // possibly-different infra). A single hard-pinned model was the non-cohesive
  // gap vs the rest of the pipeline.
  const runnerCmd = process.env.AI_RUNNER_CMD || path.join(scriptDir, 'ai-run.sh');
  const baseModel = process.env.SPEC_MODE_OPENSPEC_MODEL_HIGH || process.env.ESCALATION_MODEL_HIGH || 'z-ai/glm-5.1';
  const baseProvider = resolvePromptProvider(process.env);
  const escalatedModel = ladderNextModel(baseModel, process.env);
  const escalatedProvider = escalatedModel
    ? (resolveModelProvider(escalatedModel, process.env) || baseProvider)
    : null;
  const execFor = (attempt) => {
    // attempt 1 → base HIGH model; attempt 2+ → ladder successor (if any).
    const useEscalated = attempt >= 2 && escalatedModel;
    const m = useEscalated ? escalatedModel : baseModel;
    const p = useEscalated ? escalatedProvider : baseProvider;
    return { exec: { cmd: runnerCmd, args: ['--provider', p, '--model', m] }, model: m, escalated: !!useEscalated };
  };
  const logPath = logDir ? path.join(logDir, `${story.id}-codegraph-detective.log`) : null;

  // Extract the findings array from the (possibly chatty) agent output. Returns
  // null when NO JSON array is present at all — the signal that the model did
  // not actually answer (e.g. it wandered off and called WriteFile, returning
  // "The file has been written successfully" instead of the JSON). null → retry;
  // an explicit [] → the model's real answer of "no fix site".
  const parseFindings = (out) => {
    const m = out && out.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (!m) return null;
    let arr;
    try { arr = JSON.parse(m[0]); } catch { return null; }
    const seen = new Set();
    const findings = [];
    for (const h of (Array.isArray(arr) ? arr : [])) {
      if (!h || typeof h.file !== 'string') continue;
      const file = h.file.replace(/^\.?\//, '');
      if (!file || seen.has(file)) continue;
      seen.add(file);
      const helper = typeof h.helper === 'string' ? h.helper : '';
      const brokenLine = typeof h.brokenLine === 'string' ? h.brokenLine : '';
      findings.push({
        file,
        function: typeof h.function === 'string' ? h.function : '',
        reason: typeof h.reason === 'string' ? h.reason : '',
        fix: typeof h.fix === 'string' ? h.fix : '',
        helper,
        brokenLine,
        // true = named helper exists; false = named but not found (likely
        // hallucinated); null = no helper named. Only false downgrades the fix.
        fixVerified: verifyDetectiveHelper(helper, repoPath),
        // true = the quoted broken expression is really in the named file;
        // false = it is not (a diagnosis about code that does not exist —
        // the live 2026-07-26 failure); null = nothing quoted.
        evidenceVerified: verifyDetectiveEvidence(brokenLine, file, repoPath),
        // PROVENANCE. A feature has no broken line to quote, so "does the file you named
        // actually exist" is the grounding available to it — and it is the thing the novel
        // prompt asks for. true = present, false = named but absent (invented), null = could
        // not be checked.
        fileVerified: (() => {
          if (!file || !repoPath) return null;
          try { return fs.existsSync(path.resolve(repoPath, file.replace(/^\.?\//, ''))); }
          catch { return null; }
        })(),
      });
    }
    return findings;
  };

  // The detective is a LOAD-BEARING step for a brownfield defect: if it yields
  // nothing, the implementer gets symptom ACs with no root cause (the exact
  // pre-2026-07-23 failure). It must NOT fail silently. Found live 2026-07-23:
  // with tools enabled the model sometimes "answers" by calling WriteFile and
  // returns a tool-echo instead of the JSON — the old code swallowed that as a
  // silent []. Now: retry with a corrective note when the output carries no
  // JSON array, and log LOUDLY at every empty/failed step.
  // Default 3 attempts: base model, then two escalated (kimi-k3) tries — a
  // stuck/slow base endpoint gets a real second chance on a stronger model.
  const maxAttempts = Number(process.env.CODEGRAPH_DETECTIVE_MAX_ATTEMPTS || '3');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { exec, model: attemptModel, escalated } = execFor(attempt);
    if (escalated) {
      console.warn(`spec-mode: code-graph-detective ladder escalation for ${story.id} (attempt ${attempt}/${maxAttempts}) — model ${baseModel} → ${attemptModel}`);
    }
    const correctiveNote = attempt === 1 ? '' :
      `\n\nRETRY — your previous reply contained NO JSON array (you may have called a write tool). Emit ONLY the JSON array as text in THIS reply now. Do NOT call WriteFile or write to any file.`;
    const _roundStarted = Date.now();
    try {
      // PHASE 1 — EXPLORE (tools). A reasoning model reliably EXPLORES but does
      // NOT reliably switch to emitting structured JSON in the same turn: found
      // live 2026-07-23 it ended on a narrative "Now let me read the full X to
      // understand…" and hit the iteration cap mid-sentence, so there was no
      // JSON to parse/persist. So phase 1's job is just to INVESTIGATE; a
      // separate no-tools phase 2 does the structured output. If phase 1 happens
      // to already contain JSON (it sometimes does), we use it directly.
      const out = await runClaude(exec, prompt + correctiveNote, logPath, {
        AI_GATE_ALLOW_TOOLS: '1',           // enable tools so it can call the CodeGraph script via Bash
        // Output-token budget: the detective runs on a REASONING model (GLM-5.1)
        // whose <think> blocks count against the output budget. SPEC_MODE_MAX_
        // OUTPUT_TOKENS (6000) is tuned for non-reasoning spec elaboration and is
        // far too small here — the model exhausts it mid-reasoning and emits an
        // EMPTY result BEFORE writing the JSON (found live 2026-07-23: nailed the
        // fix on a run that fit under 6000, emitted nothing on a run that didn't —
        // the source of the detective's non-determinism). Floor it high so the
        // model has room to think AND write. Same class as claude.sh's
        // resolve_brownfield_effort_floor (24576) for the impl agent.
        EPAM_MAX_OUTPUT_TOKENS: process.env.CODEGRAPH_DETECTIVE_MAX_OUTPUT_TOKENS || '24576',
        // STRUCTURAL guard: the detective is read-only — it queries CodeGraph via
        // Bash and outputs JSON. Restricting it to `bash` means it CANNOT reach
        // write_file, so it can never "answer" by writing a file and losing its
        // real output (the live 2026-07-23 failure). Prompt wording alone did not
        // hold; this makes the failure structurally impossible. Inherited by the
        // grandchild `epam run` through runClaude's env merge (spawn env).
        EPAM_ALLOWED_TOOLS: process.env.CODEGRAPH_DETECTIVE_ALLOWED_TOOLS || 'bash',
        PROJECT_ROOT: repoPath,
        // Iteration budget. HARD-WON lesson (2026-07-23): a GENEROUS cap is
        // actively harmful here. At 40 the model THRASHED — 40 tool calls,
        // 680K input tokens, ~$0.17, and it hit the cap returning "Agent reached
        // maximum iterations" with NO fix (the real cause of the detective's
        // empty output). A free-form loop lets glm-5.1 explore forever instead
        // of committing. A TIGHT cap + the prompt's "output your best guess by
        // call 6" forces it to decide (it converges in a few calls when it does
        // converge — proven live). 10 = 6 tool calls + room to write the JSON.
        // B21 (2026-07-24): was 10, which exhausted on THREE consecutive runs —
        // "reached maximum iterations (10)" appears 16 times in today's logs, every
        // one the detective — forcing a glm-5.1 -> kimi-k3 ladder escalation each
        // time. A SUCCESSFUL pass used 7 round-trips, so 10 sat right on the
        // boundary: the top-of-ladder model fits, the cheaper one does not, and we
        // paid the escalation on every run. 20 is ~2x the observed need and still
        // BOUNDED — a runaway agent must terminate, and the ladder + self-heal
        // remain the backstop rather than being replaced by a bigger budget.
        // Raised 20 -> 25 on 2026-07-24: 20 still exhausted on a self-heal retry pass.
        EPAM_MAX_ITERATIONS: process.env.CODEGRAPH_DETECTIVE_MAX_ITERATIONS || '25',
        // Tool budget — the limit the prompt above has always CLAIMED ("HARD
        // LIMIT: 6 tool calls total. This is not a suggestion.") and which
        // nothing enforced. The model explored past 6 and hit the ITERATION
        // cap with no answer, discarding the investigation; that is what every
        // one of the 16 recorded ladder escalations actually was. Raising
        // EPAM_MAX_ITERATIONS three times never fixed it because it is the
        // wrong limit. At the budget, AgentRunner withdraws the tools and
        // demands the answer, so "keep querying instead of committing" stops
        // being reachable. 7 = the prompt's 6 calls plus the pre-seeded
        // explore already handed over, and one successful live pass used 7
        // round-trips. EPAM_MAX_ITERATIONS stays as the outer backstop.
        EPAM_MAX_TOOL_CALLS: process.env.CODEGRAPH_DETECTIVE_MAX_TOOL_CALLS || String(specModeDefaults().perSeam.codegraphDetective),
        // Identity for the Langfuse trace. Without it every trace in the run
        // renders as `llm-stream (uuid)` with no agent, no story and no prompt
        // — a list of 35 identical unreadable rows.
        EPAM_AGENT_NAME: 'code-graph-detective',
        EPAM_STORY_ID: (story && story.id) || '',
        // The detective TRACES the causal fix site + picks the helper to reuse —
        // correctness is paramount and it must reason carefully. With story-point-
        // derived LOW effort it gave different/wrong helpers across passes (live
        // 2026-07-24: getPreciseFloatNumber vs the correct parseDispatchLineItemKey).
        // Force HIGH effort for the brownfield ladder — less guessing, more tracing.
        // (Distinct from VC generation, which stays LOW: that is a restate task where
        // high effort drives prescriptive drift.) Env-overridable.
        EPAM_REASONING_EFFORT: process.env.CODEGRAPH_DETECTIVE_REASONING_EFFORT || 'high',
        // Whatever this seam is configured to run with — ladder, effort, temperature — read
        // from the registry by name. An explicit env override above still wins, and a seam
        // with no entry simply runs on the run's defaults.
        ...seamInvocationEnv('code-graph-detective', logDir),
      }, { costAgent: 'code-graph-detective', costStoryId: story && story.id ? story.id : '',
        // Salvage the detective's JSON even if its process exits non-zero/null
        // (it emits the answer, then a detached grandchild teardown trips the
        // exit code). parseFindings validates, so a genuinely broken run still
        // yields null and retries. Found live 2026-07-23: perfect fix-site JSON
        // was produced and then discarded on a null exit.
        salvageOutputOnFailure: true,
        // Tighter per-attempt timeout so a stalled base-model call (seen live
        // in-pipeline: glm-5.1 hung 6 min producing nothing while the pipeline
        // hammered the same OpenRouter key) fails FAST and escalates up the
        // ladder, instead of burning the full RUNCLAUDE_TIMEOUT_MS per attempt.
        timeoutMs: Number(process.env.CODEGRAPH_DETECTIVE_TIMEOUT_MS || '450000'),
      });
      let findings = parseFindings(out);
      const _phase1Findings = Array.isArray(findings) ? findings.length : 0;
      // PHASE 2 — EXTRACT (no tools). Phase 1 investigated but ended in prose
      // (no JSON). Hand that investigation text to a NO-TOOLS turn whose ONLY
      // possible action is to emit the JSON — it cannot wander off exploring
      // because it has no tools. This is the robust fix for "reasoning model
      // won't commit to structured output": separate exploration from output.
      if (findings === null && out && out.trim() && !/reached maximum iterations/i.test(out)) {
        const extractPrompt = `A code investigation of a bug produced the analysis below. Extract the single most-likely causal fix site and output ONLY a JSON array — no prose, no markdown fences, then stop. If the analysis is incomplete, output your BEST hypothesis from what it contains (a best guess beats nothing).\n[{"file":"<repo-relative path>","function":"<symbol>","reason":"<why THIS computes the wrong value, not just displays it>","fix":"<the exact minimal change: which line/expression to change and which EXISTING helper (symbol) to reuse>","helper":"<bare existing symbol name to reuse, or empty>"}]\n\n=== INVESTIGATION ===\n${out}`;
        const extractLog = logPath ? logPath.replace(/\.log$/, '-extract.log') : null;
        const out2 = await runClaude(exec, extractPrompt, extractLog, {
          // No AI_GATE_ALLOW_TOOLS → ai-run.sh adds --no-tools → pure extraction.
          EPAM_MAX_OUTPUT_TOKENS: process.env.CODEGRAPH_DETECTIVE_MAX_OUTPUT_TOKENS || '24576',
          EPAM_MAX_ITERATIONS: '2',
        }, { salvageOutputOnFailure: true, costAgent: 'code-graph-detective', costStoryId: story && story.id ? story.id : '', timeoutMs: Number(process.env.CODEGRAPH_DETECTIVE_TIMEOUT_MS || '450000') });
        findings = parseFindings(out2);
        if (findings && findings.length) {
          console.warn(`spec-mode: code-graph-detective phase-2 extraction recovered ${findings.length} fix-site(s) for ${story.id} from a narrative phase-1 answer.`);
        }
      }
      // PLAN/EXECUTION ALIGNMENT. Confirmed empirically 2026-08-05 on AMSD-2041: the
      // detective's own plan (ai-run.sh's plan-execute pass, persisted to
      // plans-<phase>.jsonl) named `useContent` across three separate runs, and the final
      // answer landed on a completely different, unrelated file each time — the
      // execute-phase prompt permits deviating from the plan, but nothing checked whether
      // that happened, so the drift was invisible. This does not block or retry on a
      // mismatch — a plan legitimately can turn out wrong once real exploration starts —
      // it only makes an UNEXPLAINED divergence observable, the same way every other
      // silent-failure mode in this function already is.
      const _detectivePlan = readLatestDetectivePlan(logDir, process.env.PHASE || 'unknown', (story && story.id) || '');
      const _planAlignment = checkPlanExecutionAlignment(_detectivePlan, findings);
      if (_detectivePlan && Array.isArray(findings) && findings.length && !_planAlignment.aligned) {
        console.warn(`spec-mode: ⚠️ code-graph-detective plan/execution MISMATCH for ${story.id} — plan named [${_planAlignment.planTerms.join(', ')}], final answer named [${_planAlignment.findingTerms.join(', ')}], no shared term and no stated reason for the change.`);
      }

      // Round telemetry: what this attempt cost and what it actually yielded.
      // phase2Used distinguishes "explored and answered" from "explored, ended
      // in prose, needed a second call to extract" — the latter is pure waste.
      recordDetectiveRound(logDir, {
        storyId: (story && story.id) || '',
        attempt,
        maxAttempts,
        model: attemptModel,
        escalated: !!escalated,
        elapsedSec: Math.round((Date.now() - _roundStarted) / 1000),
        maxToolCalls: Number(process.env.CODEGRAPH_DETECTIVE_MAX_TOOL_CALLS || specModeDefaults().perSeam.codegraphDetective),
        phase1Findings: _phase1Findings,
        phase2Used: _phase1Findings === 0 && Array.isArray(findings) && findings.length > 0,
        findings: Array.isArray(findings) ? findings.length : 0,
        planExecutionAligned: _detectivePlan ? _planAlignment.aligned : null,
        exploreChars: String(out || '').length,
        hitIterationCap: /reached maximum iterations/i.test(String(out || '')),
      });
      if (findings === null) {
        console.warn(`spec-mode: ⚠️ code-graph-detective produced NO parseable JSON for ${story.id} (attempt ${attempt}/${maxAttempts}) even after the extraction phase. Phase-1 head: "${String(out || '').slice(0, 140).replace(/\s+/g, ' ').trim()}"`);
        continue; // retry — this is the silent-failure mode we must not accept
      }
      if (findings.length === 0) {
        console.warn(`spec-mode: ⚠️ code-graph-detective returned an EMPTY fix-site list for ${story.id} — no causal site located.`);
        await _detEmit('error', `[${_detPhase}] code-graph-detective located NO causal fix site for ${story.id}`);
        return findings;
      }

      // EVIDENCE GATE. A finding whose quoted broken expression is NOT in the
      // file it names is a diagnosis about code that does not exist. Live
      // metrolinx 2026-07-26: a confident, cleanly-parsed answer prescribed
      // halving a discount that is in fact never applied at all, because the
      // real defect is a key mismatch one line up. It named a helper that
      // really exists and its JSON parsed, so every guard we had waved it
      // through. Parseability is not correctness.
      //
      // Retry (which escalates the model) rather than accept it — but never
      // discard on the LAST attempt: the detective is load-bearing, and a
      // flagged hypothesis still beats handing the implementer symptom ACs
      // with no root cause at all.
      // A prescription that turns on a string format must state the format.
      // Live 2026-07-26: "a prefix match that accounts for the return-trip key
      // suffix" never said WHAT the suffix was, the implementer guessed '-'
      // against a repo that uses '#', and the bug shipped unfixed behind a
      // plausible diff. Same treatment as an ungrounded quote — reject and
      // regenerate rather than hand a guess downstream. Fails open.
      for (const f of findings) {
        if (!f.fix) continue;
        try {
          const res = require('child_process').spawnSync('python3', [
            path.join(__dirname, 'lib', 'fix_prescription_check.py'),
            repoPath, f.helper || '', f.fix,
          ], { encoding: 'utf8', timeout: 30000 });
          f.prescriptionNote = String(res.stdout || '').trim();
          f.prescriptionUnderspecified = res.status === 1;
          if (f.prescriptionNote) {
            console.warn(`spec-mode: code-graph-detective prescription for ${story.id}: ${f.prescriptionNote}`);
          }
        } catch { /* never block on this check */ }
      }
      const underspecified = findings.filter((f) => f.prescriptionUnderspecified);
      if (underspecified.length === findings.length && attempt < maxAttempts) {
        console.warn(`spec-mode: ⚠️ code-graph-detective prescription for ${story.id} is UNDER-SPECIFIED (attempt ${attempt}/${maxAttempts}) — it depends on a string format it never states, so the implementer would have to guess it. Retrying.`);
        continue;
      }

      // GROUNDING IS KIND-AWARE. This demanded a verified QUOTE for every story, while the
      // novel prescription tells the detective to leave brokenLine empty — so a correct
      // feature answer was rejected and re-tried three times against a check it could never
      // pass (live 2026-08-08, AMSD-2041). A feature is grounded by provenance instead.
      const _grounding = detectiveAnswerIsGrounded({ findings, kind: _kindHint });
      if (!_grounding.grounded) {
        console.warn(
          `spec-mode: ⚠️ code-graph-detective answer for ${story.id} is UNGROUNDED (attempt ${attempt}/${maxAttempts}, ${_kindHint}) — ` +
          `${_grounding.reason}.`);
        if (attempt < maxAttempts) {
          continue; // escalate: a plausible story about absent code is not an answer
        }
        console.warn(`spec-mode: ⛔ code-graph-detective remained UNGROUNDED for ${story.id} after ${maxAttempts} attempts — passing the best hypothesis through, flagged.`);
      } else if (findings.some((f) => f.evidenceVerified !== true)) {
        // Grounded findings first: the implementer reads findings[0] as the
        // primary fix site.
        // Verified-quote findings first: the implementer reads findings[0] as the primary
        // site. Computed here rather than reusing a variable from the gate above — that
        // coupling is exactly what broke: the gate was rewritten, its `grounded` local went
        // with it, and this line kept referring to it. Every detective invocation then threw
        // "grounded is not defined", three attempts per story across three lanes, producing no
        // fix sites at all while the test suite stayed green.
        findings = findings.filter((f) => f.evidenceVerified === true)
          .concat(findings.filter((f) => f.evidenceVerified !== true));
      }
      await _detEmit('spec_update', `[${_detPhase}] code-graph-detective located fix site: ${findings[0].file}${findings[0].helper ? ' (reuse ' + findings[0].helper + ')' : ''}`);
      return findings;
    } catch (e) {
      console.warn(`spec-mode: code-graph-detective invocation failed for ${story.id} (attempt ${attempt}/${maxAttempts}): ${e.message}`);
    }
  }
  console.warn(`spec-mode: ⛔ code-graph-detective found NO fix site for ${story.id} after ${maxAttempts} attempts — the implementer will proceed WITHOUT root-cause guidance (defect-fidelity risk).`);
  await _detEmit('error', `[${_detPhase}] code-graph-detective found NO fix site for ${story.id} after ${maxAttempts} attempts`);
  return [];
}

// Resolve the automation dir (orchestrations/) from a logDir like
// ".../orchestrations/logs" or an override; falls back to the script's parent.
function automationDirFromLogDir(logDir) {
  if (logDir && /(^|\/)logs\/?$/.test(logDir)) return path.dirname(logDir);
  return path.dirname(__dirname); // orchestrations/
}

// openspec: first-pass elaboration
// reviewTicketLinks — the ticket-link agent.
//
// Ingest now recovers every URL from a ticket's description and comments (jira-client's ADF
// walker). This is the step that reads them. Without it the links are carried and never
// opened, which is the same failure as destroying them, one stage later.
//
// Live cost of not having it: two vendor documentation links sat in a comment thread for six
// weeks. One stated the SDK callback the story depends on takes NO argument and the app must
// re-fetch — the story's own verification criteria assert the opposite. One stated the
// feature is configured in the vendor UI and needs no application code — a stakeholder had
// said the same in a comment. Two runs built against both assumptions.
//
// NEVER BLOCKS. Documentation lookup is evidence-gathering, not a gate: an unreachable
// network, a slow fetch or a refusing agent must degrade to "no docs" and let the spec pass
// continue. Returns [] on any failure.
/**
 * Take the link agent's answer in whatever shape it arrived, and return the reviewed links.
 *
 * Live 2026-08-06, all three lanes: the agent DID the work — it fetched both vendor pages,
 * quoted their code verbatim, judged that the guide targets CSR + App Router, and found that
 * the ticket's own comment ("no code changes are needed and its more of configure and use")
 * is contradicted by the vendor's implementation guide. Every word of that was discarded,
 * because `payload.links` did not exist: the model had keyed the payload under the TOOL'S OWN
 * NAME and used its own field names.
 *
 *   {"submit_ticket_links": {"links": [{ relevance:"relevant", document_scope:…,
 *                                        key_findings:[{quote,note}],
 *                                        contradictions_with_ticket:[…] }]}}
 *
 * Demanding exact key names throws away correct work over vocabulary. The schema stays the
 * contract for what the agent is ASKED for; this is the tolerant reader on the way back in.
 * It renames nothing it cannot recognise and invents nothing: a link with no URL is dropped.
 */
/**
 * A tool definition, rendered as the env var that binds a provider's output space.
 *
 * One source of truth: the schema the agent is ASKED for and the schema the provider
 * ENFORCES are the same object. A second copy would drift, and a drifted binding rejects
 * correct work — the failure mode agent-output-schema.js was written to avoid.
 */
function schemaEnv(toolDef) {
  try {
    if (!toolDef || !toolDef.parameters) return '';
    return JSON.stringify({ name: toolDef.name, schema: toolDef.parameters });
  } catch { return ''; }
}

/**
 * persistReferencedDocs(docs, dir) -> [written paths]
 *
 * Write each FETCHED document's body under the run, so a later agent can read more of it than
 * the handful of quotes the link agent chose.
 *
 * Without this the document exists only inside the ticket-link agent's process. Measured on
 * run 20260806T213050Z: the spec agent received four quote lines from two vendor guides, had
 * no fetch tool, and the bodies were nowhere on disk — so "use the documentation" was an
 * instruction it could not act on beyond those four lines.
 *
 * Only `fetched` documents are written. A document that could not be opened has nothing to
 * persist, and writing an empty file for it would look like a document that says nothing.
 *
 * Never throws: evidence-writing must not be able to fail a spec pass.
 */
/**
 * fetchTicketDocuments(links, dir) -> [{ url, fetchStatus, path }]
 *
 * The ENGINE opens every document linked on the ticket, before any agent runs.
 *
 * The ticket-link agent used to be the only thing that fetched, inside its own process, and
 * only the quotes it chose came back. The page itself died with that process, so no later
 * agent could read past those quotes — on run 20260806T213050Z the spec agent received four
 * quote lines from two vendor guides and had no way to see more. Putting the body in the
 * agent's schema would push a 16KB page back through the model as billed output tokens.
 *
 * Fetching here is deterministic: no model call, no tool budget, and no chance of a model
 * declining to look. Every agent then reads the SAME text via read_file rather than one
 * agent's selection from it.
 *
 * It uses the SHIPPED FetchUrlTool from dist/sdk.js — the same implementation the agents'
 * fetch_url uses, so the HTML-to-text extraction and the size cap cannot drift from a second
 * copy written here.
 *
 * A URL that cannot be opened is recorded as `unreachable` with no file. An empty file would
 * read as a document that says nothing, which is a different and much worse claim.
 */
/**
 * Where a run's artefacts live, derived from logDir the same way profiles.json already is.
 * Documents go beside the rest of the run's evidence rather than into a temp directory that
 * teardown deletes — the mistake made with discovery-vocabulary.json.
 */
function runArtifactDirFor(logDir) {
  try {
    if (logDir && fs.existsSync(logDir)) return logDir;
  } catch { /* fall through */ }
  return path.join(__dirname, '..', 'logs');
}

async function fetchTicketDocuments(links, dir) {
  const out = [];
  const list = Array.isArray(links) ? links : [];
  if (!list.length) return out;
  let FetchUrlTool;
  try {
    ({ FetchUrlTool } = require(path.join(__dirname, '..', '..', 'dist', 'sdk.js')));
  } catch (err) {
    console.warn(`spec-mode: cannot load the fetch tool (${err && err.message}) — ticket documents not retrieved`);
    return out;
  }
  const tool = new FetchUrlTool();
  const seen = new Set();
  for (const l of list) {
    // ACCEPT A BARE STRING TOO, AND NEVER SKIP IN SILENCE.
    //
    // This required `{url: "..."}` and discarded anything else without a word. Live 2026-08-07:
    // the agent-mint passed an array of plain URL strings, every entry failed the type check,
    // and the function returned [] — reported downstream as "0 fetched of 2 link(s)", which
    // reads as "the sites were unreachable" rather than "the caller used the other shape".
    // The roster was then derived with no vendor documentation at all.
    const url = (typeof l === 'string') ? l : (l && typeof l.url === 'string' ? l.url : '');
    if (!url) {
      console.warn(`spec-mode: ticket link entry has no usable url (${JSON.stringify(l).slice(0, 120)}) — skipped`);
      out.push({ url: '', fetchStatus: 'not_attempted', path: '' });
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    let body = '';
    try {
      const r = await tool.execute({ url });
      if (!r || r.isError) throw new Error((r && String(r.content || '').slice(0, 200)) || 'fetch failed');
      body = String(r.content || '');
    } catch (err) {
      console.warn(`spec-mode: could not fetch ${url} (${err && err.message})`);
      out.push({ url, fetchStatus: 'unreachable', path: '' });
      continue;
    }
    const [written] = persistReferencedDocs([{ url, fetchStatus: 'fetched', body }], dir);
    out.push({ url, fetchStatus: written ? 'fetched' : 'unreachable', path: written || '' });
  }
  return out;
}

function persistReferencedDocs(docs, dir) {
  const written = [];
  try {
    const list = Array.isArray(docs) ? docs : [];
    if (!list.length || !dir) return written;
    const target = path.join(dir, 'docs');
    fs.mkdirSync(target, { recursive: true });
    for (const d of list) {
      if (!d || d.fetchStatus !== 'fetched') continue;
      const body = typeof d.body === 'string' ? d.body : '';
      if (!body) continue;
      // Named from the URL so an agent reading a citation can find the file it names.
      const slug = String(d.url || 'document')
        .replace(/^https?:\/\//, '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(-120) || 'document';
      const file = path.join(target, `${slug}.txt`);
      fs.writeFileSync(file, `SOURCE: ${d.url || ''}\n\n${body}`);
      written.push(file);
    }
  } catch { /* evidence writing never changes the outcome of a spec pass */ }
  return written;
}

function normaliseTicketLinks(payload) {
  if (!payload || typeof payload !== 'object') return [];
  // The array may sit at the top level, under the tool's own name, or under any single
  // object-valued key the model chose as a wrapper.
  const findLinks = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 4) return null;
    if (Array.isArray(node)) return node.some((e) => e && typeof e === 'object') ? node : null;
    // The array's key comes from the TOOL DEFINITION, not from a list of guesses. A written
    // down set of likely aliases ('links','documents','items','results') is a vocabulary in
    // engine code: wrong for the next tool, and maintained by nobody.
    const declaredKey = Object.keys((TOOL_TICKET_LINKS.parameters || {}).properties || {})
      .find((k) => ((TOOL_TICKET_LINKS.parameters.properties[k] || {}).type) === 'array');
    if (declaredKey && Array.isArray(node[declaredKey])) return node[declaredKey];
    // Otherwise: whatever single array of objects this object holds, whatever it is called.
    const arrays = Object.values(node).filter((v) => Array.isArray(v) && v.some((e) => e && typeof e === 'object'));
    if (arrays.length === 1) return arrays[0];
    for (const v of Object.values(node)) {
      const found = findLinks(v, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const raw = findLinks(payload);
  if (!Array.isArray(raw)) return [];

  const firstString = (...vals) => {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  // Quotes may be a flat array of strings, or objects carrying the quote plus a note.
  const quotesOf = (l) => {
    const src = [l.quotes, l.key_findings, l.findings, l.excerpts].find(Array.isArray) || [];
    return src.map((q) => (typeof q === 'string' ? q : firstString(q && q.quote, q && q.text, q && q.excerpt)))
      .filter(Boolean);
  };
  // A contradiction may be a sentence or a list of {ticket_says, document_says, explanation}.
  const contradictionOf = (l) => {
    const direct = firstString(l.contradictsStory, l.contradiction, l.contradicts);
    if (direct) return direct;
    const list = [l.contradictions_with_ticket, l.contradictions].find(Array.isArray) || [];
    return list.map((c) => (typeof c === 'string' ? c
      : [c && c.ticket_says && `ticket says: ${c.ticket_says}`,
         c && c.document_says && `document says: ${c.document_says}`,
         c && c.explanation].filter(Boolean).join(' — '))).filter(Boolean).join(' | ');
  };
  // `relevant` may be a boolean, or a word like "relevant" / "not relevant".
  const relevanceOf = (l) => {
    if (typeof l.relevant === 'boolean') return l.relevant;
    const word = firstString(l.relevance, l.relevant, l.is_relevant).toLowerCase();
    if (!word) return true;   // it was returned at all; absence of a verdict is not a denial
    return !/\b(not|non|ir)\s*-?\s*relevant\b|^no$|^false$/.test(word);
  };

  return raw
    .map((l) => (l && typeof l === 'object' ? l : null))
    .filter(Boolean)
    .map((l) => ({
      url: firstString(l.url, l.link, l.href),
      classification: firstString(l.classification, l.type, l.category) || 'unknown',
      relevant: relevanceOf(l),
      reason: firstString(l.reason, l.note, l.summary, l.rationale),
      quotes: quotesOf(l),
      scopeCaveat: firstString(l.scopeCaveat, l.document_scope, l.scope, l.caveat),
      // Whether the agent could actually open the page. Carried through so a downstream
      // reader can tell an empty review from an unread one — the distinction the schema now
      // forces the agent to make.
      fetchStatus: firstString(l.fetchStatus, l.fetch_status, l.status) || 'not_attempted',
      contradictsStory: contradictionOf(l),
    }))
    .filter((l) => l.url);
}

async function reviewTicketLinks({ promptExec, story, logDir, docPaths = [] }) {
  // No links on the ticket means nothing to review — return before spending a model call.
  const links = Array.isArray(story && story.ticketLinks) && story.ticketLinks.length ? story.ticketLinks : [];
  if (!links.length) return [];

  const profiles = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(automationDirFromLogDir(logDir), 'agents', 'profiles.json'), 'utf8'));
    } catch { return {}; }
  })();
  const persona = profiles['ticket-link-agent'] || '';

  const linkBlock = links.map((l, i) => {
    // "ticket body" rather than "description": a link found outside a comment. The word is
    // avoided deliberately — the description itself is never truncated on its way to a
    // model (it is the only source of verification criteria in brownfield), and a guard
    // scans for exactly that pattern.
    const who = l.author || 'ticket body';
    const when = l.created ? ` on ${String(l.created).slice(0, 10)}` : '';
    // Whole context, whole comment. Clipping here would undo the un-clipping in
    // jira-client: this prompt IS the agent's only view of why the link was posted.
    const context = String(l.context || '');
    return `${i + 1}. ${l.url}\n   found by: ${who}${when}\n   surrounding text: ${context}`;
  }).join('\n');

  const commentBlock = (Array.isArray(story.ticketComments) ? story.ticketComments : [])
    .map((c) => `- ${c.author || 'unknown'}: ${String(c.text || '')}`).join('\n');

  const prompt = `${persona ? persona + '\n\n' : ''}STORY
Title: ${story.title || ''}
Description: ${String(story.description || '')}
Components: ${(Array.isArray(story.components) ? story.components : []).join(', ') || '(none)'}
Declared files: ${((story.technicalNotes && story.technicalNotes.files) || []).join(', ') || '(none yet)'}

LINKS FOUND IN THIS TICKET:
${linkBlock}

COMMENT THREAD (context for judging relevance — a link's surrounding discussion often says why it was posted):
${commentBlock || '(none)'}
${Array.isArray(docPaths) && docPaths.length ? `
ALREADY RETRIEVED — these documents have been fetched for you and written to disk. Read them
with read_file rather than fetching them again; the text is the same and it costs you nothing:
${docPaths.map((p) => `- ${p}`).join('\n')}
A document listed here that you did not read is a document you cannot quote.
` : ''}`;

  // THE AGENT MUST BE ABLE TO OPEN THE LINK.
  //
  // Its schema has a `quotes` field — verbatim extracts from the document, the entire point
  // of this step, because a paraphrase of an API contract is how a wrong contract
  // propagates. With only read_file/list_files/search it could classify a URL from its
  // address and the surrounding comment and nothing more, so `quotes` could never be
  // populated and the documentation still did not inform the pipeline.
  //
  // fetch_url is the read-only network tool (src/tools/builtin/FetchUrl.ts). Granting a
  // tool LIST without AI_GATE_ALLOW_TOOLS silently runs --no-tools, so both are set.
  // Configurable per project; a project that forbids outbound HTTP sets it to the
  // read-only subset and the agent degrades to classification, which is still useful.
  const _linkTools = {
    AI_GATE_ALLOW_TOOLS: process.env.TICKET_LINK_ALLOW_TOOLS || '1',
    EPAM_ALLOWED_TOOLS: process.env.TICKET_LINK_ALLOWED_TOOLS || 'fetch_url,read_file,list_files,search',
    EPAM_MAX_TOOL_CALLS: process.env.TICKET_LINK_MAX_TOOL_CALLS || String(Math.min(links.length + 2, 12)),
    EPAM_RESPONSE_SCHEMA: schemaEnv(TOOL_TICKET_LINKS),
    // BIND THE SHAPE, DO NOT ASK FOR IT. The prompt said "structured output only; do not
    // answer in prose" and across three live runs the model answered three different ways —
    // keyed under its own tool name, prose-then-JSON, then pure markdown. Each time it had
    // fetched both vendor pages and found the contradiction, and each time the answer was
    // discarded. A request is declinable; a bound output space is not.
    //
    // Tools survive: AgentRunner applies the binding only on the turn where tools are
    // withheld, so the research turns still fetch and the answer turn cannot be prose.

  };
  try {
    const payload = await runAgentForJson(
      promptExec, prompt, TOOL_TICKET_LINKS, 'TICKET_LINKS',
      logDir ? path.join(logDir, `${(story && story.id) || 'phase'}-ticket-links.log`) : null,
      'links', (story && story.id) || '', resolveCodelinePath(story), _linkTools,
    );
    return normaliseTicketLinks(payload);
  } catch (err) {
    console.warn(`spec-mode: ticket-link review unavailable for ${story && story.id} (${err && err.message}) — proceeding without documentation evidence`);
    return [];
  }
}

// Renders reviewed docs as EVIDENCE for the spec agents. A contradiction leads, because it
// is the one thing that changes what gets built.
function referencedDocsBlock(docs) {
  const list = Array.isArray(docs) ? docs.filter((d) => d && d.relevant) : [];
  if (!list.length) return '';
  const lines = [];
  const contradictions = list.filter((d) => d.contradictsStory);
  if (contradictions.length) {
    lines.push('\n## DOCUMENTATION CONTRADICTS THIS STORY — resolve before specifying');
    for (const d of contradictions) {
      lines.push(`- ${d.url}\n  CONTRADICTION: ${d.contradictsStory}`);
    }
  }
  lines.push('\n## REFERENCED DOCUMENTATION (quoted from sources linked on the ticket — authoritative over assumption)');
  for (const d of list) {
    lines.push(`- ${d.url} [${d.classification}]${d.reason ? ` — ${d.reason}` : ''}`);
    for (const q of (Array.isArray(d.quotes) ? d.quotes : []).slice(0, 6)) lines.push(`    "${q}"`);
    if (d.scopeCaveat) lines.push(`    SCOPE CAVEAT: ${d.scopeCaveat}`);
  }
  return lines.join('\n') + '\n';
}

async function runSpecAgent({ promptExec, agent, story, phase, runId, logDir, forcedRetryNote,
  runDetective = runCodeGraphDetective, prd = null }) {
  const acCount = Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria.length : 0;
  const splitDepthVal = story.specification?.splitDepth ?? 0;

  const storyPayload = JSON.stringify({
    id: story.id,
    title: story.title,
    description: story.description,
    acceptanceCriteria: story.acceptanceCriteria,
    acCount,
    technicalNotes: story.technicalNotes,
    agentRole: story.agentRole,
    agentGroup: story.agentGroup,
    dependencies: story.dependencies || [],
    splitDepth: splitDepthVal
  }, null, 2);

  // Uses the SAME threshold function as checkSplitMandateViolation() (below)
  // so the prompt warning and the deterministic post-hoc check can never
  // drift apart — one is prose telling the agent what's required, the other
  // verifies the agent actually did it.
  const splitRequirement = storyRequiresSplit(captureStorySnapshot(story));
  const splitWarning = splitRequirement.required
    ? `\nNOTE: This story ${splitRequirement.reason} — MANDATORY split required (see SPLIT RULES below).`
    : '';

  // Surface any prior coordinator flags so openspec addresses them rather than rubber-stamping
  const priorFlags = story.specification?.coordinatorReview?.flags;
  const priorNotes = story.specification?.coordinatorReview?.reviewNotes;
  const priorGapsBlock = (Array.isArray(priorFlags) && priorFlags.length > 0)
    ? `\n\nPRIOR COORDINATOR FLAGS (you MUST address each one — do NOT declare the spec complete without resolving these):\n${priorFlags.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n${priorNotes ? `\nAdditional context from prior review: ${priorNotes.slice(0, 500)}` : ''}`
    : '';

  // Forced-retry note goes at the VERY TOP — highest-salience position in the
  // prompt (primacy). Root cause this addresses (found live, 2026-07-06):
  // the mid-prompt "MANDATORY split required" NOTE was already present on the
  // FIRST attempt and still got ignored. A same-session forced retry needs
  // maximum prominence, not just a repeat of the same mid-prompt phrasing.
  const forcedRetryBlock = forcedRetryNote ? `${forcedRetryNote}\n\n` : '';

  const sembleContext = fetchExistingCodeContext(story);

  // Resolved here rather than taken as a parameter, the same way every other
  // consumer in this module does it. It feeds publishedContracts() below, which
  // is interpolated into the prompt — outside any try — so an unbound name here
  // is not a degraded prompt, it is a hard crash on every single attempt.
  const repoPath = resolveCodelinePath(story);

  // Brownfield archaeology block — injected for EPAM_BROWNFIELD=1 regardless of
  // which spec agent is running. Whichever agent runs must identify the
  // existing change site before writing any AC; locationHint feeds directly
  // into the story agent's context so it opens the right file.
  //
  // Root cause fix (2026-07-23, live AMSD-1820 failure): this used to also
  // require `agent === 'openspec'`. The coordinator can legitimately assign
  // ONLY speckit to a story (openspec ran "0 stories" that phase) — when that
  // happens, this block never fired for that story at all: no locationHint
  // request, no CodeGraph/Semble grounding instruction, nothing. The story
  // then went to execution with zero file guidance in a large real repo,
  // and 8 real agent attempts never found the actual fix site. sembleContext
  // (the CodeGraph/Semble-injected existing code, above) is already computed
  // unconditionally regardless of which agent runs, so it's available either way.

  // Cycle-time investigation, 2026-07-31 (mock1 comparison, same finding
  // class as the coordinator-review fix above): storyRequiresSplit() already
  // returns {required:false} for brownfield, so splitWarning above is
  // correctly empty — but the SPLIT RULES block and the splitStories schema
  // field below were never given the same treatment, even though the
  // EPAM_BROWNFIELD guard in the Step-2 caller unconditionally deletes any
  // splitStories payload from every agent, openspec included (brownfield
  // stories are tickets and are never split; multi-codeline work is one
  // story with N executions, not a split). Asking the model to reason
  // through 6 split-decision rules and emit a splitStories array it can
  // never use is pure wasted context/output for every brownfield call.
  const isBrownfieldSpec = process.env.EPAM_BROWNFIELD === '1';
  // locationHintSchemaLine (brownfield) ends in a trailing comma expecting a
  // field after it — normally splitStories. When brownfield drops that field
  // too, strip the dangling comma so the schema hint stays valid-looking JSON.
  const splitSchemaField = isBrownfieldSpec
    ? ''
    : `\n  "splitStories":[{"id":"optional","title":"...","description":"...","acceptanceCriteria":["..."],"agentRole":"...","technicalNotes":{"files":[]}}]`;
  const splitRulesBlock = isBrownfieldSpec
    ? ''
    : `\n\nSPLIT RULES (mandatory, not optional — enforce these before refining AC):
1. AC count > 12 → you MUST propose a split. Target ≤8 ACs per split child. Never leave a story with >12 ACs unsplit.
2. Both implementation files AND test files in technicalNotes.files → split into one impl child (non-test files) and one test child (*.test.ts files). Assign agentRole "typescript-engineer" to impl, "test-engineer" to test.
3. 3+ independent deliverable modules with no shared exports (e.g. client.ts, server.ts, cli.ts all in same story) → split per concern. Each split gets the files it owns.
4. External API discovery + implementation in same story → split: first child discovers/documents the API contract, second child implements against that contract.
5. technicalNotes.files contains BOTH frontend/template files (*.html, *.css, *.scss, *.jsx, *.tsx, *.vue, *.svelte) AND build/tooling files (vite.config.*, webpack.config.*, rollup.config.*, package.json, Makefile, Dockerfile, *.sh) → split: one child owns the frontend/template files, one child owns the build/tooling files. These have different runtime roles and different owners — bundling them causes token bloat and diffuse responsibility.
6. Story covers multiple independent runtime roles in the same deliverable (e.g. HTTP server AND CLI binary AND HTML dashboard) → split by runtime role, one child per runtime target. Each child's agentRole should match what it produces (typescript-engineer for application code, test-engineer for test-only files).
These rules apply only when splitDepth === 0. Never split a story that is already a split child.`;
  const generateInstruction = isBrownfieldSpec
    ? 'Generate refined acceptance criteria and optionally updated title/description. Output raw JSON only (no XML tags, no markdown fences, no preamble) using this schema:'
    : 'Generate refined acceptance criteria, optionally updated title/description, and split stories where required. Output raw JSON only (no XML tags, no markdown fences, no preamble) using this schema:';

  // GROUND THE PRODUCER BEFORE IT WRITES, not after.
  //
  // The detective used to run AFTER this model call — so the first-pass verification
  // criteria were written with no located fix site and no file contents, and only the
  // REGENERATE path (which does receive findings) was ever grounded. Live
  // 20260804T162414Z: the one lane that reached regeneration produced 5 clean criteria;
  // the two that kept first-pass output went partial, one down to a single criterion.
  //
  // The detective reads only story title/description/acceptanceCriteria and the repo path
  // — none of which this model call produces — so it gets byte-identical input here.
  // Grounding is an ENHANCEMENT: if it fails, the spec pass continues without it.
  // Read any documentation the ticket itself links to, BEFORE specifying. A vendor doc that
  // states the real contract of an API this story depends on outranks any assumption the
  // spec agents would otherwise make — and on the live ticket it refuted the story outright.
  // THE ENGINE FETCHES FIRST. Every document linked on the ticket is retrieved and written
  // under the run before any agent is asked about it, so the ticket-link agent reviews text
  // that is already on disk and every later agent can read the same file rather than one
  // agent's selection of quotes from a page nobody else can see.
  let ticketDocPaths = [];
  try {
    const _docDir = runArtifactDirFor(logDir);
    const _fetched = await fetchTicketDocuments((story && story.ticketLinks) || [], _docDir);
    ticketDocPaths = _fetched.filter((d) => d.path).map((d) => d.path);
    if (_fetched.length) {
      console.log(`spec-mode: ${story.id} — ticket documents: ${_fetched.filter((d) => d.fetchStatus === 'fetched').length}/${_fetched.length} fetched into ${_docDir}/docs`);
    }
  } catch (err) {
    console.warn(`spec-mode: ticket document retrieval failed for ${story.id} (${err && err.message}) — agents will have quotes only`);
  }

  let referencedDocs = [];
  try {
    referencedDocs = await reviewTicketLinks({ promptExec, story, logDir, docPaths: ticketDocPaths });
    if (referencedDocs.length) {
      story.specification = story.specification || {};
      story.specification.referencedDocs = referencedDocs;
      const _contra = referencedDocs.filter((d) => d && d.contradictsStory);
      if (_contra.length) {
        console.warn(`spec-mode: ⚠️ ${story.id} — linked documentation CONTRADICTS this story on ${_contra.length} point(s): ${_contra.map((d) => d.url).join(', ')}`);
      }
    }
  } catch (err) {
    console.warn(`spec-mode: ticket-link review skipped for ${story.id} (${err && err.message})`);
  }
  const referencedDocsEvidence = referencedDocsBlock(referencedDocs);

  let detectiveFindings = [];
  try {
    detectiveFindings = (await runDetective(story, logDir)) || [];
  } catch (err) {
    console.warn(`spec-mode: code-graph-detective unavailable for ${story.id} (${err && err.message}) — continuing ungrounded`);
    detectiveFindings = [];
  }
  const fixSiteBlock = detectiveFindings.length
    ? `\n\nLOCATED FIX SITE(S) — traced in this repository before you were asked. Anchor every criterion to the behaviour THIS code produces:\n`
      + detectiveFindings.slice(0, 5).map((f) => `- ${f.file}${f.function ? ` :: ${f.function}` : ''}${f.reason ? ` — ${f.reason}` : ''}`).join('\n') + '\n'
    : '';
  // detectiveFindings, not story.fixSiteAnalysis: the field is not set until later.
  const declaredFileBlock = manifestFileExcerpts(story, prd, { located: detectiveFindings });

  // Built HERE, after referencedDocs is populated — not at the top of the function.
  // `referencedDocs` is declared with `let` further down, so reading it earlier is a
  // temporal-dead-zone ReferenceError that would crash every brownfield spec call, and
  // even with the declaration hoisted it would always have been empty: the block would
  // have silently stopped offering documentation as a verification source, which is the
  // whole point of passing it.
  const { archaeologyBlock: brownfieldArchaeologyBlock, schemaLine: locationHintSchemaLine } =
    buildBrownfieldArchaeologyBlock(process.env, {
      // What THIS story actually has. The block names only sources that exist: a ticket with
      // no acceptance criteria is not told about acceptance criteria, and documentation is
      // offered as a source of verification only when documents were really fetched.
      hasAcceptanceCriteria: Array.isArray(story.acceptanceCriteria) && story.acceptanceCriteria.length > 0,
      hasReferencedDocs: Array.isArray(referencedDocs) && referencedDocs.some((d) => d && Array.isArray(d.quotes) && d.quotes.length),
    });
  // Derived from locationHintSchemaLine, so it has to follow it. It used to sit ~70 lines
  // higher; moving the block below referencedDocs left this reading the name before its
  // declaration — a second temporal-dead-zone crash, introduced while fixing the first.
  const locationHintSchemaLineTrimmed = (isBrownfieldSpec && !splitSchemaField)
    ? locationHintSchemaLine.replace(/,(\s*)$/, '$1')
    : locationHintSchemaLine;

  const prompt = `${forcedRetryBlock}You are the ${agent} specification agent for EPAM CLI. Phase ${phase}, story ${story.id}.${splitWarning}${priorGapsBlock}${sembleContext}${referencedDocsEvidence}${fixSiteBlock}${declaredFileBlock}${brownfieldArchaeologyBlock}
${generateInstruction}
{
  "storyId":"${story.id}",
  "agent":"${agent}",
  "notes":"context",
  "acceptanceCriteria":["..."],
  "description":"...",
  "title":"...",${locationHintSchemaLineTrimmed}${splitSchemaField}
}
Use existing text when no change is needed.${splitRulesBlock}

Story context:
${storyPayload}${publishedContracts(repoPath, story)}
`;
  try {
    const payload = await runAgentForJson(
      promptExec, prompt, TOOL_SPEC_AGENT, 'SPEC_AGENT',
      path.join(logDir, `${story.id}-${agent}-spec.log`), null, story.id, repoPath
    );
    // Merge fix-site candidates into locationHint. PRIMARY: the code-graph-
    // detective — a tool-using agent (GLM-5.1) that iterates CodeGraph queries
    // and traces callers to converge on the CAUSAL fix site (proven the only
    // reliable path for symptom-worded tickets). SUPPLEMENT: the deterministic
    // top-N search (a cheap seed — fragile alone, but harmless as extra
    // candidates). Both are additive to whatever openspec itself reported.
    if (payload && agent === 'openspec') {
      // Brownfield DEFECT guard (deterministic backstop to openspec's own
      // classification): when openspec judges this story a bug fix, it must NOT
      // rewrite the acceptance criteria — elaborating a defect's ACs bakes in a
      // guessed fix mechanism that misdirects the implementer (live AMSD-1820:
      // openspec expanded a symptom into 8 "split the discount" ACs and the
      // agent built exactly that wrong design). openspec still RUNS (locationHint
      // + detective below still fire); we just restore the reporter's original
      // ACs verbatim, enforcing the STEP-3 instruction even if the model ignored
      // it. Greenfield never triggers this (EPAM_BROWNFIELD gate); a "novel"
      // brownfield story is untouched and elaborates normally.
      // Anchor the classification to Jira ground truth when present: a ticket
      // typed "Bug" is a defect regardless of the spec model's own judgment
      // (a misclassified defect→novel re-opens the exact AC-misdirection this
      // guards against). No-op when issueType is absent — falls back to the
      // model's storyKind. Greenfield never reaches this block.
      const _jiraType = String(story.issueType || story.issuetype || '').toLowerCase();
      if (_jiraType === 'bug' && payload.storyKind !== 'defect') {
        payload.storyKind = 'defect';
        console.log(`spec-mode: ${story.id} is Jira type "Bug" — anchoring storyKind=defect (overriding model judgment)`);
      }
      if (preserveDefectAcceptanceCriteria(payload, story, process.env)) {
        console.log(`spec-mode: ${story.id} — ACs are immutable (VC model); openspec AC edits redacted, verification captured in verificationCriteria`);
      }
      // Persist the VERIFICATION CRITERIA (VC) layer onto the story so it reaches
      // the PRD (observability) and downstream agents (TC writer, impl, reviewer).
      // ACs stay the immutable ticket intent; VCs are the observable checks.
      // The detective runs FIRST so its findings can ground VC generation. It was
      // previously called AFTER this block, which meant the VC generator was asked
      // to specify OBSERVABLE behaviour for code it had never been shown — working
      // from ticket prose alone. Live 2026-07-25 that produced "VC 3 addresses
      // station names" for a promo-code-in-email ticket, two failed regeneration
      // cycles, and a fallback to generic VCs that the test writer could not anchor
      // to anything. The detective's own prompt states the intent: "You run early
      // (during the specification pass) and your output grounds every downstream
      // agent."
      // (detectiveFindings was computed above, BEFORE the prompt — see the grounding note.)

      if (process.env.EPAM_BROWNFIELD === '1') {
        const rawVc = normalizeVerificationCriteria(payload);
        if (rawVc.length) {
          // Autonomous guard + regenerate loop (NO human): deterministic mechanism
          // check + speckit strict flag-only review; on flags, regenerate via
          // openspec with ladder escalation; conservative safe-fallback if it can't
          // converge. Never halts — always persists a clean VC set.
          const enforced = await enforceVerificationCriteria(story, rawVc, {
            regenerateVc: (flags, nextCycle) => regenerateVcViaOpenspec({
              story, flags, cycle: nextCycle, logDir, findings: detectiveFindings,
            }),
            reviewVc: (vc, cycle) => reviewVcViaSpeckit({ story, vc, cycle, logDir }),
            findings: detectiveFindings,
            // The guard's vocabulary is derived here, from the criteria it will check
            // PLUS the story's declared manifest PLUS the detective's real file reads.
            // Inputs are state-dependent by design: an agent not shown what the guard
            // checks can only guess from the ticket, which is how invented file contents
            // reached the pipeline before.
            // The derived vocabulary is then GROUNDED against the documents linked on the
            // ticket: a term the vendor publishes verbatim is a contract, not an
            // implementation choice this team made. Without it the guard deleted the three
            // sharpest criteria of run 20260807T000054Z — all quoting `onEntryChange`, from
            // the guide the pipeline had just fetched — so better documentation grounding
            // produced more deletions.
            // The documents go to the AGENT as evidence; it decides which terms are the
            // vendor's published contract and which are this codeline's internals, and says
            // why per term. A structural whitelist was tried here first — whitelist any
            // blacklisted term quoted verbatim in a fetched document — and it was too
            // permissive: it forced through a criterion asserting the SHAPE of an internal
            // options object because the key name happened to be documented. The reviewer
            // caught it and the spec gate halted the run at quality 0.68. Whether a
            // documented name is being used to describe behaviour or to assert internal
            // structure requires reading the statement, which is a judgement, not a rule.
            deriveVocabulary: (vcToCheck) => deriveGuardVocabulary({
              promptExec,
              rule: VC_OBSERVABILITY_RULES,
              statements: vcToCheck,
              story,
              findings: detectiveFindings,
              manifestFiles: (story && story.technicalNotes && story.technicalNotes.files) || [],
              logDir,
              seam: 'verification-criteria',
              referencedDocs,
            }),
          });
          story.verificationCriteria = enforced.vc;
          // Kept, not consumed: "who observes this, and on what" is the most useful thing to
          // show a reviewer or a human deciding whether a criterion is worth verifying — and
          // it is what was missing when the pipeline argued with itself about whether a mocked
          // precondition counted as prescribing mechanism.
          const _vcDecl = vcDeclarations(payload).filter((d) => enforced.vc.includes(d.criterion));
          if (_vcDecl.length) story.verificationCriteriaDetail = _vcDecl;
          // 'disputed' is NOT fallback: the criteria are the author's real ones, kept
          // because acting on an outlier review would have left the story under-verified.
          story.vcSource = enforced.source === 'fallback'
            ? 'fallback'
            : ((typeof payload.vcSource === 'string' && payload.vcSource) || 'acceptance');
          // Persist a small provenance record for observability in the PRD.
          story.vcResolution = enforced.source; // clean | regenerated | partial | disputed | fallback
          // A dropped criterion is a decision the pipeline made about what will NOT be
          // verified. Recording it only in a console warning would lose it with the
          // console; it belongs on the story, in the PRD, on disk.
          if (Array.isArray(enforced.dropped) && enforced.dropped.length) {
            story.vcDropped = enforced.dropped;
          }
          console.log(`spec-mode: ${story.id} — ${enforced.vc.length} verification criteria persisted (source: ${story.vcSource}, resolution: ${enforced.source})`);
        }
      }
      const detectiveFiles = detectiveFindings.map((f) => f.file);
      const deterministicFiles = getDeterministicCandidateFiles(story);
      const candidateFiles = [...new Set([...detectiveFiles, ...deterministicFiles])];
      if (candidateFiles.length) {
        const existingHints = Array.isArray(payload.locationHint) ? payload.locationHint : [];
        const seenFiles = new Set(existingHints.map((h) => h && h.file).filter(Boolean));
        const merged = [...existingHints];
        for (const file of candidateFiles) {
          if (!seenFiles.has(file)) {
            const finding = detectiveFindings.find((f) => f.file === file);
            merged.push(finding
              ? { file, function: finding.function, reason: finding.reason, fix: finding.fix }
              : { file, function: '', reason: 'deterministic search seed', fix: '' });
            seenFiles.add(file);
          }
        }
        payload.locationHint = merged;
      }
      // Persist the detective's ROOT-CAUSE ANALYSIS on the story so the
      // implementation agent starts WITH the answer (the cross-file bug the
      // detective already traced) instead of re-reading files to re-discover
      // it — the "input bloat on a bad attempt" is exactly that re-tracing.
      // Stored on the story directly (survives applySpecChanges into the PRD);
      // claude.sh's build_implementation_prompt injects it verbatim.
      if (detectiveFindings.length) {
        story.fixSiteAnalysis = detectiveFindings.filter((f) => f.reason);
      }
      // Deterministic coverage check (see checkFixSiteCoverage) — flags VCs
      // the detective's findings never touch, so the implementer's budget and
      // prompt can react to a known-incomplete prescription instead of a
      // silently-incomplete one.
      story.fixSiteAnalysisCoverage = coverageForStory(story);
      // complete === null means NO vocabulary was available, so coverage was not computed.
      // Treating that as "incomplete" would report a gap nobody measured.
      if (story.fixSiteAnalysisCoverage.complete === false) {
        console.warn(
          `spec-mode: ⚠️ ${story.id} — fixSiteAnalysis does not cover ${story.fixSiteAnalysisCoverage.uncoveredVerificationCriteria.length} verification criterion/criteria (e.g. "${String(story.fixSiteAnalysisCoverage.uncoveredVerificationCriteria[0] || '').slice(0, 100)}"). The prescribed fix may be structurally incomplete.`
        );
      }
      // Deterministic dependency check on the PLAN, beside the coverage check above and
      // for the same reason: a prescription the codeline cannot satisfy is incomplete, and
      // the pipeline should know before the writer spends rather than after.
      //
      // Live, four consecutive runs of one story: the prescribed fix flipped between a
      // config change on an ALREADY-INSTALLED package and installing a live-preview SDK
      // no codeline declares. The requirement existed only as prose inside `fix`/`reason`,
      // so nothing could check it — the writer discovered it mid-turn, had no way to
      // report a blockage, and shipped a workaround the reviewer called "dead code from a
      // runtime perspective". Seven self-heal diagnoses later, HealingBroken fired.
      //
      // Nothing here is hardcoded: the package names come from the plan's own
      // requiredPackages declaration, and availability is computed from the project's own
      // dependency-check.json (manifestFile / manifestKeys / vendorDirs) by the SAME pure
      // function the dependency_available agent tool uses, so gate and agent cannot drift.
      try {
        const declaredPkgs = [
          ...new Set(
            (story.fixSiteAnalysis || [])
              .flatMap((f) => (Array.isArray(f.requiredPackages) ? f.requiredPackages : []))
              .filter((n) => typeof n === 'string' && n.trim())
              .map((n) => n.trim())
          ),
        ];
        if (declaredPkgs.length) {
          // eslint-disable-next-line global-require
          const { checkPackageAvailability } = require('../plugins/dependency-contract-tools.js');
          const projectRoot = process.env.PROJECT_ROOT || process.cwd();
          story.requiredPackagesCheck = checkPackageAvailability(projectRoot, declaredPkgs);
          if (!story.requiredPackagesCheck.allAvailable) {
            const worst = story.requiredPackagesCheck.unavailable
              .map((r) => `${r.package}=${r.verdict}`)
              .join(', ');
            console.warn(
              `spec-mode: ⛔ ${story.id} — the prescribed fix requires ${story.requiredPackagesCheck.unavailable.length} package(s) this codeline cannot satisfy: ${worst}. The plan CANNOT be implemented as written; an implementer given it will either fake a workaround or burn its retry ladder. Prefer a fix built on what is installed, or add the dependency deliberately.`
            );
          }
        }
      } catch (err) {
        // Never fail the spec pass on the check itself — report and continue, so a broken
        // gate degrades to "unchecked", never to "silently passed".
        console.warn(`spec-mode: requiredPackages check could not run for ${story.id}: ${err.message}`);
      }
      // Loud, spec-pass-level surface: a DEFECT that reaches implementation with
      // NO located fix site is the exact failure mode this whole subsystem
      // exists to prevent — it must never pass by unnoticed. (Detective already
      // warned internally; this makes it visible at the story/spec-pass level.)
      const isDefect = String(story.issueType || '').toLowerCase() === 'bug'
        || payload.storyKind === 'defect';
      const hasFixSite = Array.isArray(story.fixSiteAnalysis) && story.fixSiteAnalysis.length;
      if (isDefect && !hasFixSite) {
        console.warn(`spec-mode: ⛔ DEFECT ${story.id} has NO fixSiteAnalysis after the spec pass — the implementer gets symptom ACs with no root cause. This is a defect-fidelity risk; investigate the detective before trusting this run's fix.`);
      }
      // A NOVEL story has no fix site by definition, so the defect check above
      // never fires for it — but it still needs somewhere to plug IN. A feature
      // nobody can place is as unimplementable as a defect nobody can locate:
      // the implementer would be left to invent both the location and the
      // integration, which is how a "small feature" becomes a rewrite.
      // Same signal, same weight (user decision, 2026-07-28).
      const hasAttachment = (Array.isArray(story.fixSiteAnalysis) && story.fixSiteAnalysis.length)
        || (Array.isArray(payload.locationHint) && payload.locationHint.length);
      if (!isDefect && !hasAttachment) {
        console.warn(`spec-mode: ⛔ NOVEL ${story.id} has NO attachment point after the spec pass — nothing identifies the existing code this new capability plugs into, so the implementer must invent both the location and the integration. Investigate before trusting this run.`);
      }
      // SUFFICIENCY GATE (step 3): the detective IS the sufficiency signal. If it
      // located NO fix site AND the ticket context is thin (sparse ACs + short
      // description), there is not enough to implement OR to write a test that
      // reproduces the bug — fail EARLY with a clear reason instead of proceeding
      // to a doomed run. Autonomous (no human halt): the flag blocks execution
      // loudly at the orchestration level.
      if (!hasFixSite && isThinContext(story)) {
        story.specification = story.specification || {};
        story.specification.insufficientContext = true;
        story.specification.specPassFailed = true;
        story.specification.insufficientReason = 'code-graph-detective located no fix site and the ticket context is thin (sparse acceptance criteria + short description) — not enough to implement or to write a reproducing test';
        console.warn(`spec-mode: ⛔ INSUFFICIENT CONTEXT for ${story.id} — no fix site located and thin AC/description. Failing early (no human halt).`);
      }
    }
    return { agent, payload };
  } catch (error) {
    console.warn(`spec-mode: ${agent} run failed for ${story.id}:`, error.message);
    return null;
  }
}

// ─── Speckit AC validator (runtime version mirrors test/unit/orchestration/speckit-validator.test.ts)

function stripPrescriptiveACs(acceptanceCriteria, storyId, vocabulary) {
  // PURE APPLIER — no patterns, no library names, no language assumptions.
  // A hardcoded list used to live here: eleven regexes naming specific JS test
  // libraries, so a codeline in any other language received no protection at all
  // while the guard still reported clean. What counts as prescriptive for THIS
  // story is derived by the guard-vocabulary agent from the same rule the
  // reviewer reads, grounded in the detective's real file evidence.
  //
  // NO VOCABULARY IS NOT "NOTHING TO STRIP" — the caller aborts before here.
  const acs = Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [];
  const hits = applyVocabulary(acs, vocabulary);
  const flaggedItems = new Set(hits.map((h) => h.item));
  const clean = acs.filter((ac) => !flaggedItems.has(ac));
  const flagged = hits.map((h) => ({ criterion: h.item, reason: h.reason }));
  if (storyId) {
    for (const f of flagged) {
      console.warn(`spec-mode: AC guard stripped prescriptive AC in ${storyId}: [${f.reason}] "${String(f.criterion).slice(0, 80)}"`);
    }
  }
  return { clean, flagged };
}

// speckit: second-pass review of openspec's output — the collaboration point
async function runSpeckitReview({ promptExec, story, openspecOutput, phase, runId, logDir, forcedRetryNote, refineExistingChildren = false }) {
  // Same primacy placement as runSpecAgent's forcedRetryBlock — highest-salience
  // position in the prompt for a same-session forced retry.
  const forcedRetryBlock = forcedRetryNote ? `${forcedRetryNote}\n\n` : '';
  // Single story, single codeline — real tools can be safely enabled (see
  // specAgentEnv's docstring for why phase-level calls cannot do this).
  const repoPath = resolveCodelinePath(story);
  // Full agent audit, 2026-07-31: `validateMidExecutionSplits` called this
  // function expecting per-child AC refinement back via
  // `result.payload.splitStories`, but every call site shared ONE prompt
  // that unconditionally told speckit "ALWAYS omit splitStories... never
  // propose split children of your own" — so that branch could never fire;
  // the entire call there was a no-op (its parent-AC output is also
  // discarded immediately after by the "Delegated to split children"
  // placeholder). `refineExistingChildren` is an explicit, narrow opt-in —
  // NOT inferred from `openspecOutput.splitStories` being present, since
  // that field carries a different meaning at other call sites (openspec
  // PROPOSING a split, not yet-created children) and conflating the two
  // would silently change behavior there. Only validateMidExecutionSplits
  // passes this true, for children it already created.
  const prompt = refineExistingChildren
    ? `${forcedRetryBlock}You are the speckit specification agent for EPAM CLI. Phase ${phase}, story ${story.id}.

This story was ALREADY split into the children listed below (openspec's decision, already applied — you are not creating or removing any child). Your job: review and refine EACH CHILD's acceptanceCriteria for testability and completeness, exactly as you would for an unsplit story.
1. For each child, review its acceptanceCriteria for testability and completeness
2. Add missing edge-case, error-handling, security, and accessibility criteria per child
3. Flag any AC that are vague, untestable, or overlapping
4. Do NOT add, remove, or rename any child — return one entry per child id below, using the SAME ids
5. Do NOT remove or duplicate the existing work — build on it

━━━ WHAT-NOT-HOW RULE (MANDATORY) ━━━
Every AC must describe an OBSERVABLE OUTCOME (what a test can verify from outside the code),
NOT an implementation instruction. If an AC names vi.mock, jest.fn, mockReturnValue,
mockResolvedValue, import statements, or require() calls, REPLACE it with a
Given/When/Then behaviour statement. Never tell the implementer which library or mock pattern to use.

THE EXISTING CHILDREN (your input to review):
${JSON.stringify(openspecOutput?.splitStories || [], null, 2)}

ORIGINAL PARENT STORY CONTEXT:
${JSON.stringify({
  id: story.id,
  title: story.title,
  description: story.description,
  originalAcceptanceCriteria: story.acceptanceCriteria,
  technicalNotes: story.technicalNotes,
  dependencies: story.dependencies || []
}, null, 2)}

Produce your refined output as raw JSON only (no XML tags, no markdown fences, no preamble):
- "splitStories": array of {"id": "<same child id>", "acceptanceCriteria": [...], "notes": "what you changed and why"} — one entry per child id above, same ids, no new/removed ids.
- "notes": overall summary of what you changed and why.

You may have read-only tools (read_file, list_files, search) available this turn for a
brownfield story with a real codeline — if so, USE them for real to verify a file's actual
contents before relying on it; do not invent what a tool would return. For a greenfield
story with no existing codeline, you have none — answer from what is already in this
prompt rather than guessing at file contents. Either way, never emit tool-call syntax
(<tool_call>, <tool_use>, <function_call>) narrating an imagined result — a fabricated
"tool_result" is worse than an honest "I don't know."
`
    : `${forcedRetryBlock}You are the speckit specification agent for EPAM CLI. Phase ${phase}, story ${story.id}.

You are reviewing and building on the openspec agent's output for this story.
Your role is COLLABORATIVE — you are NOT starting from scratch. Instead:
1. Review openspec's proposed acceptance criteria for testability and completeness
2. Add missing edge-case, error-handling, security, and accessibility criteria
3. Flag any AC that are vague, untestable, or overlapping
4. Splitting is openspec's decision alone — you do NOT split stories. If openspec already split
   this story, do NOT include a "splitStories" field in your output at all (it will be ignored if
   you do). Review and refine the acceptanceCriteria openspec gave you for the UNSPLIT story as
   normal; per-child refinement of an already-split story's children happens on a later turn, not
   here.
5. Do NOT remove or duplicate openspec's good work — build on it

━━━ WHAT-NOT-HOW RULE (MANDATORY) ━━━
Every AC must describe an OBSERVABLE OUTCOME (what a test can verify from outside the code),
NOT an implementation instruction. If an AC names vi.mock, jest.fn, mockReturnValue,
mockResolvedValue, import statements, or require() calls, REPLACE it with a
Given/When/Then behaviour statement. Never tell the implementer which library or mock pattern to use.

OPENSPEC'S OUTPUT (your input to review — ACs and split proposals only):
${JSON.stringify({
  acceptanceCriteria: openspecOutput?.acceptanceCriteria || [],
  notes: openspecOutput?.notes || '',
  splitStories: openspecOutput?.splitStories || undefined,
}, null, 2)}

ORIGINAL STORY CONTEXT:
${JSON.stringify({
  id: story.id,
  title: story.title,
  description: story.description,
  originalAcceptanceCriteria: story.acceptanceCriteria,
  technicalNotes: story.technicalNotes,
  dependencies: story.dependencies || []
}, null, 2)}

Produce your refined output as raw JSON only (no XML tags, no markdown fences, no preamble). Include:
- "acceptanceCriteria": The FULL merged list (openspec's criteria + your additions/refinements). Every item MUST be an observable outcome, not an implementation instruction.
- "notes": What you changed and why (be specific — cite which criteria you added/modified/replaced)
- "splitStories": ALWAYS omit this field. Splitting is openspec's decision alone — never propose
  split children of your own, even if openspec already split this story.
- "acAddedBySpeckit": Array of criteria YOU added that were not in openspec's output
- "acModifiedBySpeckit": Array of {"original":"...","revised":"..."} for criteria you reworded
- "acFlagged": Array of {"criterion":"...","flag":"..."} for criteria that need human attention

For a brownfield story with a real codeline, you may have read-only tools (read_file,
list_files, search) available this turn — if so, USE them for real to check a file's
actual contents before relying on it; do not invent what a tool would return. For a
greenfield story with no existing codeline, you have none — give your best answer from
the description, title and paths you were given, and say so in "notes" if the file
contents would have changed your answer. Either way, never narrate an imagined tool
result: a real answer with an honest caveat is worth everything; fabricated tool-call
syntax (<tool_call>, <tool_use>, <function_call>) is worth nothing — it is discarded in
full and the work is lost (observed live, 2026-07-28: exactly this, on an empty-criteria
story that got no answer at all).
`;
  try {
    const payload = await runAgentForJson(
      promptExec, prompt, TOOL_SPEC_AGENT, 'SPEC_AGENT',
      path.join(logDir, `${story.id}-speckit-review.log`), null, story.id, repoPath
    );
    if (payload) {
      payload.agent = 'speckit';
      // ACCEPTANCE CRITERIA ARE NOT IN SCOPE IN BROWNFIELD.
      //
      // A brownfield ticket's ACs are immutable and usually absent — the AC gate says so
      // itself, skipping AC processing and recording "VCs are derived from the
      // description". So there is nothing here for an AC guard to protect: any criteria in
      // this payload were INVENTED by the spec agent, and guarding invented criteria spends
      // a model call to police a field nothing downstream reads.
      //
      // It was not merely wasted. Live 2026-08-06, metrolinx: speckit produced ACs for a
      // brownfield story, the AC guard armed against them, the vocabulary agent's answer
      // failed to parse, and this threw — failing the spec pass on all three lanes over
      // acceptance criteria the ticket never had.
      //
      // Greenfield is unchanged: there the ACs are the contract, and the guard still
      // arms-or-aborts.
      const _brownfield = process.env.EPAM_BROWNFIELD === '1';
      let _acVocab = null;
      if (_brownfield) {
        if (Array.isArray(payload.acceptanceCriteria) && payload.acceptanceCriteria.length) {
          console.log(`spec-mode: brownfield — ignoring ${payload.acceptanceCriteria.length} AC(s) speckit produced for ${story.id}; ACs are out of scope and VCs come from the description`);
        }
      } else {
        // ARM OR ABORT — the vocabulary is derived per story; a guard with none checks
        // nothing while reporting clean, which is the failure this replaced.
        _acVocab = await deriveGuardVocabulary({
          promptExec,
          rule: AC_PRESCRIPTIVENESS_RULE,
          statements: payload.acceptanceCriteria,
          story,
          findings: (story && story.fixSiteAnalysis) || [],
          manifestFiles: (story && story.technicalNotes && story.technicalNotes.files) || [],
          logDir,
          seam: 'acceptance-criteria',
        });
        if (Array.isArray(payload.acceptanceCriteria) && payload.acceptanceCriteria.length
            && !isVocabularyUsable(_acVocab)) {
          throw new Error(`AC guard could not be armed for ${story.id}: the guard-vocabulary agent returned no usable terms after its full retry/ladder budget. Refusing to proceed with an unarmed guard.`);
        }
      }
      const { clean, flagged } = stripPrescriptiveACs(payload.acceptanceCriteria, story.id, _acVocab);
      if (flagged.length > 0) {
        payload.acceptanceCriteria = clean;
        payload.acFlagged = [...(payload.acFlagged || []), ...flagged];
        console.log(`spec-mode: speckit validator stripped ${flagged.length} prescriptive AC(s) from ${story.id}`);
      }
      // Also validate splitStories children
      if (Array.isArray(payload.splitStories)) {
        for (const child of payload.splitStories) {
          if (!child.acceptanceCriteria) continue;
          const { clean: childClean, flagged: childFlagged } = stripPrescriptiveACs(child.acceptanceCriteria, `${story.id}/${child.id}`, _acVocab);
          if (childFlagged.length > 0) {
            child.acceptanceCriteria = childClean;
            child.acFlagged = [...(child.acFlagged || []), ...childFlagged];
          }
        }
      }
    }
    return { agent: 'speckit', payload };
  } catch (error) {
    console.warn(`spec-mode: speckit review failed for ${story.id}:`, error.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildAssignments(assignments, stories, runId) {
  const map = new Map();
  const fallback = ['openspec', 'speckit'];
  const storyIds = new Set(stories.map((s) => s.id));
  // Brownfield mode: OPENSPEC MUST RUN for every story. openspec is the fix-site
  // discovery pass — it hosts the brownfield archaeology/locationHint block AND
  // the code-graph-detective invocation that grounds the story in the EXISTING
  // repo (which file actually computes the wrong value). The coordinator may
  // legitimately think a story needs no AC elaboration and assign only speckit
  // (or nothing) — but that skips openspec entirely, so fix-site discovery and
  // the detective never run, and the story proceeds to implementation with zero
  // location grounding. Found live 2026-07-23: coordinator assigned only
  // speckit → "openspec (elaboration) [0 stories]" → detective never fired →
  // technicalNotes.files null → wrong/absent fix site. Fix: in brownfield,
  // ALWAYS ensure openspec is in the agent list (prepended — it runs first),
  // regardless of what the coordinator chose. The coordinator's judgment about
  // whether speckit ALSO runs is still respected.
  const isBrownfield = process.env.EPAM_BROWNFIELD === '1';
  const ensureOpenspec = (agents) => {
    if (!isBrownfield) return agents;
    return agents.includes('openspec') ? agents : ['openspec', ...agents];
  };
  if (Array.isArray(assignments)) {
    assignments.forEach((entry) => {
      if (!entry || !storyIds.has(entry.storyId)) return;
      // Guard: only accept known agent names — LLM sometimes returns review content as agent name
      const VALID_AGENTS = new Set(['openspec', 'speckit']);
      const rawAgents = Array.isArray(entry.agents) ? entry.agents : [];
      let agents = rawAgents.filter(a => typeof a === 'string' && VALID_AGENTS.has(a));
      agents = ensureOpenspec(agents);
      map.set(entry.storyId, {
        storyId: entry.storyId,
        agents,
        notes: entry.notes || '',
        priority: entry.priority || 'normal',
        runId
      });
    });
  }
  stories.forEach((story) => {
    if (map.has(story.id)) return;
    map.set(story.id, { storyId: story.id, agents: fallback, notes: '', runId });
  });
  return map;
}

function captureStorySnapshot(story) {
  return {
    acceptanceCriteria: Array.isArray(story.acceptanceCriteria)
      ? [...story.acceptanceCriteria]
      : [],
    description: story.description,
    title: story.title,
    technicalNotes: story.technicalNotes || null,
    // Cycle-time investigation, 2026-07-31 (mock1 run that hit the 45-minute
    // test timeout): the prd-change-reviewer's own rule set says to reject
    // when "verificationCriteria is empty while the description names
    // concrete testable behaviour" — but this snapshot (the ONLY thing the
    // reviewer is shown) never included the field, so from the reviewer's
    // view it was ALWAYS absent regardless of the story's real state. That
    // false "empty" reading fired on essentially every brownfield story with
    // a concrete description, triggering the reviewer's 3-attempt retry loop
    // (each attempt re-runs openspec + detective + the full VC enforcement
    // loop) for a change the story never actually had. story.verificationCriteria
    // is already set (by enforceVerificationCriteria, inside runSpecAgent)
    // before afterSnapshot is captured, so this field is real, not a guess.
    verificationCriteria: Array.isArray(story.verificationCriteria)
      ? [...story.verificationCriteria]
      : []
  };
}

// Count split depth by walking the createdFrom chain back to the root story.
function splitDepth(story, prd) {
  let depth = 0;
  let parentId = story.specification?.createdFrom;
  const visited = new Set();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    const parent = prd.stories.find((s) => s.id === parentId);
    parentId = parent?.specification?.createdFrom;
  }
  return depth;
}

// Lightweight token-budget estimate for a story before it enters the executor.
// Measures the baseline prompt footprint (ACs × density + file entries + contract
// sizes) without running the executor. Intentionally conservative — accumulated
// context from tool calls is unknowable pre-execution, but the baseline is the
// dominant factor for over-budget stories.
const ESTIMATE_BASE = 2000;
const ESTIMATE_PER_AC = 150;
const ESTIMATE_PER_TC = 300;    // ~2 TCs per AC × 150 tokens each
const ESTIMATE_PER_FILE = 100;
const ESTIMATE_BYTES_PER_TOKEN = 4;

function estimateStoryTokens(story, contractDir) {
  const acCount = (story.acceptanceCriteria || []).length;
  const fileCount = (story.technicalNotes?.files || []).length;
  let contractTokens = 0;
  for (const depId of (story.dependencies || [])) {
    try {
      contractTokens += Math.ceil(
        fs.statSync(path.join(contractDir, `${depId}.md`)).size / ESTIMATE_BYTES_PER_TOKEN
      );
    } catch { /* contract not yet written — skip */ }
  }
  return ESTIMATE_BASE
    + (acCount * ESTIMATE_PER_AC)
    + (acCount * ESTIMATE_PER_TC)
    + (fileCount * ESTIMATE_PER_FILE)
    + contractTokens;
}

// Split MANDATE thresholds — shared by the prompt warning (runSpecAgent) and the
// deterministic post-hoc check below (checkSplitMandateViolation), so the two
// can never drift apart. Fully generic: no project/domain names, just AC count
// and impl/test file shape — applies identically to any project's stories.
const SPLIT_MANDATE_AC_THRESHOLD = 12;

function storyRequiresSplit(snapshot) {
  // Brownfield: a story IS the ticket, so there is nothing to subdivide.
  //
  // Live AMSD-2041 2026-07-30: the ticket carries NO acceptance criteria,
  // speckit invented 15 from its one-line title, this rule saw 15 > 12 and
  // forced openspec to produce `AMSD-2041-A` — a child that exists nowhere in
  // the client's Jira, can never be written back (writes to client systems are
  // hard-blocked), reached implementation and wrote nothing.
  //
  // Every assumption behind the mandate is greenfield: that ACs were authored
  // by someone who knows the work (here the pipeline authored them, so the
  // count measures the inventor); that AC count proxies size (a minimal fix to
  // existing code can be three lines behind fifteen observable behaviours); and
  // that a story is ours to split at all. Multi-codeline work is one story with
  // N executions and joined state — deliberately NOT a split.
  //
  // Keyed on brownfield being ON, never on its absence: a project that does not
  // set the variable must keep the mandate exactly as it is.
  if (process.env.EPAM_BROWNFIELD === '1') {
    return { required: false, reason: '' };
  }
  const acCount = Array.isArray(snapshot.acceptanceCriteria) ? snapshot.acceptanceCriteria.length : 0;
  const files = snapshot.technicalNotes?.files || [];
  const testFiles = files.filter((f) => f.endsWith('.test.ts') || f.endsWith('.spec.ts'));
  const implFiles = files.filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.spec.ts'));
  if (acCount > SPLIT_MANDATE_AC_THRESHOLD) {
    return { required: true, reason: `${acCount} acceptance criteria (> ${SPLIT_MANDATE_AC_THRESHOLD})` };
  }
  if (testFiles.length > 0 && implFiles.length > 0) {
    return { required: true, reason: `combines ${implFiles.length} implementation file(s) and ${testFiles.length} test file(s)` };
  }
  return { required: false, reason: '' };
}

// Root cause this catches (found live, 2026-07-06): openspec's prompt already
// says "MANDATORY split required" whenever storyRequiresSplit() is true — but
// that's pure prose, never verified afterward. A story meeting the mandate can
// silently stay unsplit for its entire lifetime with zero visible signal,
// because the ONLY existing split check (validateSplitFileCoherence, above)
// only fires when a split DID happen and is incoherent — it has nothing to
// say about a split that should have happened but never did. Confirmed live:
// a story with 15 ACs and combined impl+test files went through 3 separate
// openspec passes across 2 full pipeline runs and was never split, exhausting
// its entire model-escalation ladder on a single overloaded story instead.
// Returns {violated, reason} — detection only (Option D pattern: deterministic
// detection, not a silent auto-split, since auto-splitting requires domain
// judgment about where the split boundary goes).
function checkSplitMandateViolation(beforeSnapshot, splitCountAfter) {
  if (splitCountAfter > 0) {
    return { violated: false, reason: '' };
  }
  const { required, reason } = storyRequiresSplit(beforeSnapshot);
  if (!required) {
    return { violated: false, reason: '' };
  }
  return { violated: true, reason };
}

// ── TC-fact-density split mandate (test stories) ────────────────────────────
//
// Root cause this fixes (found live, 2026-07-14, tier3-travel-app run):
// storyRequiresSplit()/checkSplitMandateViolation() above only ever see AC
// count and impl/test file shape — both known at SPEC-PASS time (Step 0),
// before any implementation has run. But a pure test story's REAL
// generation load comes from testCriteria.facts — exact-match behavioral
// facts the TC writer only discovers post-impl, right before the test
// story itself executes (see lib/tc-writer-gate.sh). SKY-003-test had a
// modest 8 ACs (well under SPLIT_MANDATE_AC_THRESHOLD) but 20 TC facts + 19
// bannedPatterns crammed into ONE test file — every model at every
// escalation rung, up to the ceiling, produced widespread syntax
// corruption (30+ tsc errors) on it, 8/8 attempts. The AC-count mandate
// structurally cannot see this; it needs its own, TC-fact-density-based
// mandate, checked at the one point density is actually known.
//
// EPAM_TC_FACTS_SPLIT_THRESHOLD (default 30): facts count alone, since
// that's what makes ONE file too large to write correctly, independent of
// how many bannedPatterns rules also apply (those are global constraints
// copied to every split child unchanged, not something to partition).
const TC_FACTS_SPLIT_THRESHOLD = parseInt(process.env.EPAM_TC_FACTS_SPLIT_THRESHOLD || '30', 10);

function checkTcFactDensityMandate(factsCount, threshold = TC_FACTS_SPLIT_THRESHOLD) {
  const count = Number(factsCount) || 0;
  if (count > threshold) {
    return { violated: true, reason: `${count} testCriteria.facts (> ${threshold}) on a single test file — split into multiple test stories` };
  }
  return { violated: false, reason: '' };
}

// splitTestStoryByFacts <story> <prd> <phase> [maxFactsPerChild]
// Partitions a pure-test story's testCriteria.facts into N children, each
// owning a distinct test file covering its own subset of facts. Unlike
// applySpecChanges()'s AC-based split (which needs an LLM to decide WHERE
// the split boundary goes, since AC semantics require judgment), a facts
// array has no such ambiguity — each fact is an independent, already-atomic
// assertion, so a purely mechanical even partition is safe and requires no
// LLM involvement (same "deterministic code-level action, not LLM
// persuasion" principle as the rest of this pipeline's self-heal layer).
//
// Mutates `prd` in place: marks the parent deprecated+completed (delegated,
// same convention as applySpecChanges' AC-split parent handling) and
// splices the new child IDs into prd.implementationOrder[phase] at the
// parent's former position. Returns { splitCount, childIds } — {0, []} if
// the story isn't eligible (not a pure test story, or already split/
// deprecated).
function splitTestStoryByFacts(story, prd, phase, maxFactsPerChild = TC_FACTS_SPLIT_THRESHOLD) {
  if (!story || story.status === 'deprecated') return { splitCount: 0, childIds: [] };
  const files = story.technicalNotes?.files || [];
  const isPureTestStory = files.length > 0 && files.every((f) => f.endsWith('.test.ts') || f.endsWith('.spec.ts'));
  if (!isPureTestStory || files.length !== 1) return { splitCount: 0, childIds: [] };

  const facts = Array.isArray(story.testCriteria?.facts) ? story.testCriteria.facts : [];
  if (facts.length === 0) return { splitCount: 0, childIds: [] };

  const perChild = Math.max(1, Number(maxFactsPerChild) || TC_FACTS_SPLIT_THRESHOLD);
  const childCount = Math.ceil(facts.length / perChild);
  if (childCount <= 1) return { splitCount: 0, childIds: [] };

  const testFile = files[0];
  const dotIdx = testFile.lastIndexOf('.test.');
  const isSpec = dotIdx === -1;
  const splitPoint = isSpec ? testFile.lastIndexOf('.spec.') : dotIdx;
  const ext = isSpec ? '.spec.ts' : '.test.ts';
  const base = testFile.slice(0, splitPoint);

  const childIds = [];
  const newChildren = [];
  for (let i = 0; i < childCount; i++) {
    const childId = `${story.id}-tc${i + 1}`;
    const factSlice = facts.slice(i * perChild, (i + 1) * perChild);
    const child = JSON.parse(JSON.stringify(story));
    child.id = childId;
    child.title = `${story.title} (part ${i + 1}/${childCount})`;
    child.status = 'pending';
    child.completed = false;
    child.technicalNotes = { ...story.technicalNotes, files: [`${base}.tc${i + 1}${ext}`] };
    child.testCriteria = {
      ...story.testCriteria,
      facts: factSlice,
    };
    child.specification = {
      ...(story.specification || {}),
      createdFrom: story.id,
      createdAt: new Date().toISOString(),
      splitOrigin: 'tc-density-split',
      splitDepth: ((story.specification && story.specification.splitDepth) || 0) + 1,
    };
    childIds.push(childId);
    newChildren.push(child);
  }

  prd.stories.push(...newChildren);
  story.acceptanceCriteria = [`Delegated to TC-density split children: ${childIds.join(', ')}`];
  story.status = 'deprecated';
  story.completed = true;

  const order = prd.implementationOrder?.[phase];
  if (Array.isArray(order)) {
    const idx = order.indexOf(story.id);
    if (idx !== -1) {
      order.splice(idx, 1, ...childIds);
    } else {
      order.push(...childIds);
    }
  }

  console.log(`spec-mode: TC-fact-density split — ${story.id} (${facts.length} facts) → ${childIds.join(', ')} (${perChild} facts/child max)`);
  return { splitCount: childIds.length, childIds };
}

// Root cause this fixes (found live, 2026-07-06, tier3-full-run-18): a split
// child whose files are ALL test files (e.g. SKY-002-TEST, owning only
// client.test.ts) kept the PARENT's implementation-oriented agentRole
// (typescript-engineer) instead of a test-oriented role. The only existing
// correction mechanism was an LLM instruction buried in the Step 0.5 "skill
// assessment" prompt ("if all files match *.test.ts, update agentRole to
// test-engineer") — and it silently failed to apply to EVERY split child
// created this run, not just one. A rule this simple (file-extension pattern
// -> role) should never depend on an LLM correctly executing free-text
// instructions.
//
// Deliberately NOT hardcoding a role name here — agent roles are project-
// defined and dynamic (profiles.json is generated per-project, not fixed).
// The correct role name and the pattern that identifies "this is a test-only
// story" both come from the project's own .epam/contract-generation.json
// (testFilePattern / testFileAgentRole), the same "config supplies stack
// knowledge, engine has none" convention already used for dependency-check.json
// and elsewhere in this file. If the project hasn't supplied testFileAgentRole,
// this is a no-op — the child simply keeps whatever role it already had.
function correctSplitChildAgentRoleIfTestOnly(prd, story) {
  const outputDir = prd.project?.outputDir;
  if (!outputDir) return;
  const configPath = path.join(outputDir, '.epam', 'contract-generation.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return;
  }
  if (!cfg.testFileAgentRole || !cfg.testFilePattern) return;
  const files = story.technicalNotes?.files;
  if (!Array.isArray(files) || files.length === 0) return;
  const testFileRe = new RegExp(cfg.testFilePattern);
  const allTestFiles = files.every((f) => testFileRe.test(f));
  if (allTestFiles) {
    story.agentRole = cfg.testFileAgentRole;
  }
}

// wireSplitSiblingDependencies(siblings, prd)
// Root cause this fixes (found live, 2026-07-09, tier3-travel-app run): a
// split child's `dependencies` array comes straight from the LLM's own split
// proposal — nothing deterministically cross-references a test-only sibling
// to its impl sibling from the SAME split. Downstream, claude.sh's
// dependency-contract injection (build_implementation_prompt,
// run_failure_analyst) and are_dependencies_satisfied() gate ONLY on
// `.dependencies`/`.technicalNotes.dependsOn` — so a test child never
// receives its impl sibling's real (regex-extracted) exported signatures, on
// its first attempt OR any retry. Confirmed live: SKY-003-test/-test-1 and
// SKY-004-test all had `dependencies: []` despite an obvious impl sibling
// (same `specification.createdFrom`), and burned 7+ healing cycles guessing
// at shifting surface symptoms instead of ever seeing the real contract.
//
// Uses the SAME basename-matching convention already proven live in
// post-impl-tc-writer.sh's peer-file search (strip a test file's suffix,
// strip a candidate impl file's extension, match on the resulting stem) —
// generalized to read `testFilePattern`/`sourceExtensions` from the
// project's existing `.epam/contract-generation.json` (both keys already
// exist in every scaffolded project's config; zero new schema) instead of
// hardcoding '.test.ts'/'.ts', so this stays stack-agnostic like every other
// consumer of that config file.
function wireSplitSiblingDependencies(siblings, prd) {
  const outputDir = prd.project?.outputDir;
  if (!outputDir || !Array.isArray(siblings) || siblings.length < 2) return;
  const configPath = path.join(outputDir, '.epam', 'contract-generation.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return;
  }
  if (!cfg.testFilePattern || !Array.isArray(cfg.sourceExtensions) || !cfg.sourceExtensions.length) return;
  const testFileRe = new RegExp(cfg.testFilePattern);
  const exts = [...cfg.sourceExtensions].sort((a, b) => b.length - a.length);

  const stemOf = (filePath, isTest) => {
    const base = filePath.split('/').pop();
    if (isTest) return base.replace(testFileRe, '');
    for (const ext of exts) {
      if (base.endsWith(ext)) return base.slice(0, -ext.length);
    }
    return base;
  };

  for (const testSibling of siblings) {
    const files = testSibling.technicalNotes?.files;
    if (!Array.isArray(files) || files.length === 0) continue;
    if (!files.every((f) => testFileRe.test(f))) continue; // not a pure test-only child
    const testStems = new Set(files.map((f) => stemOf(f, true)));
    const deps = new Set(Array.isArray(testSibling.dependencies) ? testSibling.dependencies : []);
    let wired = false;
    for (const implSibling of siblings) {
      if (implSibling === testSibling) continue;
      const implFiles = implSibling.technicalNotes?.files;
      if (!Array.isArray(implFiles) || implFiles.length === 0) continue;
      if (implFiles.some((f) => testFileRe.test(f))) continue; // skip other test siblings
      const implStems = implFiles.map((f) => stemOf(f, false));
      if (implStems.some((s) => testStems.has(s)) && !deps.has(implSibling.id)) {
        deps.add(implSibling.id);
        wired = true;
      }
    }
    if (wired) {
      testSibling.dependencies = [...deps];
      console.log(`spec-mode: wired ${testSibling.id}.dependencies -> [${[...deps].join(', ')}] (deterministic sibling match, createdFrom=${testSibling.specification?.createdFrom})`);
    }
  }
}

// reorderSiblingsByDependency(siblings, order)
// Required corollary of wireSplitSiblingDependencies: are_dependencies_satisfied()
// (claude.sh) hard-gates a story on its dependencies' `.completed==true`, and
// the main Step 1 loop executes strictly in implementationOrder[phase] order.
// Newly wiring a dependency onto a sibling ordered BEFORE its dependency would
// introduce a new hard failure that doesn't exist today — this only reorders
// IDs already present in the same sibling group, moving a dependent story to
// just after its dependency.
function reorderSiblingsByDependency(siblings, order) {
  if (!Array.isArray(order) || !Array.isArray(siblings)) return;
  const siblingIds = new Set(siblings.map((s) => s.id));
  for (const s of siblings) {
    const deps = Array.isArray(s.dependencies) ? s.dependencies : [];
    for (const depId of deps) {
      if (!siblingIds.has(depId)) continue; // only reorder within this sibling group
      const selfIdx = order.indexOf(s.id);
      const depIdx = order.indexOf(depId);
      if (selfIdx !== -1 && depIdx !== -1 && selfIdx < depIdx) {
        order.splice(selfIdx, 1);
        const newDepIdx = order.indexOf(depId);
        order.splice(newDepIdx + 1, 0, s.id);
      }
    }
  }
}

// assertNoStoryIdsLost(beforeIds, afterIds, contextLabel)
// Deterministic invariant check against silent story deletion — JS-side
// mirror of run-agent-orchestration.sh's assert_no_story_ids_lost(). See
// that function's docstring for the live defect this guards against
// (SKY-002/003/004 vanishing entirely from prd.stories[], 2026-07-09).
// beforeIds/afterIds are Sets of story IDs; throws if any ID present in
// beforeIds is absent from afterIds. A GROWING set (new split children) is
// expected and not an error.
function assertNoStoryIdsLost(beforeIds, afterIds, contextLabel) {
  const lost = [...beforeIds].filter((id) => !afterIds.has(id));
  if (lost.length > 0) {
    throw new Error(`spec-mode-runner: STORY-ID-LOSS INVARIANT VIOLATED — story/ies vanished from prd.stories[] during ${contextLabel}: ${lost.join(', ')}`);
  }
}

// resolveModelProvider(model, env)
// JS port of claude.sh's resolve_model_provider() — reads EPAM_MODEL_PROVIDER_MAP
// (pipe-separated "glob-pattern=provider" pairs) and returns the provider for a
// model name via glob matching. Zero hardcoded vendor/model names here, same
// config-driven pattern as the bash original. Returns null when no map is
// configured or no pattern matches (caller keeps the story's existing aiProvider).
//
// Root cause this fixes (found live, 2026-07-07): spec-mode's LLM model-review
// step (below) can override a story's .model field (e.g. moonshotai/kimi-k2 ->
// MiniMax-M3) but never touched .aiProvider — a story ended up with
// aiProvider="qwen" (correct for the OLD model) paired with model="MiniMax-M3"
// (which needs the "minimax" provider), silently sending a MiniMax-native model
// name to the OpenRouter-routed qwen provider. That request never resolves
// correctly and hangs until the pipeline's 600s watchdog kills it — the actual
// root cause of SKY-002-test/SKY-003-test repeatedly stalling with zero output
// in that day's live run, misread at first as a flaky-API/network issue.
// Look up a model's HIGH-ladder successor (EPAM_MODEL_LADDER_HIGH is a
// "from=to|from=to" map, e.g. "z-ai/glm-5.1=moonshotai/kimi-k3"). Returns the
// escalation target for `model`, or null if the model isn't in the ladder. Used
// to escalate the code-graph-detective to a stronger model (kimi-k3) on retry —
// the same laddering openspec/speckit already do, so the detective is cohesive
// with the rest of the pipeline instead of hard-pinned to one model.
function ladderNextModel(model, env = process.env) {
  const map = env.EPAM_MODEL_LADDER_HIGH || env.EPAM_MODEL_LADDER || '';
  if (!map || !model) return null;
  for (const pair of map.split('|')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === model.trim()) return pair.slice(eq + 1).trim();
  }
  return null;
}

function resolveModelProvider(model, env = process.env) {
  const map = env.EPAM_MODEL_PROVIDER_MAP;
  if (!map || !model) return null;
  const globToRegExp = (glob) =>
    new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  for (const pair of map.split('|')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const pattern = pair.slice(0, eq);
    const provider = pair.slice(eq + 1);
    if (globToRegExp(pattern).test(model)) return provider;
  }
  return null;
}

// Matches the exact placeholder applySpecChanges writes onto a parent story's
// acceptanceCriteria after a successful split (see "Delegated to split
// children:" above). Deliberately a single-purpose string check, not a general
// AC-quality heuristic — this only needs to recognize the ONE deterministic
// template the engine itself produces.
const SPLIT_DELEGATION_AC_PATTERN = /^Delegated to split children: /;

function isSplitDelegationAc(acceptanceCriteria) {
  return (
    Array.isArray(acceptanceCriteria) &&
    acceptanceCriteria.length === 1 &&
    SPLIT_DELEGATION_AC_PATTERN.test(acceptanceCriteria[0])
  );
}

// Root cause this fixes (found live, 2026-07-06, first surfaced only once
// splits started actually succeeding): prd-change-reviewer is a content-quality
// gate that judges a story's AC/description/title rewrite on its own merits —
// it has no way to know "Delegated to split children: X, Y" is a deterministic,
// engine-written placeholder rather than an organically-authored AC, so it
// correctly-by-its-own-lights flags it as "vague and unmeasurable" and reverts
// the ENTIRE change, undoing a structurally-valid split (which applySpecChanges
// had already verified via file coherence, depth, and budget checks) purely
// because of how the resulting placeholder text reads. A split's correctness
// is already deterministically verified elsewhere; asking an LLM to also judge
// the placeholder text it can't recognize as a placeholder is a pure false
// positive, not a real quality signal.
//
// Returns true when the review gate should be skipped for this change because
// a split occurred and the ONLY substantive difference from beforeSnapshot is
// the deterministic delegation marker — description/title/technicalNotes are
// unchanged, so there is nothing else here for a content reviewer to assess.
function isSplitDelegationOnlyChange(beforeSnapshot, afterSnapshot, splitCount) {
  if (!(splitCount > 0)) return false;
  if (!isSplitDelegationAc(afterSnapshot.acceptanceCriteria)) return false;
  return (
    afterSnapshot.description === beforeSnapshot.description &&
    afterSnapshot.title === beforeSnapshot.title &&
    JSON.stringify(afterSnapshot.technicalNotes) === JSON.stringify(beforeSnapshot.technicalNotes)
  );
}

// Detect same-file coherence violations: multiple split children claiming to write
// the same non-test file. Each agent rewrites the file from scratch, so the last
// writer wins and all prior agents' work is silently discarded.
// Returns array of {file, childIds} conflicts. Empty array = coherent.
function validateSplitFileCoherence(children) {
  // Check ALL declared files — test files included. Each split child rewrites its file
  // from scratch (last writer wins), so two children declaring the same .test.ts lose
  // all work from every child except the last one. No exemption for test files.
  const fileToChildren = new Map();
  for (const child of children) {
    const files = (child.technicalNotes?.files || [])
      .filter(f => typeof f === 'string');
    for (const file of files) {
      if (!fileToChildren.has(file)) fileToChildren.set(file, []);
      fileToChildren.get(file).push(child.id);
    }
  }
  const conflicts = [];
  for (const [file, childIds] of fileToChildren) {
    if (childIds.length > 1) conflicts.push({ file, childIds });
  }
  return conflicts;
}

// Hard code enforcement for split eligibility — not a prompt instruction, a code invariant.
// Called before registering any split child (per-child, so budget check tightens as children accumulate).
const MAX_ACS_PER_STORY = parseInt(process.env.SPEC_MAX_ACS || '24', 10);
const MAX_CHILDREN_PER_SPLIT = parseInt(process.env.SPEC_MAX_CHILDREN || '4', 10);

function canSplitStory(story, prd, newStories) {
  const maxSplitDepth = parseInt(process.env.SPEC_MAX_SPLIT_DEPTH || '2', 10);
  const currentDepth = splitDepth(story, prd);
  if (currentDepth >= maxSplitDepth) {
    return { ok: false, reason: `depth ${currentDepth} >= max ${maxSplitDepth}` };
  }
  const existingChildren = (prd.stories || []).filter(
    s => s.specification?.createdFrom === story.id
  ).length;
  const pendingChildren = (newStories || []).filter(
    ns => ns.parentId === story.id
  ).length;
  if (existingChildren + pendingChildren >= MAX_CHILDREN_PER_SPLIT) {
    return { ok: false, reason: `split budget exhausted (${existingChildren + pendingChildren} children >= max ${MAX_CHILDREN_PER_SPLIT})` };
  }
  return { ok: true, reason: '' };
}

// AC cap — modifies story in place, logs if truncated
function capSplitACs(story, parentId) {
  const acs = Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [];
  if (acs.length > MAX_ACS_PER_STORY) {
    console.warn(`spec-mode: AC cap enforced on ${story.id} (child of ${parentId}): ${acs.length} → ${MAX_ACS_PER_STORY}`);
    story.acceptanceCriteria = acs.slice(0, MAX_ACS_PER_STORY);
  }
}

// Merges locationHint's discovered file paths into technicalNotes.files
// (additive, deduped) — extracted so the same merge can be re-applied after a
// content-quality revert wipes technicalNotes back to its pre-spec-pass value
// (see AMSD-2041, 2026-07-31: the revert path in run() erased a real,
// detective-grounded file list along with a rejected AC rewrite it had
// nothing to do with). Returns technicalNotes unchanged when locationHint is
// empty/absent.
/**
 * coveringTestFiles(repoPath, files) -> [test file paths]
 *
 * The test that already covers a declared file, found by IMPORT rather than guessed by name.
 *
 * The writer is responsible for tests, and it only writes inside its manifest. On AMSD-2041
 * the manifest named src/services/<module>.ts and nothing else, so the covering suite —
 * src/services/__tests__/<module>.spec.ts, which imports that exact module and already
 * exercises analogous config — was never in scope. The reviewer asked for tests on seven
 * cycles across two runs and the writer had nowhere sanctioned to put them.
 *
 * Derivation, in order:
 *   1. tracked files only (git ls-files) — never build output or vendored copies
 *   2. files the TEST RUNNER would collect. jest's documented default is __tests__ directories
 *      plus *.spec / *.test; EPAM_TEST_FILE_PATTERN overrides it for a project whose runner
 *      differs. This is the runner's own contract, not a convention invented here.
 *   3. of those, the ones that IMPORT the declared module. An import is evidence of coverage;
 *      a matching filename is a coincidence.
 */
function coveringTestFiles(repoPath, files, env = process.env) {
  const out = [];
  try {
    if (!repoPath || !fs.existsSync(repoPath)) return out;
    const declared = (Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && f);
    if (!declared.length) return out;
    const testPattern = new RegExp(env.EPAM_TEST_FILE_PATTERN || '(^|/)__tests__/|\\.(spec|test)\\.[jt]sx?$');
    const tracked = require('child_process')
      .execFileSync('git', ['-C', repoPath, 'ls-files'], { encoding: 'utf8', maxBuffer: 1 << 26 })
      .split('\n').filter(Boolean);
    const candidates = tracked.filter((f) => testPattern.test(f));
    for (const src of declared) {
      const srcNoExt = src.replace(/\.[jt]sx?$/, '');
      for (const t of candidates) {
        if (out.includes(t) || declared.includes(t)) continue;
        let body = '';
        try { body = fs.readFileSync(path.join(repoPath, t), 'utf8'); } catch { continue; }
        // RESOLVE the import, do not pattern-match its tail. Matching on basename alone
        // accepted "constants/<module>" and "interface/<module>" as covering
        // "services/<module>.ts" — 21 unrelated suites for one declared file, which would
        // have handed the writer a manifest naming most of the test tree.
        let covers = false;
        for (const m of body.matchAll(/(?:from\s*|require\(\s*)['"]([^'"]+)['"]/g)) {
          const spec = m[1];
          let resolved;
          if (spec.startsWith('.')) {
            resolved = path.posix.normalize(path.posix.join(path.posix.dirname(t), spec));
          } else {
            // Non-relative (alias or baseUrl) import: it covers the declared file only when
            // the declared path ENDS with the specifier — "services/<module>" matches
            // "src/services/<module>.ts", "constants/<module>" does not.
            resolved = spec;
            if (srcNoExt.endsWith(`/${spec}`) || srcNoExt === spec) { covers = true; break; }
            continue;
          }
          if (resolved === srcNoExt || resolved === src) { covers = true; break; }
        }
        if (covers) out.push(t);
      }
    }
  } catch { /* a manifest without a covering test is a fact, not an error */ }
  return out;
}

function mergeLocationHintFiles(technicalNotes, locationHint) {
  if (!Array.isArray(locationHint) || !locationHint.length) return technicalNotes;
  const hintFiles = locationHint
    .map(h => (h && typeof h === 'object' ? h.file : null))
    .filter(f => typeof f === 'string' && f.trim().length > 0);
  if (!hintFiles.length) return technicalNotes;
  const existingFiles = Array.isArray(technicalNotes?.files) ? technicalNotes.files : [];
  const mergedFiles = [...new Set([...existingFiles, ...hintFiles])];
  return { ...(technicalNotes || {}), files: mergedFiles };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve a declared path against ONE real checkout. Assumes no naming convention:
// exact, then case variant, then same-stem/different-extension. The repository is the
// authority — which is why no camelCase rule is needed or wanted. Mirrors
// lib/story_manifest_schema.py's resolve_path so both sides agree on what "resolved"
// means; the Python model is the schema source of truth, this is the runtime path.
function _resolveInCodeline(declared, codelineRoot) {
  const checked = [declared];
  const abs = (p) => path.join(codelineRoot, p);
  try {
    if (fs.statSync(abs(declared)).isFile()) {
      return { actual: declared, match: 'exact' };
    }
  } catch { /* fall through to variants */ }

  const relDir = path.dirname(declared) === '.' ? '' : path.dirname(declared);
  const base = path.basename(declared);
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  const absDir = relDir ? abs(relDir) : codelineRoot;
  const joinRel = (e) => (relDir ? path.join(relDir, e) : e);

  let entries;
  try {
    entries = fs.readdirSync(absDir).sort();
  } catch {
    return { unresolved: { declared, candidates_checked: checked, reason: `directory '${relDir || '.'}' does not exist in this codeline` } };
  }

  for (const e of entries) {
    if (e !== base && e.toLowerCase() === base.toLowerCase()) {
      return { actual: joinRel(e), match: 'case_variant' };
    }
  }
  for (const e of entries) {
    const eExt = path.extname(e);
    if (path.basename(e, eExt).toLowerCase() === stem.toLowerCase() && eExt !== ext) {
      return { actual: joinRel(e), match: 'extension_variant' };
    }
  }
  return {
    unresolved: {
      declared,
      candidates_checked: checked.concat(entries.map(joinRel)),
      reason: 'no exact, case-variant or extension-variant match exists in this codeline',
    },
  };
}

// codelineScopeBlock(prd, stories) → prompt text telling the spec reviewer which lane it is
// looking at, or '' when the question does not arise.
//
// The spec pass runs per codeline against that codeline's own checkout, so its manifest, fix
// sites and verification criteria describe THAT repository. The reviewer's prompt never said
// so. On AMSD-2041 it saw codelines:[three] on the story, criteria naming only metrolinx
// surfaces, and reported missing_cross_codeline_paths at 0.65 — below the 0.7 halt threshold,
// so it stopped the run. The reviewer reasoned correctly from what it was shown; it was shown
// one lane's work and told it was the whole story.
//
// This corrects what it is shown. It does NOT tell it to ignore cross-codeline problems —
// those are real whenever this lane's own change depends on another — and it does not steer
// the number. Every codeline name comes from the PRD's own project.outputDirs.
function codelineScopeBlock(prd, stories) {
  const thisLane = laneCodeline(prd);
  if (!thisLane) return '';
  const list = Array.isArray(stories) ? stories : [];
  const spanning = list.filter((s) => s && Array.isArray(s.codelines) && s.codelines.length > 1);
  if (!spanning.length) return '';

  const others = [...new Set(spanning.flatMap((s) => s.codelines))]
    .filter((cl) => cl && cl !== thisLane);
  if (!others.length) return '';

  return `
CODELINE SCOPE — you are reviewing ONE lane.

This spec pass ran against '${thisLane}' only, using that codeline's own checkout. The story
also spans: ${others.join(', ')}. Each of those is specified by its own pass, against its own
checkout, and the results are recorded per codeline and merged afterwards. You are not seeing
their work and it is not missing.

So: judge whether this specification is correct, observable and implementable IN '${thisLane}'.
Do not penalise it because a file, function or criterion it names does not exist in
${others.join(' or ')} — those codelines wire the same behaviour at their own sites, which
their own lane locates.

A cross-codeline concern IS in scope, and you should raise it, when '${thisLane}'s own change
depends on one: a shared contract it consumes, a payload shape another codeline produces, or
work that cannot function unless another lane changes too. The distinction is dependency, not
absence.
`;
}

// laneCodeline(prd) → the codeline this process is running as, or null.
//
// The spec pass runs PER LANE on that lane's own filtered PRD, and several things have to
// know WHICH lane: the resolved file manifest, and the fix sites the detective found. The
// derivation is the one used everywhere else in the engine — project.outputDir matched back
// against project.outputDirs[] — so no codeline or client name is written into the engine;
// it comes from the PRD's own data.
//
// Returns null rather than guessing. A single-codeline run has no lane to derive, and an
// outputDir matching nothing declared is a condition to leave alone, not to paper over by
// picking the first entry.
function laneCodeline(prd) {
  const outDir = prd && prd.project && prd.project.outputDir;
  const dirs = (prd && prd.project && Array.isArray(prd.project.outputDirs))
    ? prd.project.outputDirs : [];
  if (!outDir || !dirs.length) return null;
  const hit = dirs.find((d) => d && d.path === outDir);
  return (hit && hit.codeline) || null;
}

// buildPerCodelineManifest(story, prd) → { <codeline>: {files, resolved, unresolved} } | null
//
// A SINGLE shared technicalNotes.files array cannot be correct when the lanes are
// separate repositories whose real filenames differ — at most one lane's path can be
// right. Live 2026-08-03: the detective's own root-cause fix site was declared once for
// three codelines that spell it three ways, so it resolved on one lane; two writers were
// handed a path that does not exist, and a reviewer then blocked one of them for not
// editing it.
//
// Codeline→checkout comes from the PRD's own project.outputDirs, so no client name
// appears here. Returns null (never a guess) when there are no declared paths or no
// codeline mapping to resolve against.
function buildPerCodelineManifest(story, prd) {
  const declared = Array.isArray(story?.technicalNotes?.files) ? story.technicalNotes.files : [];
  if (!declared.length) return null;

  const outputDirs = Array.isArray(prd?.project?.outputDirs) ? prd.project.outputDirs : [];
  if (!outputDirs.length) return null;

  const rootFor = new Map(
    outputDirs.filter(o => o && o.codeline && o.path).map(o => [o.codeline, o.path]),
  );
  const codelines = Array.isArray(story.codelines) && story.codelines.length
    ? story.codelines
    : (story.codeline ? [story.codeline] : []);
  if (!codelines.length) return null;

  const out = {};
  for (const cl of codelines) {
    const root = rootFor.get(cl);
    if (!root) continue;                       // no checkout declared — do not invent one
    const files = [];
    const resolved = [];
    const unresolved = [];
    for (const d of declared) {
      const r = _resolveInCodeline(d, root);
      if (r.unresolved) {
        unresolved.push(r.unresolved);
      } else {
        files.push(r.actual);
        resolved.push({ declared: d, actual: r.actual, match: r.match, verified_against: root });
      }
    }
    out[cl] = { files, resolved, unresolved };
  }
  return Object.keys(out).length ? out : null;
}

function applySpecChanges(story, payload, newStories, prd, phaseId, runId, logDir = null) {
  const result = { acceptanceChanged: false, splitCount: 0 };
  // AC IMMUTABILITY — UNIVERSAL BACKSTOP (brownfield only). Every spec-agent
  // payload merges through here (openspec, speckit, every retry/token-retry path),
  // so this is the ONE choke point where the ticket's ACs can be locked as
  // immutable regardless of which agent produced the payload. The per-agent
  // preserve call in runSpecAgent only covered the `agent==='openspec'` branch;
  // speckit's prompt explicitly asks it to emit "the FULL merged acceptanceCriteria
  // list", and that payload reached applySpecChanges with NO guard — so speckit
  // silently re-elaborated a 0-AC brownfield ticket into 9 fabricated ACs (found
  // live 2026-07-24, AMSD-1820). Restoring here makes the AC array the immutable
  // ticket intent for ALL brownfield agents; the merge below then sees no change.
  // No-op for greenfield (EPAM_BROWNFIELD gate inside preserveDefectAcceptanceCriteria),
  // where speckit legitimately merges/refines ACs.
  preserveDefectAcceptanceCriteria(payload, story, process.env);
  if (Array.isArray(payload.acceptanceCriteria) && payload.acceptanceCriteria.length) {
    const capped = payload.acceptanceCriteria.slice(0, MAX_ACS_PER_STORY);
    if (capped.length < payload.acceptanceCriteria.length) {
      console.warn(`spec-mode: AC cap enforced on ${story.id}: ${payload.acceptanceCriteria.length} → ${capped.length}`);
    }
    const before = JSON.stringify(story.acceptanceCriteria || []);
    const after = JSON.stringify(capped);
    if (before !== after) {
      story.acceptanceCriteria = capped;
      result.acceptanceChanged = true;
    }
  }
  if (typeof payload.description === 'string' && payload.description.trim()) {
    story.description = payload.description.trim();
  }
  if (payload.title && typeof payload.title === 'string') {
    story.title = payload.title.trim();
  }
  if (payload.technicalNotes && typeof payload.technicalNotes === 'object') {
    story.technicalNotes = payload.technicalNotes;
  }
  // ── Persist the classification, do not just use it in passing ─────────────
  // The spec agent classifies every story as "defect" or "novel", the runner
  // reads it in-memory (Jira-type anchoring, split decisions) — and then threw
  // it away, so every story reached the PRD with storyKind:null.
  //
  // Three consumers read this field and were therefore dead code:
  //   classify_ladder_tier   novel brownfield -> high ladder
  //   resolve_model_from_story  novel brownfield -> high model
  //   the bug-reproduction gate  skip novel stories (a novel story can never
  //                              ship a test reproducing a bug that has none)
  // All three were verified against synthetic PRDs where the field was set by
  // hand; nothing checked that the PRODUCER writes it. It does not, so a live
  // run classified the story "novel" in every lane and still started it on the
  // cheapest model and gated it as a defect.
  if (payload.storyKind === 'defect' || payload.storyKind === 'novel') {
    story.storyKind = payload.storyKind;
  }
  // locationHint (brownfield openspec only): CodeGraph/Semble-grounded fix-site
  // file paths, discovered from the "EXISTING CODE" context already injected
  // into this same prompt. The prompt explicitly asks the model for this
  // (see locationHintSchemaLine above) but until now nothing ever read the
  // response back out — it was requested and silently discarded every time.
  // Without this reaching technicalNotes.files, the later planning/execution
  // prompts show an empty "Files to Create/Modify" section, so the story
  // agent has no grounded target and has to spend its own turn budget
  // searching the codebase from scratch — often running out before writing
  // anything real. Live bug (2026-07-22): AMSD-1820 ran dry mid-search
  // ("Now let me look at the Mozio dispatch models:") and the only file that
  // actually changed was CodeGraph's own incidental index write, which the
  // auto-commit step then swept up as if it were the story's real output.
  // Merge (not overwrite) — technicalNotes may already carry other fields
  // (or files) from this same payload or an earlier pass.
  story.technicalNotes = mergeLocationHintFiles(story.technicalNotes, payload.locationHint);

  // Resolve the declared files against EACH codeline's own checkout and persist the
  // per-codeline truth. The flat `files` array stays for backward compatibility, but a
  // single array cannot be correct across repositories that spell the same file
  // differently — live 2026-08-03 it resolved on one lane of three, and the two writers
  // handed a non-existent path could not do the work they were then blocked for. An
  // unresolvable entry is recorded WITH the candidates checked, so a wrong path is
  // visible in the PRD at spec time instead of surfacing as a mystery at write time.
  // A FIX SITE BELONGS TO A CODELINE. The detective's finding shape — {file, function,
  // reason, fix, helper, brokenLine, …} — has no codeline on it, so for a spanning story the
  // array could not say which repository each site lives in. Two things broke on that: the
  // merge into the canonical PRD was last-writer-wins (AMSD-2041 gave all three lanes
  // metrolinx's newsService.ts / getEventsList.ts, which exist in neither of the others), and
  // a finding from one codeline entering another's writer manifest was undetectable.
  //
  // Stamped here because this is where the lane is already derived, and it runs after the
  // detective for every story. A finding that already names a codeline is left alone: a
  // cross-codeline finding must not be relabelled with the lane that merely observed it.
  const _laneForSites = laneCodeline(prd);
  if (_laneForSites && Array.isArray(story.fixSiteAnalysis)) {
    story.fixSiteAnalysis = story.fixSiteAnalysis.map((f) =>
      (f && typeof f === 'object' && !f.codeline) ? { ...f, codeline: _laneForSites } : f);
  }

  const _perCodeline = buildPerCodelineManifest(story, prd);
  if (_perCodeline) {
    story.technicalNotes = { ...story.technicalNotes, perCodeline: _perCodeline };

    // THE FLAT LIST IS WHAT EVERYTHING READS. perCodeline was correct from the day it
    // was added and nothing consumed it: technicalNotes.files kept the DECLARED spelling,
    // and that is the list rendered into the writer prompt, handed to the reviewer, and
    // checked by the gates.
    //
    // Live 2026-08-04 (run 20260804T035435Z) two of three lanes paused with a manifest
    // naming a file that does not exist: one checkout held an extension variant of the
    // declared path, another a case variant, and both lanes declared a third spelling. The
    // writer is then sent to a path its checkout does not have; it assumes a second file
    // exists, creates it, deletes it, declares the real one out of scope, and every retry
    // reproduces the same tsc failure. 120 iterations, ~2M input tokens, 4 writes.
    //
    // The spec pass runs PER LANE on that lane's own filtered PRD, so the flat list can
    // and must be this lane's resolved list. The lane is derived the way it is everywhere
    // else in the engine: project.outputDir matched back against project.outputDirs[].
    // No lane derivable (single-codeline runs) leaves the declared list untouched.
    const _thisLane = laneCodeline(prd);
    const _mine = _thisLane && _perCodeline[_thisLane];
    if (_mine && Array.isArray(_mine.files) && _mine.files.length) {
      story.technicalNotes = { ...story.technicalNotes, files: _mine.files };
    }
    for (const [_cl, _entry] of Object.entries(_perCodeline)) {
      if (_entry.unresolved.length) {
        console.warn(
          `spec-mode: ${story.id} — ${_entry.unresolved.length} declared file(s) do NOT exist in codeline '${_cl}': ` +
          _entry.unresolved.map(u => u.declared).join(', '),
        );
      }
    }
  }

  if (Array.isArray(payload.splitStories) && payload.splitStories.length) {
    const currentDepth = splitDepth(story, prd);
    const maxSplitDepth = parseInt(process.env.SPEC_MAX_SPLIT_DEPTH || '2', 10);
    if (currentDepth >= maxSplitDepth) {
      console.warn(
        `spec-mode: skipping splits for ${story.id} — depth ${currentDepth} >= max ${maxSplitDepth}`
      );
    } else {
      const childrenBefore = newStories.filter(ns => ns.parentId === story.id).length;

      payload.splitStories.forEach((split, idx) => {
        if (!split || typeof split !== 'object') return;
        // Per-child budget check — canSplitStory sees pendingChildren accumulate each iteration
        const { ok, reason } = canSplitStory(story, prd, newStories);
        if (!ok) {
          console.warn(`spec-mode: split budget for ${story.id} child ${idx + 1} rejected — ${reason}`);
          return;
        }
        const baseId = split.id && typeof split.id === 'string' ? split.id : `${story.id}-SPEC-${idx + 1}`;
        let newId = baseId;
        let suffix = 1;
        // Check both prd.stories AND the pending newStories accumulator for collisions
        while (
          prd.stories.some((s) => s.id === newId) ||
          newStories.some((ns) => ns.story.id === newId)
        ) {
          newId = `${baseId}-${suffix}`;
          suffix += 1;
        }
        const newStory = JSON.parse(JSON.stringify(story));
        newStory.id = newId;
        newStory.title = split.title || `${story.title} (Spec Split ${idx + 1})`;
        newStory.description = split.description || story.description;
        newStory.acceptanceCriteria = Array.isArray(split.acceptanceCriteria) && split.acceptanceCriteria.length
          ? [...split.acceptanceCriteria]
          : Array.isArray(story.acceptanceCriteria)
            ? [...story.acceptanceCriteria]
            : [];
        newStory.status = 'pending';
        newStory.completed = false;
        newStory.dependencies = Array.isArray(split.dependencies) ? split.dependencies : [];
        // Backfill the PARENT's own external cross-story dependencies (found
        // live, 2026-07-12, tier3-travel-app run): a split child's
        // dependencies come ENTIRELY from the LLM's own per-child split
        // proposal, which frequently omits a dependency the PARENT already
        // deterministically declared. Confirmed live: SKY-003 declared
        // dependencies: ["SKY-002"] (the real Skyscanner API client), but
        // its split child SKY-003-impl ended up with dependencies: [] after
        // the split — it ran immediately with no dependency gate at all,
        // found no real client to import, and self-servingly fabricated a
        // fake stub client via its own dynamic tool just to get ITS OWN
        // deliverables to pass. That wrong stub then poisoned every
        // downstream consumer (SKY-003-test, SKY-004), producing a cascade
        // of misleading "static vs instance method" self-heal diagnoses that
        // were never fixable, because the real problem (SKY-002 never
        // actually succeeded) was invisible the whole time. Merge the
        // parent's own dependencies into EVERY child unconditionally --
        // redundant with wireSplitSiblingDependencies' test-to-impl wiring
        // below is harmless (a dependency gate only needs every listed ID
        // completed), but dropping a real cross-story dependency is not.
        for (const _parentDep of Array.isArray(story.dependencies) ? story.dependencies : []) {
          if (!newStory.dependencies.includes(_parentDep)) newStory.dependencies.push(_parentDep);
        }
        // Root cause of "no split has ever succeeded" (found live, 2026-07-06):
        // newStory starts as a full clone of the PARENT (including its combined
        // technicalNotes.files) and this field was never overwritten with the
        // split proposal's own file ownership — every child silently inherited
        // ALL of the parent's files regardless of what was actually proposed,
        // guaranteeing every split looked incoherent (every child "wrote" every
        // file) and was rejected below, no matter how the model partitioned it.
        if (split.technicalNotes && typeof split.technicalNotes === 'object') {
          newStory.technicalNotes = split.technicalNotes;
        }
        // Same backfill as newStory.dependencies above, for the ALTERNATE
        // dependency field this project (and claude.sh's own dependency
        // lookups: `.dependencies // .technicalNotes.dependsOn // []`,
        // consistently a fallback UNION of both fields) actually uses.
        // Found while auditing for other instances of the exact dependency-
        // drop bug (2026-07-12): SKY-002 itself declares its OWN dependency
        // on SKY-001 ONLY via technicalNotes.dependsOn, not .dependencies --
        // so a split of SKY-002 would have been just as vulnerable as
        // SKY-003 was, through this second field path. The technicalNotes
        // reassignment right above can replace the whole object wholesale
        // (e.g. a split proposal supplying only `files`), silently dropping
        // dependsOn the same way the bare dependencies array was dropped --
        // so this backfill must run AFTER that reassignment, not before.
        const _parentDependsOn = Array.isArray(story.technicalNotes?.dependsOn) ? story.technicalNotes.dependsOn : [];
        if (_parentDependsOn.length) {
          if (!newStory.technicalNotes || typeof newStory.technicalNotes !== 'object') newStory.technicalNotes = {};
          const _existingDependsOn = Array.isArray(newStory.technicalNotes.dependsOn) ? newStory.technicalNotes.dependsOn : [];
          const _mergedDependsOn = [..._existingDependsOn];
          for (const _pd of _parentDependsOn) {
            if (!_mergedDependsOn.includes(_pd)) _mergedDependsOn.push(_pd);
          }
          newStory.technicalNotes.dependsOn = _mergedDependsOn;
        }
        newStory.specification = {
          createdFrom: story.id,
          createdAt: new Date().toISOString(),
          runId,
          splitDepth: currentDepth + 1,
          splitOrigin: 'spec-pass'  // marks spec-pass splits; mid-execution splits use 'mid-execution'
        };
        capSplitACs(newStory, story.id);
        correctSplitChildAgentRoleIfTestOnly(prd, newStory);
        newStories.push({ parentId: story.id, story: newStory, phase: phaseId });
        result.splitCount += 1;
      });

      // Same-file coherence check: if >1 child writes the same non-test file, each agent
      // overwrites the file from scratch and only the last writer's output survives.
      // Reject the entire split — parent runs as a single story (with capped ACs).
      const addedChildren = newStories.filter(ns => ns.parentId === story.id).slice(childrenBefore);
      const fileConflicts = validateSplitFileCoherence(addedChildren.map(ns => ns.story));
      if (fileConflicts.length > 0) {
        for (const { file, childIds } of fileConflicts) {
          console.warn(
            `spec-mode: split coherence violation for ${story.id}: ` +
            `children [${childIds.join(', ')}] all write to ${path.basename(file)} — ` +
            `rejecting split (last writer wins = silent data loss)`
          );
          if (logDir) appendSpecPassEvent(logDir, { storyId: story.id, phase: phaseId, event: 'coherence_violation', decision: 'rejected', details: { file: path.basename(file), childIds } });
        }
        // Roll back all children added during this forEach
        newStories.splice(newStories.length - addedChildren.length, addedChildren.length);
        result.splitCount = 0;
      } else if (addedChildren.length > 0) {
        // Parent AC redistribution — clear parent ACs after split to prevent 93-AC parent stories.
        const childIds = addedChildren.map(ns => ns.story.id).join(', ');
        story.acceptanceCriteria = [`Delegated to split children: ${childIds}`];
        console.log(`spec-mode: parent ${story.id} ACs redistributed → delegated to ${childIds}`);
        if (logDir) appendSpecPassEvent(logDir, { storyId: story.id, phase: phaseId, event: 'story_delegated', decision: 'delegated', details: { childIds: addedChildren.map(ns => ns.story.id) } });
        // Root cause of a real bug (found live, 2026-07-06, tier3-full-run-15):
        // a delegated parent's technicalNotes.files still lists its ORIGINAL
        // files (including any .test.ts), and it stayed in
        // implementationOrder[phase] alongside its own children — every
        // downstream consumer that scans implementationOrder (the TC writer,
        // the main implementation loop) still saw it as an active "test
        // story" with real source, when its actual implementation is now
        // entirely delegated. Mark it deprecated/completed so consumers that
        // already check those fields skip it; implementationOrder itself is
        // cleaned up separately (see the Step 3 insertion loop and
        // validateMidExecutionSplits, which both know the split-vs-parent
        // topology needed to do that safely).
        story.status = 'deprecated';
        story.completed = true;
      }
    }
  }
  return result;
}

function appendJsonl(filePath, obj) {
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}\n`);
}

function appendSpecPassEvent(logDir, { storyId, phase, event, decision, details = {} }) {
  const ts = new Date().toISOString();
  const id = `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  appendJsonl(path.join(logDir, 'agent-activity.jsonl'), {
    event_id: id,
    timestamp: ts,
    agent: 'spec-coordinator-agent',
    story_id: storyId ?? null,
    phase: phase ?? null,
    type: 'spec_pass_decision',
    detail: { event, decision, ...details },
  });
}

// _promptVersionCache — the epam-cli repo's own short git SHA, computed once
// per process. These prompts live embedded in the scripts themselves (no
// separate template files), so the commit hash of the script IS the version
// proxy for correlating a violation-rate change to "what changed in this
// commit" — mirrors _epam_prompt_version() in run-agent-orchestration.sh.
let _promptVersionCache = null;
function promptVersion() {
  if (_promptVersionCache === null) {
    try {
      _promptVersionCache = execSync('git rev-parse --short HEAD', {
        cwd: path.join(__dirname, '..', '..'),
        encoding: 'utf8',
      }).trim();
    } catch {
      _promptVersionCache = 'unknown';
    }
  }
  return _promptVersionCache;
}

// logGuardedStepRetry — double-write a guarded-step-retry record: unchanged
// per-run file (logDir, wiped on next run's teardown) plus a persistent
// engine-side history file (orchestrations/logs/, survives target-project
// teardown) — same double-write convention as _log_guarded_step_retry() in
// run-agent-orchestration.sh, so bash- and JS-side guarded steps land in the
// same cross-run history for trend/versioning aggregation.
function logGuardedStepRetry(logDir, record) {
  const augmented = { ...record, runId: record.runId ?? 'unknown', promptVersion: promptVersion() };
  appendJsonl(path.join(logDir, 'guarded-step-retries.jsonl'), augmented);
  try {
    const historyDir = path.join(__dirname, '..', 'logs');
    fs.mkdirSync(historyDir, { recursive: true });
    appendJsonl(path.join(historyDir, 'guarded-step-retries-history.jsonl'), augmented);
  } catch {
    // Persistent history is best-effort — never let it block the pipeline.
  }
}

function extractCodeRefs(story) {
  const files = story?.technicalNotes?.files;
  if (!Array.isArray(files)) return [];
  return files
    .map((f) => (typeof f === 'string' ? f.trim() : ''))
    .filter(Boolean)
    .slice(0, 3);
}

function emitMonitorEvent({ monitorScript, type, message, storyId = '', lane = 'main', role = '' }) {
  return new Promise((resolve) => {
    const proc = spawn(
      monitorScript,
      ['event', type, message, storyId, lane, role],
      { env: process.env }
    );
    proc.on('error', () => resolve());
    proc.on('close', () => resolve());
  });
}

// Recover a JSON payload a tool-trained model hid inside a TOOL CALL. Some models
// "answer" by emitting a write_file-style call — e.g.
//   <tool_use><tool_name>write_file</tool_name><arguments>{"path":"...","content":"{...JSON...}"}</arguments></tool_use>
// — wrapping the real answer in the call's `content` (or in the arguments object)
// instead of returning it inline. The pipeline reads the reply TEXT (not a file), so
// the answer would be lost. This unwraps it. General across models/tags — no
// model- or field-name hardcoding beyond the standard tool-call shape. (Found live
// 2026-07-24, AMSD-1820: glm-5.1 wrapped the spec JSON in a write_file call → FATAL.)
function unwrapToolCallJson(text) {
  if (!text) return null;
  const candidates = [];
  // Arg container tag varies by model/provider: <arguments> (glm), <input> (others),
  // <parameters>. Backref \1 keeps open/close matched. Found live 2026-07-24: speckit
  // used <arguments>, MODEL_REVIEW used <input>.
  // Models "answer" by emitting a tool invocation wrapped in an XML-ish tag. The tag NAME
  // varies per provider and version — observed live: <arguments> (glm), <tool_call>
  // (mock3 MODEL_REVIEW, 2026-08-03) and <function_calls> (metrolinx SPEC_ASSIGNMENTS,
  // the same day, minutes after a fix that enumerated only <tool_call>). Enumerating
  // names loses to whatever the next provider emits, and each miss silently DISCARDS a
  // real decision.
  //
  // So match on SHAPE, not on a name list: every balanced <tag>…</tag> body becomes a
  // candidate scope, peeled repeatedly so a nested wrapper cannot hide the payload from
  // an outer match. A wrong guess costs nothing — a candidate is only accepted below if
  // it actually parses as JSON — whereas a missing name costs the whole answer.
  const scopes = [];
  const seen = new Set();
  let frontier = [text];
  for (let depth = 0; depth < 4 && frontier.length; depth += 1) {
    const next = [];
    for (const scope of frontier) {
      if (!scope || seen.has(scope)) continue;
      seen.add(scope);
      scopes.push(scope);
      for (const m of scope.matchAll(/<([a-zA-Z_][\w.-]*)\b[^>]*>\s*([\s\S]*?)\s*<\/\1>/g)) {
        if (m[2] && m[2] !== scope) next.push(m[2]);
      }
    }
    frontier = next;
  }
  // Innermost bodies first: a nested payload is more specific than its wrapper.
  for (const scope of scopes.slice().reverse()) candidates.push(scope);
  for (const raw of candidates) {
    let args;
    try { args = JSON.parse(String(raw).trim()); } catch { continue; }
    // Unwrap one nesting level if it's {name, arguments:{...}}.
    if (args && typeof args === 'object' && args.arguments && typeof args.arguments === 'object') args = args.arguments;
    if (!args || typeof args !== 'object') continue;
    // write_file-style call: the real payload is a JSON string in `content`.
    if (typeof args.content === 'string') {
      try { const inner = JSON.parse(args.content); if (inner && typeof inner === 'object') return inner; } catch { /* not JSON */ }
    }
    // Otherwise the arguments object itself may BE the payload (ignore path/tool wrappers).
    const keys = Object.keys(args).filter((k) => !['path', 'server_name', 'tool_name', 'content'].includes(k));
    if (keys.length > 0) return args;
  }

  // LAST RESORT: the JSON is in there, but not inside a balanced tag.
  //
  // Everything above requires <tag>…</tag> to close. Live 2026-08-06, on the metrolinx
  // run, the three shapes that actually arrived were none of those:
  //
  //   submit_guard_vocabulary\n{"blacklist":[…]}   ← bare tool NAME, then the payload
  //   <tool_call>{"name":…                         ← never closed (truncated mid-answer)
  //   Both documents describe … {"links":[…]}      ← prose first, then the payload
  //
  // Each one discarded a real answer. The guard-vocabulary agent then reported "no usable
  // terms after its full retry/ladder budget" and aborted the spec pass on all three
  // lanes — a run lost to punctuation, not to a model that could not do the work.
  //
  // So scan for the first balanced JSON OBJECT anywhere in the text, tracking string
  // state so a brace inside a quoted value cannot end it early. This cannot produce a
  // false positive: the result still has to parse, and the caller still validates it
  // against the tool definition.
  const obj = firstBalancedJsonObject(text);
  if (obj) {
    let args = obj;
    if (args.arguments && typeof args.arguments === 'object') args = args.arguments;
    if (typeof args.content === 'string') {
      try { const inner = JSON.parse(args.content); if (inner && typeof inner === 'object') return inner; } catch { /* not JSON */ }
    }
    const keys = Object.keys(args).filter((k) => !['path', 'server_name', 'tool_name', 'name', 'content'].includes(k));
    if (keys.length > 0) return args;
  }
  return null;
}

/**
 * The first complete `{...}` in a string, parsed — or null.
 *
 * Brace counting alone is wrong: a `{` or `}` inside a quoted value ends the object early
 * and yields malformed JSON. This tracks whether it is inside a string and honours
 * backslash escapes, so a reason like "use {} for an empty set" cannot truncate the answer.
 */
function firstBalancedJsonObject(text) {
  const s = String(text || '');
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i += 1) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(s.slice(start, i + 1));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
          } catch { /* try the next opening brace */ }
          break;
        }
      }
    }
  }
  return null;
}

// ─── Why a spec agent produced no payload ────────────────────────────────────
// Only ONE of these is worth re-asking. A model that answered in the wrong shape
// will answer in the wrong shape again: live AMSD-2041 (2026-07-28) speckit
// emitted invented `<tool_call>read_file(...)` text, and re-sending the same
// prompt reproduced it on glm-5.2 AND on the glm-5.1 escalation. Three attempts
// and a ladder step to learn nothing. Classifying the failure lets the retry
// carry a correction instead of repeating the question.
const SPEC_TOOL_CALL_RE = /<\/?(?:tool_call|tool_use|function_call|invoke)\b/i;

function classifySpecFailure(rawText) {
  const t = String(rawText || '').trim();
  if (!t) return 'empty';                          // genuinely no answer — a transient
  if (SPEC_TOOL_CALL_RE.test(t)) return 'tool-call';
  if (/^[[{]/.test(t)) return 'malformed-json';    // tried to answer, shape broke
  return 'prose';                                  // answered in the wrong medium
}

// The correction handed to the next attempt. Empty for a transient: an empty
// response says nothing about what went wrong, and inventing advice would make
// the prompt differ for no reason.
function specCorrectiveNote(kind) {
  switch (kind) {
    case 'tool-call':
      return 'CRITICAL — YOUR PREVIOUS RESPONSE WAS REJECTED: it emitted tool calls ' +
             '(e.g. <tool_call>read_file(...)</tool_call>). You have NO tools available in this ' +
             'request and cannot call any — nothing executes them, so that response was discarded ' +
             'entirely. Everything you are permitted to use is already in this prompt. If a file\'s ' +
             'contents would have helped, say so in "notes" and answer from what you were given. ' +
             'Reply with the raw JSON object and nothing else.';
    case 'prose':
      return 'CRITICAL — YOUR PREVIOUS RESPONSE WAS REJECTED: it was prose, not JSON. ' +
             'Reply with the raw JSON object described above and nothing else — no preamble, ' +
             'no explanation outside the JSON, no markdown fences.';
    case 'malformed-json':
      return 'CRITICAL — YOUR PREVIOUS RESPONSE WAS REJECTED: it began as JSON but could not be ' +
             'parsed. Emit strictly valid JSON — quote every key, no trailing commas, no comments ' +
             'and no unescaped newlines inside string values.';
    default:
      return '';
  }
}

/**
 * The raw text an agent produced, read back from the log runAgentForJson wrote.
 * The parsed payload is all that is returned through the call stack, so on a
 * parse failure this file is the only surviving record of what the model said —
 * and it is what the classifier needs.
 */
function readAgentRawOutput(logPath) {
  try {
    const txt = require('fs').readFileSync(logPath, 'utf8');
    const i = txt.indexOf('# Text output');
    return i === -1 ? '' : txt.slice(i + '# Text output'.length).trim();
  } catch { return ''; }
}

function extractTaggedJson(text, tag) {
  if (!text) return null;

  // Normalize variant opening tags that models sometimes emit:
  //   <_TAG>  →  <TAG>   (Qwen adds leading underscore to distinguish from template echo)
  //   <-TAG>  →  <TAG>   (similar dash-prefix variant)
  text = text.replace(new RegExp(`<[_\\-]${tag}>`, 'g'), `<${tag}>`);

  function stripAndParse(jsonText) {
    jsonText = jsonText.trim();
    // Strip markdown code fences that LLMs often wrap around JSON
    jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
    try {
      return JSON.parse(jsonText);
    } catch (err) {
      // Try jsonrepair for M3-style malformed JSON (truncated strings, unescaped chars, double braces).
      // Only attempt repair when text looks like JSON (starts with { or [) to avoid
      // jsonrepair turning arbitrary plain text into a JSON string.
      if (_jsonrepair && /^\s*[{[]/.test(jsonText)) {
        try {
          return JSON.parse(_jsonrepair(jsonText));
        } catch (repairErr) {
          console.warn(`Failed to parse JSON for tag ${tag}:`, err.message);
        }
      } else {
        console.warn(`Failed to parse JSON for tag ${tag}:`, err.message);
      }
      return null;
    }
  }

  // Full pair: <TAG>content</TAG> — find ALL matches, return the last parseable one.
  // Models sometimes echo an empty template block from the prompt before outputting
  // their real content (e.g. coordinator prompt contains empty <SPEC_ASSIGNMENTS></SPEC_ASSIGNMENTS>
  // which the model echoes, then outputs the real block after "# Output").
  const fullRegex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  const fullMatches = [...text.matchAll(fullRegex)];
  if (fullMatches.length > 0) {
    // Try matches in reverse — prefer the last well-formed JSON block
    for (let i = fullMatches.length - 1; i >= 0; i--) {
      const parsed = stripAndParse(fullMatches[i][1]);
      if (parsed !== null) return parsed;
    }
    // All full-pair matches failed to parse; fall through to partial-match fallback
  }

  // Partial (SDK single-turn): prompt injected the opening tag, model response
  // contains only content followed by </TAG>. Match everything up to the close tag.
  const closeRegex = new RegExp(`^([\\s\\S]*?)<\\/${tag}>`, 'm');
  const closeMatch = closeRegex.exec(text.trim());
  if (closeMatch) return stripAndParse(closeMatch[1]);

  // Raw JSON fallback: model ignored tag instructions and returned bare JSON.
  // Strip markdown fences then try parsing the entire response directly.
  const rawAttempt = stripAndParse(text);
  if (rawAttempt !== null) return rawAttempt;

  // Last resort: the model "answered" by emitting a tool CALL that wraps the real
  // JSON payload (write_file content / arguments). Recover it rather than lose it.
  const unwrapped = unwrapToolCallJson(text);
  if (unwrapped !== null) return unwrapped;

  return null;
}

// READ AT CALL TIME, not at module load.
//
// This was a module-level const, so the value was fixed when the file was first required and
// no later assignment could change it. That made the budget un-tunable in practice: an agent
// could not be given its own, and a caller setting RUNCLAUDE_TIMEOUT_MS after import was
// silently ignored. When the guard-vocabulary agent timed out at 360s on 2026-08-06 and took
// the specification pass with it, there was no lever to pull — the number had been baked in
// at import.
function runClaudeTimeoutMs() {
  const v = parseInt(process.env.RUNCLAUDE_TIMEOUT_MS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 360000;
}

function runClaude(execSpec, prompt, logPath, envOverrides = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...envOverrides };
    // Name the agent from the label it already declares for cost tracking.
    // Only the detective ever set EPAM_AGENT_NAME explicitly, so every other
    // spec-mode agent's plan record and Langfuse trace was anonymous — written
    // as `agent:plan`, attributable to nothing. One place, so a new agent
    // cannot be added without a name.
    if (!env.EPAM_AGENT_NAME && opts.costAgent) env.EPAM_AGENT_NAME = opts.costAgent;
    if (!env.EPAM_STORY_ID && opts.costStoryId) env.EPAM_STORY_ID = opts.costStoryId;
    delete env.CLAUDECODE;

    // COST TRACKING. Every LLM call in this file funnels through runClaude, so
    // wiring it here covers the detective, openspec, speckit, spec-coordinator,
    // the VC reviewer and the PRD change reviewer in one place. Before this,
    // spec-mode emitted NO cost at all and ~68% of a run's real spend was
    // invisible ($0.1115 recorded vs $0.3480 actually billed on 2026-07-24).
    // ai-run.sh already writes the normalized {total_cost_usd, usage:{...}} JSON
    // to $ORCH_JSON_RESULT — it just was never asked to.
    let _costFile = null;
    try {
      _costFile = path.join(os.tmpdir(), `spec-cost-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
      env.ORCH_JSON_RESULT = _costFile;
    } catch { _costFile = null; }

    const _emitCost = () => {
      if (!_costFile) return;
      try {
        emitCostSnapshot({
          resultFile: _costFile,
          activityFile: process.env.ACTIVITY_FILE ||
            path.join(process.env.LOG_DIR || path.join(__dirname, '..', 'logs'), 'agent-activity.jsonl'),
          agent: opts.costAgent || envOverrides.SPEC_AGENT_NAME || 'spec-mode-agent',
          storyId: opts.costStoryId || '',
          phase: process.env.PHASE || '',
          model: envOverrides.AI_MODEL || execSpec?.model || process.env.SPEC_MODE_MODEL || '',
          provider: execSpec?.provider || process.env.SPEC_MODE_PROVIDER || process.env.EPAM_ORCHESTRATION_PROVIDER || '',
        });
      } catch { /* cost emission must never break the agent call */ }
      try { fs.unlinkSync(_costFile); } catch { /* ignore */ }
    };
    const cmd = execSpec?.cmd;
    if (!cmd) {
      return reject(new Error('prompt runner exited with code 1: no execSpec.cmd — set EPAM_ORCHESTRATION_PROVIDER'));
    }
    const args = Array.isArray(execSpec?.args) ? execSpec.args : [];
    // ROOT CAUSE, verified live (2026-08-06): read_file/list_files/search
    // (src/tools/builtin/ReadFile.ts et al.) resolve paths via
    // `path.resolve(filePath)` against the CLI process's OWN cwd — none of
    // them consult PROJECT_ROOT (grep confirms only the unrelated
    // EscalateDefect.ts tool ever reads that env var). Without an explicit
    // cwd here, every tool-enabled spec-mode call (detective, openspec,
    // speckit, coordinator, coordinator-review, vc-agent, PRD-change-
    // reviewer — all funnel through this one spawn) pointed its tools at
    // wherever the ORCHESTRATOR happened to be running from, not the target
    // repo. A live probe against a real fixture file proved this precisely:
    // identical env/tool grant returned "file does not exist" without cwd
    // set, and the file's real, unguessable content with it set. This was
    // very likely the true cause of the SPEC_REVIEW live-tool-call failure
    // documented in test/integration/spec-reviewer-live.test.ts, not an
    // absence of any tool-execution loop.
    const cwd = env.PROJECT_ROOT || process.cwd();
    // detached:true puts the child in its own process group so we can kill the
    // entire group (child + grandchildren like epam CLI) on timeout.
    const proc = spawn(cmd, args, { env, cwd, detached: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const killGroup = () => {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    };

    // Salvage: a subprocess can emit a COMPLETE, parseable result and STILL exit
    // non-zero / with a null (signal) code — killed during teardown, or a
    // detached grandchild (epam CLI → codegraph, etc.) disturbing the process
    // group. Discarding that already-captured output loses real work. Found live
    // 2026-07-23: the code-graph-detective emitted its perfect fix-site JSON and
    // then exited with code null; runClaude discarded it, so the implementer got
    // no root cause. When the caller opts in AND we actually captured output,
    // resolve with it and let the caller's parser decide — a genuinely broken run
    // yields unparseable output the caller already handles. Off by default so
    // other callers keep their strict reject-on-failure semantics.
    const finishOutput = () => `${stdout}\n${stderr}`.trim();

    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : runClaudeTimeoutMs();
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup();
      // FIX: destroy stdio streams so grandchildren that inherited these pipe fds
      // (e.g. epam CLI spawning detached node subprocesses) don't keep the Node.js
      // event loop alive after the process group is killed.
      const salvaged = finishOutput();
      if (logPath) { try { fs.writeFileSync(logPath, `# Prompt\n${prompt}\n\n# Output (timed out)\n${salvaged}\n`); } catch { /* ignore */ } }
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      _emitCost();
      if (opts.salvageOutputOnFailure && salvaged) {
        return resolve(salvaged);
      }
      _emitCost();
      reject(new Error(`prompt runner timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (error) => { if (!settled) { settled = true; clearTimeout(killTimer); reject(error); } });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const output = finishOutput();
      if (logPath) fs.writeFileSync(logPath, `# Prompt\n${prompt}\n\n# Output\n${output}\n`);
      // Emit on EVERY terminal path, including failures: a call that errored or
      // was salvaged still consumed tokens and still cost real money. Recording
      // only successes is how spend goes missing precisely when things go wrong.
      _emitCost();
      if (code !== 0) {
        if (opts.salvageOutputOnFailure && output) {
          return resolve(output);
        }
        return reject(new Error(`prompt runner exited with code ${code}`));
      }
      resolve(output);
    });
    proc.unref(); // don't keep Node alive waiting for the child
    proc.stdin?.on('error', () => { /* suppress EPIPE when process is killed before stdin flush */ });
    proc.stdin?.end(prompt);
  });
}

function resolvePromptProvider(env = process.env) {
  const provider = env.AI_PROVIDER
    || env.EPAM_ORCHESTRATION_PROVIDER
    || (/codex$/.test(env.CLAUDE_CMD || '') ? 'codex' : null);
  if (!provider) {
    throw new Error(
      'No AI provider configured. Set AI_PROVIDER or EPAM_ORCHESTRATION_PROVIDER (e.g. EPAM_ORCHESTRATION_PROVIDER=qwen).'
    );
  }
  return provider;
}

function resolvePromptExec(aiRunnerCmd, env = process.env) {
  const provider = resolvePromptProvider(env);
  const gateModel = env.AI_MODEL || env.ORCH_GATE_MODEL || '';
  const modelArgs = gateModel ? ['--model', gateModel] : [];
  return { cmd: aiRunnerCmd, args: ['--provider', provider, ...modelArgs] };
}

// buildKnownValidModels <upgradeModel, miniModel>
// isValidModelString <model, currentModel, knownValidModels>
//
// Root cause of a live-run defect (2026-07-02 tier3 core phase): the LLM
// model-review pass's finalModel string was assigned to story.model with
// ZERO validation. The reviewer hallucinated "moonshotai/MiniMax-M3" —
// mixing the moonshotai org prefix with the minimax model name, a string
// that matches no real model on any provider — and every subsequent API
// call for that story failed instantly (cost=$0, 0 tokens), burning all 8
// retry attempts on a broken model string the InferenceLadder could never
// fix (escalation only helps when the *current* model works well enough to
// diagnose a real failure — it can't recover from a malformed model string).
//
// Extracted as standalone functions (not inlined in run()) so this
// validation is directly unit-testable, not just greppable — the whole
// point is to catch this bug CLASS (any future unvalidated LLM-written
// PRD field), not just this one instance.
function buildKnownValidModels(upgradeModel, miniModel) {
  return new Set([
    'MiniMax-M3', 'MiniMax-M2.5', 'MiniMax-M2.7', 'MiniMax-M2.1', 'MiniMax-M2',
    'moonshotai/kimi-k3', 'z-ai/glm-5.2', 'z-ai/glm-5.1', 'z-ai/glm-4.7',
    upgradeModel, miniModel,
  ]);
}

// Anthropic/Claude models are never permitted as a story-agent assignment in
// this pipeline (this engine IS Claude Code — running Claude AS a story
// agent inside its own orchestration is not a supported configuration; the
// pipeline is qwen/minimax-routed by design). This is an absolute rule, not
// just a preference for what the default should be — checked independently
// of currentModel/knownValidModels so it still holds even if a story's
// current model was somehow already corrupted to an Anthropic model by an
// earlier bug (defense in depth, not just "fix the default").
const DISALLOWED_MODEL_PATTERN = /^anthropic\/|claude/i;

function isValidModelString(model, currentModel, knownValidModels) {
  if (typeof model !== 'string') return false;
  if (DISALLOWED_MODEL_PATTERN.test(model)) return false;
  return model === currentModel || knownValidModels.has(model);
}

// buildGateExec <aiRunnerCmd>
// The gate model (ORCH_GATE_PROVIDER/ORCH_GATE_MODEL) is independent of the
// story-agent provider resolved by resolvePromptExec — reviewer calls always
// use the gate model, defaulting to minimax/MiniMax-M3 like claude.sh's
// run_prd_change_reviewer.
function buildGateExec(aiRunnerCmd, env = process.env) {
  const provider = env.ORCH_GATE_PROVIDER || 'minimax';
  // Persistent writes (PRD/profiles.json) get the highest-quality model
  // available, matching claude.sh's run_prd_change_reviewer precedence
  // (`${ESCALATION_MODEL_HIGH:-${ORCH_GATE_MODEL:-MiniMax-M3}}`). Full agent
  // audit, 2026-07-31: this path never honored ESCALATION_MODEL_HIGH, so the
  // spec-pass call site silently ran a cheaper model tier than the
  // claude.sh call site for the identical review job, despite both claiming
  // "highest-quality model" intent.
  const model = env.ESCALATION_MODEL_HIGH || env.ORCH_GATE_MODEL || 'MiniMax-M3';
  return { cmd: aiRunnerCmd, args: ['--provider', provider, '--model', model] };
}

// parseReviewVerdict <text>
// Extracts {"verdict":"pass|fail",...} from raw LLM output. Mirrors the
// python parsing in claude.sh's run_prd_change_reviewer: try strict JSON
// parse first, fall back to a regex scan for the verdict field.
function parseReviewVerdict(text) {
  const raw = (text || '').trim();
  try {
    const obj = JSON.parse(raw);
    if (obj && (obj.verdict === 'pass' || obj.verdict === 'fail')) {
      return { verdict: obj.verdict, issues: obj.issues || [] };
    }
  } catch { /* fall through to regex */ }
  const m = raw.match(/"verdict"\s*:\s*"(pass|fail)"/);
  return { verdict: m ? m[1] : 'pass', issues: [] };
}

// capReviewSnapshot(snapshot) — caps only acceptanceCriteria (the one field
// with unbounded length) so JSON.stringify(...) never needs a blind
// .slice(0, N) that can silently truncate technicalNotes/description/title
// out of what the reviewer actually sees. Real tickets with several detailed
// ACs routinely serialize past any fixed char budget; mock1's trivial 4-AC
// fixture never does, which is exactly why this bug (found live 2026-07-23,
// AMSD-1820: openspec's real locationHint got reverted to null because the
// reviewer never saw technicalNotes in its truncated payload) had no
// coverage until now.
function capReviewSnapshot(snapshot) {
  const ac = Array.isArray(snapshot?.acceptanceCriteria) ? snapshot.acceptanceCriteria : [];
  const CAP = 8;
  const acceptanceCriteria = ac.length > CAP
    ? [...ac.slice(0, CAP), `…and ${ac.length - CAP} more AC(s), omitted here for length`]
    : ac;
  return { ...snapshot, acceptanceCriteria };
}

// reviewPrdChange <opts>
// Calls the prd-change-reviewer gate agent to validate a proposed spec-pass
// change (AC/description/title rewrite or split creation) before it is
// accepted. Non-blocking by design: any call failure or unconfigured gate
// defaults to "pass" (matches claude.sh's run_prd_change_reviewer contract) —
// this is a quality gate, not a hard dependency for the spec pass to function.
async function reviewPrdChange({ aiRunnerCmd, profiles, storyId, changeType, before, after, logDir, splitOccurred }) {
  const gateProvider = process.env.ORCH_GATE_PROVIDER || '';
  if (!gateProvider) return { verdict: 'pass', issues: [] };

  const reviewerProfile = profiles['prd-change-reviewer'] || '';
  if (!reviewerProfile) return { verdict: 'pass', issues: [] };

  // When a split occurred alongside other field changes (description/title),
  // the parent's acceptanceCriteria is a deterministic engine-written
  // placeholder ("Delegated to split children: ..."), not organically
  // authored content — tell the reviewer explicitly so it doesn't flag that
  // placeholder as a vague/unmeasurable AC (see isSplitDelegationOnlyChange
  // for the more common case where this skips the reviewer call entirely).
  const splitNote = splitOccurred
    ? '\nNOTE: This story was just split into child stories. Its acceptanceCriteria field is a deterministic "Delegated to split children: ..." placeholder written by the engine, not an authored AC — do NOT flag that placeholder as vague or unmeasurable. Only evaluate the description/title changes.\n'
    : '';

  // A blind `.slice(0, N)` on the full serialized snapshot silently drops
  // whichever fields serialize LAST (technicalNotes, since captureStorySnapshot
  // orders acceptanceCriteria first) whenever acceptanceCriteria is long enough
  // — which real tickets with several detailed ACs routinely are, but mock1's
  // deliberately trivial 4-AC fixture never is (confirmed: this exact story's
  // snapshot put technicalNotes at byte offset 1448, past the old 1000-char
  // cutoff). The reviewer then judged a payload it never actually saw
  // technicalNotes in, and any verdict — pass OR fail — that triggers a revert
  // restores the field to its PRE-this-turn value, silently discarding a real,
  // well-grounded locationHint openspec had just discovered. Found live
  // 2026-07-23 on AMSD-1820. Fix: cap acceptanceCriteria (the only field whose
  // length is unbounded) independently, and always include technicalNotes/
  // description/title in full so structural fields can never be truncated away.
  const prompt = `${reviewerProfile}

STORY: ${storyId}
CHANGE TYPE: ${changeType}
${splitNote}
BEFORE:
${JSON.stringify(capReviewSnapshot(before))}

AFTER:
${JSON.stringify(capReviewSnapshot(after))}

You have read-only tools available (list/search/read files, run read-only shell commands). Several of your rejection rules ("introduces a technology this project does not already use," "TC fact cannot be verified by reading source code") require checking a claim against the real manifests/config/source of THIS codeline — do not judge those from the before/after snapshots alone. Verify before rejecting on that basis. Your tool budget is small — check the ONE fact your verdict depends on, not the whole codebase.

Emit ONLY: {"verdict":"pass|fail","issues":["<issue1>"],"reason":"<15 words max>"}`;

  try {
    const gateExec = buildGateExec(aiRunnerCmd);
    const logPath = logDir ? path.join(logDir, `prd-reviewer-${storyId}-${changeType}.log`) : null;
    // Full agent audit, 2026-07-31 (same class as HEAL-BLIND): zero tool
    // access on this call despite the profile's own rules requiring
    // real-codebase verification — a live incident already occurred (see
    // reviewer-no-stack-hardcoding.test.ts) where the reviewer rejected
    // correct guidance about the project's real CMS stack with no way to
    // check it. Reuses the same shared read-only allowlist every other
    // gate agent draws from.
    const output = await runClaude(gateExec, prompt, logPath, {
      AI_GATE_ALLOW_TOOLS: '1',
      EPAM_ALLOWED_TOOLS: process.env.ORCH_GATE_ALLOWED_TOOLS || 'bash,read_file,list_files,search',
      EPAM_MAX_TOOL_CALLS: process.env.PRD_CHANGE_REVIEWER_MAX_TOOL_CALLS || String(specModeDefaults().perSeam.prdChangeReviewer),
    }, { costAgent: 'prd-change-reviewer', costStoryId: storyId });
    return parseReviewVerdict(output);
  } catch (err) {
    console.warn(`spec-mode: prd-change-reviewer call failed for ${storyId} (${err.message}) — defaulting to pass`);
    return { verdict: 'pass', issues: [] };
  }
}

// Returns true when a model string is mini/nano/flash/haiku tier — fast but limited generation capacity.
function isMiniTierModel(model) {
  if (!model || typeof model !== 'string') return false;
  const m = model.toLowerCase();
  // Named mini model from env var always qualifies
  const miniModelEnv = (process.env.ORCH_MINI_MODEL || '').toLowerCase();
  if (miniModelEnv && m === miniModelEnv) return true;
  return m.includes('-mini') || m.includes('-nano') || m.includes('-flash') || m.includes('-haiku')
      || m.startsWith('minimax-m2') || m.startsWith('minimax/minimax-m2');
}

// VERY_HIGH_AC_THRESHOLD (2026-07-15): a story this far past the normal
// upgrade signals (acCount > 15) isn't just "needs a stronger model" — it's
// extreme enough that climbing the retry ladder rung-by-rung (mini -> mid ->
// high, 2 attempts each) burns several guaranteed-failing attempts before
// ever reaching a model with a real chance. Root cause this addresses
// (found live, 2026-07-14, tier3-travel-app run): SKY-003-test (a test
// story assessed via the equivalent TC-fact-density signal, not this
// AC-count one, but the same underlying problem) failed 8/8 attempts across
// every rung, producing widespread syntax corruption at every tier below
// the ceiling. Configurable via VERY_HIGH_AC_THRESHOLD; default picked
// meaningfully above the existing acCount>15 upgrade trigger so this is a
// distinct, rarer classification, not a redundant re-trigger of it.
const VERY_HIGH_AC_THRESHOLD = parseInt(process.env.EPAM_VERY_HIGH_AC_THRESHOLD || '20', 10);

// Compute story complexity signals and decide whether the assigned model needs upgrading.
function modelComplexitySignals(story) {
  const acCount = Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria.length : 0;
  const files = story.technicalNotes?.files || [];
  const outputFiles = files.filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.spec.ts'));
  const isSingleFile = outputFiles.length === 1;
  const hasHtmlOutput = outputFiles.some((f) => f.endsWith('.html'));
  const desc = (story.description || '').toLowerCase();
  const hasSelfContainedKeyword =
    desc.includes('self-contained') || desc.includes('no build') ||
    desc.includes('complete') || desc.includes('single-file');

  let needsUpgrade = false;
  let reason = '';

  if (acCount > 15 && isSingleFile) {
    needsUpgrade = true;
    reason = `${acCount} ACs on a single output file exceeds mini-tier generation capacity`;
  } else if (acCount > 10 && hasHtmlOutput) {
    needsUpgrade = true;
    reason = `HTML output file with ${acCount} ACs requires strong generation capability`;
  } else if (isSingleFile && hasSelfContainedKeyword && acCount > 8) {
    needsUpgrade = true;
    reason = `self-contained single-file story with ${acCount} ACs needs reliable large output`;
  }

  // veryHighComplexity: a SEPARATE, stricter classification (only true for
  // the most extreme cases) — see VERY_HIGH_AC_THRESHOLD's docstring above.
  // Independent of needsUpgrade so it can be checked even when the normal
  // upgrade rules didn't fire (e.g. multi-file stories the isSingleFile
  // gate above would otherwise miss).
  let veryHighComplexity = false;
  let veryHighReason = '';
  if (acCount > VERY_HIGH_AC_THRESHOLD) {
    veryHighComplexity = true;
    veryHighReason = `${acCount} acceptance criteria (> ${VERY_HIGH_AC_THRESHOLD}) — extreme complexity, assign ceiling model directly instead of climbing the retry ladder`;
  }

  return {
    acCount, isSingleFile, hasHtmlOutput, hasSelfContainedKeyword, needsUpgrade, reason,
    veryHighComplexity, veryHighReason,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mid-execution split validation — called from run-agent-orchestration.sh
// after any step that may write new stories to the PRD (Step 0.5, post-story).
//
// Flow: find unvalidated split children → run speckit in parent context →
//       apply AC cap → redistribute parent ACs → mark speckitValidated → write PRD.
// ─────────────────────────────────────────────────────────────────────────────
async function validateMidExecutionSplits(prdFile, storyIdsCsv) {
  const storyIds = (storyIdsCsv || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!prdFile || !storyIds.length) {
    console.log('spec-mode: --validate-splits: nothing to validate');
    return;
  }

  const prd = JSON.parse(fs.readFileSync(prdFile, 'utf8'));
  const _initialStoryIds = new Set((prd.stories || []).map((s) => s.id));
  const scriptDir = path.dirname(fs.realpathSync(process.argv[1]));
  const aiRunnerCmd = process.env.AI_RUNNER_CMD || path.join(scriptDir, 'ai-run.sh');
  const promptExec = resolvePromptExec(aiRunnerCmd);
  const phase = process.env.PHASE || 'unknown';
  const runId = process.env.ORCH_RUN_ID || new Date().toISOString().replace(/[:-]/g, '');
  const logDir = process.env.OUTPUT_DIR || path.join(path.dirname(prdFile), 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const storiesToValidate = storyIds
    .map(id => prd.stories.find(s => s.id === id))
    .filter(s => s && s.specification?.createdFrom && !s.specification?.speckitValidated);

  if (!storiesToValidate.length) {
    console.log('spec-mode: --validate-splits: all target stories already validated or not found');
    return;
  }

  // Group by parent
  const byParent = new Map();
  for (const child of storiesToValidate) {
    const parentId = child.specification.createdFrom;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(child);
  }

  // Root cause this fixes (found live, 2026-07-06, tier3-full-run-16): a
  // rejected split child (depth guard, budget guard, or coherence violation)
  // gets marked status='deprecated' below, but was never removed from
  // implementationOrder[phase] — it was already inserted there by whatever
  // created the mid-execution split BEFORE this validation ran, unlike
  // applySpecChanges' spec-pass path (where rejected children are spliced out
  // of the pending-insert list entirely and never reach implementationOrder
  // in the first place). Violates the same "no deprecated story in
  // implementationOrder" invariant the parent-delegation fix maintains.
  function removeFromImplementationOrder(storyId) {
    const order = prd.implementationOrder?.[phase];
    if (Array.isArray(order)) {
      prd.implementationOrder[phase] = order.filter((id) => id !== storyId);
    }
  }

  let hardViolations = 0;

  for (const [parentId, children] of byParent) {
    const parentStory = prd.stories.find(s => s.id === parentId);
    if (!parentStory) {
      console.warn(`spec-mode: --validate-splits: parent ${parentId} not in PRD — skipping`);
      continue;
    }

    // Depth guard (code, not prompt)
    const currentDepth = splitDepth(parentStory, prd);
    const maxSplitDepth = parseInt(process.env.SPEC_MAX_SPLIT_DEPTH || '2', 10);
    if (currentDepth >= maxSplitDepth) {
      console.warn(`spec-mode: --validate-splits: ${parentId} depth ${currentDepth} >= max ${maxSplitDepth} — rejecting ${children.length} children`);
      for (const child of children) {
        child.specification.splitRejected = true;
        child.specification.splitRejectionReason = `depth ${currentDepth} >= max ${maxSplitDepth}`;
        child.status = 'deprecated';
        removeFromImplementationOrder(child.id);
      }
      hardViolations++;
      continue;
    }

    // Split budget guard — count against already-registered children from prior runs
    const existingValidatedChildren = prd.stories.filter(
      s => s.specification?.createdFrom === parentId && s.specification?.speckitValidated
    ).length;
    if (existingValidatedChildren + children.length > MAX_CHILDREN_PER_SPLIT) {
      const allowed = Math.max(0, MAX_CHILDREN_PER_SPLIT - existingValidatedChildren);
      console.warn(`spec-mode: --validate-splits: ${parentId} budget allows ${allowed} more children, got ${children.length} — capping`);
      const rejected = children.splice(allowed);
      for (const r of rejected) {
        r.specification.splitRejected = true;
        r.specification.splitRejectionReason = `split budget exhausted (max ${MAX_CHILDREN_PER_SPLIT})`;
        r.status = 'deprecated';
        removeFromImplementationOrder(r.id);
      }
      if (!children.length) { hardViolations++; continue; }
    }

    // Same-file coherence check — reject entire split if children share a non-test file
    const fileConflicts = validateSplitFileCoherence(children);
    if (fileConflicts.length > 0) {
      for (const { file, childIds } of fileConflicts) {
        console.warn(
          `spec-mode: --validate-splits: coherence violation for ${parentId}: ` +
          `children [${childIds.join(', ')}] all write to ${path.basename(file)} — rejecting split`
        );
        appendSpecPassEvent(logDir, { storyId: parentId, phase, event: 'coherence_violation', decision: 'rejected', details: { file: path.basename(file), childIds, source: 'mid_execution' } });
      }
      for (const child of children) {
        child.specification.splitRejected = true;
        child.specification.splitRejectionReason = `same-file coherence violation: multiple children write to the same file`;
        child.status = 'deprecated';
        removeFromImplementationOrder(child.id);
      }
      hardViolations++;

      // Root cause this fixes (found live, 2026-07-10, tier3-travel-app run):
      // openspec (elaboration) and speckit (verification) each independently
      // split SKY-002 without knowing about each other, producing TWO
      // redundant impl/test pairs that collide on client.ts/client.test.ts.
      // Both pairs got deprecated here — correctly — but parentStory.status
      // was ALREADY 'deprecated' (set by applySpecChanges' spec-pass path
      // when the FIRST of the two redundant splits looked valid in
      // isolation), and nothing here ever restored it. Result: the
      // Skyscanner API client was never implemented at all this run — every
      // downstream story that depended on it (SKY-003, SKY-004) failed on a
      // missing module. If the parent has no OTHER surviving (non-deprecated,
      // non-rejected) children from a different split attempt, it must be
      // resurrected as a single unsplit story — otherwise its entire scope
      // silently vanishes with no story left to implement it.
      const parentHasSurvivingChildren = prd.stories.some(
        (s) => s.specification?.createdFrom === parentId
          && s.status !== 'deprecated'
          && !s.specification?.splitRejected
      );
      if (!parentHasSurvivingChildren && parentStory.status === 'deprecated') {
        const restoredACs = [...new Set(children.flatMap((c) => c.acceptanceCriteria || []))];
        parentStory.status = 'pending';
        parentStory.completed = false;
        if (restoredACs.length) {
          parentStory.acceptanceCriteria = restoredACs;
        }
        const orderForRestore = prd.implementationOrder?.[phase];
        if (Array.isArray(orderForRestore) && !orderForRestore.includes(parentId)) {
          orderForRestore.push(parentId);
        }
        console.warn(
          `spec-mode: --validate-splits: ${parentId} has no surviving split children — ` +
          `restoring as a single unsplit story so its scope isn't lost`
        );
        appendSpecPassEvent(logDir, { storyId: parentId, phase, event: 'story_restored', decision: 'restored', details: {} });
      }
      continue;
    }

    // AC cap on each child
    for (const child of children) capSplitACs(child, parentId);
    for (const child of children) correctSplitChildAgentRoleIfTestOnly(prd, child);

    // Wire test-child dependencies onto impl siblings from the SAME split —
    // see wireSplitSiblingDependencies' docstring for the live defect this
    // fixes. Must run after the coherence check above so a rejected sibling
    // (already spliced out / deprecated) is never wired.
    wireSplitSiblingDependencies(children, prd);
    reorderSiblingsByDependency(children, prd.implementationOrder?.[phase]);

    // Run speckit — treat children as openspec's split proposals
    const openspecOutput = {
      acceptanceCriteria: parentStory.acceptanceCriteria || [],
      notes: 'Mid-execution split registered by agent during story execution',
      splitStories: children.map(c => ({
        id: c.id,
        title: c.title,
        description: c.description,
        acceptanceCriteria: c.acceptanceCriteria || [],
        dependencies: c.dependencies || [],
        agentRole: c.agentRole
      }))
    };

    let speckitResult = null;
    try {
      speckitResult = await runSpeckitReview({
        promptExec,
        story: parentStory,
        openspecOutput,
        phase,
        runId,
        logDir,
        refineExistingChildren: true
      });
    } catch (err) { speckitResult = null; }

    // Apply speckit refinements if returned
    if (speckitResult?.payload?.splitStories) {
      for (const sc of speckitResult.payload.splitStories) {
        const child = children.find(c => c.id === sc.id);
        if (child && Array.isArray(sc.acceptanceCriteria) && sc.acceptanceCriteria.length) {
          // Split-child ACs, mid-execution. Same armed-or-abort contract as every
          // other guard seam: derived vocabulary, or the run stops.
          const _childVocab = await deriveGuardVocabulary({
            promptExec,
            rule: AC_PRESCRIPTIVENESS_RULE,
            statements: sc.acceptanceCriteria,
            story: child,
            findings: (child && child.fixSiteAnalysis) || [],
            manifestFiles: (child && child.technicalNotes && child.technicalNotes.files) || [],
            logDir,
            seam: 'acceptance-criteria:split-child',
          });
          if (!isVocabularyUsable(_childVocab)) {
            throw new Error(`AC guard could not be armed for split child ${child.id}: no usable vocabulary after the full retry/ladder budget. Refusing to proceed with an unarmed guard.`);
          }
          const { clean } = stripPrescriptiveACs(sc.acceptanceCriteria, child.id, _childVocab);
          child.acceptanceCriteria = clean.slice(0, MAX_ACS_PER_STORY);
        }
        if (child && sc.notes) {
          child.specification.speckitNotes = sc.notes;
        }
      }
    }

    // Mark children validated and tag as mid-execution so pre-flight can strip them on next restore
    for (const child of children) {
      child.specification.speckitValidated = true;
      child.specification.speckitValidatedAt = new Date().toISOString();
      child.specification.splitOrigin = 'mid-execution';
    }

    // Parent AC redistribution
    const childIds = children.map(c => c.id).join(', ');
    parentStory.acceptanceCriteria = [`Delegated to split children: ${childIds}`];
    console.log(`spec-mode: --validate-splits: ${parentId} → validated ${children.length} children (${childIds})`);
    // Same fix as applySpecChanges' spec-pass split path (found live,
    // 2026-07-06, tier3-full-run-15): a validated parent's technicalNotes.
    // files still lists its original (now-delegated) files, and it stayed in
    // implementationOrder[phase] alongside its own children — the TC writer
    // and main implementation loop both scan implementationOrder and saw it
    // as active work with real source, when it's now entirely delegated.
    parentStory.status = 'deprecated';
    parentStory.completed = true;
    const order = prd.implementationOrder?.[phase];
    if (Array.isArray(order)) {
      prd.implementationOrder[phase] = order.filter((id) => id !== parentId);
    }
  }

  // Story-ID-loss invariant — see assertNoStoryIdsLost's docstring.
  assertNoStoryIdsLost(_initialStoryIds, new Set((prd.stories || []).map((s) => s.id)), 'validateMidExecutionSplits()');

  // Atomic write, lock-protected — see the identical rationale at run()'s
  // writeFileSync call.
  const _prdLockPath2 = `${prdFile}.lock`;
  acquireFileLock(_prdLockPath2);
  try {
    const _tmpPrdFile = `${prdFile}.tmp`;
    fs.writeFileSync(_tmpPrdFile, JSON.stringify(prd, null, 2) + '\n');
    fs.renameSync(_tmpPrdFile, prdFile);
  } finally {
    releaseFileLock(_prdLockPath2);
  }

  if (hardViolations > 0) {
    console.error(`spec-mode: --validate-splits: ${hardViolations} hard violation(s) — check PRD for deprecated splits`);
    process.exit(1);
  }

  console.log('spec-mode: --validate-splits: complete');
}

// splitTestStoryCli <prdFile> <storyId> — shell entry point for
// lib/tc-writer-gate.sh's TC-fact-density split mandate. Loads the PRD,
// locates the story's phase (whichever implementationOrder[phase] array
// contains it), delegates to splitTestStoryByFacts(), and writes the PRD
// back atomically (same lock pattern as validateMidExecutionSplits above).
// Exits 0 with splitCount>0 printed to stdout on success, exits 1 if the
// story wasn't found or wasn't eligible to split (so the caller can treat
// that as "nothing to do" rather than a real error).
function splitTestStoryCli(prdFile, storyId) {
  if (!prdFile || !storyId) {
    console.error('spec-mode: --split-test-story: usage: --split-test-story <prdFile> <storyId>');
    process.exit(1);
  }
  const prd = JSON.parse(fs.readFileSync(prdFile, 'utf8'));
  const _initialStoryIds = new Set((prd.stories || []).map((s) => s.id));
  const story = prd.stories.find((s) => s.id === storyId);
  if (!story) {
    console.error(`spec-mode: --split-test-story: story ${storyId} not found`);
    process.exit(1);
  }
  const phase = Object.keys(prd.implementationOrder || {})
    .find((p) => (prd.implementationOrder[p] || []).includes(storyId)) || process.env.PHASE || 'unknown';

  const maxFactsPerChild = parseInt(process.env.EPAM_TC_FACTS_SPLIT_THRESHOLD || String(TC_FACTS_SPLIT_THRESHOLD), 10);
  const { splitCount, childIds } = splitTestStoryByFacts(story, prd, phase, maxFactsPerChild);
  if (splitCount === 0) {
    console.log(`spec-mode: --split-test-story: ${storyId} not eligible to split (not a pure single-test-file story, or facts <= threshold)`);
    process.exit(1);
  }

  assertNoStoryIdsLost(_initialStoryIds, new Set((prd.stories || []).map((s) => s.id)), 'splitTestStoryCli()');

  const _prdLockPath = `${prdFile}.lock`;
  acquireFileLock(_prdLockPath);
  try {
    const _tmpPrdFile = `${prdFile}.tmp`;
    fs.writeFileSync(_tmpPrdFile, JSON.stringify(prd, null, 2) + '\n');
    fs.renameSync(_tmpPrdFile, prdFile);
  } finally {
    releaseFileLock(_prdLockPath);
  }

  console.log(`spec-mode: --split-test-story: ${storyId} → ${childIds.join(', ')} (splitCount=${splitCount})`);
}

if (require.main === module) {
  if (process.argv[2] === '--validate-splits') {
    validateMidExecutionSplits(process.argv[3], process.argv[4]).catch((err) => {
      console.error('spec-mode-runner --validate-splits failed:', err);
      process.exit(1);
    });
  } else if (process.argv[2] === '--split-test-story') {
    try {
      splitTestStoryCli(process.argv[3], process.argv[4]);
    } catch (err) {
      console.error('spec-mode-runner --split-test-story failed:', err);
      process.exit(1);
    }
  } else {
    run().catch((err) => {
      console.error('spec-mode-runner failed:', err);
      process.exit(1);
    });
  }
}

module.exports = {
  // The tool definitions ARE the contract. Exported so lib/agent-output-schema.js can
  // validate answers against them instead of restating the shapes — a restated copy
  // drifted within hours and rejected valid coordinator output on a live run.
  vcFormSamples,
  TOOL_DEFINITIONS: {
    TOOL_SPEC_ASSIGNMENTS,
    TOOL_SPEC_AGENT,
    TOOL_SPEC_REVIEW,
    TOOL_MODEL_REVIEW,
    TOOL_GUARD_VOCABULARY,
    TOOL_TICKET_LINKS,
  },
  specAgentEnv,
  surveyToolBudget,
  specModeDefaults,
  reviewTicketLinks,
  normaliseTicketLinks,
  coveringTestFiles,
  persistReferencedDocs,
  fetchTicketDocuments,
  manifestFileExcerpts,
  deriveGuardVocabulary,
  mintProjectAgents,
  TOOL_PROJECT_AGENTS,
  assignAgentRoles,
  candidateRoles,
  buildAssignmentPrompt,
  TOOL_ROLE_ASSIGNMENTS,
  reviewRoster,
  detectivePrescription,
  surveyEstate,
  sanitizeSurvey,
  buildSurveyPrompt,
  surveyLineFor,
  reconcileMintTally,
  TOOL_ESTATE_SURVEY,
  SURVEY_STATES,
  TOOL_ROSTER_REVIEW,
  seamInvocationEnv,
  schemaEnv,
  referencedDocsBlock,
  advanceAgentLadderEscalation,
  recordDetectiveRound,
  classifySpecFailure,
  specCorrectiveNote,
  readAgentRawOutput,
  extractTaggedJson,
  stripPrescriptiveACs,
  buildAssignments,
  captureStorySnapshot,
  splitDepth,
  canSplitStory,
  capSplitACs,
  validateSplitFileCoherence,
  storyRequiresSplit,
  checkSplitMandateViolation,
  isSplitDelegationAc,
  correctSplitChildAgentRoleIfTestOnly,
  wireSplitSiblingDependencies,
  reorderSiblingsByDependency,
  assertNoStoryIdsLost,
  resolveModelProvider,
  isSplitDelegationOnlyChange,
  SPLIT_MANDATE_AC_THRESHOLD,
  applySpecChanges,
  mergeLocationHintFiles,
  buildPerCodelineManifest,
  buildBrownfieldArchaeologyBlock,
  VC_OBSERVABILITY_RULES,
  preserveDefectAcceptanceCriteria,
  normalizeVerificationCriteria,
  vcDeclarations,
  findVcMechanism,
  safeFallbackVc,
  partitionFlaggedVc,
  // The two LLM-calling stages of the VC flow. Unexported until 2026-08-04, which is
  // exactly why the flow had no live coverage: only the pure functions around them could
  // be tested, and every defect in it lived in what the real model actually returns.
  reviewVcViaSpeckit,
  regenerateVcViaOpenspec,
  manifestEvidence,
  manifestPathStatus,
  manifestMissingPaths,
  buildReviewPayload,
  enforceVerificationCriteria,
  isThinContext,
  verifyDetectiveHelper,
  verifyDetectiveEvidence,
  checkFixSiteCoverage,
  coverageForStory,
  laneCodeline,
  codelineScopeBlock,
  detectiveCorrectionNeeded,
  detectiveAnswerIsGrounded,
  inferStoryKindHint,
  minEvidenceChars,
  renderDetectiveCorrection,
  precomputeDetectiveExplore,
  ladderNextModel,
  runClaude,
  capReviewSnapshot,
  getDeterministicCandidateFiles,
  buildBrownfieldSearchQuery,
  runCodeGraphDetective,
  runSpecAgent,
  publishedContracts,
  fetchCodeGraphContext,
  validateMidExecutionSplits,
  extractCodeRefs,
  resolvePromptProvider,
  resolvePromptExec,
  buildGateExec,
  parseReviewVerdict,
  reviewPrdChange,
  buildKnownValidModels,
  isValidModelString,
  isMiniTierModel,
  modelComplexitySignals,
  MAX_ACS_PER_STORY,
  MAX_CHILDREN_PER_SPLIT,
  promptVersion,
  logGuardedStepRetry,
  checkTcFactDensityMandate,
  splitTestStoryByFacts,
  TC_FACTS_SPLIT_THRESHOLD,
  VERY_HIGH_AC_THRESHOLD,
};
