/**
 * THE HTTP LAYER — thin by design.
 *
 * node:http, no framework. This artefact ships to clients: every dependency is something a security
 * review must accept and the release scanner must cover, and five endpoints do not need Express.
 *
 * The API computes nothing. It writes a request, reads rows, and returns them. Every decision that
 * matters — busy, resumable, replayable — belongs to the store, where it is enforced against the
 * same rows the grid reads.
 */
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

let tmp, app, base, server;
const PASSWORD = 'let-me-in';

const start = async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-'));
  app = createApp({ dbFile: path.join(tmp, 'runs.db'), spoolDir: path.join(tmp, 'spool'),
                    password: PASSWORD, codeLevel: 'v1.6' });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
};

const req = (method, p, { body, password } = {}) => fetch(`${base}${p}`, {
  method,
  headers: {
    'content-type': 'application/json',
    ...(password === null ? {} : { authorization: `Bearer ${password ?? PASSWORD}` }),
  },
  body: body ? JSON.stringify(body) : undefined,
});

describe('the API', () => {
  beforeEach(async () => { if (server) server.close(); await start(); });
  after(() => { if (server) server.close(); });

  test('refuses to start without a password configured — an open launch button spends money', () => {
    assert.throws(() => createApp({ dbFile: ':memory:', spoolDir: tmp, password: '' }), /password/i);
  });

  test('rejects a request with no credentials', async () => {
    const r = await req('GET', '/api/runs', { password: null });
    assert.equal(r.status, 401);
  });

  test('rejects a wrong password', async () => {
    const r = await req('GET', '/api/runs', { password: 'wrong' });
    assert.equal(r.status, 401);
  });

  test('creates a run and returns it', async () => {
    const r = await req('POST', '/api/runs', { body: { ticket: 'AMSD-1919', requestedBy: 'alice' } });
    assert.equal(r.status, 201);
    const j = await r.json();
    assert.equal(j.ticket, 'AMSD-1919');
    assert.equal(j.status, 'pending');
    assert.equal(j.codeLevel, 'v1.6', 'the run must record the code level it will run against');
  });

  test('a created run leaves a request in the spool for the host runner', async () => {
    const r = await req('POST', '/api/runs',
      { body: { ticket: 'AMSD-1919', requestedBy: 'alice', pauseBeforeWriter: true } });
    const { id } = await r.json();
    const f = path.join(tmp, 'spool', 'requests', `${id}.json`);
    assert.ok(fs.existsSync(f), 'nothing was spooled, so the run can never start');
    const spooled = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(spooled.ticket, 'AMSD-1919');
    assert.equal(spooled.pauseBeforeWriter, true, 'the pause choice must reach the runner');
  });

  test('REFUSES a second run while one is active, with a reason a human can read', async () => {
    await req('POST', '/api/runs', { body: { ticket: 'A-1', requestedBy: 'alice' } });
    const r = await req('POST', '/api/runs', { body: { ticket: 'A-2', requestedBy: 'bob' } });
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.match(j.error, /busy|already/i);
    assert.match(j.error, /A-1/, 'the message must name what is blocking');
  });

  test('lists runs newest first for the grid', async () => {
    await req('POST', '/api/runs', { body: { ticket: 'A-1', requestedBy: 'alice' } });
    const rows = await (await req('GET', '/api/runs')).json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ticket, 'A-1');
  });

  test('a stop writes a stop marker — the API never touches a process', async () => {
    const { id } = await (await req('POST', '/api/runs',
      { body: { ticket: 'A-1', requestedBy: 'alice' } })).json();
    const r = await req('POST', `/api/runs/${id}/stop`);
    assert.equal(r.status, 202);
    assert.ok(fs.existsSync(path.join(tmp, 'spool', 'requests', `${id}.stop`)));
  });

  test('rejects a ticket that is missing, rather than spooling a run for nothing', async () => {
    const r = await req('POST', '/api/runs', { body: { requestedBy: 'alice' } });
    assert.equal(r.status, 400);
    assert.equal(fs.readdirSync(path.join(tmp, 'spool', 'requests')).length, 0);
  });

  test('an unknown route is 404, not a stack trace', async () => {
    const r = await req('GET', '/api/nope');
    assert.equal(r.status, 404);
  });
});
