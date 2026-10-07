#!/usr/bin/env node
/**
 * release-lines.js <prd> <codeline> — the release lines this codeline ships on beyond its own base.
 *
 * Read from the story's plan (detective-overall-plan): for each package this codeline provides, each release line
 * the plan marks onCodelineBase:false, as "<line>\t<base>". The plan decides how many — 0, 1 or N; a line whose
 * onCodelineBase is not stated is not guessed at. A codeline used to have one base and one story branch, and a shared
 * library could not ship on the older lines its consumers are locked to (AMSD-2974, 2026-10-06).
 */
'use strict';
const fs = require('fs');

const [prdFile, codeline, canonicalFile] = process.argv.slice(2);
const prd = JSON.parse(fs.readFileSync(prdFile, 'utf8'));
// A resumed lane works from its checkpoint PRD, which may predate the plan: the canonical PRD holds it then.
const canonical = canonicalFile && fs.existsSync(canonicalFile) ? JSON.parse(fs.readFileSync(canonicalFile, 'utf8')) : null;
const planOf = (s) => (s && s.overallPlan) || ((canonical && canonical.stories || []).find((c) => c && c.id === s.id) || {}).overallPlan;
const seen = new Set();
for (const s of (prd && Array.isArray(prd.stories) ? prd.stories : [])) {
  const plan = s && planOf(s);
  for (const p of (plan && Array.isArray(plan.packages) ? plan.packages : [])) {
    if (!p || p.providedBy !== codeline) continue;
    for (const l of (Array.isArray(p.releaseLines) ? p.releaseLines : [])) {
      if (!l || l.onCodelineBase !== false || !l.line || !l.base) continue;
      const key = `${l.line}\t${l.base}`;
      if (seen.has(key)) continue;
      seen.add(key);
      process.stdout.write(`${key}\n`);
    }
  }
}
