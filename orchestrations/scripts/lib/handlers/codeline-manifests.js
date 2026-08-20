#!/usr/bin/env node
/**
 * codeline-manifests.js — WHAT THIS CODELINE DECLARES ABOUT ITSELF, or nothing at all.
 *
 * run-agent-orchestration.sh wrote three .epam/ manifests into every codeline worktree that lacked
 * them, from heredocs asserting — of a repository it had never inspected — that its manifest is
 * package.json, its sources are .ts/.tsx/.js, its vendor directory is node_modules, its install
 * command is npm, and that it must carry typescript, @types/node, vitest and tsx.
 *
 * THAT IS NOT AN ASSUMPTION, IT IS A FABRICATION. Seventeen scripts read dependency-check.json as
 * the codeline's OWN declaration; it is the ground truth every generic component consults. Writing
 * it from a template defeats that genericity at the source — a Python repository is handed a
 * document saying it is TypeScript, and everything downstream then behaves "generically" against
 * a lie, in client-repo space, with facts nobody detected.
 *
 * Here the manifests are ASSEMBLED from the provider whose manifest the repository actually
 * carries. The registry answers what it can (manifest file, vendor dirs, add-command); the
 * provider supplies the rest under `codelineManifests`.
 *
 *   node codeline-manifests.js <codelineRoot>
 *
 * stdout  a JSON object keyed by filename, ready to be written into .epam/
 * exit 0  a declaration was produced
 * exit 1  NO provider recognises this codeline, or the one that does declares nothing — nothing is
 *         printed. The caller must report that and move on, never substitute a default. An
 *         undeclared codeline is a state to surface, not one to invent an answer for.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const { allManifests, lockfileFor } = require('../ecosystem-registry.js');

function manifestNames(eco) {
  return [eco.file, ...(Array.isArray(eco.alsoMatches) ? eco.alsoMatches : [])];
}

/** The provider whose manifest this repository actually carries, in declared precedence order. */
function resolveEcosystem(root) {
  for (const eco of allManifests()) {
    const present = manifestNames(eco).find((n) => {
      try { return fs.existsSync(path.join(root, n)); } catch { return false; }
    });
    if (present) return { eco, present };
  }
  return null;
}

function build(root) {
  const hit = resolveEcosystem(root);
  if (!hit) return null;
  const { eco, present } = hit;

  const declared = eco.codelineManifests || {};

  // The vendored tree, from what the ecosystem says it vendors. `installDir` is the one that gets
  // populated; `artifactDirs` is the wider set it leaves behind.
  const vendorDirs = [...new Set([
    ...(eco.installDir ? [eco.installDir] : []),
    ...(Array.isArray(eco.artifactDirs) ? eco.artifactDirs : []),
  ])];

  // THE ADD COMMAND, not the install command. `installCommand` provisions what the manifest already
  // declares and cannot add anything; the engine's heredoc wrote "npm install --save-dev {package}"
  // beside the provider's own addCommand — two spellings of one fact.
  const lock = lockfileFor(eco, (f) => {
    try { return fs.existsSync(path.join(root, f)); } catch { return false; }
  });
  const manager = (lock && (eco.lockfiles || {})[lock]) || '';
  let addCommand = '';
  if (typeof eco.addCommand === 'function') {
    try { addCommand = String(eco.addCommand(manager) || ''); } catch { addCommand = ''; }
  }

  const dependencyCheck = {
    manifestFile: present,
    ...(declared.dependencyCheck || {}),
    vendorDirs,
    ...(addCommand ? { installCommand: addCommand } : {}),
  };

  const out = { 'dependency-check.json': dependencyCheck };
  if (declared.contractGeneration) out['contract-generation.json'] = declared.contractGeneration;
  if (declared.knownFixes) out['known-fixes.json'] = declared.knownFixes;

  // A provider that supplies nothing beyond its own identity has not declared how this codeline is
  // checked. Emitting a near-empty dependency-check.json would read downstream as a real
  // declaration, which is the defect this file exists to remove.
  if (!declared.dependencyCheck) return null;

  return out;
}

function main() {
  const root = process.argv[2];
  if (!root) {
    process.stderr.write('[codeline-manifests] usage: <codelineRoot>\n');
    return 2;
  }
  const out = build(root);
  if (!out) {
    process.stderr.write(
      `[codeline-manifests] no provider declares how ${root} is checked — writing nothing. `
      + 'Its ecosystem must declare this, or supply a provider that does.\n');
    return 1;
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { build, resolveEcosystem };
