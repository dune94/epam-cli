#!/usr/bin/env node
/**
 * THE AC GATE'S PER-STORY VERDICTS, AS A LINE EACH.
 *
 * Lifted out of ingest-jira-tickets.sh on 2026-08-16, where it was a `node -e "..."` string with
 * the results path interpolated into its own source.
 *
 * Generic: the results path is an argument, and the icons come from the verdicts the gate emits —
 * a verdict this does not recognise still prints, rather than vanishing.
 *
 *   argv[2]  the gate's results JSON
 *   stdout   one line per story
 */
'use strict';

const fs = require('fs');

if (!process.argv[2]) {
  process.stderr.write('[ac-gate-verdicts] usage: <gate-results.json>\n');
  process.exit(1);
}

let results;
try {
  results = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
} catch (e) {
  process.stderr.write(`[ac-gate-verdicts] cannot read ${process.argv[2]}: ${e.message}\n`);
  process.exit(1);
}

const ICON = { sufficient: '✅', enrichable: '🔶', insufficient: '🛑' };

results.forEach((s) => {
  console.log(`  ${ICON[s.verdict] || '•'} ${s.jiraKey} — ${s.verdict}: ${s.reason}`);
});
