#!/usr/bin/env node
/**
 * HOW MANY STORIES THE AC GATE FOUND INSUFFICIENT.
 *
 * The greenfield flow halts for a human on any non-zero count. Brownfield does not — there,
 * sufficiency is decided later by the code-graph-detective.
 *
 * Lifted out of ingest-jira-tickets.sh on 2026-08-16, where it was a `node -e "..."` string with
 * the results path interpolated into its own source.
 *
 *   argv[2]  the gate's results JSON
 *   stdout   the count
 *
 * An unreadable file is fatal rather than 0. The inline copy fell back to "0", which is the reading
 * that skips the human halt — a gate that cannot be read is not a gate that passed.
 */
'use strict';

const fs = require('fs');

if (!process.argv[2]) {
  process.stderr.write('[ac-gate-insufficient-count] usage: <gate-results.json>\n');
  process.exit(1);
}

let results;
try {
  results = require('./_read-input.js').readJsonOrRefuse(process.argv[2], 'the AC gate results', { expect: 'array' });
} catch (e) {
  process.stderr.write(`[ac-gate-insufficient-count] cannot read ${process.argv[2]}: ${e.message}\n`);
  process.exit(1);
}

console.log(results.filter((x) => x.verdict === 'insufficient').length);
