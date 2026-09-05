/**
 * THE CALIBRATION SCAN COUNTS TESTS, NOT WHATEVER HAPPENS TO BE ON DISK.
 *
 * scan-uncalibrated-guards.js answers "did anybody write a test that names this blocking
 * function?" by reading every .ts/.js/.sh/.bats file under test/ into one string and asking
 * whether the guard's name appears in it. Two things made that answer wrong, both found
 * 2026-09-05 when the source repo passed pre-flight and the install packaged FROM it failed:
 *
 *   corpus in the checkout : 39,612,695 bytes
 *   corpus in the install  : 11,067,202 bytes
 *
 * The walk never skipped node_modules. So the corpus included every dependency's source, and
 * `_body` counted as calibrated because TypeScript's own diagnostics contain
 * "A_return_statement_can_only_be_used_within_a_function_body". A ratchet whose number depends
 * on whether someone has run `npm install` cannot ratchet — and it under-reported, which is the
 * dangerous direction for a check that exists to catch guards nobody has tested.
 *
 * The second defect is in the match itself: a plain substring made `_body` satisfiable by any
 * identifier ending in it, in the test suite too. The bar is deliberately weak — a MENTION, not a
 * good test — but it must be a mention of this function.
 *
 * Correcting both raised the honest count from a reported 29 to 32. That is not a loosened gate:
 * three guards were always uncalibrated and the scan could not see it.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCANNER = join(__dirname,
  '../../../orchestrations/scripts/lib/handlers/scan-uncalibrated-guards.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { scan, testCorpus, corpusNames } = require(SCANNER);

/** A tree shaped like the real one: one blocking guard, and a test dir we control. */
function tree(opts: { testFiles?: Record<string, string>; vendorFiles?: Record<string, string> }) {
  const root = mkdtempSync(join(tmpdir(), 'calib-'));
  mkdirSync(join(root, 'orchestrations/scripts'), { recursive: true });
  writeFileSync(join(root, 'orchestrations/scripts/thing.sh'),
    ['#!/usr/bin/env bash', 'my_guard() {', '    [ -f x ] || return 1', '    return 0', '}'].join('\n'));
  for (const [rel, body] of Object.entries(opts.testFiles || {})) {
    mkdirSync(join(root, 'test/unit', rel, '..'), { recursive: true });
    writeFileSync(join(root, 'test/unit', rel), body);
  }
  for (const [rel, body] of Object.entries(opts.vendorFiles || {})) {
    mkdirSync(join(root, 'test/unit/node_modules', rel, '..'), { recursive: true });
    writeFileSync(join(root, 'test/unit/node_modules', rel), body);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const uncoveredNames = (root: string) =>
  scan(root).uncovered.map((g: { name: string }) => g.name);

describe('what the corpus is allowed to contain', () => {
  it('a guard named ONLY by vendored code is NOT calibrated', () => {
    const t = tree({ vendorFiles: { 'dep.js': 'const my_guard = 1;' } });
    try {
      expect(uncoveredNames(t.root), [
        'a dependency mentioning the name counted as a test of it. That is how `_body` passed —',
        'TypeScript diagnostics contain "..._within_a_function_body" — and it makes the count',
        'depend on whether node_modules is installed.',
      ].join('\n')).toContain('my_guard');
    } finally { t.cleanup(); }
  });

  it('a guard named by a REAL test IS calibrated — the check still works', () => {
    // The other end: over-correcting here would report every guard as uncalibrated forever.
    const t = tree({ testFiles: { 'a.test.ts': 'it("runs my_guard", () => {});' } });
    try {
      expect(uncoveredNames(t.root),
        'a genuine test naming the guard was ignored, so the scan now reports everything')
        .not.toContain('my_guard');
    } finally { t.cleanup(); }
  });

  it('the corpus excludes node_modules entirely, not just at the top level', () => {
    const t = tree({
      testFiles: { 'a.test.ts': 'nothing here' },
      vendorFiles: { 'deep/inner.js': 'UNIQUE_VENDOR_TOKEN' },
    });
    try {
      expect(testCorpus(t.root).includes('UNIQUE_VENDOR_TOKEN'),
        'vendored source nested below test/ still reached the corpus').toBe(false);
      expect(testCorpus(t.root).includes('nothing here'),
        'the real test file was dropped along with the vendor code').toBe(true);
    } finally { t.cleanup(); }
  });

  it('dot directories are skipped too — build caches are not tests', () => {
    const t = tree({ testFiles: { 'a.test.ts': 'real' } });
    try {
      mkdirSync(join(t.root, 'test/unit/.cache'), { recursive: true });
      writeFileSync(join(t.root, 'test/unit/.cache/x.js'), 'CACHED_TOKEN');
      expect(testCorpus(t.root).includes('CACHED_TOKEN')).toBe(false);
    } finally { t.cleanup(); }
  });
});

describe('the match is a name, not a fragment', () => {
  it('a longer identifier ENDING in the guard name does not calibrate it', () => {
    const t = tree({ testFiles: { 'a.test.ts': 'function_body_helper()' } });
    try {
      expect(uncoveredNames(tree({}).root)).toBeDefined();   // sanity: scan runs
      expect(scan(t.root).uncovered.map((g: { name: string }) => g.name))
        .toContain('my_guard');
    } finally { t.cleanup(); }
  });

  it.each([
    ['my_guard', 'calls my_guard() here', true],
    ['my_guard', 'expect(my_guard).toBe', true],
    ['my_guard', 'run_my_guard_variant', false],
    ['my_guard', 'xxmy_guardxx', false],
    // The real case, with the name spelled via concatenation ON PURPOSE. Written literally, this
    // file would itself become the "test" that calibrates the guard called that in
    // agent-attempt-analyst.sh — a mention here is not a test of it, and the count would drop by
    // one for no reason. Exactly the false calibration this file exists to close.
    ['_' + 'body', 'A_return_statement_within_a_function_body', false],
  ])('corpusNames(%s) in %j -> %s', (name, corpus, expected) => {
    expect(corpusNames(corpus, name)).toBe(expected);
  });

  it('a regex-special character in a guard name cannot break the match', () => {
    // Guard names are [a-zA-Z0-9_] by the scanner's own pattern, but the escape must hold anyway:
    // an unescaped name would throw and take the whole pre-flight check down.
    expect(() => corpusNames('anything', 'a.b*c')).not.toThrow();
    expect(corpusNames('a.b*c', 'a.b*c')).toBe(true);
    expect(corpusNames('axbxc', 'a.b*c'),
      'the name was treated as a regex, so unrelated text matched it').toBe(false);
  });
});

describe('the answer does not depend on the environment', () => {
  it('an empty corpus reports every guard rather than none', () => {
    // corpus === '' is falsy, and the original code already handled this. Asserted because the
    // node_modules fix shrinks the corpus, and a bug that emptied it would otherwise read as
    // "everything is calibrated" — silently disabling the check.
    const t = tree({});
    try {
      expect(uncoveredNames(t.root),
        'with no tests at all the scan reported nothing uncalibrated')
        .toContain('my_guard');
    } finally { t.cleanup(); }
  });
});
