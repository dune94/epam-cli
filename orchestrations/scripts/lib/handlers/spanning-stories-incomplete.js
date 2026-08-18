#!/usr/bin/env node
/**
 * WHICH SPANNING STORIES HAVE NOT REPORTED FROM EVERY CODELINE.
 *
 * A story listing two or more codelines is not finished when one lane succeeds — it is finished
 * when every codeline it names has produced a result. Running it as "done" after one lane reports
 * ships a fraction of the work while the run says success.
 *
 * Lifted out of run-agent-orchestration.sh on 2026-08-16, where it was a `node -e "..."` string.
 * As a string it could not be tested, linted or type-checked, and it was invoked with
 * `2>/dev/null || true`, so a syntax error in it and "every story is complete" were the same
 * observation.
 *
 * Generic: the PRD path is an argument, and the rule holds for any project and any stack.
 *
 *   argv[2]  path to the PRD
 *   stdout   "<story-id> → no result for: <codeline>, <codeline>" per offender, "; "-separated
 *   exit 0   always when the PRD could be read — an empty result means nothing is incomplete
 *   exit 1   the PRD is missing or unreadable, which is NOT the same as nothing being incomplete
 */
'use strict';

const fs = require('fs');

const prdPath = process.argv[2];
if (!prdPath) {
  process.stderr.write('[spanning-stories-incomplete] usage: <prd-path>\n');
  process.exit(1);
}

let prd;
try {
  prd = JSON.parse(fs.readFileSync(prdPath, 'utf8'));
} catch (e) {
  // LOUD. The inline version swallowed this: an unreadable PRD produced an empty string, which
  // the caller read as "no spanning story is incomplete" and carried on.
  process.stderr.write(`[spanning-stories-incomplete] cannot read ${prdPath}: ${e && e.message}\n`);
  process.exit(1);
}

const bad = [];
for (const s of (prd.stories || [])) {
  const want = Array.isArray(s.codelines) ? s.codelines : [];
  if (want.length < 2) continue;                       // not a spanning story
  const got = s.perCodeline || {};
  const missing = want.filter((cl) => !got[cl]);
  if (missing.length) bad.push(`${s.id} → no result for: ${missing.join(', ')}`);
}

process.stdout.write(bad.join('; '));
