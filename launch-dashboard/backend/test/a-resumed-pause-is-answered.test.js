/**
 * A PAUSE THAT HAS BEEN ANSWERED IS NO LONGER A PAUSE.
 *
 * Live 2026-09-04, pipeline-tests-19. The operator resumed a paused run and reported:
 *
 *   "But now the screen is showing a second row - is this expected - the first row still has a
 *    resume button on it even though it is now in flight this was not thought through."
 *
 * resumeRun deliberately creates a NEW row rather than mutating the paused one, so that history
 * records both the pause and the answer to it. That part is right. What it does not do is record
 * that the OLD row has been answered: it stays `paused` forever.
 *
 * Two consequences, one cosmetic and one not:
 *
 *   - the frontend derives `canResume` from `status == 'paused'`, so the stale row keeps offering
 *     a resume button for a decision the operator already made;
 *   - resumeRun's own guard reads THAT row's status, which is still 'paused', so it permits the
 *     resume again. Today a second click is caught incidentally by createRun's busy check while
 *     the resumed run is active — but once that run finishes, the stale row will happily spawn a
 *     DUPLICATE run against the same checkpoint. The protection is accidental, and it expires.
 *
 * The fix is to close the question: an answered pause moves to `resumed`, which is terminal. The
 * row and its history stay exactly where they are.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as store from '../src/runs-store.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'resumed-pause-'));
  const db = store.open(join(dir, 'runs.db'));
  return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A run that has reached a pause, the way the pipeline reports one. */
function pausedRun(db, ticket = 'T-1') {
  const run = store.createRun(db, {
    ticket, requestedBy: 'op', providerSet: 'claude',
    pauseAfterMint: true, pauseBeforeWriter: false,
  });
  store.updateProgress(db, run.id, {
    status: 'paused', stage: 'post-roster', runId: 'run-abc', detail: 'awaiting review',
  });
  return store.getRun(db, run.id);
}

test('the answered pause is marked resumed, so its button retires', () => {
  const { db, cleanup } = freshDb();
  try {
    const paused = pausedRun(db);
    assert.equal(paused.status, 'paused');

    store.resumeRun(db, paused.id, { requestedBy: 'op' });

    const after = store.getRun(db, paused.id);
    assert.equal(after.status, 'resumed',
      'the paused row is still `paused` after being resumed. The frontend derives canResume from '
      + 'exactly this value, so the operator is offered a resume button for a decision they have '
      + 'already made — the live 2026-09-04 report.');
  } finally { cleanup(); }
});

test('and it cannot be resumed a SECOND time — no duplicate run against one checkpoint', () => {
  const { db, cleanup } = freshDb();
  try {
    const paused = pausedRun(db);
    const resumed = store.resumeRun(db, paused.id, { requestedBy: 'op' });

    // Take the resumed run out of the way, so createRun's busy check cannot mask the defect.
    // That check is what accidentally prevents this today, and it expires the moment the
    // resumed run finishes.
    store.finishRun(db, resumed.id, 'succeeded', 'done');

    assert.throws(
      () => store.resumeRun(db, paused.id, { requestedBy: 'op' }),
      /not paused|already resumed|nothing to resume/i,
      'the already-answered pause accepted a second resume. Once the first resumed run finishes, '
      + 'clicking the stale button spawns a DUPLICATE run against the same checkpoint.',
    );
  } finally { cleanup(); }
});

test('the answer is still linked to the question — history is not lost', () => {
  // The whole reason resumeRun creates a new row is that the record of a human being asked must
  // survive. Closing the old row must not break that link.
  const { db, cleanup } = freshDb();
  try {
    const paused = pausedRun(db);
    const resumed = store.resumeRun(db, paused.id, { requestedBy: 'op' });
    assert.equal(resumed.resumeOf, paused.id, 'the resumed run no longer points at the pause it answered');

    const after = store.getRun(db, paused.id);
    assert.equal(after.runId, 'run-abc', 'the paused row lost the pipeline runId it recorded');
    assert.equal(after.ticket, paused.ticket, 'the paused row lost its ticket');
  } finally { cleanup(); }
});

test('a resumed run is not mistaken for an active one', () => {
  // `resumed` is terminal: it must not make the ticket look busy, or the next launch is refused
  // with "already running" for a run that ended.
  const { db, cleanup } = freshDb();
  try {
    const paused = pausedRun(db, 'T-9');
    const resumed = store.resumeRun(db, paused.id, { requestedBy: 'op' });
    store.finishRun(db, resumed.id, 'succeeded', 'done');

    assert.doesNotThrow(
      () => store.createRun(db, { ticket: 'T-9', requestedBy: 'op', providerSet: 'claude' }),
      'a closed pause is holding the ticket busy — no further run of it can ever be launched',
    );
  } finally { cleanup(); }
});
