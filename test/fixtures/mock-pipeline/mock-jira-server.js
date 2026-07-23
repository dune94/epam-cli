#!/usr/bin/env node
'use strict';
/**
 * mock-jira-server.js — the ONLY stubbed piece of the full-pipeline mock
 * tests. Everything downstream of this HTTP boundary (jira-client.js,
 * ac-gate.js, codeline-discovery.js, synthesize-prd-from-jira.js, the full
 * run-agent-orchestration.sh gate chain) runs for real against this
 * server's response, exactly like a real run does against real Jira Cloud —
 * we just can't hit the real Atlassian API for a disposable test project.
 *
 * Implements the exact 2 endpoints jira-client.js's real HTTP client calls
 * (see orchestrations/scripts/lib/jira-client.js):
 *   GET /rest/api/3/search/jql?jql=...&maxResults=...&fields=...
 *   GET /rest/api/3/issue/<key>
 * Both return the SAME single ticket, shaped like a genuine bare Jira issue
 * (summary + plain-text description, no labels, no pre-supplied ACs) so the
 * real AC-gate has genuine elaboration work to do — no field is hand-filled
 * with what a real run would have to discover.
 *
 * Usage: node mock-jira-server.js <issueKey> <summary> <description>
 * Prints "LISTENING:<port>" to stdout once bound (port 0 = OS-assigned).
 */

const http = require('http');

const [, , issueKey, summary, description] = process.argv;
if (!issueKey || !summary || !description) {
  process.stderr.write('Usage: mock-jira-server.js <issueKey> <summary> <description>\n');
  process.exit(1);
}

const issue = {
  key: issueKey,
  fields: {
    summary,
    description,
    status: { name: 'To Do' },
    labels: [],
    issuetype: { name: 'Bug' },
    assignee: null,
    priority: { name: 'Medium' },
  },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'application/json');

  if (url.pathname === '/rest/api/3/search/jql') {
    res.end(JSON.stringify({ issues: [issue], total: 1, maxResults: 100 }));
    return;
  }
  if (url.pathname === `/rest/api/3/issue/${issueKey}`) {
    res.end(JSON.stringify(issue));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ errorMessages: [`Unknown mock endpoint: ${url.pathname}`] }));
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`LISTENING:${server.address().port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
