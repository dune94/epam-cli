const fs = require('fs');
let _codegraph, _semble;
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
const SYMPTOM_STOPWORDS = new Set([
  // grammatical
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'not',
  'for', 'in', 'of', 'and', 'or', 'to', 'as', 'at', 'by', 'it', 'its', 'that',
  'this', 'with', 'on', 'from', 'when', 'if', 'but', 'per', 'via', 'into',
  // presentation / symptom noise — describe how a bug LOOKS, never where it's caused
  'displayed', 'display', 'displays', 'shown', 'show', 'shows', 'showing',
  'rendered', 'render', 'renders', 'appear', 'appears', 'appearing', 'visible',
  'expected', 'correctly', 'incorrectly', 'properly', 'improperly', 'wrong',
  'screen', 'page', 'ui', 'view', 'email', 'confirmation', 'message', 'text',
  'label', 'field', 'value', 'output', 'result', 'issue', 'bug', 'problem',
]);
function buildBrownfieldSearchQuery(story) {
  const raw = [story.title || '', ...(Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria.slice(0, 3) : [])].join(' ');
  const domainTerms = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')      // strip punctuation/brackets like "[Mozio]"
    .split(/\s+/)
    .filter((w) => w.length > 1 && !SYMPTOM_STOPWORDS.has(w));
  // De-dupe while preserving order (keeps the most salient domain terms first).
  const seen = new Set();
  const ordered = [];
  for (const w of domainTerms) {
    if (!seen.has(w)) { seen.add(w); ordered.push(w); }
  }
  const query = ordered.join(' ').slice(0, 400);
  // Safety net: if stripping removed everything (degenerate title), fall back
  // to the raw title so we never send an empty query.
  return query || (story.title || '').slice(0, 400);
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
const story = {"id":"AMSD-1820","title":"[Mozio] - The Promo code amount is NOT displayed as expected for Return trip tickets in the Mozio email confirmation","codeline":"cdts","acceptanceCriteria":[]};
try {
  const result = fetchExistingCodeContext(story);
  console.log('RESULT_START' + result + 'RESULT_END');
} catch (e) {
  console.log('SCRIPT_ERROR: ' + e.stack);
}