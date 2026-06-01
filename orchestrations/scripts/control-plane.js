#!/usr/bin/env node
// Control plane sidecar for epam-cli orchestration.
// Exposes a minimal HTTP API on port 8094 (or $CONTROL_PLANE_PORT).
// The orchestrator polls $LOG_DIR/PAUSED between stories; redirect requests
// are written to $LOG_DIR/redirect-<storyId>.json for the story runner to pick up.
//
// Routes:
//   POST /pause               — create sentinel $LOG_DIR/PAUSED
//   POST /resume              — remove sentinel $LOG_DIR/PAUSED
//   POST /redirect/:storyId   — write redirect JSON { targetAgent, requestedAt }
//   GET  /status              — return { paused, pendingRedirects[] }
//   GET  /health              — 200 OK

'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const crypto = require('crypto');

const LIB_DIR = path.join(__dirname, 'lib');
const webhookQueue = require(path.join(LIB_DIR, 'webhook-queue'));
const jiraAdapter  = require(path.join(LIB_DIR, 'jira-adapter'));

const PORT               = parseInt(process.env.CONTROL_PLANE_PORT || '8094', 10);
const LOG_DIR            = process.env.LOG_DIR;
const JIRA_WEBHOOK_SECRET = process.env.JIRA_WEBHOOK_SECRET || '';
// PRD output dir for webhook-generated PRDs (defaults to orchestrations/ dir)
const WEBHOOK_PRD_DIR    = process.env.WEBHOOK_PRD_DIR ||
                           path.resolve(__dirname, '..', '');

if (!LOG_DIR) {
  process.stderr.write('[control-plane] ERROR: LOG_DIR env var is required\n');
  process.exit(1);
}

fs.mkdirSync(LOG_DIR, { recursive: true });

// Init webhook queue with persistent store in LOG_DIR
webhookQueue.init({
  queueFile:  path.join(LOG_DIR, 'webhook-queue.json'),
  prdOutDir:  WEBHOOK_PRD_DIR,
  onFlush: (projectKey, prdPath) => {
    process.stdout.write(`[control-plane] webhook PRD ready: ${prdPath}\n`);
  },
});

const PAUSED_SENTINEL = path.join(LOG_DIR, 'PAUSED');

// ── HMAC verification ─────────────────────────────────────────────────────────

function verifyJiraSignature(rawBody, signatureHeader) {
  if (!JIRA_WEBHOOK_SECRET) return true; // dev mode — accept all
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', JIRA_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function isPaused() {
  return fs.existsSync(PAUSED_SENTINEL);
}

// Read and parse the PAUSED sentinel content.
// Returns a reason object, or null if not paused.
function pauseReason() {
  if (!isPaused()) return null;
  try {
    const raw = fs.readFileSync(PAUSED_SENTINEL, 'utf8').trim();
    try {
      return JSON.parse(raw);
    } catch {
      return { reason: 'operator_pause', pausedAt: raw };
    }
  } catch {
    return { reason: 'operator_pause' };
  }
}

function pendingRedirects() {
  try {
    return fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith('redirect-') && f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(LOG_DIR, f), 'utf8')); }
        catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => { chunks.push(chunk); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      resolve({ raw, text: raw.toString('utf8') });
    });
    req.on('error', reject);
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

// ── router ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url || '/');
  const pathname = parsed.pathname || '/';
  const method   = req.method || 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  // GET /health
  if (method === 'GET' && pathname === '/health') {
    send(res, 200, { status: 'ok', pid: process.pid });
    return;
  }

  // GET /status
  if (method === 'GET' && pathname === '/status') {
    send(res, 200, { paused: isPaused(), pauseReason: pauseReason(), pendingRedirects: pendingRedirects() });
    return;
  }

  // POST /pause
  if (method === 'POST' && pathname === '/pause') {
    fs.writeFileSync(PAUSED_SENTINEL, JSON.stringify({ reason: 'operator_pause', pausedAt: new Date().toISOString() }));
    process.stdout.write(`[control-plane] PAUSED\n`);
    send(res, 200, { paused: true, pauseReason: pauseReason() });
    return;
  }

  // POST /resume
  if (method === 'POST' && pathname === '/resume') {
    try { fs.unlinkSync(PAUSED_SENTINEL); } catch { /* already gone */ }
    process.stdout.write(`[control-plane] RESUMED\n`);
    send(res, 200, { paused: false });
    return;
  }

  // POST /webhook/jira
  if (method === 'POST' && pathname === '/webhook/jira') {
    let raw, text;
    try { ({ raw, text } = await readBody(req)); } catch { send(res, 400, { error: 'read error' }); return; }

    const sig = req.headers['x-hub-signature-256'] || req.headers['x-jira-signature'] || '';
    if (!verifyJiraSignature(raw, sig)) {
      process.stdout.write('[control-plane] webhook/jira: invalid signature\n');
      send(res, 401, { error: 'invalid signature' });
      return;
    }

    const payload = parseJson(text);
    if (!payload) { send(res, 400, { error: 'invalid JSON' }); return; }

    const event = jiraAdapter.adapt(payload);
    if (!event) {
      send(res, 202, { status: 'ignored', reason: 'unrecognised event type' });
      return;
    }

    webhookQueue.enqueue(event);
    send(res, 202, { status: 'queued', jiraKey: event.jiraKey, urgent: event.urgent });
    return;
  }

  // POST /redirect/:storyId
  const redirectMatch = pathname.match(/^\/redirect\/([^/]+)$/);
  if (method === 'POST' && redirectMatch) {
    const storyId = decodeURIComponent(redirectMatch[1]);
    let text = '{}';
    try { ({ text } = await readBody(req)); } catch { /* ignore */ }
    const body = parseJson(text) || {};
    const targetAgent = (body.targetAgent || body.target || '').trim();
    if (!targetAgent) {
      send(res, 400, { error: 'targetAgent is required' });
      return;
    }
    const record = { storyId, targetAgent, requestedAt: new Date().toISOString() };
    const dest = path.join(LOG_DIR, `redirect-${storyId}.json`);
    fs.writeFileSync(dest, JSON.stringify(record, null, 2));
    process.stdout.write(`[control-plane] REDIRECT ${storyId} → ${targetAgent}\n`);
    send(res, 200, record);
    return;
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`[control-plane] listening on http://127.0.0.1:${PORT}  LOG_DIR=${LOG_DIR}\n`);
});

process.on('SIGTERM', () => { server.close(); process.exit(0); });
process.on('SIGINT',  () => { server.close(); process.exit(0); });
