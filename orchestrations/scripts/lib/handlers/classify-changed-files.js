#!/usr/bin/env node
/**
 * classify-changed-files.js — WHICH OF THESE CHANGED FILES IS A TEST, asked of the project.
 *
 * brownfield-repro-test-gate.sh and brownfield-repro-test-writer.sh each carried their own copy:
 *
 *     the four-glob case statement matching .test. / .spec. / a __tests__ dir / _test.
 *
 * Three faults. Stack filenames hardcoded in engine code, which is not permitted. Two copies that
 * drift, so the writer can produce a file the gate refuses — exactly the shape of the AMSD-1919
 * failure, where writer and stage disagreed over .spec.ts vs .spec.tsx and a fix shipped untested.
 * And a declaration that already existed and was ignored: .epam/verification.json test.testFilePattern,
 * read by verification-plugin.js isTestFile().
 *
 * The declared pattern is also STRICTER, deliberately: a file inside __tests__/ that is not named
 * .spec/.test — a fixture, a mock like __tests__/content.mock.ts — no longer satisfies "this change
 * ships a test". Under the old globs it did, which let a mock stand in for a reproduction.
 *
 *   node classify-changed-files.js <projectRoot>       # paths on stdin, one per line
 *
 * stdout  "TEST\t<path>" or "FIX\t<path>", input order preserved
 * exit 0  the project declares a convention and every path was judged
 * exit 1  no convention declared — the caller must FAIL rather than guess one
 */
'use strict';
const fs = require('fs');
const path = require('path');

function main() {
  const root = process.argv[2];
  if (!root) {
    process.stderr.write('[classify-changed-files] usage: <projectRoot>  (paths on stdin)\n');
    return 2;
  }
  let plugin;
  try {
    plugin = require(path.join(__dirname, '..', '..', '..', 'plugins', 'verification-plugin.js'));
  } catch (e) {
    process.stderr.write(`[classify-changed-files] verification plugin unavailable: ${e.message}\n`);
    return 1;
  }
  const paths = fs.readFileSync(0, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);

  // THE CODELINE SPEAKS FIRST, ITS ECOSYSTEM SECOND. isTestFile returns null — not false — when
  // the project declares nothing, and null must never read as "not a test": that is how a gate
  // reports a pass having checked nothing.
  //
  // A codeline with no .epam/verification.json is the NORMAL case, not an error, so falling
  // straight to a refusal would disable this gate on most repositories. The second authority is the
  // ecosystem the repository actually carries — its provider file declares
  // codelineManifests.contractGeneration.testFilePattern — which is still runtime-injected and
  // still names no stack here. Same chain as lib/handlers/testable-source.js.
  let decide = (rel) => plugin.isTestFile(root, rel);
  if (plugin.isTestFile(root, 'probe.spec.ts') === null) {
    let pattern = '';
    try {
      const { allManifests } = require(path.join(__dirname, '..', 'ecosystem-registry.js'));
      for (const eco of allManifests()) {
        const present = [eco.file, ...(Array.isArray(eco.alsoMatches) ? eco.alsoMatches : [])]
          .some((n) => { try { return fs.existsSync(path.join(root, n)); } catch { return false; } });
        if (!present) continue;
        const p2 = ((eco.codelineManifests || {}).contractGeneration || {}).testFilePattern;
        if (typeof p2 === 'string' && p2) { pattern = p2; break; }
      }
    } catch { /* fall through to the refusal below */ }
    // THIRD AUTHORITY: WHAT ANY KNOWN ECOSYSTEM CALLS A TEST.
    //
    // A repository can carry no .epam/ declaration AND no manifest any provider recognises — a bare
    // checkout, a fixture, a repo whose build lives elsewhere. Stopping here made the writer and the
    // gate fail outright on such a repo, where the globs they replaced had worked: a capability
    // lost to a stricter rule, which is not a fix. The union of what the PROVIDERS declare is still
    // runtime-injected and still names no stack here. Deliberately last: the codeline speaks first,
    // its ecosystem second, and only a repository that answers neither falls back to this.
    if (!pattern) {
      try {
        const { allManifests } = require(path.join(__dirname, '..', 'ecosystem-registry.js'));
        const seen = [];
        for (const eco of allManifests()) {
          const p3 = ((eco.codelineManifests || {}).contractGeneration || {}).testFilePattern;
          if (typeof p3 === 'string' && p3 && !seen.includes(p3)) seen.push(p3);
        }
        if (seen.length) pattern = seen.length === 1 ? seen[0] : `(?:${seen.join(')|(?:')})`;
      } catch { /* fall through to the refusal below */ }
    }
    if (!pattern) {
      process.stderr.write(`[classify-changed-files] ${root} declares no test-file convention, no `
        + 'ecosystem it carries declares one, and no provider declares one either — refusing to guess\n');
      return 1;
    }
    let re;
    try { re = new RegExp(pattern); } catch {
      process.stderr.write(`[classify-changed-files] declared testFilePattern is not a regex: ${pattern}\n`);
      return 1;
    }
    decide = (rel) => re.test(rel);
  }

  const out = [];
  for (const p of paths) {
    out.push(`${decide(p) === true ? 'TEST' : 'FIX'}\t${p}`);
  }
  if (out.length) process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

if (require.main === module) process.exitCode = main();
module.exports = { main };
