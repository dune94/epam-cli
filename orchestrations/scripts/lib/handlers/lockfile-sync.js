#!/usr/bin/env node
/**
 * DOES THE LOCKFILE RESOLVE WHAT THE MANIFEST DECLARES?
 *
 * Live metrolinx AMSD-2041, approved commit af1d6b99. package.json gained a dependency and
 * package-lock.json — tracked, not ignored — was never touched. tsc, ESLint, the build and the
 * reviewer all passed it, because node_modules already carried the package from a run five days
 * earlier that survived the codeline reset. `npm install` never ran. Every check the pipeline owns
 * was therefore run against a tree no commit describes, and `npm ci` on that branch fails.
 *
 * This asks a file comparison, not a judgement, so it belongs with the deterministic checks and
 * carries no model. It names no package manager and no manifest filename: every answer comes from
 * lib/ecosystem-registry.js, the one table.
 *
 *   usage: lockfile-sync.js <repo>
 *
 * Emits TSV to stdout, one finding per line, and always exits 0 — the CALLER owns the policy:
 *
 *   missing    <package>   <lockfile>   declared by the manifest, not resolved by the lockfile
 *   unprovable <reason>                 no lockfile, or a format this engine does not parse
 *
 * `unprovable` must be read as "cannot prove", never as "in sync". The whole defect this exists to
 * catch is a check that reported success from absent evidence.
 */
const fs = require('fs');
const path = require('path');
const { allManifests, lockfileFor } = require('../ecosystem-registry.js');

const repo = process.argv[2];
if (!repo) {
  process.stderr.write('[lockfile-sync] usage: <repo>\n');
  process.exit(1);
}

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const emit = (...cols) => process.stdout.write(`${cols.join('\t')}\n`);

const eco = allManifests().find((e) => fs.existsSync(path.join(repo, e.file)));
if (!eco) {
  emit('unprovable', 'no manifest of any known ecosystem in this repository');
  process.exit(0);
}

const lock = lockfileFor(eco, (f) => fs.existsSync(path.join(repo, f)));
if (!lock) {
  emit('unprovable', `${eco.file} declares dependencies and this repository carries no lockfile`);
  process.exit(0);
}

const manifestText = read(path.join(repo, eco.file));
const lockText = read(path.join(repo, lock));
if (manifestText === null || lockText === null) {
  emit('unprovable', `could not read ${eco.file} or ${lock}`);
  process.exit(0);
}

if (typeof eco.lockDeclares !== 'function') {
  emit('unprovable', `this engine cannot read ${lock}`);
  process.exit(0);
}

let declared = [];
try { declared = eco.deps(manifestText) || []; } catch {
  emit('unprovable', `${eco.file} could not be parsed`);
  process.exit(0);
}

for (const name of declared) {
  let resolved;
  try { resolved = eco.lockDeclares(lockText, name); } catch { resolved = null; }
  // null is the ecosystem saying it does not parse this lockfile format. One such answer means the
  // whole file is unreadable, so report that once and claim nothing about any package.
  if (resolved === null) {
    emit('unprovable', `this engine cannot read ${lock}`);
    process.exit(0);
  }
  if (!resolved) emit('missing', name, lock);
}
