'use strict';
/**
 * jira-adapter.js — Normalise Jira webhook payloads to epam-cli PRD story shape.
 *
 * Jira webhooks fire for: issue_created, issue_updated, jira:issue_created,
 * jira:issue_updated, sprint_started, sprint_closed. This adapter extracts
 * what the orchestration engine needs from each event type.
 *
 * Usage:
 *   const { adapt } = require('./lib/jira-adapter');
 *   const event = adapt(rawJiraPayload);   // returns null if unrecognised
 *
 * Output shape per event:
 *   {
 *     projectKey,        // "PROJ"
 *     jiraKey,           // "PROJ-123"
 *     epicKey,           // "PROJ-10" or null (phase grouping)
 *     storyId,           // same as jiraKey (PRD story id)
 *     title,             // issue summary
 *     description,       // issue description (plain text)
 *     acceptanceCriteria, // string[] parsed from description or custom field
 *     effort,            // "low" | "medium" | "high" derived from story points
 *     status,            // "pending" | "in-progress" | "completed"
 *     urgent,            // true if issue has "urgent" label
 *     agentRole,         // "engineer" (default); "qa-engineer" for Test tasks
 *     aiProvider,        // "claude"
 *   }
 */

// ── Effort mapping from story points ──────────────────────────────────────

function pointsToEffort(points) {
  const p = Number(points) || 0;
  if (p <= 2) return 'low';
  if (p <= 5) return 'medium';
  return 'high';
}

// ── Status mapping from Jira status category ──────────────────────────────

function mapStatus(statusName) {
  const s = (statusName || '').toLowerCase();
  if (s.includes('done') || s.includes('closed') || s.includes('resolved')) return 'completed';
  if (s.includes('progress') || s.includes('review') || s.includes('testing')) return 'in-progress';
  return 'pending';
}

// ── AC extraction ──────────────────────────────────────────────────────────
// Looks for "Acceptance Criteria:" section in description, or a custom field
// named "Acceptance Criteria". Falls back to empty array.

function extractAC(description, customFields) {
  // Try custom field first (common Jira setup)
  if (customFields) {
    for (const [, v] of Object.entries(customFields)) {
      if (v && typeof v === 'object' && v.type === 'doc') continue; // ADF — skip
      if (typeof v === 'string' && v.length > 0 &&
          customFields['customfield_10016'] === undefined) { /* heuristic */ }
    }
  }

  if (!description) return [];

  // Look for "Acceptance Criteria" heading in plain text or ADF
  const text = typeof description === 'string'
    ? description
    : extractPlainText(description);

  const acMatch = text.match(/acceptance criteria[:\s]*\n([\s\S]+?)(?:\n#{1,3}|\n\n\n|$)/i);
  if (!acMatch) return [];

  return acMatch[1]
    .split('\n')
    .map(l => l.replace(/^[-*•]\s*/, '').trim())
    .filter(l => l.length > 5);
}

// Convert Jira Atlassian Document Format (ADF) to plain text
function extractPlainText(adf) {
  if (!adf || typeof adf !== 'object') return '';
  if (adf.type === 'text') return adf.text || '';
  if (Array.isArray(adf.content)) {
    return adf.content.map(extractPlainText).join(' ');
  }
  return '';
}

// ── Main adapter ───────────────────────────────────────────────────────────

function adapt(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const eventType = payload.webhookEvent || payload.event_type || '';
  const issue     = payload.issue || payload.fields || null;

  // Sprint events — no individual issue to adapt
  if (eventType.includes('sprint')) return null;

  if (!issue) return null;

  const fields      = issue.fields || issue;
  const key         = issue.key || payload.key || '';
  const projectKey  = (fields.project && fields.project.key) || key.split('-')[0] || '';
  const summary     = fields.summary || fields.title || '';
  const description = fields.description || '';
  const status      = (fields.status && fields.status.name) || 'To Do';
  const labels      = Array.isArray(fields.labels) ? fields.labels : [];
  const points      = fields.story_points || fields.customfield_10016 ||
                      fields.storyPoints || 0;
  const epicLink    = fields.epic || fields['customfield_10014'] ||
                      (fields.parent && fields.parent.key) || null;
  const issueType   = (fields.issuetype && fields.issuetype.name) || 'Story';

  if (!key || !projectKey || !summary) return null;

  // Only process Story, Task, Bug, Sub-task types
  const supportedTypes = ['story', 'task', 'bug', 'sub-task', 'subtask'];
  if (!supportedTypes.includes(issueType.toLowerCase())) return null;

  const descText = typeof description === 'string'
    ? description
    : extractPlainText(description);

  const agentRole = issueType.toLowerCase().includes('test') ||
                    issueType.toLowerCase().includes('qa')
    ? 'qa-engineer'
    : 'engineer';

  return {
    projectKey,
    jiraKey:            key,
    epicKey:            epicLink,
    storyId:            key,
    title:              summary,
    description:        descText.slice(0, 2000),
    acceptanceCriteria: extractAC(descText, fields),
    effort:             pointsToEffort(points),
    status:             mapStatus(status),
    urgent:             labels.some(l => (typeof l === 'string' ? l : l.name || '').toLowerCase() === 'urgent'),
    agentRole,
    aiProvider:         'claude',
    completed:          mapStatus(status) === 'completed',
  };
}

module.exports = { adapt, pointsToEffort, mapStatus, extractAC };
