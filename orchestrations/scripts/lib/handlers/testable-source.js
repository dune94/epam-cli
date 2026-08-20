#!/usr/bin/env node
/**
 * testable-source.js — WHICH OF THESE FILES COULD A TEST TARGET, asked of the codeline.
 *
 * brownfield-repro-test-writer.sh decided this with a hardcoded case statement:
 *
 *     *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) return 0 ;;
 *     *) return 1 ;;
 *
 * A .py, .go, .rs, .java or .rb file falls to the default. On any non-Node codeline NO file is ever
 * testable, `_choose_target` finds no candidate, and the writer skips — which is reported as
 * "nothing sensible to test" and is indistinguishable from a correct decision. Bug-reproduction
 * tests silently never happened there.
 *
 * TWO RULES, BOTH FROM DATA THAT ALREADY EXISTS:
 *
 *   POSITIVE  the file carries one of the extensions the CODELINE declares as source
 *             (.epam/dependency-check.json scanFileExtensions, or contract-generation.json
 *             sourceExtensions — written by lib/handlers/codeline-manifests.js from the provider)
 *
 *   NEGATIVE  the file is not a manifest, a lockfile, or a protected file, per the ecosystem
 *             registry
 *
 * THE OLD EXCLUSION LIST IS GONE. It named .md, .txt, .json, .yml, .toml, .png, .svg, .css and
 * more — every one of which fails the positive rule on its own once that rule is grounded in a
 * declaration. Those entries were compensating for a positive rule that was not.
 *
 *   node testable-source.js <codelineRoot> [path...]
 *
 * stdout  the testable subset, one path per line, input order preserved
 * exit 0  always when the codeline declares its source extensions
 * exit 1  the codeline declares none — NOTHING is printed and the reason goes to stderr. A guessed
 *         extension set is how one stack's conventions get applied to another's repository.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const { allManifests } = require('../ecosystem-registry.js');

/** Extensions the codeline itself declares as source, normalised to ".ext". */
function declaredExtensions(root) {
  const out = new Set();
  const read = (rel, keys) => {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch { return; }
    for (const k of keys) {
      const v = j && j[k];
      if (!Array.isArray(v)) continue;
      for (const e of v) {
        const s = String(e || '').trim();
        if (s) out.add(s.startsWith('.') ? s : `.${s}`);
      }
    }
  };
  read(path.join('.epam', 'dependency-check.json'), ['scanFileExtensions']);
  read(path.join('.epam', 'contract-generation.json'), ['sourceExtensions']);
  if (out.size) return out;

  // SECOND AUTHORITY: THE ECOSYSTEM THE REPOSITORY ACTUALLY CARRIES.
  //
  // Codeline-first is right — a repository that declares its own source extensions knows better
  // than any provider. But a codeline that has not been given a declaration yet is the NORMAL case,
  // not an error: the live metrolinx checkout carries .epam/verification.json and
  // .epam/settings.json and no dependency-check.json at all. Stopping at the codeline would have
  // made the repro-test-writer find nothing testable there and skip — replacing a Node-only defect
  // with a nothing-works one.
  //
  // This is still injected at run time and still names no stack here: the extensions come from
  // whichever provider's manifest the repository carries.
  for (const eco of allManifests()) {
    const present = [eco.file, ...(Array.isArray(eco.alsoMatches) ? eco.alsoMatches : [])]
      .some((n) => { try { return fs.existsSync(path.join(root, n)); } catch { return false; } });
    if (!present) continue;
    const declared = ((eco.codelineManifests || {}).dependencyCheck || {}).scanFileExtensions;
    for (const e of (Array.isArray(declared) ? declared : [])) {
      const t = String(e || '').trim();
      if (t) out.add(t.startsWith('.') ? t : `.${t}`);
    }
    break;                                  // precedence order already decided which one wins
  }
  if (out.size) return out;

  // THIRD AUTHORITY: WHAT ANY KNOWN ECOSYSTEM CALLS SOURCE.
  //
  // A repository can carry no .epam/ declaration AND no manifest any provider recognises -- a bare
  // checkout, a fixture, a repo whose build lives elsewhere. Stopping here made NOTHING testable
  // there, and the repro-test-writer skipped: a capability the hardcoded `*.ts|*.js` case statement
  // used to have, lost to a stricter rule.
  //
  // The union of what the PROVIDERS declare is still runtime-injected and still names no stack
  // here. It is deliberately the last resort: the codeline speaks first, its ecosystem second, and
  // only a repository that answers neither falls back to what every ecosystem considers source.
  for (const eco of allManifests()) {
    const declared = ((eco.codelineManifests || {}).dependencyCheck || {}).scanFileExtensions;
    for (const e of (Array.isArray(declared) ? declared : [])) {
      const t = String(e || '').trim();
      if (t) out.add(t.startsWith('.') ? t : `.${t}`);
    }
  }
  return out;
}

/**
 * Filenames no test targets, from the registry: every provider's manifest, its lockfiles, and the
 * files it marks protected.
 *
 * The union across providers, not just the resolved one — a repository can carry more than one
 * ecosystem's manifest, and excluding a name it does not have costs nothing.
 */
function excludedNames() {
  const out = new Set();
  for (const eco of allManifests()) {
    for (const n of [eco.file, ...(Array.isArray(eco.alsoMatches) ? eco.alsoMatches : [])]) {
      if (n) out.add(n);
    }
    for (const n of Object.keys(eco.lockfiles || {})) out.add(n);
    for (const n of (Array.isArray(eco.protectedFiles) ? eco.protectedFiles : [])) out.add(n);
  }
  return out;
}

function testable(root, paths) {
  const exts = declaredExtensions(root);
  if (exts.size === 0) return null;
  const excluded = excludedNames();
  return paths.filter((p) => {
    const base = String(p).split('/').pop() || '';
    if (excluded.has(base)) return false;
    return [...exts].some((e) => base.endsWith(e));
  });
}

function main() {
  const root = process.argv[2];
  const paths = process.argv.slice(3);
  if (!root) {
    process.stderr.write('[testable-source] usage: <codelineRoot> [path...]\n');
    return 2;
  }
  const keep = testable(root, paths);
  if (keep === null) {
    process.stderr.write(
      `[testable-source] ${root} declares no source extensions in .epam/ — nothing is testable by `
      + 'this rule, and no extension set is assumed on its behalf.\n');
    return 1;
  }
  if (keep.length) process.stdout.write(keep.join('\n') + '\n');
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { testable, declaredExtensions, excludedNames };
