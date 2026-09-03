/**
 * The implementation-fidelity fixes (2026-07-23, AMSD-1820 wrong-fix follow-up):
 * the detective must PRESCRIBE a specific minimal fix (naming existing helpers to
 * reuse), that fix must flow through to the implementer, and the engineer/review/
 * detective profiles must all push "minimal change + reuse existing functions
 * over novel code."
 *
 * Source-contract assertions on spec-mode-runner.js's detective wiring plus the
 * real profile strings in profiles.json / profiles.json.original.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const specSrc = readFileSync(join(ROOT, 'orchestrations/scripts/spec-mode-runner.js'), 'utf8');
const profiles = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/profiles.json'), 'utf8'));
const profilesOrig = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/profiles.json.original'), 'utf8'));

describe('code-graph-detective — prescribes a minimal fix + existing helpers', () => {
  it('prompt requires a mandatory "fix" field in the output schema', () => {
    expect(specSrc).toMatch(/"fix":"<the exact minimal change/);
    expect(specSrc).toMatch(/PRESCRIBE THE MINIMAL FIX/);
  });

  it('prompt tells the detective to locate an EXISTING helper instead of new logic', () => {
    expect(specSrc).toMatch(/LOCATE AN EXISTING HELPER/);
    expect(specSrc).toMatch(/Writing novel code when a helper already exists is a defect/);
  });

  it('parses the fix field off each finding', () => {
    expect(specSrc).toMatch(/fix: typeof h\.fix === 'string' \? h\.fix : ''/);
  });

  it('carries fix through the locationHint merge', () => {
    expect(specSrc).toMatch(/reason: finding\.reason, fix: finding\.fix/);
  });
});

describe('profiles push minimal-change + reuse-existing-functions (both files in sync)', () => {
  for (const [name, store] of [['profiles.json', profiles], ['profiles.json.original', profilesOrig]] as const) {
    it(`${name}: code-graph-detective prescribes the minimal fix and existing helper to reuse`, () => {
      expect(store['code-graph-detective']).toMatch(/PRESCRIBE THE MINIMAL FIX/);
      expect(store['code-graph-detective']).toMatch(/EXISTING helper/i);
      expect(store['code-graph-detective']).toMatch(/Fewer lines of code is always better/);
    });

    it(`${name}: typescript-engineer requires reusing existing functions over new code`, () => {
      expect(store['typescript-engineer']).toMatch(/MINIMAL CHANGE & REUSE/);
      expect(store['typescript-engineer']).toMatch(/reuse it by importing it/);
      expect(store['typescript-engineer']).toMatch(/fewer lines of code is always better/i);
    });

    it(`${name}: review-agent rejects over-engineered / non-reuse changes`, () => {
      expect(store['review-agent']).toMatch(/CONCISION & REUSE/);
      expect(store['review-agent']).toMatch(/more concise change \(fewer lines\)/);
      expect(store['review-agent']).toMatch(/Do NOT approve an over-engineered fix/);
    });
  }
});
