#!/usr/bin/env node
/**
 * INJECT AN EMPTY SCAFFOLD PHASE AHEAD OF EVERYTHING ELSE.
 *
 * The phase carries no implementation stories. Its only job is to make the launcher's
 * run_phase "scaffold" call fire the pre-phase skill assessment over every synthesised story, so
 * each agent's profile gains this project's skills before any implementation begins. Without it
 * that assessment never runs and every agent works without them.
 *
 * FIRST, not appended: the object is rebuilt with scaffold ahead of the existing keys, because
 * phases run in declared order and an assessment after the work has assessed nothing.
 *
 *   argv[2]  the PRD, rewritten in place
 *
 * Idempotent — a PRD that already declares a scaffold phase is left exactly as it is, so a resume
 * cannot reorder the phases of a run already under way.
 *
 * Written through a temporary file and rename: this rewrites the PRD the whole run depends on, and
 * an interrupted write left a truncated one.
 */
'use strict';

const fs = require('fs');

const prdPath = process.argv[2];
if (!prdPath) {
  process.stderr.write('[scaffold-phase] usage: <prd.json>\n');
  process.exit(1);
}

let prd;
try {
  prd = JSON.parse(fs.readFileSync(prdPath, 'utf8'));
} catch (e) {
  process.stderr.write(`[scaffold-phase] cannot read ${prdPath}: ${e.message}\n`);
  process.exit(1);
}

if (!prd.implementationOrder) prd.implementationOrder = {};
if (!prd.implementationOrder.scaffold) {
  prd.implementationOrder = { scaffold: [], ...prd.implementationOrder };
}

const tmp = `${prdPath}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(prd, null, 2)}\n`);
fs.renameSync(tmp, prdPath);
