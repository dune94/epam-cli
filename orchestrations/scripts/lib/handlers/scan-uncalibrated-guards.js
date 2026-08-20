#!/usr/bin/env node
/**
 * scan-uncalibrated-guards.js — guards that can block a run and that no test ever executes.
 *
 * A guard is any shell function that can STOP something: it returns non-zero, exits, or raises
 * DETERMINISTIC_CHECK_FAILURE. Those are the functions whose behaviour decides whether work ships.
 *
 * On 2026-08-20 three of them were confirmed inert in production while the suite was green:
 * review_feedback_is_incomplete read a field its writer projects away; the undefined-call scan was
 * scoped to a naming convention; the plugin check collected `undefined` and passed. None had a
 * test that ran the guard against a case it was supposed to catch.
 *
 * "Calibrated" here is the weakest useful bar — the guard's NAME appears somewhere under test/.
 * It cannot prove the test is good. It does prove nobody shipped a blocking function that no test
 * has ever heard of, which is how all three above happened.
 *
 *   node scan-uncalibrated-guards.js [repoRoot]     → one "file:line\tname" per uncovered guard
 *
 * Exit 0 always — the caller ratchets on the count.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SCRIPT_DIRS = ['orchestrations/scripts', 'orchestrations/scripts/lib'];
const TEST_DIRS = ['test/unit/orchestration', 'test/unit', 'test'];

/** Signals that a function body can stop the caller. */
const BLOCKING = [
  /\breturn\s+[1-9]\d*\b/,
  /\bexit\s+[1-9]\d*\b/,
  /DETERMINISTIC_CHECK_FAILURE\s*=\s*1/,
  /\bVERIFICATION_FAILURE\s*=/,
];

/** Every shell function that can block, with where it is defined. */
function blockingGuards(root) {
  const out = [];
  for (const d of SCRIPT_DIRS) {
    const dir = path.join(root, d);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.filter((x) => x.endsWith('.sh'))) {
      const p = path.join(dir, n);
      let lines = [];
      try { lines = fs.readFileSync(p, 'utf8').split('\n'); } catch { continue; }
      for (let i = 0; i < lines.length; i++) {
        const m = /^\s*(?:function\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\)\s*\{/.exec(lines[i]);
        if (!m) continue;
        // Body = to the first line that closes at column 0. Good enough for this codebase's
        // style, and a miss here under-reports rather than inventing a guard that is not one.
        let end = i + 1;
        while (end < lines.length && !/^\}/.test(lines[end])) end++;
        const body = lines.slice(i + 1, end).join('\n');
        if (BLOCKING.some((re) => re.test(body))) {
          out.push({ file: path.relative(root, p), line: i + 1, name: m[1] });
        }
      }
    }
  }
  return out;
}

/** Everything the test suite says, as one string. */
function testCorpus(root) {
  let all = '';
  const seen = new Set();
  const walk = (dir) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|js|sh)$/.test(e.name) && !seen.has(p)) {
        seen.add(p);
        try { all += fs.readFileSync(p, 'utf8') + '\n'; } catch { /* unreadable */ }
      }
    }
  };
  for (const d of TEST_DIRS) walk(path.join(root, d));
  return all;
}

function scan(root) {
  const guards = blockingGuards(root);
  const corpus = testCorpus(root);
  const uncovered = corpus
    ? guards.filter((g) => !corpus.includes(g.name))
    : guards;
  return { guards, uncovered, corpusBytes: corpus.length };
}

module.exports = { scan, blockingGuards, testCorpus };

if (require.main === module) {
  const root = process.argv[2] || process.cwd();
  const { uncovered } = scan(root);
  for (const g of uncovered) console.log(`${g.file}:${g.line}\t${g.name}`);
}
