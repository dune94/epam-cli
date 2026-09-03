/**
 * THE RUN STORE — history, and the one rule that protects the machine.
 *
 * Node's native test runner: this component ships standalone with zero runtime dependencies and
 * requires Node 22 for node:sqlite. Using the repo's vitest would couple a shippable artefact to
 * the pipeline's bundler, which could not resolve node:sqlite anyway.
 *
 *   node --test launch-dashboard/backend/test/
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/runs-store.js';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-store-')); });
const dbFile = () => path.join(tmp, 'runs.db');

describe('the run store', () => {
  test('records a created run as pending, with who asked for it', () => {
    const db = store.open(dbFile());
    const run = store.createRun(db, { ticket: 'AMSD-1919', requestedBy: 'alice' });
    assert.ok(run.id, 'a run needs an id to be addressable');
    assert.equal(run.ticket, 'AMSD-1919');
    assert.equal(run.status, 'pending');
    // the question after "why is this expensive" is "who ran it"
    assert.equal(run.requestedBy, 'alice');
    assert.ok(run.createdAt);
  });

  test('lists runs newest first, so the grid shows the current one at the top', () => {
    const db = store.open(dbFile());
    const first = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice' });
    store.finishRun(db, first.id, 'succeeded');
    store.createRun(db, { ticket: 'A-2', requestedBy: 'bob' });
    assert.deepEqual(store.listRuns(db).map((r) => r.ticket), ['A-2', 'A-1']);
  });

  test('REFUSES a second run while one is active — the machine-protecting rule', () => {
    // Two concurrent runs exhausted a 14GB workstation on 2026-09-02 and forced a restart.
    // Enforced in the store because a UI check is advisory the moment a second tab opens.
    const db = store.open(dbFile());
    store.createRun(db, { ticket: 'A-1', requestedBy: 'alice' });
    assert.throws(
      () => store.createRun(db, { ticket: 'A-2', requestedBy: 'bob' }),
      /busy|already|active/i,
    );
    assert.equal(store.listRuns(db).length, 1, 'the rejected run must not be recorded');
  });

  test('allows a new run once the previous one has finished — success or failure', () => {
    const db = store.open(dbFile());
    const first = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice' });
    store.finishRun(db, first.id, 'failed');
    assert.equal(store.createRun(db, { ticket: 'A-2', requestedBy: 'bob' }).ticket, 'A-2');
  });

  test('survives a restart — history is the point of a database', () => {
    const file = dbFile();
    const db1 = store.open(file);
    const r = store.createRun(db1, { ticket: 'A-1', requestedBy: 'alice' });
    store.finishRun(db1, r.id, 'succeeded');
    store.close(db1);

    const rows = store.listRuns(store.open(file));
    assert.equal(rows.length, 1, 'the run vanished across a restart');
    assert.equal(rows[0].status, 'succeeded');
  });

  test('a stalled run is distinguishable from a live one', () => {
    // A "pending" row that never changes is the silent-failure shape this project keeps hitting.
    const db = store.open(dbFile());
    const run = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice' });
    store.updateProgress(db, run.id, { stage: 'external verification' });
    const row = store.listRuns(db)[0];
    assert.equal(row.stage, 'external verification');
    assert.ok(row.updatedAt, 'without a heartbeat, stalled and running look identical');
  });

  test('refuses a request with no ticket, rather than recording a run for nothing', () => {
    const db = store.open(dbFile());
    assert.throws(() => store.createRun(db, { ticket: '', requestedBy: 'alice' }), /ticket/i);
    assert.equal(store.listRuns(db).length, 0);
  });
});
