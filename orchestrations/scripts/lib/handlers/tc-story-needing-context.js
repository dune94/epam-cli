#!/usr/bin/env node
/**
 * tc-story-needing-context.js — WHICH STORY WOULD THE TC WRITER ACTUALLY BE BRIEFED ABOUT?
 *
 * tc-story-context.py builds that brief, and deliberately emits NOTHING for a story that already
 * has testCriteria.facts — there is nothing to brief. So "the handler produced nothing" only means
 * something when it was asked about a story that needs a brief.
 *
 * The pre-flight check written to catch an empty brief took stories[0] and called an empty answer a
 * failure. Once AMSD-2041 had its 21 facts, that check failed on the handler doing exactly the
 * right thing — the same shape of defect it existed to catch, one level up: a check whose scope
 * does not match its claim reports the wrong thing in both directions.
 *
 *   node tc-story-needing-context.js <prd> <phase>
 *
 * stdout  the id of a story in this phase that needs criteria, or nothing
 * exit 0  always. "No story needs criteria" is a real state and a legitimate answer, not an error;
 *         the caller must report it as a SKIP and never as a pass.
 */
'use strict';
const fs = require('fs');

function storyNeedingContext(prd, phase) {
  const ids = ((prd.implementationOrder || {})[phase]) || [];
  return (prd.stories || []).find((s) => s
    && ids.includes(s.id)
    && s.status !== 'deprecated'
    && !((((s.testCriteria || {}).facts) || []).length)
    // NOT YET IS NOT BROKEN.
    //
    // A story needs TC context only once the evidence to brief FROM exists. Verification criteria
    // are that evidence, and the specification pass produces them — so before that pass every
    // story lacks TC facts, this selected one anyway, and the caller reported
    // "EMPTY — the TC writer would be given nothing" about a stage that had not run.
    //
    // The check could therefore only pass in a narrow mid-run window, and on a CLEAN pre-run PRD it
    // failed by construction. Live 2026-08-27: it passed at run 14's launch because the PRD still
    // held the PREVIOUS run's output, and failed afterwards on a correctly reset one — reporting
    // health on stale data and a defect on good data, exactly backwards.
    //
    // With criteria present and context still empty, this reports as before: that is a real defect,
    // and the distinction is what the check exists to draw.
    && ((s.verificationCriteria || []).length > 0)) || null;
}

function main() {
  const [file, phase] = process.argv.slice(2);
  if (!file || !phase) {
    process.stderr.write('[tc-needing-context] usage: <prd> <phase>\n');
    return 2;
  }
  let prd;
  try { prd = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    // Unreadable is NOT "no story needs criteria" — that would let a broken PRD read as a clean
    // skip, which is the absence-as-success shape this whole check exists to refuse.
    process.stderr.write(`[tc-needing-context] cannot read ${file}: ${e.message}\n`);
    return 2;
  }
  const s = storyNeedingContext(prd, phase);
  if (s) process.stdout.write(`${s.id}\n`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { storyNeedingContext };
