#!/usr/bin/env node
/**
 * HOW MANY ELEMENTS A JSON ARRAY FILE HOLDS.
 *
 * Lifted out of ingest-jira-tickets.sh on 2026-08-16, where it was a one-line `node -e` with the
 * file path interpolated into a string INSIDE the program — a path containing a quote broke it.
 *
 *   argv[2]  a file holding a JSON array
 *   stdout   the element count
 *
 * An unreadable or non-array file is fatal. The count decides whether the run has work at all, and
 * a 0 that means "could not read" is indistinguishable from a 0 that means "no work".
 */
'use strict';

const fs = require('fs');

if (!process.argv[2]) {
  process.stderr.write('[json-array-length] usage: <file.json>\n');
  process.exit(1);
}

let doc;
try {
  doc = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
} catch (e) {
  process.stderr.write(`[json-array-length] cannot read ${process.argv[2]}: ${e.message}\n`);
  process.exit(1);
}

if (!Array.isArray(doc)) {
  process.stderr.write(`[json-array-length] ${process.argv[2]} does not hold an array\n`);
  process.exit(1);
}

console.log(doc.length);
