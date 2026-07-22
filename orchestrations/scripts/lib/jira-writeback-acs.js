#!/usr/bin/env node
/**
 * jira-writeback-acs.js — Post pipeline-remediated ACs back to Jira as a comment.
 *
 * On the NEXT run, ingest reads these comments and merges the ACs into the
 * synthesized PRD before the pipeline sees it — making remediations durable
 * without storing anything outside of Jira.
 *
 * Usage:
 *   node jira-writeback-acs.js <jiraKey> <storyId> <acs-json-file>
 *
 * acs-json-file must contain: { "acs": ["ac text", ...] }
 *
 * The comment format is: [EPAM-AC-ADDITION] { "storyId": "...", "acs": [...] }
 * jira-client.normalizeIssue reads this tag on the next ingest and merges ACs.
 */

'use strict';

const fs   = require('fs');
const jira = require('./jira-client');

const [jiraKey, storyId, acsFile] = process.argv.slice(2);

if (!jiraKey || !storyId || !acsFile) {
  process.stderr.write('Usage: node jira-writeback-acs.js <jiraKey> <storyId> <acs-json-file>\n');
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(fs.readFileSync(acsFile, 'utf8'));
} catch (e) {
  process.stderr.write(`[jira-writeback-acs] Failed to read ${acsFile}: ${e.message}\n`);
  process.exit(0); // non-fatal — local write already succeeded
}

const acs = Array.isArray(payload.acs) ? payload.acs.filter(a => a && typeof a === 'string') : [];
if (acs.length === 0) {
  process.stderr.write(`[jira-writeback-acs] No ACs to write back for ${storyId}\n`);
  process.exit(0);
}

if (!jira.CONFIGURED) {
  process.stderr.write(`[jira-writeback-acs] Jira not configured — skipping writeback for ${storyId}\n`);
  process.exit(0);
}

const tag = '[EPAM-AC-ADDITION]';
const body = `${tag} ${JSON.stringify({ storyId, acs })}`;

jira.addComment(jiraKey, body)
  .then(() => {
    process.stderr.write(`[jira-writeback-acs] Posted ${acs.length} AC(s) to ${jiraKey} (story: ${storyId})\n`);
  })
  .catch(e => {
    process.stderr.write(`[jira-writeback-acs] Comment post failed for ${jiraKey}: ${e.message}\n`);
    // non-fatal — local write already succeeded
  });
