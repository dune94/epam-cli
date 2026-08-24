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

/**
 * The WHOLE body of scoreRepos, not a fixed character window.
 *
 * These invariants used to slice `scoreIdx + 4000` / `+ 5000` characters. That is a guess
 * about how long the function is, and it silently becomes wrong the moment anyone adds a
 * comment: on 2026-08-06 a note explaining why terms are ordered by TF-IDF pushed the real
 * `queryCodeGraph` call past the 4000-char mark, and the test failed while the behaviour it
 * checks was untouched. A test that fails on prose length teaches people to delete
 * explanations to keep it green.
 */
function scoreReposSource(): string {
  const src = readFileSync(DISCOVERY_JS, 'utf8');
  const start = src.indexOf('function scoreRepos');
  if (start < 0) throw new Error('scoreRepos not found — the invariant cannot be checked');
  const end = src.indexOf('\n}', start);
  return src.slice(start, end < 0 ? src.length : end);
}

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

describe('codeline-discovery.js — the CLI contract', () => {
  // WHAT THIS FILE USED TO ASSERT, and why almost none of it survives.
  //
  // Six suites held discovery to the behaviour of a ranking apparatus in engine code: that
  // scoreRepos exists and uses a CodeGraph tier, that a dry run picks the highest-scored
  // repository, that selectBestCandidate returns scored[0], that an empty model reply falls back
  // to that candidate rather than failing, that the scan excludes repositories by declared
  // patterns, and that the PROMPT tells the model the candidate list is "pre-scored and ordered
  // by confidence".
  //
  // All of it is gone, because all of it was the engine deciding which client repository gets
  // modified — by arithmetic, from a shortlist of eight, with the ticket's own short words
  // stripped, and with a deterministic fallback that overrode the agent exactly when the agent
  // had failed. The last item was worse than obsolete: the prompt asserted a ranking that no
  // longer existed, and the model was told to lean on it.
  //
  // These tests are what remains true of the command itself, and they are about REFUSAL — the
  // cases where discovery must not proceed. What discovery must now DO is in
  // discovery-is-agentic-and-uncontaminated.test.ts and discovery-holds-no-term-filter.test.ts.
  setupFixtures();
  afterAll(cleanupFixtures);

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

  it('a dry run reports what would be sent and selects NOTHING', () => {
    // A "dry" run that quietly picked a repository was the most misleading output this command
    // could produce: it exercised none of the reasoning and still wrote an answer to disk.
    const { stdout, exitCode } = runDiscovery([
      '--issues', ISSUES_PATH,
      '--root',   TMP_ROOT,
      '--out',    OUT_PATH,
      '--dry-run',
    ]);
    expect(exitCode, `discovery exited non-zero.\nstdout: ${stdout}`).toBe(0);
    // It renders the prompt...
    expect(stdout).toContain('JIRA TICKETS:');
    expect(stdout).toContain('REPOSITORY MANIFEST');
    // ...and writes no selection.
    expect(existsSync(OUT_PATH), 'a dry run wrote a codeline selection').toBe(false);
  });
});
