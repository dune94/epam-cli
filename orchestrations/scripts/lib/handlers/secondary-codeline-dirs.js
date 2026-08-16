#!/usr/bin/env node
/**
 * THE OUTPUT DIRECTORIES OF EVERY CODELINE EXCEPT THE PRIMARY ONE.
 *
 * A multi-codeline PRD declares an output directory per codeline. The launcher tears down the
 * primary one directly; these are the others it must also reset, so that a run starts clean in
 * every codeline rather than only the first.
 *
 * Lifted out of tier3-skyscanner-app-run.sh on 2026-08-16, where it was a `node -e "..."` string
 * with the PRD path and the primary directory interpolated into its own source. Both feed a
 * `rm -rf` loop, so a path the shell mangled was a deletion aimed at the wrong place.
 *
 * Generic: both inputs are arguments, and the rule holds for any project and any stack.
 *
 *   argv[2]  the PRD
 *   argv[3]  the primary output directory, which is excluded
 *   stdout   one directory per line; nothing at all for a single-codeline PRD
 *
 * An unreadable PRD is fatal. The inline copy ran under `2>/dev/null || true`, so a malformed PRD
 * produced an empty list and the launcher reported a single-codeline run — leaving every secondary
 * codeline holding the previous run's work.
 */
'use strict';

const fs = require('fs');

const [, , prdPath, primaryDir] = process.argv;
if (!prdPath || !primaryDir) {
  process.stderr.write('[secondary-codeline-dirs] usage: <prd.json> <primary-output-dir>\n');
  process.exit(1);
}

let prd;
try {
  prd = JSON.parse(fs.readFileSync(prdPath, 'utf8'));
} catch (e) {
  process.stderr.write(`[secondary-codeline-dirs] cannot read ${prdPath}: ${e.message}\n`);
  process.exit(1);
}

const dirs = (prd.project && prd.project.outputDirs) || [];
dirs.filter((d) => d.path !== primaryDir).forEach((d) => process.stdout.write(`${d.path}\n`));
