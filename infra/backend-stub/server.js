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

// ─── Auth Middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing Bearer token' });
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

app.listen(PORT, () => {
  console.log(`Backend stub running on http://localhost:${PORT}`);
});
