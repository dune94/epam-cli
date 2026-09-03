/**
 * A SUCCESSFUL RUN MUST BE REPLAYABLE.
 *
 * Replay means: launch again with the SAME inputs and get the same result. That is only true if the
 * row captured every input — and the inputs include the CODE LEVEL. A replay against different
 * pipeline code is not a replay, it is a new experiment wearing the same name.
 *
 * Operator, 2026-09-02: "no manipulations, otherwise it is not repeatable and replayable."
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/runs-store.js';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-')); });
const dbFile = () => path.join(tmp, 'runs.db');

const succeed = (db, run, codeLevel = 'v1.6') => {
  store.updateProgress(db, run.id, { status: 'running', runId: '20260903T010438Z', codeLevel });
  return store.finishRun(db, run.id, 'succeeded');
};

describe('replay', () => {
  test('a run records the code level it ran against', () => {
    const db = store.open(dbFile());
    const run = store.createRun(db, { ticket: 'AMSD-1919', requestedBy: 'alice', codeLevel: 'v1.6', providerSet: 'claude' });
    assert.equal(run.codeLevel, 'v1.6');
  });

  test('replaying a successful run reproduces every launch input', () => {
    const db = store.open(dbFile());
    const orig = store.createRun(db, {
      ticket: 'AMSD-1919', requestedBy: 'alice',
      pauseAfterMint: true, pauseBeforeWriter: false, codeLevel: 'v1.6',
      providerSet: 'claude',
    });
    succeed(db, orig);

    const replay = store.replayRun(db, orig.id, { requestedBy: 'bob' });
    assert.equal(replay.ticket, 'AMSD-1919');
    assert.equal(replay.pauseAfterMint, 1);
    assert.equal(replay.pauseBeforeWriter, 0);
    assert.equal(replay.codeLevel, 'v1.6', 'a replay against other code is not a replay');
    assert.equal(replay.replayOf, orig.id);
    assert.equal(replay.status, 'pending');
  });

  test('a replay is a FRESH run, never a resume', () => {
    // A resume continues a checkpoint; a replay starts over. Carrying resumeRunId into a replay
    // would silently continue the original instead of reproducing it.
    const db = store.open(dbFile());
    const orig = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', codeLevel: 'v1.6', providerSet: 'claude' });
    succeed(db, orig);
    const replay = store.replayRun(db, orig.id, { requestedBy: 'bob' });
    assert.equal(replay.resumeRunId, null, 'a replay must not resume the original');
    assert.equal(replay.resumeOf, null);
  });

  test('both runs remain in history — a replay does not overwrite what it reproduces', () => {
    const db = store.open(dbFile());
    const orig = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', codeLevel: 'v1.6', providerSet: 'claude' });
    succeed(db, orig);
    store.replayRun(db, orig.id, { requestedBy: 'bob' });
    assert.equal(store.listRuns(db).length, 2);
  });

  test('refuses to replay a run that did not finish', () => {
    const db = store.open(dbFile());
    const run = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', codeLevel: 'v1.6', providerSet: 'claude' });
    assert.throws(() => store.replayRun(db, run.id, { requestedBy: 'bob' }), /finish|complete|succeed/i);
  });

  test('a FAILED run is replayable too — reproducing a failure is the point of a bug report', () => {
    const db = store.open(dbFile());
    const run = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', codeLevel: 'v1.6', providerSet: 'claude' });
    store.finishRun(db, run.id, 'failed');
    assert.doesNotThrow(() => store.replayRun(db, run.id, { requestedBy: 'bob' }));
  });

  test('flags when the code level has moved, so a replay is never silently different', () => {
    // The most dangerous replay is one that LOOKS identical. If the installed pipeline is no longer
    // the level the original ran on, the caller must be told rather than discovering it in the diff.
    const db = store.open(dbFile());
    const orig = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', codeLevel: 'v1.6', providerSet: 'claude' });
    succeed(db, orig);
    const replay = store.replayRun(db, orig.id, { requestedBy: 'bob', currentCodeLevel: 'v1.7' });
    assert.equal(replay.codeLevel, 'v1.6', 'the replay still targets the original level');
    assert.match(String(replay.detail), /v1\.6.*v1\.7|code level/i,
      'a moved code level must be recorded on the replay');
  });

  test('refuses to replay while something is running', () => {
    const db = store.open(dbFile());
    const orig = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', codeLevel: 'v1.6', providerSet: 'claude' });
    succeed(db, orig);
    store.createRun(db, { ticket: 'A-2', requestedBy: 'bob', providerSet: 'claude' });
    assert.throws(() => store.replayRun(db, orig.id, { requestedBy: 'carol' }), /busy|active/i);
  });
});
