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

// pointsToEffort(points) — maps a Jira story-point estimate to a coarse effort bucket.
//
// `Number(points) || 0` used to treat a genuinely UNESTIMATED ticket (points === undefined,
// because the ticket was never groomed) identically to a verified 0-point ticket — both
// collapsed to the same 'low' bucket. Live 2026-08-05 (AMSD-2041: title-only, blank
// description, zero acceptance criteria — never groomed) that put a story the detective
// itself found touches a shared React context consumed by 30+ components into the cheapest
// effort bucket, same as a trivial one-line fix. Absence of an estimate is not evidence the
// work is small; it is evidence nobody looked. Callers get `undefined` back for "no real
// estimate" and are expected to fall back to a neutral default (synthesize-prd-from-jira.js
// already does `tmpl.effort || c.effort || 'medium'`) rather than trust a fabricated number.
function pointsToEffort(points) {
  if (points === undefined || points === null || points === '') return undefined;
  const p = Number(points);
  if (Number.isNaN(p)) return undefined;
  if (p <= 2) return 'low';
  if (p <= 5) return 'medium';
  return 'high';
}

// sizeLabelToEffort(labels) — a Jira LABEL-derived t-shirt-size signal, consulted when a
// ticket carries no story-point estimate at all rather than falling straight to a neutral
// default. Matches the same label-prefix convention this file already uses for codeline
// ("codeline-metrolinx") and urgency ("urgent") labels — a real grooming signal a human
// actually set on the ticket, preferred over a value nobody chose. Recognizes "size-<x>"
// and "t-shirt-<x>" / "tshirt-<x>" prefixes (S/M/L/XL and their spelled-out forms);
// unrecognized or absent labels return undefined so the neutral 'medium' default still
// applies — this never invents a size that was not actually set.
const SIZE_TO_EFFORT = {
  xs: 'low', s: 'low', small: 'low',
  m: 'medium', medium: 'medium',
  l: 'high', large: 'high', xl: 'high', xxl: 'high',
};
function sizeLabelToEffort(labels) {
  if (!Array.isArray(labels)) return undefined;
  for (const raw of labels) {
    const label = (typeof raw === 'string' ? raw : (raw && raw.name) || '').toLowerCase();
    const match = label.match(/^(?:size|t-?shirt)[-:]\s*(xs|xxl|xl|s|m|l|small|medium|large)$/);
    if (match && SIZE_TO_EFFORT[match[1]]) return SIZE_TO_EFFORT[match[1]];
  }
  return undefined;
}

// ── Status mapping from Jira status category ──────────────────────────────

/**
 * WHAT THIS PROJECT'S TRACKER CALLS THINGS — declared by the project, never by this file.
 *
 * A Jira custom field id is per-TENANT: customfield_10016 is story points on one instance and
 * something else, or nothing, on the next. Type and status names are per-WORKFLOW. Carrying any
 * of them here made the generic ingest a reader of exactly one tenant's schema, and the failure
 * was silent — points and epic link read as absent, and a type outside a five-word English list
 * dropped the ticket entirely with `return null`.
 *
 * A declaration that is ABSENT filters nothing. That is the opposite of the old default: an
 * undeclared vocabulary must not mean "ingest nothing", because nothing is what a project gets
 * before it knows the declaration exists.
 */
