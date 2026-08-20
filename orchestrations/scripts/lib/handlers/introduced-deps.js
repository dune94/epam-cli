#!/usr/bin/env node
/**
 * WHICH DEPENDENCIES DID THIS STORY ADD?
 *
 * Two gates need the answer and must agree on it: the SAST gate, which reports a CVE in
 * pre-existing debt as advisory but blocks one in a package this change introduced (665f1a5), and
 * the lockfile-sync gate, which blocks only on drift this change caused.
 *
 * The first version of this lived inline in run-agent-orchestration.sh as
 * `git diff <ref> -- package.json | grep -oE '"[^"]+" *:'`. That names a manifest and assumes a
 * JSON one, so every non-Node codeline got the empty answer — and the empty answer means "this
 * story introduced nothing", which silently turns every finding into debt and disarms both gates.
 * The manifest and the way to read it come from lib/ecosystem-registry.js, the one table.
 *
 *   usage: introduced-deps.js <repo> <baseline_ref>
 *
 * Prints a comma-separated list of dependency names present in the working tree's manifest and
 * absent from the manifest at <baseline_ref>. Exits non-zero when it cannot answer — a caller must
 * never read a failure as "none", which is the same claim-from-absent-evidence this exists to stop.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { allManifests } = require('../ecosystem-registry.js');

const repo = process.argv[2];
const ref = process.argv[3];
if (!repo || !ref) {
  process.stderr.write('[introduced-deps] usage: <repo> <baseline_ref>\n');
  process.exit(1);
}

const eco = allManifests().find((e) => fs.existsSync(path.join(repo, e.file)));
if (!eco || typeof eco.deps !== 'function') {
  process.stderr.write('[introduced-deps] no manifest of a known ecosystem in this repository\n');
  process.exit(1);
}

const names = (text) => { try { return new Set(eco.deps(text) || []); } catch { return null; } };

let baselineText;
try {
  baselineText = execFileSync('git', ['-C', repo, 'show', `${ref}:${eco.file}`],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
} catch {
  // The manifest may not have existed at the baseline — that is a real answer (everything in it is
  // new). An unreadable REF is not, and git cannot tell us which from the exit code alone, so ask.
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' });
    baselineText = '';
  } catch {
    process.stderr.write(`[introduced-deps] baseline ref '${ref}' is not readable in ${repo}\n`);
    process.exit(1);
  }
}

let current;
try { current = fs.readFileSync(path.join(repo, eco.file), 'utf8'); } catch {
  process.stderr.write(`[introduced-deps] cannot read ${eco.file}\n`);
  process.exit(1);
}

const before = baselineText === '' ? new Set() : names(baselineText);
const after = names(current);
if (before === null || after === null) {
  process.stderr.write(`[introduced-deps] ${eco.file} could not be parsed on both sides\n`);
  process.exit(1);
}

process.stdout.write(`${[...after].filter((n) => !before.has(n)).join(',')}\n`);
