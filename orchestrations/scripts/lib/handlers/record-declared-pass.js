#!/usr/bin/env node
/**
 * record-declared-pass.js <prd> <codeline> — a lane the operator declared passed (EPAM_PASSED_LANES) is that
 * codeline's result for every story spanning it, recorded as one and marked as declared. A codeline that already
 * has a result keeps it. AMSD-2974 run 9 (2026-10-08): declared lanes recorded nothing, and the completeness check
 * (spanning-stories-incomplete.js) failed the run for them.
 */
'use strict';
const fs = require('fs');

const [file, cl] = process.argv.slice(2);
try {
  const prd = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = false;
  for (const s of prd.stories || []) {
    if (!s || !Array.isArray(s.codelines) || !s.codelines.includes(cl)) continue;
    s.perCodeline = s.perCodeline || {};
    if (s.perCodeline[cl]) continue;
    s.perCodeline[cl] = { status: 'completed', completed: true, completedAt: new Date().toISOString(), reviewStatus: 'declared-passed' };
    changed = true;
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(prd, null, 2));
} catch (e) { process.stderr.write(`[record-declared-pass] ${e.message}\n`); process.exit(1); }