function declaredList(name) {
  return String(process.env[name] || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
}

/** The value of a project-declared field, by whichever names the tracker may present it under. */
function declaredField(fields, envName, ...fallbackKeys) {
  const declared = String(process.env[envName] || '').trim();
  if (declared && fields[declared] !== undefined) return fields[declared];
  for (const k of fallbackKeys) if (fields[k] !== undefined) return fields[k];
  return undefined;
}

/**
 * A TRACKER STATUS, CLASSIFIED BY THE PROJECT'S OWN WORKFLOW.
 *
 * This matched English substrings — done/closed/resolved meant completed, progress/review/testing
 * meant in-progress — so a workflow in any other language classified everything as pending, and
 * `completed` gates whether a story is skipped. This project's own board carries "BA ACCEPTANCE",
 * "READY FOR DEV" and "Pending I&IT Approval"; none of them matched either list.
 *
 * The vocabularies are declared per project (JIRA_STATUS_COMPLETED, JIRA_STATUS_IN_PROGRESS), as
 * comma-separated substrings matched case-insensitively — substrings because a workflow names
 * states like "Done (verified)".
 *
 * UNDECLARED CLASSIFIES NOTHING, and pending is where that lands. Pending is the absence of
 * evidence that work started or finished, not an invented fact — and it is the safe direction: a
 * story wrongly pending is attempted again, while one wrongly completed is silently skipped.
 */
function mapStatus(statusName) {
  const s = String(statusName || '').toLowerCase();
  if (!s) return 'pending';
  const any = (name) => declaredList(name)
    .some((term) => s.includes(String(term).toLowerCase()));
  if (any('JIRA_STATUS_COMPLETED')) return 'completed';
  if (any('JIRA_STATUS_IN_PROGRESS')) return 'in-progress';
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
          declaredField(customFields, 'JIRA_FIELD_STORY_POINTS') === undefined) { /* heuristic */ }
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
  // ABSENT STAYS ABSENT. `|| 'To Do'` gave a ticket with no status one that may exist in no
  // workflow anywhere, and a reader downstream cannot tell an invented status from a real one.
  const status      = (fields.status && fields.status.name) || '';
  const labels      = Array.isArray(fields.labels) ? fields.labels : [];
  // No `|| 0` default here — an absent estimate must reach pointsToEffort as absent,
  // not as a fabricated verified-zero. See pointsToEffort's own comment.
  const points      = declaredField(fields, 'JIRA_FIELD_STORY_POINTS', 'story_points', 'storyPoints');
  const epicLink    = declaredField(fields, 'JIRA_FIELD_EPIC_LINK', 'epic')
                      || (fields.parent && fields.parent.key) || null;
  // And an unknown type does not become a Story: the type decides whether the ticket is ingested
  // at all, so inventing one decides that question by assumption.
  const issueType   = (fields.issuetype && fields.issuetype.name) || '';

  if (!key || !projectKey || !summary) return null;

  // WHICH TYPES THIS PROJECT INGESTS. This was a five-word English list, and a ticket outside it
  // was dropped by `return null` — no message, no count, no way to tell "no tickets matched" from
  // "your tracker does not speak English". A project whose work is "Defect" or "Change Request"
  // ingested nothing.
  //
  // Undeclared means UNFILTERED. Ingesting a type nobody expected is visible and correctable; an
  // empty backlog is neither.
  const wanted = declaredList('JIRA_ISSUE_TYPES').map((t) => t.toLowerCase());
  if (wanted.length && !wanted.includes(issueType.toLowerCase())) return null;

  const descText = typeof description === 'string'
    ? description
    : extractPlainText(description);

  // WHICH TYPES GO TO THE QA ROLE — declared, not matched on English substrings. Deciding this by
  // whether a type name contains "test" or "qa" routes "Änderungsantrag" and "Prüfung" to the
  // wrong role, and routes an English "Latest changes" to QA by accident.
  const qaTypes = declaredList('JIRA_QA_ISSUE_TYPES').map((t) => t.toLowerCase());
  const agentRole = qaTypes.includes(issueType.toLowerCase()) ? 'qa-engineer' : 'engineer';

  return {
    projectKey,
    jiraKey:            key,
    epicKey:            epicLink,
    storyId:            key,
    title:              summary,
    // WHOLE description. It was clipped to 2000 characters here — at the source, so every
    // consumer inherited a truncated field no matter what they did downstream. In brownfield
    // the description IS the contract: the AC gate skips acceptance criteria entirely and
    // records "VCs are derived from the description", and codeline discovery uses it to
    // choose which client repository gets modified. A cap here silently removes requirement
    // text from every one of those decisions, and nothing reports that it happened.
    description:        descText,
    acceptanceCriteria: extractAC(descText, fields),
    // Story points, then a t-shirt-size label if a human actually set one, then the
    // same neutral fallback synthesize-prd-from-jira.js's ingest path already uses.
    // Never a fabricated 'low' from an unestimated ticket.
    effort:             pointsToEffort(points) || sizeLabelToEffort(labels) || 'medium',
    status:             mapStatus(status),
    urgent:             labels.some(l => (typeof l === 'string' ? l : l.name || '').toLowerCase() === 'urgent'),
    agentRole,
    aiProvider:         'claude',
    completed:          mapStatus(status) === 'completed',
  };
}

module.exports = { adapt, pointsToEffort, sizeLabelToEffort, mapStatus, extractAC };
