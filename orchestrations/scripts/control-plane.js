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

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT     = parseInt(process.env.CONTROL_PLANE_PORT || '8094', 10);
const LOG_DIR  = process.env.LOG_DIR;

if (!LOG_DIR) {
  process.stderr.write('[control-plane] ERROR: LOG_DIR env var is required\n');
  process.exit(1);
}

fs.mkdirSync(LOG_DIR, { recursive: true });

const PAUSED_SENTINEL = path.join(LOG_DIR, 'PAUSED');

// ── helpers ──────────────────────────────────────────────────────────────────

function isPaused() {
  return fs.existsSync(PAUSED_SENTINEL);
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
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
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
    send(res, 200, { paused: isPaused(), pendingRedirects: pendingRedirects() });
    return;
  }

  // POST /pause
  if (method === 'POST' && pathname === '/pause') {
    fs.writeFileSync(PAUSED_SENTINEL, new Date().toISOString());
    process.stdout.write(`[control-plane] PAUSED\n`);
    send(res, 200, { paused: true });
    return;
  }

  // POST /resume
  if (method === 'POST' && pathname === '/resume') {
    try { fs.unlinkSync(PAUSED_SENTINEL); } catch { /* already gone */ }
    process.stdout.write(`[control-plane] RESUMED\n`);
    send(res, 200, { paused: false });
    return;
  }

  // POST /redirect/:storyId
  const redirectMatch = pathname.match(/^\/redirect\/([^/]+)$/);
  if (method === 'POST' && redirectMatch) {
    const storyId = decodeURIComponent(redirectMatch[1]);
    let body = {};
    try { body = await readBody(req); } catch { /* ignore */ }
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
