/**
 * PAUSE AND RESUME FROM THE UI.
 *
 * The pipeline supports two human-in-the-loop pauses, set at launch:
 *
 *   pause 1  EPAM_PAUSE_AFTER_AGENT_MINT=1   after the roster is minted and reviewed
 *   pause 2  EPAM_PAUSE_BEFORE_WRITER=1      inputs ready, before any code is generated
 *
 * THE STATE-MODEL POINT: a paused run EXITS. `run-agent-orchestration.sh` prints the checkpoint and
 * calls `exit 0`. So the process is gone and the machine is FREE — another run could legitimately
 * start — while this run is still resumable from its checkpoint.
 *
 * Therefore `paused` must NOT count as busy, and must carry the pipeline runId, because a resume is
 * `EPAM_RESUME_RUN=<runId>` and without it there is nothing to resume.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from '../src/runs-store.js';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pause-')); });
const dbFile = () => path.join(tmp, 'runs.db');

describe('pause and resume', () => {
  test('a run records which pauses were requested, so the grid can show them', () => {
    const db = store.open(dbFile());
    const run = store.createRun(db, {
      ticket: 'AMSD-1919', requestedBy: 'alice', pauseAfterMint: true, pauseBeforeWriter: true,
    });
    assert.equal(run.pauseAfterMint, 1);
    assert.equal(run.pauseBeforeWriter, 1);
  });

  test('pauses default to off when not asked for', () => {
    const db = store.open(dbFile());
    const run = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice' });
    assert.equal(run.pauseAfterMint, 0);
    assert.equal(run.pauseBeforeWriter, 0);
  });

  test('a PAUSED run does not hold the machine — the process has exited', () => {
    const db = store.open(dbFile());
    const first = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', pauseBeforeWriter: true });
    store.updateProgress(db, first.id, { status: 'paused', runId: '20260903T010438Z' });
    // another run may start: nothing is running
    assert.doesNotThrow(() => store.createRun(db, { ticket: 'A-2', requestedBy: 'bob' }));
  });

  test('a paused run keeps the pipeline runId, without which it cannot be resumed', () => {
    const db = store.open(dbFile());
    const run = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', pauseAfterMint: true });
    store.updateProgress(db, run.id, { status: 'paused', runId: '20260903T010438Z' });
    assert.equal(store.getRun(db, run.id).runId, '20260903T010438Z');
  });

  test('resuming creates a NEW row that points at the run it continues', () => {
    // History must show both: the paused attempt and the resume. Mutating the original row would
    // erase the fact that a human was asked and answered.
    const db = store.open(dbFile());
    const first = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice', pauseBeforeWriter: true });
    store.updateProgress(db, first.id, { status: 'paused', runId: '20260903T010438Z' });

    const resumed = store.resumeRun(db, first.id, { requestedBy: 'bob' });
    assert.equal(resumed.ticket, 'A-1', 'a resume is for the same ticket');
    assert.equal(resumed.resumeOf, first.id);
    assert.equal(resumed.resumeRunId, '20260903T010438Z', 'this becomes EPAM_RESUME_RUN');
    assert.equal(resumed.status, 'pending');
    assert.equal(store.listRuns(db).length, 2, 'both the pause and the resume are history');
  });

  test('refuses to resume a run that is not paused', () => {
    const db = store.open(dbFile());
    const run = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice' });
    assert.throws(() => store.resumeRun(db, run.id, { requestedBy: 'bob' }), /paused/i);
  });

  test('refuses to resume a paused run that never recorded a runId', () => {
    // Without EPAM_RESUME_RUN the launch would start a FRESH run, which on a brownfield defect
    // resets the codeline and discards committed work. Live 2026-09-02: exactly that happened.
    const db = store.open(dbFile());
    const run = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice' });
    store.updateProgress(db, run.id, { status: 'paused' });
    assert.throws(() => store.resumeRun(db, run.id, { requestedBy: 'bob' }), /runId|resume/i);
  });

  test('a resume is refused while something else is actually running', () => {
    const db = store.open(dbFile());
    const first = store.createRun(db, { ticket: 'A-1', requestedBy: 'alice' });
    store.updateProgress(db, first.id, { status: 'paused', runId: 'R1' });
    store.createRun(db, { ticket: 'A-2', requestedBy: 'bob' });   // now busy
    assert.throws(() => store.resumeRun(db, first.id, { requestedBy: 'carol' }), /busy|active/i);
  });
});
