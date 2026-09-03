/**
 * A GATE THAT OVER-GATES IS WORSE THAN NO GATE.
 *
 * dependency-scan reports an installed-but-undeclared import when "THIS story touched the file
 * importing it". Touching a FILE is not introducing an IMPORT. A one-line edit to a file that has
 * carried an undeclared import since before the run makes that pre-existing debt the story's
 * problem, and the writer cannot fix it without editing outside its scope.
 *
 * Live 2026-09-02, AMSD-1919. The writer made exactly the prescribed change:
 *
 *   - if (email && value && value !== email) {
 *   + if (email && value && value.toLowerCase() !== email.toLowerCase()) {
 *
 * CheckoutForm.tsx has imported rc-tooltip since before v1.5, and rc-tooltip is declared in no
 * package.json — in FOUR files across the repo, none of them ours. The gate blamed the one-line
 * edit, the writer "fixed" it by adding rc-tooltip to package.json (scope creep the reviewer should
 * refuse), the scan still failed, and it burned retry after retry out of twelve against something
 * it should never have been asked to fix.
 *
 * The gate's own comment already states the right principle — "otherwise it is pre-existing estate
 * condition, and reporting it every run buries the finding that matters" — and then implements a
 * test that cannot tell the two apart. A file-level test answers "was this file edited"; the
 * question is "did this change add this import".
 *
 * SO THE TEST BECOMES THE DIFF. An import is the story's responsibility when the change ADDED it.
 * Everything else in a touched file is estate condition, reported by an estate sweep if it is
 * reported at all — not by a gate that can block a correct fix.
 *
 * WHAT MUST NOT BE LOST: an agent importing a package it never declared is exactly the case worth
 * catching, and it stays caught — that import appears on an added line.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll } from 'vitest';

const REPO = process.cwd();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require(join(REPO, 'orchestrations/plugins/dependency-scan-plugin.js'));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

/** A repo whose touched file carries a pre-existing undeclared import. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'depscan-')); dirs.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules/rc-tooltip'), { recursive: true });
  writeFileSync(join(root, 'node_modules/rc-tooltip/package.json'), '{"name":"rc-tooltip","version":"5.3.1"}');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { react: '^18.2.0' } }));
  // THE DECLARATION THE SCANNER ACTUALLY READS. It is not env vars: readScanManifest looks for
  // dependency-check.json and refuses to guess when a key is absent. The first version of this
  // fixture passed env vars, the scan returned status:"unknown", and the "not reported" assertions
  // passed while nothing had been scanned at all.
  mkdirSync(join(root, '.epam'), { recursive: true });
  writeFileSync(join(root, '.epam/dependency-check.json'), JSON.stringify({
    manifestFile: 'package.json',
    manifestKeys: ['dependencies', 'devDependencies'],
    scanFileExtensions: ['.ts', '.tsx', '.js', '.jsx'],
    importPattern: "from\\s+['\"]([^./][^'\"]*)['\"]|require\\(\\s*['\"]([^./][^'\"]*)['\"]\\s*\\)",
    vendorDirs: ['node_modules'],
    ignorePackages: ['react'],
  }));
  // rc-tooltip imported but NOT declared — exactly the metrolinx condition.
  writeFileSync(join(root, 'src/CheckoutForm.tsx'),
    'import Tooltip from "rc-tooltip";\nimport React from "react";\nexport const F = () => null;\n');
  return root;
}

const ENV = { ...process.env };

describe('the dependency gate judges the change, not the file', () => {
  it('the plugin is callable and the fixture reproduces the condition', () => {
    expect(typeof plugin.scanImports, 'scanImports is not exported').toBe('function');
    const root = fixture();
    // With the file named as touched AND the import treated as introduced, it must be found —
    // otherwise the assertions below pass because the scanner sees nothing at all.
    const r = plugin.scanImports(root, ENV, {
      changedFiles: ['src/CheckoutForm.tsx'],
      introducedLines: ['+import Tooltip from "rc-tooltip";'],
    });
    expect(r.status, `scan did not run: ${r.reason || ''}`).not.toBe('unknown');
    expect((r.findings || []).some((f: any) => f.specifier === 'rc-tooltip'),
      'the scanner cannot see the undeclared import at all').toBe(true);
  });

  it('A PRE-EXISTING UNDECLARED IMPORT IN A TOUCHED FILE IS NOT REPORTED', () => {
    const root = fixture();
    const r = plugin.scanImports(root, ENV, {
      changedFiles: ['src/CheckoutForm.tsx'],   // the story edited this file
      introducedLines: [],                  // but added no import
    });
    const bad = (r.findings || []).filter((f: any) => f.verdict === 'installed_undeclared');
    expect(bad.map((f: any) => f.specifier),
      'the gate blamed a one-line edit for an import the file already had — this is what blocked '
      + 'AMSD-1919 and cannot be fixed without editing outside the story')
      .toEqual([]);
  });

  it('AN IMPORT THE CHANGE ADDED IS STILL CAUGHT — the case worth catching', () => {
    const root = fixture();
    const r = plugin.scanImports(root, ENV, {
      changedFiles: ['src/CheckoutForm.tsx'],
      introducedLines: ['+import Tooltip from "rc-tooltip";'],      // the change added this import
    });
    expect((r.findings || []).some((f: any) => f.specifier === 'rc-tooltip' && f.verdict === 'installed_undeclared'),
      'an agent importing a package it never declared is no longer caught — the whole point of the gate')
      .toBe(true);
  });

  it('AN UNTOUCHED FILE IS STILL SILENT', () => {
    const root = fixture();
    const r = plugin.scanImports(root, ENV, { changedFiles: [], introducedSpecifiers: [] });
    expect((r.findings || []).filter((f: any) => f.verdict === 'installed_undeclared'),
      'estate condition in an untouched file is being reported').toEqual([]);
  });

  it('THE CALLER SUPPLIES IT — an unwired option leaves the gate silently inert', () => {
    // A plugin option no caller passes is worse than the bug it replaced: the gate reports nothing
    // and looks like a clean scan. claude.sh must hand over the ADDED LINES of the diff.
    const sh = readFileSync(join(REPO, 'orchestrations/scripts/claude.sh'), 'utf8');
    expect(sh, 'claude.sh does not pass introducedLines, so the dependency gate is inert')
      .toMatch(/introducedLines/);
    // AND IT MUST NOT CARRY ITS OWN IMPORT PATTERN. dependency-check.json declares importPattern
    // and the plugin compiles it (dependency-scan-plugin.js:336). A second copy in the caller is a
    // project fact living outside config or a plugin — forbidden, and it would drift.
    // Precisely: the caller must not compile the project's import pattern itself. An earlier
    // version of this assertion used a broad regex over a 4,000-char window and matched unrelated
    // prose — a test failing on its own sloppiness rather than on the code.
    const at = sh.indexOf('EPAM_SCAN_ADDED_LINES');
    const callBlock = sh.slice(Math.max(0, at - 1200), at + 1200)
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');   // comments explain, they do not execute
    expect(callBlock, 'the caller compiles importPattern itself — the pattern belongs to the plugin')
      .not.toMatch(/importPattern|new RegExp/);
  });

  it('NO INTRODUCED-SET SUPPLIED = REPORT NOTHING ON THAT BASIS', () => {
    // Same stance the file-level check already takes: "we cannot tell what changed" must not
    // manufacture findings. A caller that cannot compute the diff must not turn the gate into a
    // whole-repo audit that blocks every story.
    const root = fixture();
    const r = plugin.scanImports(root, ENV, { changedFiles: ['src/CheckoutForm.tsx'] });
    expect((r.findings || []).filter((f: any) => f.verdict === 'installed_undeclared'),
      'with no introduced-set the gate fell back to blaming the touched file')
      .toEqual([]);
  });
});
