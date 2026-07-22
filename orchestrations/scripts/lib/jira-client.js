'use strict';
/**
 * jira-client.js — Read-only Jira REST API v2/v3 client for ingestion.
 *
 * This project NEVER writes to Jira. There is no addComment, transitionIssue,
 * updateField, or createIssue function in this file — not gated behind a flag,
 * removed entirely. request() only ever issues GET requests; there is no
 * method parameter, so a write call cannot even be constructed here.
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
 *   const issue = await jira.getIssue('PROJ-123');
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

// ── HTTP helper (GET only — no method parameter exists) ────────────────────

function request(path) {
  return new Promise((resolve, reject) => {
    if (!CONFIGURED) { resolve({}); return; }

    const parsed = url.parse(`${JIRA_URL}${path}`);
    const proto  = parsed.protocol === 'https:' ? https : http;
    const auth   = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.path,
      method:   'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept':        'application/json',
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
    req.end();
  });
}

// ── Public API — reads only ─────────────────────────────────────────────────

/**
 * Fetch full issue data.
 */
async function getIssue(issueKey) {
  if (!CONFIGURED) return {};
  return request(`/rest/api/3/issue/${issueKey}`);
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
  return request(`/rest/api/3/search/jql?${qs}`);
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
  const result = await request(path);
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

  // Merge ACs from [EPAM-AC-ADDITION] comments a HUMAN or another tool posted
  // to the ticket. This project never posts these itself, but still reads
  // them if a human chooses to add one — the marker is just a parse target.
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
  getIssue, searchIssues, getBoardIssues, getProjectIssues,
  CONFIGURED,
};
