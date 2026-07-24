/**
 * Real end-to-end tests for codeline-discovery.js.
 *
 * These tests spawn the actual script with a temp directory of fake git repos,
 * exercising the scoring and fallback paths without a live LLM or Semble binary.
 *
 * Bug reproduced:
 *   When the LLM call timed out, dryRunDiscovery() selected the first git repo
 *   ALPHABETICALLY — which was cx-shared, not azure.commerce.cdts. The fix:
 *   scoreRepos() now runs first (always), and both dry-run and LLM-failure
 *   fallback use selectBestCandidate() which picks the highest-SCORED repo.
 *
 * Test strategy:
 *   - Create two temp git repos: z-commerce-cdts (last alphabetically, has
 *     promo/discount/mozio in source) and ax-shared (first alphabetically, generic).
 *   - Run with CODELINE_DISCOVERY_DRY_RUN=1 (skips LLM, exercises fallback path).
 *   - Verify z-commerce-cdts is selected despite being last alphabetically.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync }        from 'node:child_process';
import { mkdtempSync, mkdirSync,
         writeFileSync, readFileSync,
         rmSync, existsSync }             from 'node:fs';
import { join }                           from 'node:path';
import { tmpdir }                         from 'node:os';

const REPO_ROOT    = join(__dirname, '../../../');
const DISCOVERY_JS = join(REPO_ROOT, 'orchestrations/scripts/lib/codeline-discovery.js');
const NODE         = process.execPath;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGitRepo(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, '.git'), { recursive: true });
  // Minimal git objects so it looks like a real repo
  mkdirSync(join(dir, '.git', 'objects'), { recursive: true });
  mkdirSync(join(dir, '.git', 'refs'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

function makeIssuesJson(tmpDir: string, issues: object[]): string {
  const p = join(tmpDir, 'issues.json');
  writeFileSync(p, JSON.stringify(issues));
  return p;
}

function runDiscovery(args: string[], env: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(NODE, [DISCOVERY_JS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env, SEMBLE_ENABLED: '0' },
    // Tier-2 now queries each term SEPARATELY against every repo (cross-repo
    // document frequency), which is terms x repos process spawns at ~185ms each
    // — ~35s over the real 31-repo Metrolinx root, vs ~6s for the old single
    // joined query. That joined query was fast and WRONG (it ranked the wrong
    // repo first, see codeline-score.js), so the extra time is the price of a
    // correct ranking. 60s was tight standalone and blew up under parallel
    // suite load; the cost is spawn-bound, so raise the ceiling rather than
    // trade away correctness.
    timeout: 180000,
  });
  return {
    stdout:   result.stdout || '',
    stderr:   result.stderr || '',
    exitCode: result.status ?? 1,
  };
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

let TMP_ROOT: string;
let ISSUES_PATH: string;
let OUT_PATH: string;
let RELEVANT_REPO: string;   // z-commerce-cdts — last alphabetically, high content signal
let IRRELEVANT_REPO: string; // ax-shared — first alphabetically, no signal

const AMSD_LIKE_ISSUE = [{
  jiraKey: 'AMSD-1820',
  title: '[Mozio] - The Promo code amount is NOT displayed as expected for Return trip tickets in the Mozio email confirmation',
  description: 'When a promo code discount is applied to a return dispatch ticket in Mozio, the discount amount does not appear in the confirmation email. Expected: email shows promo discount. Actual: email shows full price.'
}];

function setupFixtures() {
  TMP_ROOT = mkdtempSync(join(tmpdir(), 'codeline-discovery-test-'));
  OUT_PATH = join(TMP_ROOT, 'out.json');

  // ax-shared: first alphabetically, no domain-relevant content
  IRRELEVANT_REPO = makeGitRepo(TMP_ROOT, 'ax-shared');
  mkdirSync(join(IRRELEVANT_REPO, 'src'), { recursive: true });
  writeFileSync(join(IRRELEVANT_REPO, 'src', 'index.ts'), `
    export function sharedUtil() { return 'generic'; }
  `);
  writeFileSync(join(IRRELEVANT_REPO, 'package.json'), JSON.stringify({
    name: 'ax-shared',
    description: 'Shared utility library',
  }));

  // z-commerce-cdts: last alphabetically, has promo/discount/mozio in source
  RELEVANT_REPO = makeGitRepo(TMP_ROOT, 'z-commerce-cdts');
  mkdirSync(join(RELEVANT_REPO, 'src', 'services'), { recursive: true });
  writeFileSync(join(RELEVANT_REPO, 'src', 'services', 'apply-report-discounts.service.ts'), `
    // Applies promo code discounts to Mozio booking line items.
    // Used for email confirmation when promo discount is present.
    export function applyReportDiscounts(lineItems: LineItem[], discounts: Discount[]) {
      return lineItems.map(item => {
        const discount = discounts.find(d => d.lineItemId === item.id);
        return discount ? { ...item, discountAmount: discount.amount } : item;
      });
    }
  `);
  writeFileSync(join(RELEVANT_REPO, 'package.json'), JSON.stringify({
    name: 'z-commerce-cdts',
    description: 'Commerce and dispatch ticketing service',
  }));

  ISSUES_PATH = makeIssuesJson(TMP_ROOT, AMSD_LIKE_ISSUE);
}

function cleanupFixtures() {
  if (TMP_ROOT && existsSync(TMP_ROOT)) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('codeline-discovery.js — scoring and fallback', () => {
  // Setup once; cleanup after all tests in this suite
  setupFixtures();
  afterAll(cleanupFixtures);

  it('dry-run selects highest-scored repo, not first alphabetically', () => {
    // ax-shared is alphabetically first; z-commerce-cdts has promo/discount/mozio content.
    // The bug: old code picked ax-shared because it was first. Fix: pick by score.
    const { stdout, exitCode } = runDiscovery([
      '--issues', ISSUES_PATH,
      '--root',   TMP_ROOT,
      '--out',    OUT_PATH,
      '--dry-run',
    ]);
    expect(exitCode, `discovery exited non-zero.\nstdout: ${stdout}`).toBe(0);

    const out = JSON.parse(require('fs').readFileSync(OUT_PATH, 'utf8'));
    expect(out.codelines).toHaveLength(1);
    // Must pick z-commerce-cdts (higher score) not ax-shared (first alphabetically)
    expect(out.codelines[0].path).toBe(RELEVANT_REPO);
    expect(out.codelines[0].name).toBe('cdts');
  });

  it('dry-run reason includes "scored-fallback" not "First git repo"', () => {
    const { exitCode } = runDiscovery([
      '--issues', ISSUES_PATH,
      '--root',   TMP_ROOT,
      '--out',    OUT_PATH,
      '--dry-run',
    ]);
    expect(exitCode).toBe(0);
    const out = JSON.parse(require('fs').readFileSync(OUT_PATH, 'utf8'));
    expect(out.codelines[0].reason).toMatch(/scored-fallback/i);
    expect(out.codelines[0].reason).not.toMatch(/First git repo/i);
  });

  it('LLM-timeout fallback (via CODELINE_DISCOVERY_DRY_RUN env) also picks highest-scored repo', () => {
    // CODELINE_DISCOVERY_DRY_RUN=1 exercises the same selectBestCandidate() path
    // that the LLM-failure catch block now uses.
    const { exitCode } = runDiscovery([
      '--issues', ISSUES_PATH,
      '--root',   TMP_ROOT,
      '--out',    OUT_PATH,
    ], { CODELINE_DISCOVERY_DRY_RUN: '1' });

    expect(exitCode).toBe(0);
    const out = JSON.parse(require('fs').readFileSync(OUT_PATH, 'utf8'));
    expect(out.codelines[0].path).toBe(RELEVANT_REPO);
  });

  it('output path is valid absolute path and .git exists in selected repo', () => {
    const { exitCode } = runDiscovery([
      '--issues', ISSUES_PATH,
      '--root',   TMP_ROOT,
      '--out',    OUT_PATH,
      '--dry-run',
    ]);
    expect(exitCode).toBe(0);
    const out = JSON.parse(require('fs').readFileSync(OUT_PATH, 'utf8'));
    const selected = out.codelines[0];
    expect(require('node:path').isAbsolute(selected.path)).toBe(true);
    expect(existsSync(join(selected.path, '.git'))).toBe(true);
  });

  it('exits non-zero when no git repos exist in root', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'codeline-empty-'));
    try {
      const { exitCode } = runDiscovery([
        '--issues', ISSUES_PATH,
        '--root',   emptyRoot,
        '--out',    join(emptyRoot, 'out.json'),
        '--dry-run',
      ]);
      expect(exitCode).not.toBe(0);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('exits non-zero when required args are missing', () => {
    const { exitCode } = runDiscovery(['--issues', ISSUES_PATH]);
    expect(exitCode).not.toBe(0);
  });

  it('docs.* repos are excluded from the manifest (not in maintenance scope)', () => {
    const docsRoot = mkdtempSync(join(tmpdir(), 'codeline-docs-test-'));
    try {
      // docs.anything — should be excluded
      const docsRepo = join(docsRoot, 'docs.tools.com');
      mkdirSync(join(docsRepo, '.git'), { recursive: true });
      mkdirSync(join(docsRepo, 'src'), { recursive: true });
      writeFileSync(join(docsRepo, 'src', 'promo.ts'), 'export const promoDiscount = () => {}');

      // Normal repo — should be included
      const realRepo = join(docsRoot, 'azure.commerce.cdts');
      mkdirSync(join(realRepo, '.git'), { recursive: true });
      writeFileSync(join(realRepo, 'package.json'), JSON.stringify({ name: 'cdts', description: 'commerce service' }));

      const issuesPath = makeIssuesJson(docsRoot, AMSD_LIKE_ISSUE);
      const outPath = join(docsRoot, 'out.json');

      const { stdout, exitCode } = runDiscovery([
        '--issues', issuesPath,
        '--root',   docsRoot,
        '--out',    outPath,
        '--dry-run',
      ]);
      expect(exitCode, stdout).toBe(0);
      const out = JSON.parse(require('fs').readFileSync(outPath, 'utf8'));
      // Must select azure.commerce.cdts, not docs.tools.com
      expect(out.codelines[0].path).toBe(realRepo);
    } finally {
      rmSync(docsRoot, { recursive: true, force: true });
    }
  });
});

// ── Source-text invariants ────────────────────────────────────────────────────
// Verify the structural fixes exist in the source even if the runtime path
// isn't exercised by the end-to-end tests above.

describe('codeline-discovery.js — source invariants', () => {
  const src = require('fs').readFileSync(DISCOVERY_JS, 'utf8');

  it('scoreRepos uses CodeGraph FTS5, not grep or Semble', () => {
    const scoreIdx = src.indexOf('function scoreRepos');
    const scoreFn  = src.slice(scoreIdx, scoreIdx + 4000);
    expect(scoreFn).toMatch(/CODEGRAPH_ENABLED.*=.*'1'/);
    expect(scoreFn).toMatch(/queryCodeGraph/);
    // Semble removed from scoring — all repos are indexed
    expect(scoreFn).not.toMatch(/sembleSearch|SEMBLE_ENABLED/);
    // Old grep must also be gone
    expect(scoreFn).not.toMatch(/grep -ril/);
  });

  it('dryRunDiscovery is replaced by selectBestCandidate', () => {
    expect(src).toMatch(/selectBestCandidate/);
    // Old function name should be gone
    expect(src).not.toMatch(/function dryRunDiscovery/);
  });

  it('selectBestCandidate picks scored[0], never uses alphabetical index', () => {
    const fnIdx = src.indexOf('function selectBestCandidate');
    const fn    = src.slice(fnIdx, fnIdx + 400);
    // Must pick index 0 of the scored list (already sorted descending by scoreRepos)
    expect(fn).toMatch(/scored\[0\]|scored\s*\[\s*0\s*\]/);
    // Must NOT pick by name/alphabetical ordering
    expect(fn).not.toMatch(/manifest\[0\]|candidates\[0\].*alpha/i);
  });

  it('main dry-run branch uses selectBestCandidate, not old dryRunDiscovery', () => {
    // Find the `if (DRY_RUN)` branch inside the async main, not the variable declaration
    const mainBranchIdx = src.indexOf('if (DRY_RUN)');
    expect(mainBranchIdx).toBeGreaterThan(-1);
    const mainBlock = src.slice(mainBranchIdx, mainBranchIdx + 600);
    expect(mainBlock).toMatch(/selectBestCandidate/);
    expect(mainBlock).not.toMatch(/dryRunDiscovery/);
  });

  it('LLM failure catch block uses selectBestCandidate, not dryRunDiscovery', () => {
    const catchIdx = src.indexOf('LLM call failed');
    const catchBlock = src.slice(catchIdx, catchIdx + 200);
    expect(catchBlock).toMatch(/selectBestCandidate/);
  });

  it('scoreRepos always runs before the DRY_RUN branch so fallback has scores', () => {
    // scoreRepos must be called BEFORE the if (DRY_RUN) conditional in main
    const scoringCallIdx  = src.indexOf('const candidates = scoreRepos');
    const dryRunBranchIdx = src.indexOf('if (DRY_RUN)');
    expect(scoringCallIdx).toBeGreaterThan(-1);
    expect(dryRunBranchIdx).toBeGreaterThan(-1);
    expect(scoringCallIdx).toBeLessThan(dryRunBranchIdx);
  });

  it('scored-fallback reason text appears in selectBestCandidate', () => {
    expect(src).toMatch(/scored-fallback/);
  });

  it('getLlm/ai-run.sh call still present for non-dry-run path', () => {
    expect(src).toMatch(/callLlm|AI_RUN_SH/);
  });

  it('docs.* repos are excluded in buildRepoManifest', () => {
    expect(src).toMatch(/docs\.\*/);
    expect(src).toMatch(/not in maintenance scope|docs repo/);
  });

  it('Semble is not used in scoring (all repos indexed; removed as noise source)', () => {
    const scoreIdx = src.indexOf('function scoreRepos');
    const scoreFn  = src.slice(scoreIdx, scoreIdx + 5000);
    expect(scoreFn).not.toMatch(/sembleScore|sembleSearch|SEMBLE_ENABLED/);
  });

  it('CodeGraph scoring uses CROSS-REPO term exclusivity, not per-repo BM25 sum', () => {
    // REPLACES the old "uses BM25 score sum, not result count" invariant, whose
    // premise was DISPROVEN by live measurement on 2026-07-24. Summing a capped
    // top-20 of BM25 scores has two fatal flaws:
    //   1. every candidate repo returned exactly 20 hits, so the sum degenerated to
    //      "average BM25 of your top 20" and could not express 50-hits vs 0-hits;
    //   2. BM25's IDF is computed WITHIN each repo's own index, so a token that is
    //      rare inside an irrelevant repo scores high there — an intra-corpus
    //      measure used as an inter-corpus ranking.
    // Measured: `mozio` had 50+ hits in azure.commerce.cdts and 0 in c365, yet the
    // BM25-sum ranked c365 HIGHER (140 vs 128) — the deterministic evidence argued
    // for the WRONG repo. Scoring is now document-frequency based across the repo
    // SET (see lib/codeline-score.js + codeline-score-cross-repo.test.ts).
    const scoreIdx = src.indexOf('function scoreRepos');
    const scoreFn  = src.slice(scoreIdx, scoreIdx + 5000);
    expect(scoreFn).toMatch(/crossRepoTermScores/);
    // Terms must be queried INDIVIDUALLY — a single joined query lets generic
    // tokens flood a shared result window and drown the discriminating one.
    expect(scoreFn).toMatch(/terms/);
    // The old saturating construct must be gone.
    expect(scoreFn).not.toMatch(/bm25Sum/);
    expect(scoreFn).not.toMatch(/queryCodeGraph\([^)]*cgQuery[^)]*,\s*20\s*\)/);
  });

  it('CodeGraph query filters domain stopwords before querying FTS5', () => {
    // Generic transit words ("trip","ticket","return","schedule") flood every repo
    // equally and collapse score separation. They must be stripped from the cgQuery.
    const scoreIdx = src.indexOf('function scoreRepos');
    const scoreFn  = src.slice(scoreIdx, scoreIdx + 5000);
    expect(scoreFn).toMatch(/DOMAIN_STOPWORDS/);
    expect(scoreFn).toMatch(/cgSpecificWords/);
    expect(scoreFn).toMatch(/cgSpecificWords.*slice|cgQuery.*cgSpecificWords/);
  });

  it('DOMAIN_STOPWORDS contains common transit terms that would flood all repos', () => {
    expect(src).toMatch(/'trip'/);
    expect(src).toMatch(/'ticket'|'tickets'/);
    expect(src).toMatch(/'schedule'|'schedules'/);
    expect(src).toMatch(/'station'|'stations'/);
  });
});

