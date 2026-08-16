#!/usr/bin/env node
/**
 * MERGE ONE LANE'S STORY STATE BACK INTO THE CANONICAL PRD.
 *
 * Lanes of a spanning story run in parallel and each writes only its own filtered PRD. The merges
 * happen afterwards, one at a time, here — concurrent merges into the same file would clobber
 * each other.
 *
 * Lifted out of run-agent-orchestration.sh on 2026-08-16, where it was a `node -e "..."` string
 * that interpolated four shell values directly into its own source. A codeline name or path
 * containing a quote was a syntax error in a language the author was not writing.
 *
 * Generic: every input is an argument, and the rule holds for any project and any stack.
 *
 *   argv[2]  SCRIPT_DIR — where lib/story-merge.js lives
 *   argv[3]  the canonical PRD, read and written in place
 *   argv[4]  this lane's filtered PRD
 *   argv[5]  the codeline name this lane ran as
 *
 * Exits non-zero on any failure. The caller distinguishes that from success and says so: a failed
 * merge silently discards a lane's entire outcome — status, criteria and all.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const [, , scriptDir, canonicalPath, updatedPath, codeline] = process.argv;
if (!scriptDir || !canonicalPath || !updatedPath || !codeline) {
  process.stderr.write('[merge-lane-into-canonical] usage: <script-dir> <canonical-prd> <lane-prd> <codeline>\n');
  process.exit(1);
}

const { mergeLaneIntoCanonical } = require(path.join(scriptDir, 'lib/story-merge.js'));

const canonical = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
const updated = JSON.parse(fs.readFileSync(updatedPath, 'utf8'));
mergeLaneIntoCanonical({ canonical, updated, codeline });
fs.writeFileSync(canonicalPath, JSON.stringify(canonical, null, 2));
