/**
 * A RUN THAT FINISHED MUST NOT STAY "pending" FOREVER IN THE DASHBOARD.
 *
 * runner.js (the host-side watcher) writes progress and terminal status to
 * spool/status/<id>.json — the ONLY channel from the host back to the container (spool.js's own
 * header). GET /api/runs and GET /api/runs/:id read ONLY the DB, and nothing ever synced the
 * spool's real status back into it: a run that finished (succeeded, failed, killed, whatever)
 * left its row exactly as createRun first wrote it, forever.
 *
 * Found live 2026-09-04: a run that had already failed at pre-flight stayed "pending" in the
 * dashboard for the rest of the session — operator: "no updates are landing on the ui to say
 * what is going on" — and the only way to unblock a NEW save was deleting the stuck row by hand
 * via node:sqlite directly against runs.db.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import * as spool from '../src/spool.js';

let tmp, app, base, server, spoolDir, providerSetsFile;
const PASSWORD = 'let-me-in';

async function start() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'status-sync-'));
  spoolDir = path.join(tmp, 'spool');
  providerSetsFile = path.join(tmp, 'provider-sets.json');
  fs.writeFileSync(providerSetsFile, JSON.stringify({
    sets: { claude: { description: 'x' } },
  }));
  process.env.PROVIDER_SETS_FILE = providerSetsFile;
  app = createApp({ dbFile: path.join(tmp, 'runs.db'), spoolDir, password: PASSWORD, codeLevel: 'v1.6' });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
}

function stop() { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }

const req = (method, p, body) => fetch(`${base}${p}`, {
  method,
  headers: { authorization: `Bearer ${PASSWORD}`, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined,
});

describe('the DB status is synced from the spool the runner actually wrote', () => {
  test('a run the host-side runner marked FAILED shows as failed in GET /api/runs, not stuck pending', async () => {
    await start();
    try {
      const created = await req('POST', '/api/runs', { ticket: 'AMSD-1', requestedBy: 'dune94', providerSet: 'claude' })
        .then((r) => r.json());
      assert.equal(created.status, 'pending');

      // THE REAL CHANNEL: exactly what runner.js's writeStatus() does when a launch dies before
      // ever reaching the pipeline (permission-denied / subnet-mismatch, both since fixed).
      spool.init(spoolDir);
      fs.writeFileSync(
        path.join(spoolDir, 'status', `${created.id}.json`),
        JSON.stringify({ id: created.id, status: 'failed', detail: 'pre-flight aborted', at: new Date().toISOString() }),
      );

      const list = await req('GET', '/api/runs').then((r) => r.json());
      const row = list.find((r) => r.id === created.id);
      assert.equal(row.status, 'failed', 'the grid still shows the pre-launch status — the operator has no idea the run already ended');
      assert.equal(row.detail, 'pre-flight aborted');
    } finally { stop(); }
  });

  test('GET /api/runs/:id is synced too, not just the list endpoint', async () => {
    await start();
    try {
      const created = await req('POST', '/api/runs', { ticket: 'AMSD-2', requestedBy: 'dune94', providerSet: 'claude' })
        .then((r) => r.json());
      spool.init(spoolDir);
      fs.writeFileSync(
        path.join(spoolDir, 'status', `${created.id}.json`),
        JSON.stringify({ id: created.id, status: 'succeeded', detail: 'exit 0', runId: '20260904T000000Z' }),
      );

      const row = await req('GET', `/api/runs/${created.id}`).then((r) => r.json());
      assert.equal(row.status, 'succeeded');
      assert.equal(row.runId, '20260904T000000Z');
    } finally { stop(); }
  });

  test('a run with NO spool status yet stays exactly as the DB last had it (never invents a status)', async () => {
    await start();
    try {
      const created = await req('POST', '/api/runs', { ticket: 'AMSD-3', requestedBy: 'dune94', providerSet: 'claude' })
        .then((r) => r.json());
      // No status file written at all — the runner has not picked it up yet.
      const row = await req('GET', `/api/runs/${created.id}`).then((r) => r.json());
      assert.equal(row.status, 'pending');
    } finally { stop(); }
  });

  test('a run already TERMINAL in the DB is left alone even if a stale spool file disagrees', async () => {
    // A finished row must never revert — the spool status file for an id is only meaningful while
    // that run is the one currently active; a stale leftover from a much earlier attempt must not
    // resurrect a closed row.
    await start();
    try {
      const created = await req('POST', '/api/runs', { ticket: 'AMSD-4', requestedBy: 'dune94', providerSet: 'claude' })
        .then((r) => r.json());
      spool.init(spoolDir);
      fs.writeFileSync(path.join(spoolDir, 'status', `${created.id}.json`),
        JSON.stringify({ id: created.id, status: 'succeeded', detail: 'exit 0' }));
      await req('GET', `/api/runs/${created.id}`); // syncs it to 'succeeded'

      // Now the spool file goes stale/wrong (should never happen in practice, but must not be
      // trusted blindly against a row that has already closed).
      fs.writeFileSync(path.join(spoolDir, 'status', `${created.id}.json`),
        JSON.stringify({ id: created.id, status: 'running', detail: 'stale' }));

      const row = await req('GET', `/api/runs/${created.id}`).then((r) => r.json());
      assert.equal(row.status, 'succeeded', 'a terminal row was reopened by a stale spool file');
    } finally { stop(); }
  });
});
