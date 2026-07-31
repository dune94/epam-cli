/**
 * Speckit AC over-specification validator tests.
 *
 * Speckit's failure mode: it expands ACs with prescriptive HOW-to-implement
 * instructions rather than WHAT-the-code-should-do requirements. This causes
 * test stories to fail because the agent can't satisfy "use vi.mock() with
 * implementation returning { flights: [] }" — that's an implementation detail,
 * not a behaviour requirement.
 *
 * This file tests:
 *   1. validateAC() — detects over-specified ACs (mocks, imports, prescriptive verbs)
 *   2. validateSpeckitOutput() — validates a full speckit payload
 *   3. PRD high-AC-count check — stories > 12 ACs need split attention
 *   4. Speckit prompt guard — verifies the prompt instructs WHAT not HOW
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── AC validator ─────────────────────────────────────────────────────────────

const PRESCRIPTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /vi\.mock\s*\(/i,          reason: 'prescribes vi.mock() call' },
  { pattern: /vi\.spyOn\s*\(/i,         reason: 'prescribes vi.spyOn() call' },
  { pattern: /jest\.mock\s*\(/i,        reason: 'prescribes jest.mock() call' },
  { pattern: /jest\.fn\s*\(/i,          reason: 'prescribes jest.fn() call' },
  { pattern: /\.?mockReturnValue[\s(]/i,    reason: 'prescribes mock return value' },
  { pattern: /\.?mockResolvedValue[\s(]/i, reason: 'prescribes mock resolved value' },
  { pattern: /\.?mockImplementation[\s(]/i, reason: 'prescribes mock implementation' },
  { pattern: /import\s+\{[^}]+\}\s+from/i, reason: 'prescribes exact import statement' },
  { pattern: /require\s*\(\s*['"`]/i,   reason: 'prescribes require() call' },
  { pattern: /^use supertest/i,         reason: 'prescribes supertest usage' },
  { pattern: /^call\s+\w+\s*\(/i,       reason: 'prescribes exact function call' },
  { pattern: /^import\s+/i,             reason: 'prescribes import statement' },
];

function validateAC(ac: string): { valid: boolean; reason?: string } {
  const trimmed = ac.trim();
  for (const { pattern, reason } of PRESCRIPTIVE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { valid: false, reason };
    }
  }
  return { valid: true };
}

function validateSpeckitOutput(payload: { acceptanceCriteria?: string[] }): {
  valid: boolean;
  violations: Array<{ ac: string; reason: string }>;
} {
  const violations: Array<{ ac: string; reason: string }> = [];
  for (const ac of payload.acceptanceCriteria ?? []) {
    const result = validateAC(ac);
    if (!result.valid) {
      violations.push({ ac: ac.slice(0, 120), reason: result.reason! });
    }
  }
  return { valid: violations.length === 0, violations };
}

describe('validateAC — prescriptive pattern detection', () => {
  it('accepts a plain behaviour requirement', () => {
    expect(validateAC('Returns 404 when the flight route is not found').valid).toBe(true);
    expect(validateAC('Handles empty search results by displaying a "no flights" message').valid).toBe(true);
    expect(validateAC('GET /search returns JSON with a flights array').valid).toBe(true);
  });

  it('rejects vi.mock() prescription', () => {
    const result = validateAC('Use vi.mock("./client") to stub SkyscannerClient with empty flights array');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('vi.mock');
  });

  it('rejects vi.spyOn() prescription', () => {
    const result = validateAC('vi.spyOn(client, "searchFlights").mockResolvedValue([])');
    expect(result.valid).toBe(false);
  });

  it('rejects mockReturnValue prescription', () => {
    const result = validateAC('Configure the mock to .mockReturnValue({ data: [] })');
    expect(result.valid).toBe(false);
  });

  it('rejects import statement prescription', () => {
    const result = validateAC('import { renderTable } from "./table" must be used in cli.ts');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('import');
  });

  it('rejects supertest prescription', () => {
    const result = validateAC('Use supertest to make GET /search requests in tests');
    expect(result.valid).toBe(false);
  });

  it('rejects require() prescription', () => {
    const result = validateAC("Test calls require('./server') to load the module");
    expect(result.valid).toBe(false);
  });

  it('accepts test-related ACs that describe outcomes, not mocks', () => {
    expect(validateAC('Tests cover the happy path and error cases for GET /search').valid).toBe(true);
    expect(validateAC('All exported functions have at least one unit test').valid).toBe(true);
    expect(validateAC('Test suite exits 0 with no failures').valid).toBe(true);
  });
});

describe('validateSpeckitOutput — full payload validation', () => {
  it('clean payload with no violations passes', () => {
    const result = validateSpeckitOutput({
      acceptanceCriteria: [
        'renderTable returns a string',
        'Handles empty input array gracefully',
        'Column widths pad to the longest value in each column',
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('payload with mock prescriptions fails', () => {
    const result = validateSpeckitOutput({
      acceptanceCriteria: [
        'renderTable returns a string',
        'vi.mock("../client") stubs the SkyscannerClient',
        'Use mockReturnValue to return fixed flight data',
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(2);
  });

  it('returns all violations, not just the first', () => {
    const result = validateSpeckitOutput({
      acceptanceCriteria: [
        'vi.mock("a") is used',
        'vi.mock("b") is also used',
        'Good AC — returns 200',
        'import { x } from "./y" must appear',
      ],
    });
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });
});

// ─── PRD high-AC-count check ──────────────────────────────────────────────────

const PRD_PATH = join(__dirname, '../../../orchestrations/travel-app-prd.json');

interface Story {
  id: string;
  acceptanceCriteria?: string[];
  status?: string;
}

interface Prd {
  stories: Story[];
  implementationOrder: Record<string, string[]>;
}

const prd: Prd = JSON.parse(readFileSync(PRD_PATH, 'utf8'));
const activeIds = new Set(Object.values(prd.implementationOrder).flat());
const activeStories = prd.stories.filter((s) => activeIds.has(s.id));

describe('PRD high-AC-count stories (split candidates)', () => {
  it('no active story has more than 24 ACs without being a known high-volume story', () => {
    const HARD_LIMIT = 24;
    const over = activeStories.filter(
      (s) => (s.acceptanceCriteria?.length ?? 0) > HARD_LIMIT
    );
    if (over.length > 0) {
      const summary = over.map((s) => `${s.id}:${s.acceptanceCriteria?.length}`).join(', ');
      throw new Error(`Stories exceed ${HARD_LIMIT} ACs (extreme — must split): ${summary}`);
    }
    expect(over).toHaveLength(0);
  });

  it('stories with >12 ACs are flagged as split candidates (informational)', () => {
    const SPLIT_THRESHOLD = 12;
    const candidates = activeStories.filter(
      (s) => (s.acceptanceCriteria?.length ?? 0) > SPLIT_THRESHOLD
    );
    if (candidates.length > 0) {
      console.warn(
        `[WARN] ${candidates.length} story/stories exceed ${SPLIT_THRESHOLD} ACs and are split candidates:`,
        candidates.map((s) => `${s.id}(${s.acceptanceCriteria?.length})`).join(', ')
      );
    }
    // Non-blocking: speckit is responsible for splitting at runtime
    // This test documents the candidates without failing
    expect(typeof candidates.length).toBe('number');
  });
});

// ─── Speckit prompt guard ─────────────────────────────────────────────────────

describe('speckit prompt — describes WHAT not HOW', () => {
  const src = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'),
    'utf8'
  );
  const speckitFnStart = src.indexOf('async function runSpeckitReview');
  // Full agent audit, 2026-07-31: runSpeckitReview's prompt is now a
  // refineExistingChildren ternary (two prompt variants), pushing the
  // post-prompt processing code (stripPrescriptiveACs etc.) further from
  // the function start than before.
  const speckitSection = src.slice(speckitFnStart, speckitFnStart + 8000);

  it('speckit prompt has an explicit WHAT-NOT-HOW rule heading', () => {
    expect(speckitSection).toContain('WHAT-NOT-HOW');
  });

  it('speckit prompt references observable outcome requirement', () => {
    expect(speckitSection).toContain('OBSERVABLE OUTCOME');
  });

  it('speckit prompt instructs model to REPLACE prescriptive ACs', () => {
    expect(speckitSection).toContain('REPLACE');
  });

  // Behavior change (2026-07-13, following a live split-collision on SKY-002
  // and SKY-003): speckit no longer has independent split authority.
  // openspec is the sole split decision-maker; checkSplitMandateViolation's
  // deterministic forced-retry on openspec (unchanged) is the real backstop
  // if it misses a mandatory split, not speckit's own prose "independent
  // obligation" — see speckit-no-independent-split.test.ts for the full
  // fix and live-collision reproduction.
  it('speckit prompt no longer claims independent split authority', () => {
    expect(speckitSection).not.toContain('MANDATORY split conditions');
    expect(speckitSection).toContain("Splitting is openspec's decision alone");
  });

  it('runtime validator function stripPrescriptiveACs is defined in spec-mode-runner.js', () => {
    expect(src).toContain('function stripPrescriptiveACs');
  });

  it('stripPrescriptiveACs is called on speckit payload output', () => {
    // Validator must be wired into the speckit return path, not just defined
    expect(speckitSection).toContain('stripPrescriptiveACs(payload.acceptanceCriteria');
  });
});
