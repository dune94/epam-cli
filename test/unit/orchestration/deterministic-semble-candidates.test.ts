/**
 * getDeterministicCandidateFiles() — REAL execution of the actual,
 * unmodified exported function, using the real `semble` binary against a
 * real fixture repo.
 *
 * Built 2026-07-23 after confirming (via direct manual `semble search`
 * against the real Metrolinx azure.commerce.cdts repo) that Semble itself
 * reliably surfaces the correct fix-site file in its top 1-2 results across
 * multiple different real AC wordings for the identical story — but the
 * openspec MODEL's own selection of what to report as locationHint varied
 * run to run despite EPAM_TEMPERATURE=0 (a known characteristic of many
 * hosted inference backends, not an epam-cli bug). This closes the gap by
 * injecting the top-N search candidates directly and unconditionally,
 * removing the model's discretion from a step that doesn't need judgment —
 * the model's own locationHint still adds anything beyond the top-N.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const specModeRunner = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { getDeterministicCandidateFiles } = specModeRunner;

function sembleAvailable(): boolean {
  try { execSync('command -v semble', { stdio: 'ignore' }); return true; } catch { return false; }
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.SEMBLE_ENABLED;
  delete process.env.EPAM_BROWNFIELD;
  delete process.env.PROJECT_ROOT;
});

function makeFixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'semble-candidates-'));
  cleanupDirs.push(repo);
  mkdirSync(join(repo, 'src', 'services'), { recursive: true });
  writeFileSync(
    join(repo, 'src', 'services', 'apply-report-discounts.service.ts'),
    `export function applyReportDiscountsService(dispatches: any[], lineItems: any[]) {
  // matches discount.lineItemId against lineItem.id — return-trip line
  // items carry a "#return" suffix that never matches here.
  return dispatches;
}\n`,
  );
  writeFileSync(
    join(repo, 'src', 'services', 'unrelated-shipping.service.ts'),
    `export function calculateShippingCost(order: any) { return 0; }\n`,
  );
  return repo;
}

describe('getDeterministicCandidateFiles (real semble binary, real fixture)', () => {
  it('returns [] when SEMBLE_ENABLED is not set', () => {
    if (!sembleAvailable()) return;
    const repo = makeFixtureRepo();
    process.env.EPAM_BROWNFIELD = '1';
    process.env.PROJECT_ROOT = repo;
    delete process.env.SEMBLE_ENABLED;
    const story = { title: 'Promo code discount amount not displayed for return trip tickets', acceptanceCriteria: [] };
    expect(getDeterministicCandidateFiles(story)).toEqual([]);
  });

  it('returns [] when EPAM_BROWNFIELD is not set (greenfield)', () => {
    if (!sembleAvailable()) return;
    const repo = makeFixtureRepo();
    process.env.SEMBLE_ENABLED = '1';
    process.env.PROJECT_ROOT = repo;
    delete process.env.EPAM_BROWNFIELD;
    const story = { title: 'Promo code discount amount not displayed for return trip tickets', acceptanceCriteria: [] };
    expect(getDeterministicCandidateFiles(story)).toEqual([]);
  });

  it('surfaces the real fix-site file for a real, non-trivial story title', () => {
    if (!sembleAvailable()) return;
    const repo = makeFixtureRepo();
    process.env.SEMBLE_ENABLED = '1';
    process.env.EPAM_BROWNFIELD = '1';
    process.env.PROJECT_ROOT = repo;
    const story = {
      title: 'Promo code discount amount not displayed for return trip tickets in email confirmation',
      acceptanceCriteria: [
        'The discount amount must be displayed for return trip dispatches.',
        'The return-trip line item discount matching must work correctly.',
      ],
    };
    const files = getDeterministicCandidateFiles(story, 3);
    expect(files.some((f: string) => f.includes('apply-report-discounts.service.ts'))).toBe(true);
  });

  it('respects the topN cap', () => {
    if (!sembleAvailable()) return;
    const repo = makeFixtureRepo();
    process.env.SEMBLE_ENABLED = '1';
    process.env.EPAM_BROWNFIELD = '1';
    process.env.PROJECT_ROOT = repo;
    const story = { title: 'Promo code discount amount not displayed for return trip tickets', acceptanceCriteria: [] };
    const files = getDeterministicCandidateFiles(story, 1);
    expect(files.length).toBeLessThanOrEqual(1);
  });

  it('ranking is STABLE across topN values: topN=1 returns the prefix of topN=3 (the -k instability fix)', () => {
    if (!sembleAvailable()) return;
    const repo = makeFixtureRepo();
    process.env.SEMBLE_ENABLED = '1';
    process.env.EPAM_BROWNFIELD = '1';
    process.env.PROJECT_ROOT = repo;
    const story = {
      title: 'Promo code discount amount not displayed for return trip tickets in email confirmation',
      acceptanceCriteria: ['The discount amount must be displayed for return trip dispatches.'],
    };
    // Before the fix, topN was passed straight to Semble's own -k limit, and
    // Semble's ranking is NOT stable across -k values — so top-1 could return
    // a DIFFERENT file than the head of top-3. The fix queries a fixed k=8 and
    // slices in JS, guaranteeing top-1 is exactly the first element of top-3.
    const top1 = getDeterministicCandidateFiles(story, 1);
    const top3 = getDeterministicCandidateFiles(story, 3);
    expect(top3.slice(0, 1)).toEqual(top1);
  });

  it('returns deduplicated, real repo-relative-ish paths (no empty/undefined entries)', () => {
    if (!sembleAvailable()) return;
    const repo = makeFixtureRepo();
    process.env.SEMBLE_ENABLED = '1';
    process.env.EPAM_BROWNFIELD = '1';
    process.env.PROJECT_ROOT = repo;
    const story = { title: 'Promo code discount amount not displayed for return trip tickets', acceptanceCriteria: [] };
    const files = getDeterministicCandidateFiles(story, 5);
    expect(new Set(files).size).toBe(files.length);
    expect(files.every((f: string) => typeof f === 'string' && f.length > 0)).toBe(true);
  });
});
