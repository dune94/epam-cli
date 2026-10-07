#!/usr/bin/env node
/**
 * carry-plan.js <lane-prd> <canonical-prd> — a lane's work copy carries the story's plan.
 *
 * A resumed lane works from a copy of its checkpoint PRD, written before the story had a plan
 * (write-missing-plans.js writes it into the canonical PRD). Every step inside the lane reads PRD_FILE, so the
 * run's plan is copied onto the lane's copy of each story — replacing an older one. The checkpoint itself is never edited.
 */
'use strict';
const fs = require('fs');

const [laneFile, canonicalFile] = process.argv.slice(2);
try {
  const lane = JSON.parse(fs.readFileSync(laneFile, 'utf8'));
  const canonical = JSON.parse(fs.readFileSync(canonicalFile, 'utf8'));
  let changed = false;
  for (const s of lane.stories || []) {
    if (!s) continue;
    // ONE PLAN PER STORY: the run's. A lane copy's older plan is replaced (AMSD-2974, 2026-10-07: a checkpoint's
    // older plan skipped the writer on a plan the run no longer held).
    const c = (canonical.stories || []).find((x) => x && x.id === s.id);
    if (c && c.overallPlan && JSON.stringify(c.overallPlan) !== JSON.stringify(s.overallPlan)) { s.overallPlan = c.overallPlan; changed = true; }
  }
  if (changed) fs.writeFileSync(laneFile, JSON.stringify(lane, null, 2));
} catch { process.exit(0); }
