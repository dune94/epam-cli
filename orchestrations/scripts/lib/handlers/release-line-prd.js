#!/usr/bin/env node
/**
 * release-line-prd.js <lane-prd> <out> <codeline> <line> — the lane's PRD for one more release line.
 *
 * The stories whose plan ships on that line for this codeline, pending again — a story completed on the codeline's
 * own base is not done on another line (each line is its own branch and its own change). Everything else about the
 * story (its plan, its fix sites, its criteria) is kept: the line is worked from the same plan.
 */
'use strict';
const fs = require('fs');

const [src, out, codeline, line, canonicalFile] = process.argv.slice(2);
const prd = JSON.parse(fs.readFileSync(src, 'utf8'));
// A resumed lane works from its checkpoint PRD, which may predate the plan: the canonical PRD holds it then.
const canonical = canonicalFile && fs.existsSync(canonicalFile) ? JSON.parse(fs.readFileSync(canonicalFile, 'utf8')) : null;
for (const s of prd.stories || []) {
  const c = s && !s.overallPlan && ((canonical && canonical.stories) || []).find((x) => x && x.id === s.id);
  if (c && c.overallPlan) s.overallPlan = c.overallPlan;
}
const onLine = (s) => !!(s && s.overallPlan && (s.overallPlan.packages || []).some((p) => p && p.providedBy === codeline
  && (p.releaseLines || []).some((l) => l && l.line === line)));
const stories = (prd.stories || []).filter(onLine).map((s) => ({
  ...s, status: 'pending', completed: false, passes: false, completedAt: null,
}));
const ids = new Set(stories.map((s) => s.id));
const order = {};
for (const [phase, list] of Object.entries(prd.implementationOrder || {})) {
  const kept = (list || []).filter((id) => ids.has(id));
  if (kept.length) order[phase] = kept;
}
fs.writeFileSync(out, JSON.stringify({ ...prd, stories, implementationOrder: order }, null, 2));
