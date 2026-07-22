/**
 * CodeGraph integration tests.
 *
 * Tests three things:
 *   1. codegraph-context.js module API (source invariants + live calls against
 *      azure.commerce.cdts which is already indexed)
 *   2. spec-mode-runner.js wiring — CodeGraph replaces Semble for brownfield context
 *   3. codeline-discovery.js wiring — CodeGraph is Tier 2 (before Semble as Tier 3)
 *
 * Why CodeGraph over Semble for brownfield:
 *   - Semble: cosine-similarity snippets, 1-pt margin between 31 repos → brittle
 *   - CodeGraph: FTS5 BM25 on symbol names; indexed repo wins by 50-100 pts → decisive
 *
 * For the live tests, azure.commerce.cdts MUST already be indexed. If it is not,
 * the live tests are skipped (not failed) to avoid blocking CI on other machines.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join }                    from 'node:path';
import { execFileSync }            from 'node:child_process';

const REPO_ROOT      = join(__dirname, '../../../');
const LIB_DIR        = join(REPO_ROOT, 'orchestrations/scripts/lib');
const CODEGRAPH_LIB  = join(LIB_DIR, 'codegraph-context.js');
const DISCOVERY_SRC  = readFileSync(join(LIB_DIR, 'codeline-discovery.js'), 'utf8');
const SPEC_SRC       = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
const CODEGRAPH_SRC  = readFileSync(CODEGRAPH_LIB, 'utf8');
const CDTS_PATH      = '/home/bradleyjerome/projects/metrolinx/azure.commerce.cdts';
const CDTS_INDEXED   = existsSync(join(CDTS_PATH, '.codegraph', 'codegraph.db'));

// ── codegraph-context.js: module API ────────────────────────────────────────

describe('codegraph-context.js: module structure', () => {
  it('exports resolveCodeGraphBin', () => {
    expect(CODEGRAPH_SRC).toMatch(/module\.exports.*resolveCodeGraphBin/);
  });

  it('exports isCodeGraphIndexed', () => {
    expect(CODEGRAPH_SRC).toMatch(/module\.exports.*isCodeGraphIndexed/);
  });

  it('exports initCodeGraph', () => {
    expect(CODEGRAPH_SRC).toMatch(/module\.exports.*initCodeGraph/);
  });

  it('exports queryCodeGraph', () => {
    expect(CODEGRAPH_SRC).toMatch(/module\.exports.*queryCodeGraph/);
  });

  it('exports exploreCodeGraph', () => {
    expect(CODEGRAPH_SRC).toMatch(/module\.exports.*exploreCodeGraph/);
  });

  it('isCodeGraphIndexed checks .codegraph/codegraph.db (fast filesystem check, no subprocess)', () => {
    expect(CODEGRAPH_SRC).toMatch(/codegraph\.db/);
    expect(CODEGRAPH_SRC).toMatch(/fs\.existsSync/);
    // Must NOT call execSync for isCodeGraphIndexed
    const fnIdx  = CODEGRAPH_SRC.indexOf('function isCodeGraphIndexed');
    const fnBody = CODEGRAPH_SRC.slice(fnIdx, fnIdx + 200);
    expect(fnBody).not.toMatch(/execSync/);
  });

  it('queryCodeGraph uses --json flag for machine-readable output', () => {
    const fnIdx  = CODEGRAPH_SRC.indexOf('function queryCodeGraph');
    const fnBody = CODEGRAPH_SRC.slice(fnIdx, fnIdx + 400);
    expect(fnBody).toMatch(/--json/);
  });

  it('exploreCodeGraph caps output to maxChars to avoid token budget overruns', () => {
    const fnIdx  = CODEGRAPH_SRC.indexOf('function exploreCodeGraph');
    const fnBody = CODEGRAPH_SRC.slice(fnIdx, fnIdx + 600);
    expect(fnBody).toMatch(/maxChars/);
  });

  it('exploreCodeGraph uses --max-files flag', () => {
    const fnIdx  = CODEGRAPH_SRC.indexOf('function exploreCodeGraph');
    const fnBody = CODEGRAPH_SRC.slice(fnIdx, fnIdx + 400);
    expect(fnBody).toMatch(/--max-files/);
  });

  it('all CLI calls have a timeout to prevent pipeline hangs', () => {
    // Every execSync inside the lib must have a timeout
    const calls = CODEGRAPH_SRC.match(/execSync\([^)]+\)/g) || [];
    for (const call of calls) {
      expect(call, `execSync call missing timeout: ${call}`).toMatch(/timeout/);
    }
  });

  it('gracefully returns empty/null when codegraph binary is missing', () => {
    const fnIdx  = CODEGRAPH_SRC.indexOf('function resolveCodeGraphBin');
    const fnBody = CODEGRAPH_SRC.slice(fnIdx, fnIdx + 300);
    // Must have a catch that returns null
    expect(fnBody).toMatch(/return null/);
  });
});

// ── codegraph-context.js: live calls (skipped if repo not indexed) ──────────

describe('codegraph-context.js: live calls against azure.commerce.cdts', () => {
  const cg = require(CODEGRAPH_LIB);

  it('isCodeGraphIndexed returns true for azure.commerce.cdts', () => {
    if (!CDTS_INDEXED) return; // skip without failing
    expect(cg.isCodeGraphIndexed(CDTS_PATH)).toBe(true);
  });

  it('isCodeGraphIndexed returns false for a non-existent path', () => {
    expect(cg.isCodeGraphIndexed('/tmp/definitely-does-not-exist-99999')).toBe(false);
  });

  it('queryCodeGraph returns symbol matches for discount/mozio/dispatch', () => {
    if (!CDTS_INDEXED) return;
    const results = cg.queryCodeGraph('discount mozio dispatch', CDTS_PATH, 10);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    // Each result must have node.filePath and score
    for (const r of results) {
      expect(r).toHaveProperty('node.filePath');
      expect(r).toHaveProperty('score');
      expect(typeof r.score).toBe('number');
    }
  });

  it('queryCodeGraph finds applyReportDiscountsService by name', () => {
    if (!CDTS_INDEXED) return;
    const results = cg.queryCodeGraph('applyReportDiscounts', CDTS_PATH, 5);
    const names = results.map((r: any) => r.node.name);
    expect(names.some((n: string) => /applyReport|reportDiscount/i.test(n))).toBe(true);
  });

  it('queryCodeGraph returns empty array for unindexed repo', () => {
    const results = cg.queryCodeGraph('anything', '/tmp/not-a-repo-42', 5);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  it('exploreCodeGraph returns non-empty markdown for apply report discounts', () => {
    if (!CDTS_INDEXED) return;
    const output = cg.exploreCodeGraph('apply report discounts mozio email', CDTS_PATH, { maxFiles: 2 });
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(100);
    // Must contain the bug file
    expect(output).toMatch(/apply-report-discounts|applyReportDiscounts/i);
  });

  it('exploreCodeGraph output is capped at maxChars', () => {
    if (!CDTS_INDEXED) return;
    const output = cg.exploreCodeGraph('discount mozio return', CDTS_PATH, { maxFiles: 6, maxChars: 500 });
    expect(output.length).toBeLessThanOrEqual(510); // small buffer for last-newline trim
  });

  it('resolveCodeGraphBin finds the installed codegraph binary', () => {
    const bin = cg.resolveCodeGraphBin();
    // If not installed in CI, just ensure no throw
    if (bin) {
      expect(typeof bin).toBe('string');
      expect(bin.length).toBeGreaterThan(0);
    }
  });
});

// ── codeline-discovery.js: CodeGraph Tier 2 wiring ──────────────────────────

describe('codeline-discovery.js: CodeGraph Tier 2 in scoreRepos', () => {
  it('imports codegraph-context lazily (getCodeGraph function)', () => {
    expect(DISCOVERY_SRC).toMatch(/function getCodeGraph/);
    expect(DISCOVERY_SRC).toMatch(/require\(['"]\.\/codegraph-context['"]\)/);
  });

  it('CodeGraph scoring is gated on CODEGRAPH_ENABLED=1', () => {
    const scoreIdx = DISCOVERY_SRC.indexOf('function scoreRepos');
    const scoreFn  = DISCOVERY_SRC.slice(scoreIdx, scoreIdx + 4000);
    expect(scoreFn).toMatch(/CODEGRAPH_ENABLED.*=.*'1'/);
  });

  it('CodeGraph scoring only runs for indexed repos (isCodeGraphIndexed check)', () => {
    const scoreIdx = DISCOVERY_SRC.indexOf('function scoreRepos');
    const scoreFn  = DISCOVERY_SRC.slice(scoreIdx, scoreIdx + 4000);
    expect(scoreFn).toMatch(/isCodeGraphIndexed/);
  });

  it('CodeGraph is the sole scoring tier (Tier 2 comment present, no Tier 3)', () => {
    const scoreIdx = DISCOVERY_SRC.indexOf('function scoreRepos');
    const scoreFn  = DISCOVERY_SRC.slice(scoreIdx, scoreIdx + 4000);
    expect(scoreFn).toMatch(/Tier 2/);
    expect(scoreFn).not.toMatch(/Tier 3/);
  });

  it('Semble is not present in scoreRepos (removed — all repos indexed, no fallback needed)', () => {
    const scoreIdx = DISCOVERY_SRC.indexOf('function scoreRepos');
    const scoreFn  = DISCOVERY_SRC.slice(scoreIdx, scoreIdx + 2000);
    expect(scoreFn).not.toMatch(/sembleSearch|SEMBLE_ENABLED/);
  });

  it('CodeGraph scoring uses BM25 score sum from queryCodeGraph results', () => {
    const scoreIdx = DISCOVERY_SRC.indexOf('function scoreRepos');
    const scoreFn  = DISCOVERY_SRC.slice(scoreIdx, scoreIdx + 3000);
    expect(scoreFn).toMatch(/queryCodeGraph/);
    // Must sum BM25 scores — NOT count results (count saturates cap for all repos)
    expect(scoreFn).toMatch(/reduce.*score|bm25Sum/);
    expect(scoreFn).not.toMatch(/\.length.*\*.*5|5.*\*.*\.length/);
  });
});

// ── spec-mode-runner.js: CodeGraph replaces Semble for brownfield ────────────

describe('spec-mode-runner.js: CodeGraph context for brownfield', () => {
  it('defines fetchCodeGraphContext function', () => {
    expect(SPEC_SRC).toMatch(/function fetchCodeGraphContext/);
  });

  it('fetchCodeGraphContext is gated on CODEGRAPH_ENABLED=1', () => {
    const fnIdx  = SPEC_SRC.indexOf('function fetchCodeGraphContext');
    const fnBody = SPEC_SRC.slice(fnIdx, fnIdx + 600);
    expect(fnBody).toMatch(/CODEGRAPH_ENABLED.*=.*'1'/);
  });

  it('fetchCodeGraphContext checks isCodeGraphIndexed before calling explore', () => {
    const fnIdx  = SPEC_SRC.indexOf('function fetchCodeGraphContext');
    const fnBody = SPEC_SRC.slice(fnIdx, fnIdx + 1200);
    expect(fnBody).toMatch(/isCodeGraphIndexed/);
    expect(fnBody).toMatch(/exploreCodeGraph/);
  });

  it('fetchCodeGraphContext returns null (not empty string) when unavailable', () => {
    const fnIdx  = SPEC_SRC.indexOf('function fetchCodeGraphContext');
    const fnBody = SPEC_SRC.slice(fnIdx, fnIdx + 1200);
    expect(fnBody).toMatch(/return null/);
  });

  it('defines fetchExistingCodeContext that prefers CodeGraph for brownfield', () => {
    expect(SPEC_SRC).toMatch(/function fetchExistingCodeContext/);
    const fnIdx  = SPEC_SRC.indexOf('function fetchExistingCodeContext');
    const fnBody = SPEC_SRC.slice(fnIdx, fnIdx + 500);
    expect(fnBody).toMatch(/isBrownfield/);
    expect(fnBody).toMatch(/fetchCodeGraphContext/);
  });

  it('fetchExistingCodeContext falls back to Semble when CodeGraph returns null', () => {
    const fnIdx  = SPEC_SRC.indexOf('function fetchExistingCodeContext');
    const fnBody = SPEC_SRC.slice(fnIdx, fnIdx + 500);
    expect(fnBody).toMatch(/fetchSembleContext/);
  });

  it('greenfield path uses Semble only (not CodeGraph)', () => {
    const fnIdx  = SPEC_SRC.indexOf('function fetchExistingCodeContext');
    const fnBody = SPEC_SRC.slice(fnIdx, fnIdx + 600);
    // The non-brownfield branch must return fetchSembleContext without calling CodeGraph
    expect(fnBody).toMatch(/return fetchSembleContext/);
  });

  it('call site uses fetchExistingCodeContext, not raw fetchSembleContext', () => {
    // The prompt assembly line must call the new dispatcher
    const callSiteIdx = SPEC_SRC.indexOf('fetchExistingCodeContext(story)');
    expect(callSiteIdx).toBeGreaterThan(-1);
  });

  it('archaeology block references CodeGraph or Semble generically (not Semble-only)', () => {
    const blockIdx = SPEC_SRC.indexOf('BROWNFIELD MODE — output JSON only');
    expect(blockIdx).toBeGreaterThan(-1);
    const block = SPEC_SRC.slice(blockIdx, blockIdx + 400);
    expect(block).toMatch(/CodeGraph.*Semble|Semble.*CodeGraph/);
  });

  it('CodeGraph context label says "CodeGraph static analysis" in the injected block', () => {
    expect(SPEC_SRC).toMatch(/CodeGraph static analysis/);
  });

  it('Semble brownfield fallback label says "brownfield fallback via Semble"', () => {
    expect(SPEC_SRC).toMatch(/brownfield fallback via Semble/);
  });
});

// ── codeline-discovery.js: CodeGraph Tier 2 scoring advantage (controlled temp repos) ──

describe('codeline-discovery.js: CodeGraph Tier 2 scoring advantage', () => {
  // Uses a temp dir with two repos where only the relevant one is CodeGraph-indexed.
  // This avoids the brittleness of running against the live 31-repo Metrolinx root
  // (where other indexed repos may score higher due to generic term matches).

  it('CodeGraph-indexed repo wins over unindexed repo with same Tier 1 keyword score', () => {
    if (!CDTS_INDEXED) return; // need codegraph binary
    const cg = require(CODEGRAPH_LIB);
    const bin = cg.resolveCodeGraphBin();
    if (!bin) return;

    const { mkdtempSync, mkdirSync, writeFileSync: wf, rmSync } = require('node:fs');
    const { tmpdir } = require('node:os');

    const root = mkdtempSync(join(tmpdir(), 'cg-tier2-test-'));
    try {
      // Both repos: same Tier 1 keywords in description so keyword score is equal.
      // Only one is CodeGraph-indexed.

      // Repo A: unindexed — "discount promo mozio dispatch" in description
      const repoA = join(root, 'a-generic-service');
      mkdirSync(join(repoA, '.git'), { recursive: true });
      wf(join(repoA, 'package.json'), JSON.stringify({
        name: 'a-generic-service',
        description: 'discount promo mozio dispatch email service',
      }));

      // Repo B: to be indexed — same description keywords + actual symbol names
      const repoB = join(root, 'b-discount-service');
      mkdirSync(join(repoB, '.git'), { recursive: true });
      mkdirSync(join(repoB, 'src'), { recursive: true });
      wf(join(repoB, 'package.json'), JSON.stringify({
        name: 'b-discount-service',
        description: 'discount promo mozio dispatch email service',
      }));
      wf(join(repoB, 'src', 'apply-discounts.ts'), `
        /** Applies promo discount to mozio dispatch line items for email confirmation. */
        export function applyDiscounts(lineItems, discounts) {
          return lineItems.map(item => {
            const discount = discounts.find(d => d.lineItemId === item.id);
            return discount ? { ...item, promoDiscount: discount.amount } : item;
          });
        }
      `);

      // Index only repoB
      execFileSync(bin, ['init', repoB], { encoding: 'utf8', timeout: 30000 });
      expect(existsSync(join(repoB, '.codegraph', 'codegraph.db'))).toBe(true);

      // Run discovery with CodeGraph enabled
      const issuesPath = join(root, 'issues.json');
      const outPath    = join(root, 'out.json');
      wf(issuesPath, JSON.stringify([{
        jiraKey: 'TEST-1',
        title: 'Promo discount not shown in Mozio email for dispatch tickets',
        description: 'Promo code discount amount is missing from Mozio email confirmation for return dispatch.',
      }]));

      execFileSync(process.execPath, [
        join(LIB_DIR, 'codeline-discovery.js'),
        '--issues', issuesPath,
        '--root',   root,
        '--out',    outPath,
        '--dry-run',
      ], {
        encoding: 'utf8',
        timeout:  30000,
        env: { ...process.env, CODEGRAPH_ENABLED: '1', SEMBLE_ENABLED: '0' },
      });

      const result = JSON.parse(readFileSync(outPath, 'utf8'));
      expect(result.codelines).toHaveLength(1);
      // b-discount-service (indexed) must beat a-generic-service (unindexed)
      // even though both have identical Tier 1 keyword scores
      expect(result.codelines[0].path).toBe(repoB);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
