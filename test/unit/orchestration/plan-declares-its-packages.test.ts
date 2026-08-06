/**
 * A PLAN THAT NEEDS A PACKAGE MUST SAY SO, AND THE PIPELINE MUST CHECK IT.
 *
 * The detective's contract already has a field that exists purely to be machine-verified:
 *
 *   "The 'helper' field must be the BARE SYMBOL NAME of the existing function you are
 *    telling the implementer to reuse (so it can be machine-verified to actually exist)"
 *   "SHOW THE BROKEN CODE — 'brokenLine' is REQUIRED and is machine-verified... if what
 *    you quote is not in the file, your answer is rejected as ungrounded"
 *
 * That is the established pattern: the plan states a checkable fact, and the pipeline
 * checks it rather than trusting the narrative. `requiredPackages` is the same idea for
 * the fact that decided four AMSD-2041 runs — the prescribed fix needed
 * @contentstack/live-preview-utils, which no codeline declares, and that requirement
 * existed only as prose inside `fix`/`reason` on 2 of 3 lanes. Nothing could check it, so
 * the writer discovered it mid-turn and faked a workaround.
 *
 * The check is deterministic and reads NOTHING hardcoded: package names come from the
 * plan, and availability comes from the project's own dependency-check.json
 * (manifestFile / manifestKeys / vendorDirs). It sits beside checkFixSiteCoverage, which
 * already flags a structurally-incomplete prescription the same way.
 *
 * ONE implementation: the pipeline check and the dependency_available agent tool share the
 * same pure function, so the answer an agent gets and the answer the gate computes cannot
 * drift apart.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const SPEC_RUNNER = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const plugin = require('../../../orchestrations/plugins/dependency-contract-tools.js');

function codeline(declared: Record<string, string>, installed: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'plan-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'c', dependencies: declared }));
  for (const p of installed) {
    mkdirSync(join(root, 'node_modules', ...p.split('/')), { recursive: true });
  }
  mkdirSync(join(root, '.epam'), { recursive: true });
  writeFileSync(
    join(root, '.epam/dependency-check.json'),
    JSON.stringify({
      manifestFile: 'package.json',
      manifestKeys: ['dependencies'],
      vendorDirs: ['node_modules'],
    }),
  );
  return root;
}

describe('the availability check is ONE shared implementation', () => {
  it('the plugin exports a pure function the pipeline can call directly', () => {
    expect(
      typeof plugin.checkPackageAvailability,
      'the agent tool and the pipeline gate must compute availability the same way — two ' +
        'implementations of "is this package usable" is how the answer an agent sees and ' +
        'the answer a gate enforces drift apart',
    ).toBe('function');
  });

  it('the function answers without any agent or tool plumbing', () => {
    const root = codeline({ good: '^1.0.0' }, ['good', 'ghost']);
    const r = plugin.checkPackageAvailability(root, ['good', 'ghost', 'nowhere']);
    const verdict = (p: string) =>
      r.results.find((x: { package: string }) => x.package === p)?.verdict;
    expect(verdict('good')).toBe('available');
    expect(verdict('ghost')).toBe('installed_undeclared');
    expect(verdict('nowhere')).toBe('absent');
  });

  it('THE AMSD-2041 SHAPE: a plan naming an absent package is not implementable', () => {
    const root = codeline({ 'installed-sdk': '^1.0.0' }, ['installed-sdk']);
    const r = plugin.checkPackageAvailability(root, ['missing-sdk']);
    expect(r.unavailable, 'the caller needs a single boolean to gate on, not a scan').toEqual([
      expect.objectContaining({ package: 'missing-sdk', verdict: 'absent' }),
    ]);
    expect(r.allAvailable).toBe(false);
  });

  it('a plan needing nothing is trivially satisfiable', () => {
    const root = codeline({}, []);
    const r = plugin.checkPackageAvailability(root, []);
    expect(r.allAvailable).toBe(true);
    expect(r.unavailable).toEqual([]);
  });
});

describe('the detective is required to declare the packages its fix needs', () => {
  const src = readFileSync(SPEC_RUNNER, 'utf8');

  it('requiredPackages is in the output contract', () => {
    expect(
      src,
      'the requirement lived only in the prose of `fix`/`reason`, which is why nothing ' +
        'could check it. It joins `helper` and `brokenLine` as a declared, checkable fact.',
    ).toMatch(/requiredPackages/);
  });

  it('the contract explains it is machine-verified, as it does for helper', () => {
    const i = src.indexOf('requiredPackages');
    const block = src.slice(Math.max(0, i - 1200), i + 1200);
    expect(
      block,
      'an unexplained field gets filled in carelessly; `helper` and `brokenLine` both say ' +
        'outright that they are verified, which is why they are trustworthy',
    ).toMatch(/machine-verified|verified|checked/i);
  });
});

describe('the spec pass checks the declaration deterministically', () => {
  const src = readFileSync(SPEC_RUNNER, 'utf8');

  it('runs the availability check beside the existing coverage check', () => {
    // lastIndexOf, not indexOf: fixed 2026-08-05, a SECOND, textually-earlier call site
    // (Step 4's bounded corrective re-invocation of the detective on a reviewer-flagged
    // plan/execution mismatch) now shares this exact call text. The canonical site this
    // test targets — immediately following the detective's own findings assignment — is
    // still the LAST occurrence in the file.
    const i = src.lastIndexOf('story.fixSiteAnalysisCoverage = checkFixSiteCoverage');
    expect(i, 'the coverage check moved').toBeGreaterThan(-1);
    const block = src.slice(i, i + 2500);
    expect(
      block,
      'checkFixSiteCoverage already flags a structurally-incomplete plan at exactly this ' +
        'point; a plan requiring a package the codeline does not have is incomplete in the ' +
        'same way and belongs in the same place',
    ).toMatch(/checkPackageAvailability|requiredPackagesCheck/);
  });

  it('records the verdict on the story so a gate can act on it', () => {
    expect(
      src,
      'a warning alone is not actionable — the coverage check writes ' +
        'story.fixSiteAnalysisCoverage for downstream consumers, and this must do the same',
    ).toMatch(/story\.requiredPackagesCheck\s*=/);
  });

  it('warns loudly when the plan cannot be implemented as written', () => {
    const i = src.indexOf('story.requiredPackagesCheck');
    const block = src.slice(Math.max(0, i - 500), i + 2000);
    expect(block).toMatch(/console\.warn/);
  });
});
