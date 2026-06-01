'use strict';
/**
 * webhook-queue.js — Debounced Jira webhook batch aggregator.
 *
 * Groups inbound Jira events by projectKey. Holds events for DEBOUNCE_MS
 * (default 45s) then flushes as a batch — collapsing rapid Jira edits into
 * a single orchestration trigger. Events labelled "urgent" bypass the window
 * and flush immediately.
 *
 * Queue is persisted to disk so events survive control-plane.js restarts.
 *
 * Usage (from control-plane.js):
 *   const queue = require('./lib/webhook-queue');
 *   queue.init({ queueFile, prdOutDir, debounceMs });
 *   queue.enqueue(adaptedEvent);   // adaptedEvent from jira-adapter.js
 *
 * Flushed PRDs are written to:
 *   <prdOutDir>/webhook-prd-<projectKey>-<timestamp>.json
 */

const fs   = require('fs');
const path = require('path');

const DEBOUNCE_MS = parseInt(process.env.WEBHOOK_DEBOUNCE_MS || '45000', 10);

let _queueFile  = null;
let _prdOutDir  = null;
let _timers     = {};   // projectKey → timeout handle
let _onFlush    = null; // optional callback(projectKey, prdPath)

// ── Init ───────────────────────────────────────────────────────────────────

function init({ queueFile, prdOutDir, debounceMs, onFlush } = {}) {
  _queueFile = queueFile;
  _prdOutDir = prdOutDir || path.dirname(queueFile || '.');
  if (debounceMs) DEBOUNCE_MS_OVERRIDE = debounceMs; // test override
  if (onFlush) _onFlush = onFlush;

  if (_queueFile && !fs.existsSync(path.dirname(_queueFile))) {
    fs.mkdirSync(path.dirname(_queueFile), { recursive: true });
  }
}

// ── Persistence ────────────────────────────────────────────────────────────

function loadQueue() {
  if (!_queueFile || !fs.existsSync(_queueFile)) return {};
  try { return JSON.parse(fs.readFileSync(_queueFile, 'utf8')); }
  catch { return {}; }
}

function saveQueue(q) {
  if (!_queueFile) return;
  try { fs.writeFileSync(_queueFile, JSON.stringify(q, null, 2)); }
  catch (e) { process.stderr.write(`[webhook-queue] save error: ${e.message}\n`); }
}

// ── Enqueue ────────────────────────────────────────────────────────────────

function enqueue(event) {
  if (!event || !event.projectKey) {
    process.stderr.write('[webhook-queue] enqueue: missing projectKey\n');
    return;
  }

  const q = loadQueue();
  const key = event.projectKey;

  if (!q[key]) q[key] = { events: [], queuedAt: new Date().toISOString() };
  q[key].events.push({ ...event, receivedAt: new Date().toISOString() });
  saveQueue(q);

  process.stdout.write(`[webhook-queue] queued ${event.jiraKey || key} (${q[key].events.length} events in window)\n`);

  // Urgent label — bypass debounce
  if (event.urgent) {
    process.stdout.write(`[webhook-queue] urgent label — flushing ${key} immediately\n`);
    if (_timers[key]) { clearTimeout(_timers[key]); delete _timers[key]; }
    flush(key);
    return;
  }

  // Debounce: reset timer on each new event
  if (_timers[key]) clearTimeout(_timers[key]);
  const delay = (typeof DEBOUNCE_MS_OVERRIDE !== 'undefined') ? DEBOUNCE_MS_OVERRIDE : DEBOUNCE_MS;
  _timers[key] = setTimeout(() => {
    delete _timers[key];
    flush(key);
  }, delay);
}

// ── Flush ──────────────────────────────────────────────────────────────────

function flush(projectKey) {
  const q = loadQueue();
  const bucket = q[projectKey];

  if (!bucket || bucket.events.length === 0) {
    process.stdout.write(`[webhook-queue] flush ${projectKey}: nothing to flush\n`);
    return null;
  }

  const events  = bucket.events;
  const prdPath = buildPrd(projectKey, events);

  // Remove this key from the persisted queue
  delete q[projectKey];
  saveQueue(q);

  process.stdout.write(`[webhook-queue] flushed ${projectKey}: ${events.length} events → ${prdPath}\n`);
  if (_onFlush) _onFlush(projectKey, prdPath);
  return prdPath;
}

// ── PRD construction ───────────────────────────────────────────────────────

function buildPrd(projectKey, events) {
  const timestamp = Date.now();
  const stories   = dedupeStories(events);
  const phases    = groupByEpic(stories);

  const prd = {
    id:          `webhook-${projectKey}-${timestamp}`,
    title:       `Webhook-triggered run — ${projectKey} (${new Date().toISOString()})`,
    version:     '1.0.0',
    lastUpdated: new Date().toISOString().slice(0, 10),
    project: {
      name:        projectKey,
      description: `Auto-generated PRD from ${events.length} Jira webhook event(s)`,
      stack:       { language: 'unknown' },
    },
    implementationOrder: phases.order,
    stories:             phases.stories,
    _webhookMeta: {
      projectKey,
      eventCount:  events.length,
      generatedAt: new Date().toISOString(),
      sourceEvents: events.map(e => e.jiraKey).filter(Boolean),
    },
  };

  const outDir  = _prdOutDir || '.';
  const outFile = path.join(outDir, `webhook-prd-${projectKey}-${timestamp}.json`);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(prd, null, 2));
  } catch (e) {
    process.stderr.write(`[webhook-queue] could not write PRD: ${e.message}\n`);
  }
  return outFile;
}

function dedupeStories(events) {
  // Last-write wins per jiraKey — later events overwrite earlier ones
  const map = {};
  for (const e of events) {
    if (e.jiraKey) map[e.jiraKey] = e;
  }
  return Object.values(map);
}

function groupByEpic(stories) {
  const epicMap  = {};
  const enriched = [];

  for (const s of stories) {
    const epicKey = s.epicKey || 'backlog';
    if (!epicMap[epicKey]) epicMap[epicKey] = [];
    epicMap[epicKey].push(s.storyId || s.jiraKey);
    enriched.push(s);
  }

  const order = {};
  for (const [epic, ids] of Object.entries(epicMap)) {
    order[epic] = ids;
  }

  return { order, stories: enriched };
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = { init, enqueue, flush, loadQueue };
