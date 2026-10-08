#!/usr/bin/env node
/**
 * spec-predates-plan.js <prd> [canonical-prd] — the specified stories whose spec was built under another plan.
 *
 * A story's spec (fix sites, criteria) is the elaboration of its plan. AMSD-2974 (2026-10-08): every lane resumed a
 * spec approved on 10-01, before the story had a plan; the plan then gave upexpress no change while its criteria
 * demanded upexpress-owned work — the reviewer rejected, the writer was skipped, round after round. A spec made under
 * a different plan, or under none, is the spec of another story: it is specified again, from the plan it has now.
 *
 *   stdout  one story id per line whose spec predates its plan; nothing otherwise. The plan is the story's own, or
 *           the canonical PRD's when the story carries none (a lane's checkpoint copy may predate the plan).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { planHash } = require(path.join(__dirname, '..', 'plan-hash.js'));

function specPredatesPlan(prd, canonical) {
  const canon = new Map(((canonical && canonical.stories) || []).filter(Boolean).map((s) => [s.id, s]));
  return (prd.stories || [])
    .filter((s) => s && s.status !== 'deprecated' && s.specification && s.specification.runId)
    .filter((s) => {
      // The run's plan is the canonical PRD's; a lane copy carries the plan it was specified under.
      const plan = (canon.get(s.id) || {}).overallPlan || s.overallPlan;
      const now = planHash(plan);
      return now !== '' && now !== (s.specification.planHash || '');
    })
    .map((s) => s.id);
}

module.exports = { specPredatesPlan };

if (require.main === module) {
  try {
    const prd = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const canonical = process.argv[3] && fs.existsSync(process.argv[3]) ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : null;
    const out = specPredatesPlan(prd, canonical);
    if (out.length) process.stdout.write(out.join('\n') + '\n');
  } catch (e) { process.stderr.write(`[spec-predates-plan] ${e.message}\n`); }
}
