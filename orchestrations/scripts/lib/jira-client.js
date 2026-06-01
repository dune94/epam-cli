'use strict';
/**
 * jira-client.js — Minimal Jira REST API v3 client for writeback.
 *
 * Reads credentials from environment:
 *   JIRA_URL    — https://your-org.atlassian.net  (no trailing slash)
 *   JIRA_EMAIL  — bot account email
 *   JIRA_TOKEN  — Atlassian API token
 *
 * When any credential is absent, every method is a no-op that resolves {}
 * so callers don't need to guard against unconfigured environments.
 *
 * Usage:
 *   const jira = require('./lib/jira-client');
 *   await jira.addComment('PROJ-123', 'CPA estimate: 2.1 min / $0.48');
 *   await jira.transitionIssue('PROJ-123', 'In Review');
 *   const issue = await jira.getIssue('PROJ-123');
 */

const https = require('https');
const url   = require('url');

const JIRA_URL   = (process.env.JIRA_URL   || '').replace(/\/$/, '');
const JIRA_EMAIL = process.env.JIRA_EMAIL  || '';
const JIRA_TOKEN = process.env.JIRA_TOKEN  || '';

const CONFIGURED = !!(JIRA_URL && JIRA_EMAIL && JIRA_TOKEN);

if (!CONFIGURED) {
  process.stderr.write('[jira-client] JIRA_URL / JIRA_EMAIL / JIRA_TOKEN not set — running in no-op mode\n');
}

// ── HTTP helper ────────────────────────────────────────────────────────────

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!CONFIGURED) { resolve({}); return; }

    const parsed  = url.parse(`${JIRA_URL}${path}`);
    const auth    = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.path,
      method,
      headers: {
        'Authorization':  `Basic ${auth}`,
        'Accept':         'application/json',
        'Content-Type':   'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => (raw += d));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Jira API ${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        try { resolve(raw ? JSON.parse(raw) : {}); }
        catch { resolve({}); }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch full issue data.
 */
async function getIssue(issueKey) {
  if (!CONFIGURED) return {};
  return request('GET', `/rest/api/3/issue/${issueKey}`);
}

/**
 * Post a plain-text comment to an issue.
 */
async function addComment(issueKey, text) {
  if (!CONFIGURED) return {};
  const body = {
    body: {
      type:    'doc',
      version: 1,
      content: [{
        type:    'paragraph',
        content: [{ type: 'text', text }],
      }],
    },
  };
  return request('POST', `/rest/api/3/issue/${issueKey}/comment`, body);
}

/**
 * Transition an issue by transition name (case-insensitive match).
 * Fetches available transitions first, then picks the matching one.
 */
async function transitionIssue(issueKey, transitionName) {
  if (!CONFIGURED) return {};

  const { transitions = [] } = await request('GET',
    `/rest/api/3/issue/${issueKey}/transitions`);

  const match = transitions.find(t =>
    (t.name || '').toLowerCase() === transitionName.toLowerCase()
  );

  if (!match) {
    const names = transitions.map(t => t.name).join(', ');
    process.stderr.write(`[jira-client] transition "${transitionName}" not found on ${issueKey}. Available: ${names}\n`);
    return {};
  }

  return request('POST', `/rest/api/3/issue/${issueKey}/transitions`, {
    transition: { id: match.id },
  });
}

/**
 * Update a field on an issue (e.g. description with elaborated ACs).
 */
async function updateField(issueKey, fieldKey, value) {
  if (!CONFIGURED) return {};
  return request('PUT', `/rest/api/3/issue/${issueKey}`, {
    fields: { [fieldKey]: value },
  });
}

module.exports = { getIssue, addComment, transitionIssue, updateField, CONFIGURED };
