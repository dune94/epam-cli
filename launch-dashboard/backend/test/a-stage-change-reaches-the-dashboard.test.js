/**
 * A STAGE CHANGE MUST REACH THE DASHBOARD, NOT JUST A STATUS CHANGE.
 *
 * Live run 20260905T015303Z. The runner wrote the truth into the spool —
 *
 *     status: running | stage: roster-review · claude-sonnet-5 · 33s   (01:57:28)
 *
 * and the dashboard reported, three minutes stale —
 *
 *     stage: CodeGraph preflight passed ...                            (01:54:39)
 *
 * because syncActiveRunsFromSpool skipped every row whose STATUS was unchanged:
 *
 *     if (!s || !s.status || s.status === row.status) continue;
 *
 * A run's status is `running` from the moment it starts until it ends. Every stage update in
 * between — which is the entire point of live progress — was therefore discarded. The runner had
 * been correct all along; the copy into the DB refused to carry it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as store from '../src/runs-store.js';
import * as spool from '../src/spool.js';
import { syncActiveRunsFromSpool } from '../src/status-sync.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'stage-sync-'));
  const db = store.open(join(dir, 'runs.db'));
  const spoolDir = join(dir, 'spool');
  spool.init(spoolDir);
  const run = store.createRun(db, { ticket: 'AMSD-1919', requestedBy: 'op', providerSet: 'claude' });
  // The runner keeps writeStatus private, so the status file is written here exactly as it does:
  // one JSON object at spool/status/<id>.json.
  const writeStatus = (body) => writeFileSync(
    join(spoolDir, 'status', `${run.id}.json`),
    JSON.stringify({ id: run.id, ...body, at: new Date().toISOString() }, null, 2) + '\n');
  return { db, spoolDir, run, writeStatus, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a STAGE change with an unchanged status still reaches the dashboard', () => {
  const f = fixture();
  try {
    store.updateProgress(f.db, f.run.id, { status: 'running', stage: 'starting' });
    f.writeStatus({
      status: 'running', stage: 'roster-review · claude-sonnet-5 · 33s',
    });

    syncActiveRunsFromSpool(f.db, f.spoolDir);

    assert.match(String(store.getRun(f.db, f.run.id).stage || ''), /roster-review/,
      'the stage never reached the DB because the status was unchanged — which it is for the '
      + 'whole of a run. Live 2026-09-05: the dashboard sat three minutes behind while the runner '
      + 'was writing the truth into the spool.');
  } finally { f.cleanup(); }
});

test('a status change still syncs, as before', () => {
  const f = fixture();
  try {
    store.updateProgress(f.db, f.run.id, { status: 'running', stage: 'x' });
    f.writeStatus({ status: 'paused', stage: 'post-roster', runId: 'r1' });
    syncActiveRunsFromSpool(f.db, f.spoolDir);
    const r = store.getRun(f.db, f.run.id);
    assert.equal(r.status, 'paused');
    assert.equal(r.runId, 'r1');
  } finally { f.cleanup(); }
});

test('nothing changed means nothing is written — no needless churn', () => {
  const f = fixture();
  try {
    store.updateProgress(f.db, f.run.id, { status: 'running', stage: 'same' });
    const before = store.getRun(f.db, f.run.id).updatedAt;
    f.writeStatus({ status: 'running', stage: 'same' });
    syncActiveRunsFromSpool(f.db, f.spoolDir);
    assert.equal(store.getRun(f.db, f.run.id).updatedAt, before,
      'an identical status was rewritten, which makes updatedAt meaningless as a freshness signal');
  } finally { f.cleanup(); }
});

test('a run with no status file is left exactly as the DB has it', () => {
  const f = fixture();
  try {
    store.updateProgress(f.db, f.run.id, { status: 'running', stage: 'mine' });
    syncActiveRunsFromSpool(f.db, f.spoolDir);
    assert.equal(store.getRun(f.db, f.run.id).stage, 'mine');
  } finally { f.cleanup(); }
});
