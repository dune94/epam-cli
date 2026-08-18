#!/usr/bin/env node
/**
 * WHAT IS NEVER AGENT OUTPUT — one answer, for every caller that needs it.
 *
 * Two shell files each carried a hand-written list, and they had drifted. worktree-health-check.sh
 * named `.dart_tool`, `build`, `node_modules`; lib/git-ops.sh named `node_modules`, `build`,
 * `.next`. Between them they described one ecosystem.
 *
 * The consequences ran in both directions. `git_add_client_outputs` decides what is COMMITTED TO A
 * CLIENT REPOSITORY: on a Rust codeline whose target/ was not gitignored, the build tree was staged
 * into the customer's repo. And the health check's list decides what counts as the agent's
 * uncommitted work: the same directory was reported as thousands of uncommitted files, which set
 * issues=1, which made Step 3.1 exit 1 and killed the phase.
 *
 * Ecosystem artefacts come from lib/ecosystems.js, beside the ecosystem that produces them. Editor
 * and OS droppings come from config/repo-artifacts.json. Nothing is named here.
 *
 *   argv[2]  the form the caller wants:
 *              pathspec  git exclude pathspecs, one per line — for `git add -A -- ...`
 *              glob      shell case-patterns, one per line — for a status-line filter
 *              regex     one ERE matching any excluded path — for a `grep -vE` filter
 *              diff      pathspec PLUS lockfiles — for the patch a REVIEW agent is shown
 *
 * `diff` is deliberately wider than `pathspec`. A lockfile must still be STAGED: a real dependency
 * change belongs in the commit. But it must not be REVIEWED — it is machine-generated, frequently
 * thousands of lines, and it would consume the reviewer's whole budget before it reached the code
 * the change is actually about. Staging and reviewing are different questions, so they get
 * different answers rather than one list bent to serve both.
 *
 * Every directory is emitted in BOTH the top-level and the nested form. `:!*​/node_modules/*`
 * matches only a NESTED one; a top-level node_modules — the usual case — needs `:!node_modules/*`.
 * The original list carried only the nested form, so a repo without node_modules in .gitignore
 * staged the lot.
 *
 * Exit non-zero if the registry or the config cannot be read. A caller that silently fell back to
 * an empty exclusion list would stage everything, which is the failure this exists to prevent.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { allArtifactDirs, allManifests } = require('../ecosystems.js');

const form = process.argv[2] || 'pathspec';
if (!['pathspec', 'glob', 'regex', 'diff'].includes(form)) {
  process.stderr.write(`[repo-exclude-patterns] unknown form: ${form}\n`);
  process.exit(2);
}

const configPath = path.join(__dirname, '..', '..', '..', 'config', 'repo-artifacts.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  // LOUD. An empty exclusion list stages a client's build tree into their repository.
  process.stderr.write(`[repo-exclude-patterns] cannot read ${configPath}: ${err.message}\n`);
  process.exit(1);
}

const dirs = [...new Set([...allArtifactDirs(), ...(config.dirs || [])])];
const files = config.files || [];
const enginePaths = config.enginePaths || [];

// Lockfile names come from the ecosystem registry, beside the ecosystem that produces them.
const lockfiles = [...new Set(allManifests().flatMap((e) => Object.keys(e.lockfiles || {})))];

const out = [];
if (form === 'pathspec' || form === 'diff') {
  // THE LONG FORM, ALWAYS. git parses `:!` as the start of a magic signature and keeps reading
  // magic characters, so `:!__pycache__/*` dies with "Unimplemented pathspec magic '_'" — which
  // fails the whole `git add` and stages NOTHING. `:(exclude)` is unambiguous whatever follows.
  // ONE GLOB PER DIRECTORY, NOT A TOP-LEVEL AND A NESTED PREFIX.
  //
  // `:(exclude)<dir>/*` is FATAL, not merely unmatched, when the directory is a symlink — git
  // refuses a pathspec that crosses one:
  //
  //   fatal: pathspec ':(exclude)node_modules/*' is beyond a symbolic link
  //
  // Live 2026-08-18, both lanes, at the LAST step of a run that had otherwise succeeded — the fix
  // was correct, the tests passed, the type check passed — every commit failed with exit 128
  // because both codelines symlink node_modules to a shared install. Nothing could ever be
  // committed in such a repo, and the story was demoted as undelivered.
  //
  // The bare `:(exclude)<dir>` form survives the symlink but stops excluding NESTED copies, which
  // would stage a client's vendored tree: fixing the error by weakening the exclusion. The glob
  // form is correct on all three counts — top-level contents, nested contents, and a symlinked
  // directory — and replaces both prefixes with one pattern.
  // TWO PATTERNS: the CONTENTS at any depth, and the ENTRY itself. A symlinked directory is a
  // single entry to git, so the contents glob does not cover it and the link would be staged.
  for (const d of dirs) out.push(`:(exclude,glob)**/${d}/**`, `:(exclude,glob)**/${d}`);
  for (const f of files) out.push(`:(exclude)${f}`, `:(exclude)*/${f}`);
  for (const p of enginePaths) out.push(`:(exclude)${p}`);
  if (form === 'diff') {
    for (const f of lockfiles) out.push(`:(exclude)${f}`, `:(exclude)*/${f}`);
  }
} else if (form === 'regex') {
  // Anchored at the start OR after a slash, so it matches a top-level and a nested one alike.
  const alt = [...dirs, ...files].map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  process.stdout.write(`(^|/)(${alt})(/|$)\n`);
  process.exit(0);
} else {
  for (const d of dirs) out.push(`${d}/*`, `*/${d}/*`);
  for (const f of files) out.push(f, `*/${f}`);
  for (const p of enginePaths) out.push(p);
}

process.stdout.write(`${out.join('\n')}\n`);
