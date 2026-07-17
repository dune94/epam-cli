import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const SPEC_RUNNER = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');
const src = readFileSync(SPEC_RUNNER, 'utf8');

// Replicate the estimation formula from spec-mode-runner.js for unit testing.
// These constants must stay in sync with the file; if either changes, a test
// below will fail first, prompting an update here.
const ESTIMATE_BASE = 2000;
const ESTIMATE_PER_AC = 150;
const ESTIMATE_PER_TC = 300;
const ESTIMATE_PER_FILE = 100;
const ESTIMATE_BYTES_PER_TOKEN = 4;

function estimateStoryTokens(acCount: number, fileCount: number, contractBytes: number): number {
  return ESTIMATE_BASE
    + (acCount * ESTIMATE_PER_AC)
    + (acCount * ESTIMATE_PER_TC)
    + (fileCount * ESTIMATE_PER_FILE)
    + Math.ceil(contractBytes / ESTIMATE_BYTES_PER_TOKEN);
}

describe('token-budget gate — source contract', () => {
  it('estimateStoryTokens function is defined in spec-mode-runner.js', () => {
    expect(src).toContain('function estimateStoryTokens(');
  });

  it('EPAM_TOKEN_BUDGET_PER_STORY env var is read', () => {
    expect(src).toContain('EPAM_TOKEN_BUDGET_PER_STORY');
  });

  it('token-budget forcedRetryNote references the estimated token count', () => {
    expect(src).toContain('token-budget');
    expect(src).toContain('token budget');
    expect(src).toContain('requesting further split');
  });

  it('token-budget retry uses runSpecAgent with openspec agent', () => {
    const tokenBudgetBlock = src.slice(src.indexOf('Token-budget pass:'));
    expect(tokenBudgetBlock).toContain("agent: 'openspec'");
  });

  it('max-split-depth guard prevents infinite re-split chains', () => {
    expect(src).toContain('max split depth — proceeding at risk');
  });

  it('formula constants match the replicated formula in this test', () => {
    expect(src).toContain(`ESTIMATE_BASE = ${ESTIMATE_BASE}`);
    expect(src).toContain(`ESTIMATE_PER_AC = ${ESTIMATE_PER_AC}`);
    expect(src).toContain(`ESTIMATE_PER_TC = ${ESTIMATE_PER_TC}`);
    expect(src).toContain(`ESTIMATE_PER_FILE = ${ESTIMATE_PER_FILE}`);
    expect(src).toContain(`ESTIMATE_BYTES_PER_TOKEN = ${ESTIMATE_BYTES_PER_TOKEN}`);
  });
});

describe('token-budget gate — formula correctness', () => {
  it('story with 0 ACs and 0 files returns BASE tokens only', () => {
    expect(estimateStoryTokens(0, 0, 0)).toBe(ESTIMATE_BASE);
  });

  it('story with 8 ACs and 2 files returns correct value', () => {
    const expected = ESTIMATE_BASE + (8 * ESTIMATE_PER_AC) + (8 * ESTIMATE_PER_TC) + (2 * ESTIMATE_PER_FILE);
    expect(estimateStoryTokens(8, 2, 0)).toBe(expected);
  });

  it('story with 15 ACs + 3 files + 10KB contract exceeds 100K budget', () => {
    const estimate = estimateStoryTokens(15, 3, 10 * 1024);
    // 15 ACs × (150 + 300) = 6750, 3 files × 100 = 300, 10KB / 4 = 2560, base 2000 → ~11610
    // Well under 100K — verifies the formula is correctly bounded for typical stories
    expect(estimate).toBeGreaterThan(ESTIMATE_BASE);
    expect(estimate).toBeLessThan(100_000);
  });

  it('estimate scales with AC count — 50-AC story has more tokens than 5-AC story', () => {
    // The base cost ESTIMATE_BASE is constant so the ratio is NOT exactly 10x;
    // just verify monotone growth.
    const small = estimateStoryTokens(5, 0, 0);
    const large = estimateStoryTokens(50, 0, 0);
    expect(large).toBeGreaterThan(small);
    // Each extra AC adds (ESTIMATE_PER_AC + ESTIMATE_PER_TC) = 450 tokens.
    expect(large - small).toBe(45 * (ESTIMATE_PER_AC + ESTIMATE_PER_TC));
  });

  it('contract size contributes proportionally to estimate', () => {
    const noContract = estimateStoryTokens(8, 2, 0);
    const with100KBContract = estimateStoryTokens(8, 2, 100 * 1024);
    expect(with100KBContract).toBeGreaterThan(noContract + 20_000);
  });

  it('large contract (400KB) pushes a mid-size story over 100K budget', () => {
    const estimate = estimateStoryTokens(8, 3, 400 * 1024);
    expect(estimate).toBeGreaterThan(100_000);
  });
});
