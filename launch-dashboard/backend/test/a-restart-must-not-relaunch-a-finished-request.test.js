/**
 * A RESTART MUST NOT RE-LAUNCH A REQUEST THAT HAS ALREADY BEEN TAKEN.
 *
 * Live 2026-09-05, and it spends real money.
 *
 * The runner keeps `claimed` as an in-memory Set, and nothing ever removes a request file from the
 * spool. So every request the spool has ever held is `pending()` again the moment the process
 * restarts — and install.sh restarts runner-host whenever launch-dashboard/.env changes, which an
 * update routinely does.
 *
 * What that did: run 4ee80472 launched at 01:53 and PAUSED at 03:03. Its request file stayed in
 * the spool. An in-place update at ~10:50 restarted runner-host, which found the same request
 * "pending", launched the pipeline again, and that second run died at pre-flight — writing
 * `status: failed, detail: exit 1` at 10:52 over a run that had actually paused seven hours
 * earlier. The dashboard then showed a paused run as failed with no runId, so it could not be
 * resumed from the UI at all.
 *
 * The status was a symptom. The defect is that a restart re-runs paid work, and on a healthy
 * codeline it would have run the whole pipeline again rather than dying early.
 *
 * BOTH ENDS MATTER HERE, and the second is the dangerous one to get wrong:
 *   - a request already taken must NOT be launched again after a restart
 *   - a request that was genuinely never taken MUST still launch after a restart, or a queued run
 *     is silently dropped and the operator waits forever for something that will never start
 *
 * THE SIGNAL IS THE STATUS FILE, not a deletion. The runner writes one the moment it takes a
 * request ("running", stage "starting"), so its presence means "this one has been taken" — by this
 * process or a previous one. Deleting the request instead would destroy the record of what was
 * asked for, which spool.js deliberately keeps.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRunner } from '../src/runner.js';
import * as spool from '../src/spool.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'relaunch-'));
  const spoolDir = join(dir, 'spool');
  spool.init(spoolDir);
  const launched = [];
  const runner = () => createRunner({
    spoolDir,
    launcher: async (req) => { launched.push(req.id); return { code: 0, runId: 'run-1' }; },
  });
  const request = (id) => spool.writeRequest(spoolDir, {
    id, ticket: 'AMSD-1919', requestedBy: 'op', providerSet: 'claude',
    pauseAfterMint: false, pauseBeforeWriter: false,
  });
  const writeStatus = (id, body) => writeFileSync(
    join(spoolDir, 'status', `${id}.json`),
    JSON.stringify({ id, ...body, at: new Date().toISOString() }, null, 2) + '\n');
  return { dir, spoolDir, launched, runner, request, writeStatus,
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('a restart and the spool', () => {
  test('END ONE — a request already taken is NOT launched again by a fresh runner', async () => {
    const f = fixture();
    try {
      f.request('r1');
      await f.runner().tick();                 // first process takes it
      assert.deepEqual(f.launched, ['r1']);

      // The process restarts: a brand-new runner, empty in-memory `claimed`, same spool on disk.
      await f.runner().tick();

      assert.deepEqual(f.launched, ['r1'], [
        'the restarted runner launched the same request a second time. install.sh restarts',
        'runner-host whenever .env changes, so an ordinary update re-runs paid work — live',
        '2026-09-05 that re-ran a run which had paused seven hours earlier.',
      ].join('\n'));
    } finally { f.cleanup(); }
  });

  test('END TWO — a request that was NEVER taken still launches after a restart', async () => {
    // The dangerous half. A queued request whose runner died before touching it must still run,
    // or the operator waits forever for something that will never start.
    const f = fixture();
    try {
      f.request('r2');
      await f.runner().tick();
      assert.deepEqual(f.launched, ['r2'], 'a genuinely pending request was never launched');
    } finally { f.cleanup(); }
  });

  test('a run still IN FLIGHT when the runner died is not restarted underneath itself', async () => {
    // Its status says "running" and the pipeline child survives the parent (setsid), so launching
    // again would put two pipelines on one codeline.
    const f = fixture();
    try {
      f.request('r3');
      f.writeStatus('r3', { status: 'running', stage: 'starting' });
      await f.runner().tick();
      assert.deepEqual(f.launched, [],
        'a request whose run may still be in flight was launched a second time');
    } finally { f.cleanup(); }
  });

  test('a PAUSED run is not relaunched — resuming is an explicit act', async () => {
    const f = fixture();
    try {
      f.request('r4');
      f.writeStatus('r4', { status: 'paused', runId: '20260905T015303Z' });
      await f.runner().tick();
      assert.deepEqual(f.launched, [],
        'a paused run was relaunched from the start, discarding its checkpoint');
    } finally { f.cleanup(); }
  });

  test('a CORRUPT status file counts as taken — never relaunch on an unreadable claim', async () => {
    // readStatus returns null for an absent file AND a corrupt one. Treating those alike would
    // relaunch a run that had already started, putting two pipelines on one codeline. A stranded
    // request is visible and re-queueable; a double launch spends money silently.
    const f = fixture();
    try {
      f.request('r6');
      writeFileSync(join(f.spoolDir, 'status', 'r6.json'), '{"status":"run');  // truncated
      await f.runner().tick();
      assert.deepEqual(f.launched, [],
        'a request with an unreadable status was launched again — the claim was discarded because '
        + 'it could not be parsed');
    } finally { f.cleanup(); }
  });

  test('the request FILE is kept — the record of what was asked for is not destroyed', async () => {
    const f = fixture();
    try {
      f.request('r5');
      await f.runner().tick();
      assert.ok(existsSync(join(f.spoolDir, 'requests', 'r5.json')),
        'the request was deleted to mark it taken; spool.js keeps requests deliberately');
    } finally { f.cleanup(); }
  });

  test('a NEW request is still picked up alongside an old finished one', async () => {
    const f = fixture();
    try {
      f.request('old');
      await f.runner().tick();
      f.request('new');
      await f.runner().tick();
      assert.deepEqual(f.launched, ['old', 'new'],
        'an old processed request in the spool is blocking new ones from being seen');
    } finally { f.cleanup(); }
  });
});
