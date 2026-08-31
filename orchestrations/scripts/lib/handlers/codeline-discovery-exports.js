#!/usr/bin/env node
/**
 * THE ENVIRONMENT A CODELINE DISCOVERY IMPLIES.
 *
 * synthesize-prd-from-jira.js needs to know which codelines are in scope and where each one lives.
 * It reads that from the environment, so the discovery artifact has to become KEY="value" lines the
 * caller can export — with no codeline name written down anywhere in the pipeline.
 *
 *   JIRA_CODELINES            every discovered codeline, comma-separated
 *   JIRA_WORKTREE_<NAME>      the path of each, name upper-cased with non-alphanumerics as _
 *   JIRA_DEFAULT_CODELINE     only when exactly one was discovered, so the orch script's
 *                             codeline-setup can pair it with project.outputDir
 *
 * Lifted out of ingest-jira-tickets.sh on 2026-08-16, where it was a quoted heredoc. The program
 * itself is unchanged — it already took its input as an argument.
 *
 * Generic: the discovery artifact is an argument, and the rule holds for any project.
 *
 *   argv[2]  the codeline-discovery artifact
 *   stdout   one KEY="value" per line
 *
 * An unreadable artifact is fatal. Empty output is read by the caller as "no codelines", and the
 * mint has already fallen back to a single repository while three were in scope (2026-08-07).
 */
'use strict';

const fs = require('fs');

if (!process.argv[2]) {
  process.stderr.write('[codeline-discovery-exports] usage: <codeline-discovery.json>\n');
  process.exit(1);
}

let disc;
try {
  disc = require('./_read-input.js').readJsonOrRefuse(process.argv[2], "discovery's selection");
} catch (e) {
  process.stderr.write(`[codeline-discovery-exports] cannot read ${process.argv[2]}: ${e.message}\n`);
  process.exit(1);
}

const codelines = disc.codelines || [];
const names = codelines.map((c) => c.name).join(',');

let out = `JIRA_CODELINES="${names}"\n`;
for (const cl of codelines) {
  out += `JIRA_WORKTREE_${cl.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}="${cl.path}"\n`;
}
if (codelines.length === 1) {
  out += `JIRA_DEFAULT_CODELINE="${codelines[0].name}"\n`;
}

process.stdout.write(out);