// ── Live scoring: azure.commerce.cdts must rank in top 8 for AMSD-1820 ────────
// Verifies the domain-stopword filter actually works against the real 31-repo root.
// Skipped when JIRA_CODELINE_ROOT is not present (CI / other machines).

const METRO_ROOT = '/home/bradleyjerome/projects/metrolinx';
const CDTS_PATH  = `${METRO_ROOT}/azure.commerce.cdts`;
const METRO_PRESENT = existsSync(CDTS_PATH);

describe('codeline-discovery.js — live scoring: AMSD-1820 repo rank', () => {
  it('azure.commerce.cdts appears in top 8 candidates after domain-stopword filtering', () => {
    if (!METRO_PRESENT) return;

    const issuesPath = join(tmpdir(), 'amsd1820-live-test.json');
    const outPath    = join(tmpdir(), 'amsd1820-live-out.json');
    writeFileSync(issuesPath, JSON.stringify([{
      jiraKey: 'AMSD-1820',
      title: '[Mozio] - The Promo code amount is NOT displayed as expected for Return trip tickets in the Mozio email confirmation',
      description: 'Promo discount not shown in Mozio email for return dispatch tickets.',
    }]));

    const { stderr, exitCode } = runDiscovery([
      '--issues', issuesPath,
      '--root',   METRO_ROOT,
      '--out',    outPath,
      '--dry-run',
    ], { CODEGRAPH_ENABLED: '1', SEMBLE_ENABLED: '0' });

    expect(exitCode, `discovery failed:\n${stderr}`).toBe(0);

    // Scoring log goes to stderr — top 8 candidates must include azure.commerce.cdts
    expect(stderr).toMatch(/azure\.commerce\.cdts/);
  });

  it('azure.commerce.cdts is the top-1 dry-run winner for AMSD-1820', () => {
    if (!METRO_PRESENT) return;

    const issuesPath = join(tmpdir(), 'amsd1820-live2-test.json');
    const outPath    = join(tmpdir(), 'amsd1820-live2-out.json');
    writeFileSync(issuesPath, JSON.stringify([{
      jiraKey: 'AMSD-1820',
      title: '[Mozio] - The Promo code amount is NOT displayed as expected for Return trip tickets in the Mozio email confirmation',
      description: 'Promo discount not shown in Mozio email for return dispatch tickets.',
    }]));

    runDiscovery([
      '--issues', issuesPath,
      '--root',   METRO_ROOT,
      '--out',    outPath,
      '--dry-run',
    ], { CODEGRAPH_ENABLED: '1', SEMBLE_ENABLED: '0' });

    const result = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(result.codelines[0].path).toBe(CDTS_PATH);
  });
});

