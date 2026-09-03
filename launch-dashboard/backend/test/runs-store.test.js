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
import { DatabaseSync } from 'node:sqlite';
import * as store from '../src/runs-store.js';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-store-')); });
const dbFile = () => path.join(tmp, 'runs.db');

describe('the run store', () => {
  test('records a created run as pending, with who asked for it', () => {
    const db = store.open(dbFile());
    const run = store.createRun(db, { ticket: 'AMSD-1919', requestedBy: 'alice', providerSet: 'claude' });
    assert.ok(run.id, 'a run needs an id to be addressable');
    assert.equal(run.ticket, 'AMSD-1919');
    assert.equal(run.status, 'pending');
    // the question after "why is this expensive" is "who ran it"
    assert.equal(run.requestedBy, 'alice');
    assert.ok(run.createdAt);
  });

  test('lists runs newest first, so the grid shows the current one at the top', () => {
    const db = store.open(dbFile());
    const first = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', providerSet: 'claude' });
    store.finishRun(db, first.id, 'succeeded');
    store.createRun(db, { ticket: 'A-2', requestedBy: 'bob', providerSet: 'claude' });
    assert.deepEqual(store.listRuns(db).map((r) => r.ticket), ['A-2', 'A-1']);
  });

  test('REFUSES a second run while one is active — the machine-protecting rule', () => {
    // Two concurrent runs exhausted a 14GB workstation on 2026-09-02 and forced a restart.
    // Enforced in the store because a UI check is advisory the moment a second tab opens.
    const db = store.open(dbFile());
    store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', providerSet: 'claude' });
    assert.throws(
      () => store.createRun(db, { ticket: 'A-2', requestedBy: 'bob', providerSet: 'claude' }),
      /busy|already|active/i,
    );
    assert.equal(store.listRuns(db).length, 1, 'the rejected run must not be recorded');
  });

  test('allows a new run once the previous one has finished — success or failure', () => {
    const db = store.open(dbFile());
    const first = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', providerSet: 'claude' });
    store.finishRun(db, first.id, 'failed');
    assert.equal(store.createRun(db, { ticket: 'A-2', requestedBy: 'bob', providerSet: 'claude' }).ticket, 'A-2');
  });

  test('survives a restart — history is the point of a database', () => {
    const file = dbFile();
    const db1 = store.open(file);
    const r = store.createRun(db1, { ticket: 'A-1', requestedBy: 'alice', providerSet: 'claude' });
    store.finishRun(db1, r.id, 'succeeded');
    store.close(db1);

    const rows = store.listRuns(store.open(file));
    assert.equal(rows.length, 1, 'the run vanished across a restart');
    assert.equal(rows[0].status, 'succeeded');
  });

  test('a stalled run is distinguishable from a live one', () => {
    // A "pending" row that never changes is the silent-failure shape this project keeps hitting.
    const db = store.open(dbFile());
    const run = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', providerSet: 'claude' });
    store.updateProgress(db, run.id, { stage: 'external verification' });
    const row = store.listRuns(db)[0];
    assert.equal(row.stage, 'external verification');
    assert.ok(row.updatedAt, 'without a heartbeat, stalled and running look identical');
  });

  test('refuses a request with no ticket, rather than recording a run for nothing', () => {
    const db = store.open(dbFile());
    assert.throws(() => store.createRun(db, { ticket: '', requestedBy: 'alice', providerSet: 'claude' }), /ticket/i);
    assert.equal(store.listRuns(db).length, 0);
  });

  test('refuses a run with no providerSet — no vendor is ever guessed', () => {
    const db = store.open(dbFile());
    assert.throws(
      () => store.createRun(db, { ticket: 'A-1', requestedBy: 'alice' }),
      /provider/i,
    );
    assert.equal(store.listRuns(db).length, 0, 'the rejected run must not be recorded');
  });

  test('records which provider set a run declared', () => {
    const db = store.open(dbFile());
    const run = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', providerSet: 'openrouter' });
    assert.equal(run.providerSet, 'openrouter');
    assert.equal(store.listRuns(db)[0].providerSet, 'openrouter');
  });

  test('an existing DB from before this feature gets the column added, not recreated', () => {
    // The migration path, not the fresh-CREATE-TABLE path: build a file with the EXACT OLD schema
    // (no providerSet column, a real row already in it, written with the raw driver so nothing
    // from the current store touches it) and prove store.open() migrates it in place — the old
    // row survives, and a NEW row can then declare a providerSet.
    const file = dbFile();
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, ticket TEXT NOT NULL, requestedBy TEXT NOT NULL, status TEXT NOT NULL,
        stage TEXT, runId TEXT, detail TEXT,
        pauseAfterMint INTEGER NOT NULL DEFAULT 0, pauseBeforeWriter INTEGER NOT NULL DEFAULT 0,
        resumeOf TEXT, resumeRunId TEXT, replayOf TEXT, codeLevel TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
    `);
    raw.prepare(`INSERT INTO runs (id,ticket,requestedBy,status,createdAt,updatedAt)
                 VALUES ('pre-1','LEGACY-1','alice','succeeded','t0','t0')`).run();
    assert.ok(
      !raw.prepare('PRAGMA table_info(runs)').all().some((c) => c.name === 'providerSet'),
      'the fixture must genuinely lack the column, or this test proves nothing',
    );
    raw.close();

    const db = store.open(file); // must not throw, and must migrate in place
    const rows = store.listRuns(db);
    const legacyRow = rows.find((r) => r.id === 'pre-1');
    assert.ok(legacyRow, 'the pre-existing row must survive the migration');
    assert.equal(legacyRow.providerSet, null, 'a pre-migration row honestly has no recorded set');

    const r = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', providerSet: 'claude' });
    assert.equal(store.getRun(db, r.id).providerSet, 'claude');
  });

  test('migrating an already-migrated DB is a no-op, not an error', () => {
    const file = dbFile();
    store.close(store.open(file));
    assert.doesNotThrow(() => store.close(store.open(file)));
  });

  test('resuming without a providerSet override continues with the paused run\'s own set', () => {
    const db = store.open(dbFile());
    const first = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', providerSet: 'codemie' });
    store.updateProgress(db, first.id, { runId: 'orch-1', status: 'paused' });
    const resumed = store.resumeRun(db, first.id, { requestedBy: 'bob' });
    assert.equal(resumed.providerSet, 'codemie', 'resume must default to the paused run\'s own set');
  });

  test('resuming WITH a providerSet override swaps to the given set', () => {
    const db = store.open(dbFile());
    const first = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', providerSet: 'claude' });
    store.updateProgress(db, first.id, { runId: 'orch-1', status: 'paused' });
    const resumed = store.resumeRun(db, first.id, { requestedBy: 'bob', providerSet: 'openrouter' });
    assert.equal(resumed.providerSet, 'openrouter');
  });

  test('resuming into mockserver is REFUSED — the no-pay set is never a live-run swap target', () => {
    const db = store.open(dbFile());
    const first = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', providerSet: 'claude' });
    store.updateProgress(db, first.id, { runId: 'orch-1', status: 'paused' });
    assert.throws(
      () => store.resumeRun(db, first.id, { requestedBy: 'bob', providerSet: 'mockserver' }),
      /mockserver/i,
    );
  });

  test('a replay always inherits the original providerSet — no override accepted', () => {
    const db = store.open(dbFile());
    const first = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', providerSet: 'codemie' });
    store.finishRun(db, first.id, 'succeeded');
    const replayed = store.replayRun(db, first.id, { requestedBy: 'bob' });
    assert.equal(replayed.providerSet, 'codemie');
  });
});
