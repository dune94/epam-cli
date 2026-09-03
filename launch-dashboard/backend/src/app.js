/**
 * app.js — the HTTP layer. Thin on purpose.
 *
 * node:http, no framework. This artefact ships to clients: every dependency is something a security
 * review must accept and the release scanner must cover, and five endpoints do not need Express.
 *
 * THE API COMPUTES NOTHING. It writes a request, reads rows, returns them. Every decision that
 * matters — busy, resumable, replayable — lives in the store, enforced against the same rows the
 * grid reads. A rule enforced here would be advisory the moment a second API process exists.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import * as store from './runs-store.js';
import * as spool from './spool.js';
import { listProviderSets } from './provider-sets.js';

const json = (res, code, body) => {
  const s = JSON.stringify(body ?? null);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

/**
 * Constant-time compare. A shared password is weak enough already; leaking its length or prefix
 * through response timing is free to avoid.
 */
function passwordMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('body is not JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * @param {{dbFile:string, spoolDir:string, password:string, codeLevel?:string}} opts
 */
function createApp({ dbFile, spoolDir, password, codeLevel = null }) {
  // AN OPEN LAUNCH BUTTON SPENDS REAL MONEY on a shared key. Refusing to start without a password
  // is the difference between a control and a hope — and a misconfigured install must fail at
  // startup, where someone sees it, not at the first unauthenticated click.
  if (!password || !String(password).trim()) {
    throw new Error('a password is required: an unauthenticated launch button spends real money');
  }

  const db = store.open(dbFile);
  spool.init(spoolDir);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;

      if (p === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true });

      const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!passwordMatches(given, password)) return json(res, 401, { error: 'unauthorized' });

      if (p === '/api/runs' && req.method === 'GET') {
        return json(res, 200, store.listRuns(db));
      }

      if (p === '/api/provider-sets' && req.method === 'GET') {
        return json(res, 200, listProviderSets());
      }

      if (p === '/api/runs' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.ticket || !String(body.ticket).trim()) {
          return json(res, 400, { error: 'a ticket id is required' });
        }
        let run;
        try {
          run = store.createRun(db, {
            ticket: body.ticket,
            requestedBy: body.requestedBy || 'unknown',
            pauseAfterMint: !!body.pauseAfterMint,
            pauseBeforeWriter: !!body.pauseBeforeWriter,
            providerSet: body.providerSet,
            codeLevel,
          });
        } catch (e) {
          if (e.code === 'BUSY') return json(res, 409, { error: e.message, activeRun: e.activeRun });
          return json(res, 400, { error: e.message });
        }
        // SPOOL AFTER the row exists: if the write fails the run is already recorded and visible
        // as pending rather than vanishing, and the runner is the only thing that can start it.
        spool.writeRequest(spoolDir, { ...run, resumeRunId: run.resumeRunId });
        return json(res, 201, run);
      }

      let m = p.match(/^\/api\/runs\/([^/]+)\/stop$/);
      if (m && req.method === 'POST') {
        const run = store.getRun(db, m[1]);
        if (!run) return json(res, 404, { error: 'no such run' });
        spool.writeStop(spoolDir, run.id);
        store.updateProgress(db, run.id, { status: 'stopping' });
        return json(res, 202, { id: run.id, status: 'stopping' });
      }

      m = p.match(/^\/api\/runs\/([^/]+)\/(resume|replay)$/);
      if (m && req.method === 'POST') {
        const body = await readBody(req);
        const requestedBy = body.requestedBy || 'unknown';
        let created;
        try {
          created = m[2] === 'resume'
            // providerSet is OPTIONAL on resume: absent continues with the paused run's own set.
            ? store.resumeRun(db, m[1], { requestedBy, providerSet: body.providerSet })
            // NEVER accepted on replay — a replay reproduces the original exactly, no override.
            : store.replayRun(db, m[1], { requestedBy, currentCodeLevel: codeLevel });
        } catch (e) {
          if (e.code === 'BUSY' || /busy|active/i.test(e.message)) {
            return json(res, 409, { error: e.message });
          }
          return json(res, 400, { error: e.message });
        }
        spool.writeRequest(spoolDir, created);
        return json(res, 201, created);
      }

      m = p.match(/^\/api\/runs\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const run = store.getRun(db, m[1]);
        return run ? json(res, 200, run) : json(res, 404, { error: 'no such run' });
      }

      return json(res, 404, { error: 'not found' });
    } catch (e) {
      // Never a stack trace to a client, and never a 200 for a failure.
      return json(res, 500, { error: String(e && e.message ? e.message : e) });
    }
  });

  server.db = db;
  return server;
}

export { createApp };