// ── CodeGraph indexing-status starvation bug (live, 2026-07-22) ─────────────
// scoreRepos() used to assume every candidate repo was already CodeGraph-
// indexed ("all 31 Metrolinx repos are indexed" — a stale, unverified claim).
// A repo missing .codegraph/codegraph.db got ZERO Tier-2 score no matter how
// relevant its actual source was, while an already-indexed-but-irrelevant
// repo still got a real BM25 boost — so indexing status, not relevance,
// decided the winner. Confirmed live: azure.commerce.cdts (the real AMSD-1820
// fix site) was never indexed and didn't even make the top-8 offered to the
// LLM, which picked gotransit.webservices instead. Fix: scoreRepos() now
// calls codegraph init on demand for any un-indexed repo before scoring it.
//
// This suite is self-contained (temp git repos with real TS source, real
// codegraph binary) — no dependency on the live Metrolinx checkout, so it
// runs in CI. Per explicit instruction: run repeatedly to prove determinism,
// not just "it passed once."
describe('codeline-discovery.js — CodeGraph indexing-status starvation bug (real codegraph binary)', () => {
  function hasRealCodegraphBinary(): boolean {
    try {
      return spawnSync('which', ['codegraph'], { encoding: 'utf8' }).status === 0;
    } catch {
      return false;
    }
  }
  const CODEGRAPH_PRESENT = hasRealCodegraphBinary();

  function buildFixture(): { root: string; unindexedRelevant: string; preindexedIrrelevant: string; issuesPath: string; outPath: string } {
    const root = mkdtempSync(join(tmpdir(), 'codegraph-starve-test-'));

    // The ACTUAL fix-site repo — real source containing the exact symbol/terms
    // the query will search for. Deliberately left un-indexed until scoreRepos()
    // runs, so this test only passes if on-demand indexing actually happens.
    const unindexedRelevant = makeGitRepo(root, 'zzz-real-fix-site');
    mkdirSync(join(unindexedRelevant, 'src', 'services'), { recursive: true });
    writeFileSync(
      join(unindexedRelevant, 'src', 'services', 'apply-report-discounts.service.ts'),
      `
      // Applies mozio promo discount amounts to return-dispatch line items
      // before the confirmation email is generated.
      export function applyReportDiscounts(lineItems: LineItem[], discounts: Discount[]) {
        return lineItems.map(item => {
          const mozioDiscount = discounts.find(d => d.lineItemId === item.id);
          return mozioDiscount ? { ...item, discountAmount: mozioDiscount.amount, confirmationReady: true } : item;
        });
      }
      `
    );
    writeFileSync(join(unindexedRelevant, 'package.json'), JSON.stringify({ name: 'zzz-real-fix-site' }));

    // A repo that gets pre-indexed (simulating "already indexed at some
    // point") but whose actual source has nothing to do with the ticket —
    // generic transit boilerplate only. Must NOT win just for being indexed.
    const preindexedIrrelevant = makeGitRepo(root, 'aaa-irrelevant-but-indexed');
    mkdirSync(join(preindexedIrrelevant, 'src'), { recursive: true });
    writeFileSync(
      join(preindexedIrrelevant, 'src', 'schedule.ts'),
      `
      export function getTrainSchedule(stationId: string) {
        return { stationId, departures: [], arrivals: [] };
      }
      `
    );
    writeFileSync(join(preindexedIrrelevant, 'package.json'), JSON.stringify({ name: 'aaa-irrelevant-but-indexed' }));
    // Pre-index it for real, using the real binary — this is the repo that
    // should NOT win despite having a head start.
    execFileSync('codegraph', ['init', preindexedIrrelevant], { encoding: 'utf8', timeout: 30000 });

    const issuesPath = join(root, 'issues.json');
    writeFileSync(issuesPath, JSON.stringify([{
      jiraKey: 'AMSD-1820',
      title: '[Mozio] - The Promo code amount is NOT displayed as expected for Return trip tickets in the Mozio email confirmation',
      description: 'Promo discount not shown in Mozio confirmation email for return dispatch tickets.',
    }]));

    return { root, unindexedRelevant, preindexedIrrelevant, issuesPath, outPath: join(root, 'out.json') };
  }

  it('an un-indexed but genuinely relevant repo beats a pre-indexed but irrelevant one — run 10x to prove determinism', () => {
    if (!CODEGRAPH_PRESENT) return;

    const RUNS = 10;
    const results: { winner: string; indexedAfter: boolean }[] = [];

    for (let i = 0; i < RUNS; i++) {
      const fx = buildFixture();
      try {
        const { stdout, stderr, exitCode } = runDiscovery(
          ['--issues', fx.issuesPath, '--root', fx.root, '--out', fx.outPath, '--dry-run'],
          { CODEGRAPH_ENABLED: '1' }
        );
        expect(exitCode, `run ${i}: discovery failed.\nstdout: ${stdout}\nstderr: ${stderr}`).toBe(0);

        const out = JSON.parse(readFileSync(fx.outPath, 'utf8'));
        const winnerPath: string = out.codelines[0].path;
        const indexedAfter = existsSync(join(fx.unindexedRelevant, '.codegraph', 'codegraph.db'));
        results.push({
          winner: winnerPath === fx.unindexedRelevant ? 'relevant' : 'irrelevant',
          indexedAfter,
        });
      } finally {
        rmSync(fx.root, { recursive: true, force: true });
      }
    }

    // Every single run: the relevant (initially un-indexed) repo must win,
    // AND on-demand indexing must have actually happened for it.
    const failures = results.filter(r => r.winner !== 'relevant' || !r.indexedAfter);
    expect(failures, `${failures.length}/${RUNS} runs failed: ${JSON.stringify(results)}`).toHaveLength(0);
    expect(results).toHaveLength(RUNS);
  }, 180000);

  it('scoreRepos() calls initCodeGraph for a repo missing .codegraph/codegraph.db (source invariant)', () => {
    const src = readFileSync(DISCOVERY_JS, 'utf8');
    // Brace-optional: the guard is now a single-line `if (...) cg.initCodeGraph(...)`
    // inside the pre-scoring index-on-demand loop. What matters is the INVARIANT —
    // an unindexed repo gets indexed rather than silently scored zero — not the style.
    expect(src).toMatch(/if\s*\(!cg\.isCodeGraphIndexed\(repo\.path\)\)\s*\{?[\s\S]{0,80}cg\.initCodeGraph/);
  });
});

// ── LLM returns a valid-but-empty (or all-invalid-path) selection (live bug, 2026-07-22) ──
// Reproduced live: the SAME prompt against the SAME real repo, called twice
// back to back, returned different results — once a repo, once
// {"codelines": []}. Not a call failure (no exception; the existing
// try/catch around callLlm() never fires), just a non-deterministic model
// decision to select nothing. This used to hard-fail the entire pipeline
// (process.exit(1)) before a single story could be attempted, even though
// deterministic scoring had already identified a clear best candidate.
//
// Uses a fake ai-run.sh stub via CODELINE_DISCOVERY_AI_RUN_SH_OVERRIDE so
// this is deterministic and fast — no real LLM call, no network — while
// exercising the REAL non-dry-run code path (buildDiscoveryPrompt, callLlm,
// the validation/fallback logic), not a hand-copied reimplementation.
describe('codeline-discovery.js — LLM returns empty/invalid selection: deterministic fallback (live bug, 2026-07-22)', () => {
  // Self-contained fixture — deliberately NOT sharing TMP_ROOT/ISSUES_PATH/
  // RELEVANT_REPO from the 'scoring and fallback' describe block above,
  // whose afterAll(cleanupFixtures) deletes that shared fixture once ITS
  // its finish. Reusing it here worked only when run in isolation (a `-t`
  // filter skips the other block's afterAll) and broke the moment the whole
  // file ran in its natural order — found live while adding this suite.
  let root: string, issuesPath: string, outPath: string, relevantRepo: string;

  function setup() {
    root = mkdtempSync(join(tmpdir(), 'codeline-empty-selection-test-'));
    relevantRepo = makeGitRepo(root, 'z-commerce-cdts');
    mkdirSync(join(relevantRepo, 'src', 'services'), { recursive: true });
    writeFileSync(join(relevantRepo, 'src', 'services', 'apply-report-discounts.service.ts'), `
      export function applyReportDiscounts(lineItems, discounts) {
        return lineItems.map(item => ({ ...item }));
      }
    `);
    writeFileSync(join(relevantRepo, 'package.json'), JSON.stringify({
      name: 'z-commerce-cdts', description: 'Commerce and dispatch ticketing service',
    }));
    issuesPath = makeIssuesJson(root, AMSD_LIKE_ISSUE);
    outPath = join(root, 'out.json');
  }

  function makeAiRunStub(responseJson: string): string {
    const stubDir = mkdtempSync(join(tmpdir(), 'ai-run-stub-'));
    const stubPath = join(stubDir, 'ai-run.sh');
    writeFileSync(stubPath, `#!/usr/bin/env bash\ncat <<'STUBEOF'\n${responseJson}\nSTUBEOF\n`);
    execFileSync('chmod', ['+x', stubPath]);
    return stubPath;
  }

  it('falls back to the highest-scored candidate when the LLM returns {"codelines": []} — does NOT hard-fail', () => {
    setup();
    const stub = makeAiRunStub(JSON.stringify({ codelines: [] }));
    try {
      const { stdout, stderr, exitCode } = runDiscovery(
        ['--issues', issuesPath, '--root', root, '--out', outPath],
        { CODELINE_DISCOVERY_AI_RUN_SH_OVERRIDE: stub }
      );
      expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
      expect(stderr).toMatch(/LLM returned no valid codeline selection/);
      expect(stderr).toMatch(/Using highest-scored candidate as fallback/);
      const out = JSON.parse(readFileSync(outPath, 'utf8'));
      expect(out.codelines).toHaveLength(1);
      expect(out.codelines[0].path).toBe(relevantRepo);
    } finally {
      rmSync(require('node:path').dirname(stub), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the highest-scored candidate when the LLM returns only invalid/nonexistent paths', () => {
    setup();
    const stub = makeAiRunStub(JSON.stringify({
      codelines: [{ name: 'ghost', path: '/definitely/does/not/exist/anywhere', reason: 'hallucinated path' }],
    }));
    try {
      const { stdout, stderr, exitCode } = runDiscovery(
        ['--issues', issuesPath, '--root', root, '--out', outPath],
        { CODELINE_DISCOVERY_AI_RUN_SH_OVERRIDE: stub }
      );
      expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
      expect(stderr).toMatch(/Skipping codeline 'ghost'/);
      expect(stderr).toMatch(/LLM returned no valid codeline selection/);
      const out = JSON.parse(readFileSync(outPath, 'utf8'));
      expect(out.codelines[0].path).toBe(relevantRepo);
    } finally {
      rmSync(require('node:path').dirname(stub), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still hard-fails with a clear error if even the scored fallback has no valid candidates (no git repos at all)', () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'codeline-discovery-empty-root-'));
    try {
      const stub = makeAiRunStub(JSON.stringify({ codelines: [] }));
      const emptyIssuesPath = makeIssuesJson(emptyRoot, AMSD_LIKE_ISSUE);
      const { exitCode } = runDiscovery(
        ['--issues', emptyIssuesPath, '--root', emptyRoot, '--out', join(emptyRoot, 'out.json')],
        { CODELINE_DISCOVERY_AI_RUN_SH_OVERRIDE: stub }
      );
      // No git repos found at all -> exits before ever reaching the LLM call.
      expect(exitCode).not.toBe(0);
      rmSync(require('node:path').dirname(stub), { recursive: true, force: true });
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('does not use the empty/invalid-selection fallback path when the LLM genuinely picks a valid repo', () => {
    setup();
    const stub = makeAiRunStub(JSON.stringify({
      codelines: [{ name: 'cdts', path: relevantRepo, reason: 'genuine match' }],
    }));
    try {
      const { exitCode, stderr } = runDiscovery(
        ['--issues', issuesPath, '--root', root, '--out', outPath],
        { CODELINE_DISCOVERY_AI_RUN_SH_OVERRIDE: stub }
      );
      expect(exitCode).toBe(0);
      expect(stderr).not.toMatch(/LLM returned no valid codeline selection/);
      const out = JSON.parse(readFileSync(outPath, 'utf8'));
      expect(out.codelines[0].path).toBe(relevantRepo);
    } finally {
      rmSync(require('node:path').dirname(stub), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it('run 10x in a row with a stub that always returns empty — deterministic fallback every time, never hard-fails', () => {
    const RUNS = 10;
    const outcomes: { exitCode: number; path: string | null }[] = [];
    for (let i = 0; i < RUNS; i++) {
      setup();
      const stub = makeAiRunStub(JSON.stringify({ codelines: [] }));
      try {
        const { exitCode } = runDiscovery(
          ['--issues', issuesPath, '--root', root, '--out', outPath],
          { CODELINE_DISCOVERY_AI_RUN_SH_OVERRIDE: stub }
        );
        let outCodelinePath: string | null = null;
        try {
          outCodelinePath = JSON.parse(readFileSync(outPath, 'utf8')).codelines[0].path;
        } catch { /* leave null */ }
        outcomes.push({ exitCode, path: outCodelinePath === relevantRepo ? relevantRepo : outCodelinePath });
      } finally {
        rmSync(require('node:path').dirname(stub), { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      }
    }
    const failures = outcomes.filter(o => o.exitCode !== 0 || !o.path);
    expect(failures, `${failures.length}/${RUNS} failed: ${JSON.stringify(outcomes)}`).toHaveLength(0);
  }, 60000);
});

describe('codeline-discovery.js — LLM prompt clarity (live bug, 2026-07-22: model non-deterministically returned empty selection)', () => {
  const src = readFileSync(DISCOVERY_JS, 'utf8');
  const promptFnStart = src.indexOf('function buildDiscoveryPrompt');
  const promptFnEnd = src.indexOf('\n}\n\nfunction callLlm', promptFnStart);
  const promptFn = src.slice(promptFnStart, promptFnEnd > -1 ? promptFnEnd : promptFnStart + 3000);

  it('explicitly instructs the model that an empty result is never acceptable', () => {
    expect(promptFn).toMatch(/MUST return at least one/i);
    expect(promptFn).toMatch(/empty result is\s*\n?\s*NEVER acceptable|NEVER acceptable/i);
  });

  it('tells the model the candidate list is pre-scored and ordered by confidence, so it has a concrete fallback choice', () => {
    expect(promptFn).toMatch(/PRE-SCORED|pre-scored/);
    expect(promptFn).toMatch(/descending order of match confidence|ranked by match confidence/i);
  });

  it('instructs against omitting a candidate purely due to uncertainty', () => {
    expect(promptFn).toMatch(/uncertain|not fully confident/i);
  });
});
