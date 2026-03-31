'use strict';

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── LAN IP Detection ────────────────────────────────────────────────────────
const os = require('os');
const { execSync } = require('child_process');
function getLanIp() {
  // On WSL2: the internal IP (172.x) is not reachable from WiFi devices.
  // Detect the Windows host WiFi IP via powershell for QR codes.
  try {
    const isWSL = os.release().toLowerCase().includes('microsoft');
    if (isWSL) {
      const result = execSync(
        'powershell.exe -NoProfile -c "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -match \'Wi-Fi|Ethernet\' -and $_.PrefixOrigin -eq \'Dhcp\' } | Select-Object -First 1 -ExpandProperty IPAddress"',
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      if (result && !result.startsWith('172.')) return result;
    }
  } catch { /* fall through */ }

  // Standard: pick first non-internal IPv4
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}
const LAN_IP = process.env.LAN_IP || getLanIp();

// ─── Auth Middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    // Dev mode: accept unauthenticated requests with mock user
    req.user = { sub: 'dev-user', email: 'dev@example.com', tier: 'pro' };
    return next();
  }

  try {
    const token = auth.slice(7);
    const claims = jwt.verify(token, JWT_SECRET);
    req.user = claims;
    next();
  } catch (err) {
    // In dev mode, accept any token and set a mock user
    req.user = { sub: 'dev-user', email: 'dev@example.com', tier: 'pro' };
    next();
  }
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '0.1.0' });
});

// ─── User Profile ─────────────────────────────────────────────────────────────
app.get('/v1/users/me', requireAuth, (req, res) => {
  res.json({
    sub: req.user.sub || 'dev-user-123',
    email: req.user.email || 'dev@example.com',
    name: req.user.name || 'Dev User',
    tier: req.user.tier || 'pro',
    createdAt: new Date().toISOString(),
  });
});

// ─── Subscription Tier ────────────────────────────────────────────────────────
app.get('/v1/subscription', requireAuth, (req, res) => {
  res.json({
    tier: req.user.tier || 'pro',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    features: {
      maxContextTokens: 200000,
      maxOutputTokens: 8192,
      rateLimit: { requestsPerMinute: 60, tokensPerDay: 1000000 },
    },
  });
});

// ─── LLM Proxy: Anthropic ─────────────────────────────────────────────────────
app.post('/v1/proxy/anthropic/messages', requireAuth, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: 'service_unavailable',
      message: 'ANTHROPIC_API_KEY not configured in backend-stub',
    });
  }

  try {
    const stream = req.body.stream === true;

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        req.body,
        {
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          responseType: 'stream',
        }
      );

      response.data.pipe(res);
    } else {
      const { data } = await axios.post(
        'https://api.anthropic.com/v1/messages',
        req.body,
        {
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
        }
      );
      res.json(data);
    }
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: err.message };
    res.status(status).json(data);
  }
});

// ─── LLM Proxy: OpenAI ────────────────────────────────────────────────────────
app.post('/v1/proxy/openai/chat/completions', requireAuth, async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(503).json({
      error: 'service_unavailable',
      message: 'OPENAI_API_KEY not configured in backend-stub',
    });
  }

  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      req.body,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'content-type': 'application/json',
        },
      }
    );
    res.json(data);
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: err.message };
    res.status(status).json(data);
  }
});

// ─── Dev Token Endpoint (for testing) ────────────────────────────────────────
app.post('/v1/dev/token', (req, res) => {
  const { email = 'dev@example.com', tier = 'pro' } = req.body;
  const token = jwt.sign(
    { sub: `dev-${Date.now()}`, email, tier, iss: 'http://localhost:8080' },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
  res.json({ access_token: token, token_type: 'Bearer', expires_in: 86400 });
});

// ─── Remote Session Web UI ───────────────────────────────────────────────────
const nodePath = require('path');
app.get('/remote/:token', (req, res) => {
  res.sendFile(nodePath.join(__dirname, 'remote-ui.html'));
});

// ─── Remote Sessions (in-memory store) ───────────────────────────────────────
const crypto = require('crypto');
const remoteSessions = new Map();

// POST /v1/remote/sessions — create a new remote session
app.post('/v1/remote/sessions', requireAuth, (req, res) => {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const session = {
    token,
    createdBy: req.user.sub || 'dev-user',
    createdAt: new Date().toISOString(),
    expiresAt,
    status: 'pending',
    payload: req.body,
    returnPayload: null,
  };
  remoteSessions.set(token, session);

  // Auto-expire after 10 minutes
  setTimeout(() => remoteSessions.delete(token), 10 * 60 * 1000);

  // Use PUBLIC_URL env (e.g. ngrok) if available, else construct from LAN_IP
  const baseUrl = process.env.PUBLIC_URL || `http://${LAN_IP}:${PORT}`;
  const claimUrl = `${baseUrl}/v1/remote/sessions/${token}`;
  res.status(201).json({ claimToken: token, expiresAt, url: claimUrl });
});

// GET /v1/remote/sessions/:token — claim a session (atomic: returns payload and marks claimed)
app.get('/v1/remote/sessions/:token', (req, res) => {
  const session = remoteSessions.get(req.params.token);
  if (!session) {
    return res.status(404).json({ error: 'not_found', message: 'Session not found or expired' });
  }
  if (session.status !== 'pending') {
    return res.status(409).json({ error: 'already_claimed', message: `Session status: ${session.status}` });
  }
  session.status = 'claimed';
  // Return the original bundle (encryptedPayload, nonce, tag, metadata)
  res.json(session.payload);
});

// POST /v1/remote/sessions/:token/return — return results to session owner
app.post('/v1/remote/sessions/:token/return', (req, res) => {
  const session = remoteSessions.get(req.params.token);
  if (!session) {
    return res.status(404).json({ error: 'not_found', message: 'Session not found or expired' });
  }
  if (session.status !== 'claimed') {
    return res.status(409).json({ error: 'invalid_state', message: `Session status: ${session.status}` });
  }
  session.status = 'returned';
  session.returnPayload = req.body.payload || req.body;
  res.json({ status: 'returned' });
});

// GET /v1/remote/sessions/:token/return — reclaim returned results (bundle passthrough)
app.get('/v1/remote/sessions/:token/return', requireAuth, (req, res) => {
  const session = remoteSessions.get(req.params.token);
  if (!session) {
    return res.status(404).json({ error: 'not_found', message: 'Session not found or expired' });
  }
  if (session.status !== 'returned') {
    return res.status(409).json({ error: 'not_returned', message: `Session status: ${session.status}` });
  }
  // Atomic: delete after reclaim, return the encrypted bundle
  remoteSessions.delete(req.params.token);
  res.json(session.returnPayload);
});

// GET /v1/remote/sessions/:token/status — check session status
app.get('/v1/remote/sessions/:token/status', (req, res) => {
  const session = remoteSessions.get(req.params.token);
  if (!session) {
    return res.status(404).json({ error: 'not_found', message: 'Session not found or expired' });
  }
  res.json({ token: session.token, status: session.status, createdAt: session.createdAt });
});

app.listen(PORT, () => {
  console.log(`Backend stub running on http://localhost:${PORT}`);
  console.log(`  LAN address: http://${LAN_IP}:${PORT}`);
});
