#!/usr/bin/env node
/**
 * install-plan.js — WHAT THIS CODELINE INSTALLS WITH, asked of the providers.
 *
 * run-agent-orchestration.sh carried a nine-branch if-chain: package.json → npm, Pipfile → pipenv,
 * requirements.txt → pip, Cargo.toml → cargo, go.mod → go, pom.xml → mvn, build.gradle → gradle,
 * Gemfile → bundle, composer.json → composer. A tenth ecosystem meant a tenth branch inside an
 * 11,000-line engine file.
 *
 * Every one of those facts already belongs to a provider. This resolves them and emits a PLAN; the
 * engine executes it and judges the outcome. The engine keeps the parts that are not ecosystem
 * facts — that a clean install is opt-in, and that a repair leaving less than it found is
 * destruction — because those are policy, and policy is ours.
 *
 *   node install-plan.js <codelineRoot> [clean]     clean = "1" to plan the destructive variant
 *
 * Output: one TAB-separated line per ecosystem the codeline actually carries
 *
 *   <manifest>\t<installDir or ->\t<command>
 *
 * NOTHING is printed for a codeline that declares no manifest this registry has a provider for.
 * Silence means "no ecosystem resolved", never "install with the usual thing" — a guessed default
 * is how a repository gets a package manager it does not use pointed at it.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const { allManifests, lockfileFor } = require('../ecosystem-registry.js');

/** Manifest names this provider answers to — `file`, plus any it declares as equivalent. */
function manifestNames(eco) {
  return [eco.file, ...(Array.isArray(eco.alsoMatches) ? eco.alsoMatches : [])];
}

function main() {
  const root = process.argv[2];
  const clean = String(process.argv[3] || '0') === '1';
  if (!root) {
    process.stderr.write('[install-plan] usage: <codelineRoot> [clean]\n');
    return 2;
  }

  const lines = [];
  for (const eco of allManifests()) {
    const present = manifestNames(eco).find((n) => {
      try { return fs.existsSync(path.join(root, n)); } catch { return false; }
    });
    if (!present) continue;

    // The package manager is whichever lockfile the repository actually carries — the same
    // resolution `lockfileFor` uses everywhere else, so the two can never disagree.
    const lock = lockfileFor(eco, (f) => {
      try { return fs.existsSync(path.join(root, f)); } catch { return false; }
    });
    const manager = (lock && (eco.lockfiles || {})[lock]) || '';

    if (typeof eco.installCommand !== 'function') {
      // Reported, not skipped: an ecosystem that cannot say how it installs leaves the codeline
      // without dependencies, and its gates then fail for a reason that looks unrelated.
      process.stderr.write(`[install-plan] ${eco.file} declares no installCommand — nothing planned for it\n`);
      continue;
    }
    let cmd = '';
    try { cmd = String(eco.installCommand(manager, { clean }) || ''); }
    catch (e) {
      process.stderr.write(`[install-plan] ${eco.file} could not produce an install command: ${e.message}\n`);
      continue;
    }
    if (!cmd.trim()) continue;

    lines.push([present, eco.installDir || '-', cmd].join('\t'));
  }

  if (lines.length) process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { manifestNames };
