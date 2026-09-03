#!/usr/bin/env node
/**
 * WHAT ECOSYSTEM A REPOSITORY IS, AND WHAT THAT IMPLIES.
 *
 * codeline-health.sh assesses every codeline before a run spends anything. Its header says it
 * "knows no package manager, no test runner and no language" — and its body named package.json,
 * node_modules and four npm lockfiles. A Rust, Python or Ruby codeline therefore declared nothing,
 * had nothing checked, and was reported HEALTHY without ever being assessed. A free pass from the
 * one gate that exists to stop a run before it pays for an unusable baseline.
 *
 * Every answer here comes from lib/ecosystem-registry.js, the one table. This file names no manifest, no
 * lockfile and no package manager.
 *
 *   argv[2]  the repository
 *   argv[3]  optional: an estate root, to resolve a dependency to a sibling repository
 *
 *   stdout   one JSON object:
 *     stack           the ecosystem label, or "" when the repo declares none
 *     manifest        the manifest file found, or ""
 *     installDir      where this ecosystem vendors dependencies, or null if it vendors none
 *     packageManager  decided by the lockfile present, or "" when none says
 *     testCommand     what runs this project's own tests, or "" when it declares none
 *     installCommand  what installs its dependencies, or "" when it vendors nothing in-repo
 *     testFileCommand what runs JUST the files given in argv[4], or "" when this ecosystem cannot
 *     declaredDeps    every dependency the manifest declares
 *     declaredBins    the declared dependencies the repo's own scripts actually invoke
 *     missingBins     of those, the ones not present in installDir
 *     providers       { packageName: path } for sibling repositories in the estate
 *
 * A repo that declares NOTHING is not unhealthy — it has nothing to install. That is the caller's
 * rule and this reports the facts for it to apply.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { allManifests, lockfileFor } = require('../ecosystem-registry.js');

const repo = process.argv[2];
if (!repo) {
  process.stderr.write('[codeline-ecosystem] usage: <repo> [estate-root]\n');
  process.exit(1);
}
// A REPOSITORY THAT IS NOT THERE IS NOT A REPOSITORY WITHOUT A MANIFEST.
//
// Handed a path that does not exist, this returned {"stack":"","manifest":"",...} — the same
// answer it gives for a real checkout carrying no manifest of any known ecosystem. The caller
// chooses install and test commands from that, so the two must not be one answer: "there is
// nothing to detect here" and "I was pointed at nothing" lead to different actions.
const _repoStat = (() => { try { return fs.statSync(repo); } catch { return null; } })();
if (!_repoStat || !_repoStat.isDirectory()) {
  process.stderr.write(
    `[codeline-ecosystem] ${repo} is ${_repoStat ? 'not a directory' : 'not there'} — this is NOT `
    + 'the same as a repository with no recognised manifest, and an empty ecosystem here would be '
    + 'read as one. The caller picks install and test commands from this answer.\n');
  process.exit(2);
}

const estate = process.argv[3] || '';
// argv[4]: optional comma-separated test files, to be turned into a runnable command.

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

/** The first ecosystem whose manifest this repository carries. */
function ecosystemOf(root) {
  for (const eco of allManifests()) {
    if (fs.existsSync(path.join(root, eco.file))) return eco;
  }
  return null;
}

const eco = ecosystemOf(repo);
const out = {
  stack: '', manifest: '', installDir: null, packageManager: '', testCommand: '', testFileCommand: '',
  installCommand: '', addCommand: '',
  lockfile: '',
  declaredBins: [], declaredDeps: [], missingBins: [], providers: {},
};

if (eco) {
  out.stack = eco.stack;
  out.manifest = eco.file;
  out.installDir = eco.installDir || null;

  // The package manager is what the LOCKFILE says. Unknown means we do not know how to install,
  // so we do not pretend to — the caller declines rather than guessing a command.
  out.lockfile = lockfileFor(eco, (f) => fs.existsSync(path.join(repo, f)));
  out.packageManager = out.lockfile ? eco.lockfiles[out.lockfile] : '';
  if (typeof eco.addCommand === 'function') {
    try { out.addCommand = eco.addCommand(out.packageManager) || ''; } catch { out.addCommand = ''; }
  }


  const text = read(path.join(repo, eco.file));
  if (text !== null) {
    let deps = [];
    try { deps = eco.deps(text) || []; } catch { deps = []; }

    // ONLY THE TOOLING THE PROJECT ACTUALLY INVOKES: a declared dependency whose name appears in
    // the repo's own scripts. That is the set whose absence means the project cannot run its own
    // commands — the rest may be missing without stopping a gate.
    let scripts = '';
    try { scripts = Object.values(JSON.parse(text).scripts || {}).join(' '); } catch { scripts = ''; }
    // EVERY DECLARED DEPENDENCY, not only the ones the scripts invoke. The mint needs the full
    // list as evidence for an agent brief; declaredBins is the narrower "tooling this project
    // actually runs" set and answers a different question.
    out.declaredDeps = deps;

    out.declaredBins = scripts
      ? deps.filter((d) => new RegExp(`(^|[^\\w/@-])${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`).test(scripts))
      : [];

    // WHAT COMMAND RUNS ITS TESTS, from the ecosystem rather than from a runner name. Empty
    // means the project declares none — which the caller must read as "nothing to run", never as
    // "the tests passed".
    if (typeof eco.testCommand === 'function') {
      try { out.testCommand = eco.testCommand(text, out.packageManager) || ''; } catch { out.testCommand = ''; }
    }

    // HOW TO RUN SPECIFIC TEST FILES, from the same registry. The bug-reproduction gate needs to
    // execute one story's test, not the whole suite, and it used to probe for Node binaries by
    // name and skip itself entirely on anything else.
    if (typeof eco.testFileCommand === 'function') {
      const wanted = (process.argv[4] || '').split(',').map((f) => f.trim()).filter(Boolean);
      if (wanted.length) {
        try { out.testFileCommand = eco.testFileCommand(out.testCommand, wanted) || ''; }
        catch { out.testFileCommand = ''; }
      }
    }

    if (typeof eco.installCommand === 'function') {
      try { out.installCommand = eco.installCommand(out.packageManager) || ''; }
      catch { out.installCommand = ''; }
    }

    if (out.installDir) {
      out.missingBins = out.declaredBins.filter((b) => !fs.existsSync(path.join(repo, out.installDir, b)));
    }
  }
}

// Sibling repositories, by the name each one gives ITSELF. Nothing here knows a vendor, a scope or
// a repository name — it reads the manifest's own `name` through the ecosystem that defines it.
if (estate && fs.existsSync(estate)) {
  for (const entry of fs.readdirSync(estate)) {
    const dir = path.join(estate, entry);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    const sibling = ecosystemOf(dir);
    if (!sibling || typeof sibling.selfName !== 'function') continue;
    const text = read(path.join(dir, sibling.file));
    if (text === null) continue;
    let name = '';
    try { name = sibling.selfName(text); } catch { name = ''; }
    if (name) out.providers[name] = dir;
  }
}

process.stdout.write(`${JSON.stringify(out)}\n`);
