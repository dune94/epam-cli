#!/usr/bin/env node
/**
 * PULL THE WORK ITEMS FOR ONE PROJECT AT ONE STATUS, FROM THE TRACKER.
 *
 * Lifted out of ingest-jira-tickets.sh on 2026-08-16, where it was a `node - <<EOF` heredoc —
 * UNQUOTED, so the shell substituted the script directory, the project key and the status filter
 * into the program's own source before node ever saw it. A status filter containing an apostrophe
 * ("Won't Do" is a real Jira status) was a syntax error in a language nobody was writing.
 *
 * Generic: every input is an argument, and the rule holds for any tracker project.
 *
 *   argv[2]  the directory holding lib/jira-client
 *   argv[3]  the project key
 *   argv[4]  the status filter
 *   stdout   the issues, as JSON
 *
 * A FETCH FAILURE IS FATAL AND WRITES NOTHING. The heredoc printed '[]' to stdout on the way out,
 * and stdout was redirected into the issues file — so a credential or network failure left a
 * syntactically valid, empty issues file behind. Every later reader saw a project with no work
 * rather than a fetch that failed. Exiting before writing keeps those two distinguishable.
 *
 * Read-only against the tracker, always. Nothing in this pipeline writes to a client system.
 */
'use strict';

const path = require('path');

const [, , scriptDir, projectKey, status] = process.argv;
if (!scriptDir || !projectKey) {
  process.stderr.write('[fetch-tracker-issues] usage: <script-dir> <project-key> [status]\n');
  process.exit(1);
}

const jira = require(path.join(scriptDir, 'lib/jira-client'));

jira.getProjectIssues(projectKey, status || '')
  .then((issues) => {
    process.stdout.write(`${JSON.stringify(issues, null, 2)}\n`);
  })
  .catch((e) => {
    process.stderr.write(`[fetch-tracker-issues] failed to fetch issues: ${e.message}\n`);
    process.exit(1);
  });
