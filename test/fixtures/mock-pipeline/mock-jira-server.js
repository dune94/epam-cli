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
 * Usage (single ticket):  node mock-jira-server.js <issueKey> <summary> <description>
 *       (many tickets):    node mock-jira-server.js --issues <path-to-json>
 *
 * The --issues form takes [{key, summary, description}, ...] and is what a
 * multi-story mock needs: mock2 drives three tickets through the REAL Jira
 * ingest so it exercises the same piping as production rather than skipping
 * the ingest stage (user directive 2026-07-24: "mock2 should not skip jira").
 * Story TOPOLOGY stays deterministic because synthesize-prd-from-jira.js keys
 * its --template by story id and preserves each story's agentGroup, so serving
 * real tickets does not put lane assignment at the mercy of an LLM.
 *
 * Prints "LISTENING:<port>" to stdout once bound (port 0 = OS-assigned).
 */

const http = require('http');

const fs = require('fs');

/** Shape a bare Jira issue — no labels, no pre-supplied ACs, so the real
 *  AC-gate has genuine elaboration work to do (same as the single-ticket form). */
function makeIssue(key, summary, description) {
  return {
    key,
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
}

let issues;
if (process.argv[2] === '--issues') {
  const specPath = process.argv[3];
  if (!specPath) {
    process.stderr.write('Usage: mock-jira-server.js --issues <path-to-json>\n');
    process.exit(1);
  }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  if (!Array.isArray(spec) || spec.length === 0) {
    process.stderr.write('--issues file must be a non-empty JSON array\n');
    process.exit(1);
  }
  issues = spec.map(i => makeIssue(i.key, i.summary, i.description));
} else {
  const [, , issueKey, summary, description] = process.argv;
  if (!issueKey || !summary || !description) {
    process.stderr.write('Usage: mock-jira-server.js <issueKey> <summary> <description>\n');
    process.exit(1);
  }
  issues = [makeIssue(issueKey, summary, description)];
}
const byKey = new Map(issues.map(i => [i.key, i]));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'application/json');

  if (url.pathname === '/rest/api/3/search/jql') {
    res.end(JSON.stringify({ issues, total: issues.length, maxResults: 100 }));
    return;
  }
  // Look the ticket up BY KEY — with several tickets in play, always returning
  // issues[0] would silently hand back the wrong ticket (and `issueKey` is not
  // even defined in the --issues form).
  const m = url.pathname.match(/^\/rest\/api\/3\/issue\/([^/]+)$/);
  if (m) {
    const found = byKey.get(decodeURIComponent(m[1]));
    if (found) { res.end(JSON.stringify(found)); return; }
    res.statusCode = 404;
    res.end(JSON.stringify({ errorMessages: [`No such mock issue: ${m[1]}`] }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ errorMessages: [`Unknown mock endpoint: ${url.pathname}`] }));
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`LISTENING:${server.address().port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
