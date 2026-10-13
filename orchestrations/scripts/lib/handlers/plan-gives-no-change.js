#!/usr/bin/env node
/**
 * plan-gives-no-change.js <prd> <story-id> <codeline> — exit 0 when the story's plan gives this codeline no change of
 * its own: it consumes the change through a release of the provider (detective-overall-plan, consumers[].change
 * "none" — or "exactly none", the wording detective-overall-plan.json itself asks for; AMSD-2974 run 9 resume 14:
 * all three site lanes ran writers 7+ times on it). Exit 1 otherwise — no plan, no entry, or a change. Read, never guessed.
 */
'use strict';
const fs = require('fs');

const [prdFile, storyId, codeline] = process.argv.slice(2);
try {
  const prd = JSON.parse(fs.readFileSync(prdFile, 'utf8'));
  const s = (prd.stories || []).find((x) => x && x.id === storyId);
  const entries = ((s && s.overallPlan && s.overallPlan.packages) || [])
    .flatMap((p) => (p.consumers || []).filter((c) => c && c.codeline === codeline));
  process.exit(entries.length && entries.every((c) => /^\s*(exactly\s+)?none\s*\.?\s*$/i.test(String(c.change || ''))) ? 0 : 1);
} catch { process.exit(1); }
