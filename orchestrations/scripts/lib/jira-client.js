'use strict';
/**
 * jira-client.js — Minimal Jira REST API v2/v3 client for writeback and ingestion.
 *
 * Reads credentials from environment:
 *   JIRA_URL    — https://your-org.atlassian.net or http://localhost:8080 (no trailing slash)
 *   JIRA_EMAIL  — user email (cloud) or username (server/Data Center)
 *   JIRA_TOKEN  — Atlassian API token (cloud) or password (server/Data Center)
 *
 * Supports both http:// (local Docker) and https:// (cloud) transparently.
 * When any credential is absent, every method is a no-op that resolves {}.
 *
 * Usage:
 *   const jira = require('./lib/jira-client');
 *   await jira.addComment('PROJ-123', 'CPA estimate: 2.1 min / $0.48');
 *   await jira.transitionIssue('PROJ-123', 'In Review');
 *   const issue = await jira.getIssue('PROJ-123');
 *   const created = await jira.createIssue('PROJ', 'Story title', 'Description text', 'Story');
 *   const { issues } = await jira.searchIssues('project = PROJ AND status = "To Do"');
 */

const https = require('https');
const http  = require('http');
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
    const proto   = parsed.protocol === 'https:' ? https : http;
    const auth    = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.path,
      method,
      headers: {
        'Authorization':  `Basic ${auth}`,
        'Accept':         'application/json',
        'Content-Type':   'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = proto.request(options, (res) => {
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

/**
 * Create a new issue. Returns { id, key, self }.
 * issueType defaults to 'Story'. description is plain text; formatted as ADF paragraph.
 */
async function createIssue(projectKey, summary, description, issueType = 'Story', extra = {}) {
  if (!CONFIGURED) return {};
  const body = {
    fields: {
      project:     { key: projectKey },
      summary,
      description: {
        type: 'doc', version: 1,
        content: description
          ? [{ type: 'paragraph', content: [{ type: 'text', text: description }] }]
          : [],
      },
      issuetype: { name: issueType },
      ...extra,
    },
  };
  return request('POST', '/rest/api/3/issue', body);
}

/**
 * Search issues via JQL. Returns { issues: [...], total, maxResults }.
 * Each issue has fields: summary, description, status, labels, issuetype, assignee, priority.
 */
async function searchIssues(jql, maxResults = 50, fields = []) {
  if (!CONFIGURED) return { issues: [], total: 0 };
  const defaultFields = [
    'summary', 'description', 'status', 'labels', 'issuetype',
    'assignee', 'priority', 'customfield_10016', 'comment', 'parent',
  ].join(',');
  const f = fields.length > 0 ? fields.join(',') : defaultFields;
  const qs = `jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=${encodeURIComponent(f)}`;
  return request('GET', `/rest/api/3/search/jql?${qs}`);
}

/**
 * Get issues from a Jira agile board (works for team-managed/next-gen projects
 * where JQL search is not available via the standard REST API).
 * JIRA_BOARD_ID env var must be set.
 */
async function getBoardIssues(boardId, status = null) {
  if (!CONFIGURED) return [];
  let path = `/rest/agile/1.0/board/${boardId}/issue?maxResults=100&fields=summary,description,status,labels,issuetype,assignee,priority,customfield_10016`;
  if (status) path += `&jql=${encodeURIComponent(`status = "${status}"`)}`;
  const result = await request('GET', path);
  return (result.issues || []).map(normalizeIssue);
}

function normalizeIssue(issue) {
  const f = issue.fields || {};
  const descText = typeof f.description === 'string'
    ? f.description
    : f.description && Array.isArray(f.description.content)
      ? f.description.content.map(n =>
          (n.content || []).map(t => t.text || '').join(' ')
        ).join('\n')
      : '';
  const labels = Array.isArray(f.labels) ? f.labels : [];
  const codeline = labels.find(l => l.startsWith('codeline-'))
    ? labels.find(l => l.startsWith('codeline-')).replace('codeline-', '')
    : null;
  const storyIdLabel = labels.find(l => l.startsWith('storyId:'));
  const acceptanceCriteria = extractAcFromText(descText);

  // Merge ACs from [EPAM-AC-ADDITION] comments posted by the pipeline remediator.
  // These survive Jira re-ingestion so gate remediations are durable without a
  // separate canonical store.
  const comments = f.comment && Array.isArray(f.comment.comments) ? f.comment.comments : [];
  for (const comment of comments) {
    const ctext = typeof comment.body === 'string'
      ? comment.body
      : comment.body && Array.isArray(comment.body.content)
        ? comment.body.content.flatMap(n => (n.content || []).map(t => t.text || '')).join(' ')
        : '';
    const match = ctext.match(/\[EPAM-AC-ADDITION\]\s*(\{[\s\S]*?\})\s*$/);
    if (match) {
      try {
        const added = JSON.parse(match[1]);
        for (const ac of (added.acs || [])) {
          if (ac && !acceptanceCriteria.includes(ac)) acceptanceCriteria.push(ac);
        }
      } catch { /* malformed comment — skip */ }
    }
  }

  return {
    jiraKey:            issue.key,
    storyId:            storyIdLabel ? storyIdLabel.replace('storyId:', '') : issue.key,
    title:              f.summary || '',
    description:        descText,
    acceptanceCriteria,
    status:             (f.status && f.status.name) || 'To Do',
    labels,
    codeline,
    effort:             pointsToEffort(f.customfield_10016),
  };
}

/**
 * Get all issues in a project with a given status (default: all open).
 * Tries JQL search first; falls back to agile board endpoint for team-managed projects.
 * Returns normalized array ready for AC gate consumption.
 */
async function getProjectIssues(projectKey, status = null) {
  // JIRA_JQL: fully custom JQL overrides all defaults (e.g. label-based queries for brownfield)
  const customJql = process.env.JIRA_JQL;
  if (customJql) {
    const result = await searchIssues(customJql, 100);
    return (result.issues || []).map(normalizeIssue);
  }

  // Try agile board endpoint if JIRA_BOARD_ID is set (team-managed projects)
  const boardId = process.env.JIRA_BOARD_ID;
  if (boardId) {
    return getBoardIssues(boardId, status);
  }

  // Default: JQL search by project key + status (company-managed projects)
  let jql = `project = "${projectKey}" AND issuetype in (Story, Task, Bug)`;
  if (status) jql += ` AND status = "${status}"`;
  jql += ' ORDER BY created ASC';

  const result = await searchIssues(jql, 100);
  if (result.total === undefined && (!result.issues || result.issues.length === 0)) {
    process.stderr.write(`[jira-client] JQL search returned no results — try setting JIRA_JQL or JIRA_BOARD_ID\n`);
  }
  return (result.issues || []).map(normalizeIssue);
}

function extractAcFromText(text) {
  if (!text) return [];
  const match = text.match(/acceptance criteria[:\s]*\n([\s\S]+?)(?:\n#{1,3}|\n\n\n|$)/i);
  if (!match) return [];
  return match[1]
    .split('\n')
    .map(l => l.replace(/^[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
    .filter(l => l.length > 5);
}

function pointsToEffort(points) {
  const p = Number(points) || 0;
  if (p <= 2) return 'low';
  if (p <= 5) return 'medium';
  return 'high';
}

module.exports = {
  getIssue, addComment, transitionIssue, updateField,
  createIssue, searchIssues, getProjectIssues,
  CONFIGURED,
};
