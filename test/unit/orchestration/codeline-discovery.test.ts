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
import { execFileSync }                   from 'node:child_process';
import { mkdtempSync, mkdirSync,
         writeFileSync, rmSync,
         existsSync }                     from 'node:fs';
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
  try {
    const stdout = execFileSync(NODE, [DISCOVERY_JS, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env, SEMBLE_ENABLED: '0' },
      timeout: 15000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status ?? 1 };
  }
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
});

// ── Source-text invariants ────────────────────────────────────────────────────
// Verify the structural fixes exist in the source even if the runtime path
// isn't exercised by the end-to-end tests above.

describe('codeline-discovery.js — source invariants', () => {
  const src = require('fs').readFileSync(DISCOVERY_JS, 'utf8');

  it('scoreRepos uses Semble when SEMBLE_ENABLED=1, not grep', () => {
    const scoreIdx = src.indexOf('function scoreRepos');
    const scoreFn  = src.slice(scoreIdx, scoreIdx + 2000);
    expect(scoreFn).toMatch(/SEMBLE_ENABLED.*=.*'1'|semble.*Enabled/i);
    expect(scoreFn).toMatch(/sembleSearch|semble\.sembleSearch/);
    // Must NOT contain the old grep pattern that scanned all source files
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
});
