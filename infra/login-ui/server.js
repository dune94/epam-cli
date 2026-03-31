'use strict';

const express = require('express');
const axios = require('axios');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3001;
const HYDRA_ADMIN_URL = process.env.HYDRA_ADMIN_URL || 'http://localhost:4445';
const KRATOS_PUBLIC_URL = process.env.KRATOS_PUBLIC_URL || 'http://localhost:4433';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Login Flow ───────────────────────────────────────────────────────────────
app.get('/login', async (req, res) => {
  const loginChallenge = req.query.login_challenge;
  if (!loginChallenge) {
    return res.status(400).send('Missing login_challenge');
  }

  try {
    const { data } = await axios.get(
      `${HYDRA_ADMIN_URL}/admin/oauth2/auth/requests/login`,
      { params: { login_challenge: loginChallenge } }
    );

    if (data.skip) {
      const acceptRes = await axios.put(
        `${HYDRA_ADMIN_URL}/admin/oauth2/auth/requests/login/accept`,
        { subject: data.subject },
        { params: { login_challenge: loginChallenge } }
      );
      return res.redirect(acceptRes.data.redirect_to);
    }

    res.send(`
      <!DOCTYPE html>
      <html>
        <head><title>EPAM CLI Login</title>
        <style>
          body { font-family: sans-serif; max-width: 400px; margin: 100px auto; padding: 20px; }
          input { width: 100%; padding: 8px; margin: 8px 0; box-sizing: border-box; }
          button { width: 100%; padding: 10px; background: #0066cc; color: white; border: none; cursor: pointer; }
          button:hover { background: #0052a3; }
          .error { color: red; }
        </style>
        </head>
        <body>
          <h2>Sign in to EPAM CLI</h2>
          ${req.query.error ? `<p class="error">${req.query.error}</p>` : ''}
          <form method="POST" action="/login">
            <input type="hidden" name="login_challenge" value="${loginChallenge}" />
            <label>Email: <input type="email" name="email" required /></label>
            <label>Password: <input type="password" name="password" required /></label>
            <button type="submit">Sign In</button>
          </form>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('Login flow error:', err.message);
    res.status(500).send('Login service unavailable');
  }
});

app.post('/login', async (req, res) => {
  const { login_challenge, email, password } = req.body;

  // In dev: accept any non-empty credentials (kratos handles real auth)
  if (!email || !password) {
    return res.redirect(`/login?login_challenge=${login_challenge}&error=Invalid+credentials`);
  }

  try {
    // For dev stub: auto-accept login with email as subject
    const { data } = await axios.put(
      `${HYDRA_ADMIN_URL}/admin/oauth2/auth/requests/login/accept`,
      {
        subject: email,
        remember: true,
        remember_for: 3600,
        acr: '0',
      },
      { params: { login_challenge: login_challenge } }
    );
    res.redirect(data.redirect_to);
  } catch (err) {
    console.error('Login accept error:', err.message);
    res.redirect(`/login?login_challenge=${login_challenge}&error=Authentication+failed`);
  }
});

// ─── Consent Flow ─────────────────────────────────────────────────────────────
app.get('/consent', async (req, res) => {
  const consentChallenge = req.query.consent_challenge;
  if (!consentChallenge) {
    return res.status(400).send('Missing consent_challenge');
  }

  try {
    const { data } = await axios.get(
      `${HYDRA_ADMIN_URL}/admin/oauth2/auth/requests/consent`,
      { params: { consent_challenge: consentChallenge } }
    );

    // Auto-accept consent in dev
    const acceptRes = await axios.put(
      `${HYDRA_ADMIN_URL}/admin/oauth2/auth/requests/consent/accept`,
      {
        grant_scope: data.requested_scope,
        grant_access_token_audience: data.requested_access_token_audience,
        session: {
          access_token: {
            tier: 'pro',
            email: data.subject,
          },
          id_token: {
            email: data.subject,
            name: data.subject,
          },
        },
        remember: true,
        remember_for: 3600,
      },
      { params: { consent_challenge: consentChallenge } }
    );

    res.redirect(acceptRes.data.redirect_to);
  } catch (err) {
    console.error('Consent flow error:', err.message);
    res.status(500).send('Consent service unavailable');
  }
});

// ─── Device Activation ────────────────────────────────────────────────────────
app.get('/activate', async (req, res) => {
  const { user_code } = req.query;
  res.send(`
    <!DOCTYPE html>
    <html>
      <head><title>Activate EPAM CLI</title>
      <style>
        body { font-family: sans-serif; max-width: 400px; margin: 100px auto; padding: 20px; text-align: center; }
        .code { font-size: 2em; font-weight: bold; letter-spacing: 0.2em; color: #0066cc; }
        input { width: 100%; padding: 8px; margin: 8px 0; box-sizing: border-box; text-align: center; font-size: 1.2em; }
        button { padding: 10px 30px; background: #0066cc; color: white; border: none; cursor: pointer; }
      </style>
      </head>
      <body>
        <h2>Activate EPAM CLI</h2>
        ${user_code
          ? `<p>Confirming code: <span class="code">${user_code}</span></p>
             <p>Sign in below to authorize your device.</p>
             <a href="/login?user_code=${user_code}">Sign in to activate</a>`
          : `<p>Enter the code shown in your terminal:</p>
             <form method="GET" action="/activate">
               <input type="text" name="user_code" placeholder="XXXX-XXXX" required />
               <button type="submit">Activate</button>
             </form>`
        }
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Login UI running on http://localhost:${PORT}`);
});
