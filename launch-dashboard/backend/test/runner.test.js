/**
 * THE HOST-SIDE RUNNER — the only thing that starts a pipeline.
 *
 * TESTED WITH A STUB LAUNCHER ONLY. No test here starts a real run: a paid run is not a unit test,
 * and this project has spent enough on discovering plumbing bugs that way. The launcher is injected,
 * so everything around it — claiming, locking, status, stopping — is exercised for free.
 *
 * The runner also supports a real --dry mode, so the same paths can be walked on a host without
 * spending anything.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as spool from '../src/spool.js';
import { createRunner } from '../src/runner.js';

let dir, launches;
const stubLauncher = async (req, env, argv) => {
  launches.push({ req, env, argv });
  return { code: 0, runId: '20260903T010438Z' };
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'));
  spool.init(dir);
  launches = [];
});

const request = (id, extra = {}) =>
  spool.writeRequest(dir, { id, ticket: 'AMSD-1919', requestedBy: 'alice', ...extra });

const statusOf = (id) => spool.readStatus(dir, id);

describe('the runner', () => {
  test('picks up a spooled request and launches it', async () => {
    request('r1');
    const runner = createRunner({ spoolDir: dir, providerSet: 'claude', launcher: stubLauncher });
    await runner.tick();
    assert.equal(launches.length, 1, 'the request was not launched');
    assert.equal(launches[0].req.ticket, 'AMSD-1919');
  });

  test('hands the launcher an ENVIRONMENT, and argv carrying only --yes', async () => {
    request('r1', { pauseBeforeWriter: true });
    const runner = createRunner({ spoolDir: dir, providerSet: 'claude', launcher: stubLauncher });
    await runner.tick();
    const { env, argv } = launches[0];
    assert.equal(env.EPAM_PROVIDER_SET, 'claude');
    assert.equal(env.EPAM_PAUSE_BEFORE_WRITER, '1');
    assert.deepEqual(argv, ['--yes']);
  });

  test('writes a status the API can read, from the moment it claims the request', async () => {
    request('r1');
    const runner = createRunner({ spoolDir: dir, providerSet: 'claude', launcher: stubLauncher });
    await runner.tick();
    const s = statusOf('r1');
    assert.ok(s, 'no status written, so the grid would show pending forever');
    assert.ok(['running', 'succeeded'].includes(s.status), `unexpected status: ${s && s.status}`);
    assert.equal(s.runId, '20260903T010438Z', 'the pipeline runId must reach the store or a resume is impossible');
  });

  test('REFUSES to start a second run while one is in flight', async () => {
    // Two concurrent runs exhausted a 14GB workstation on 2026-09-02. The runner owns the lock
    // because it is the only thing that knows a launch is actually in progress.
    request('r1'); request('r2');
    let inFlight = 0, maxSeen = 0;
    const slow = async (req, env, argv) => {
      inFlight += 1; maxSeen = Math.max(maxSeen, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return { code: 0, runId: 'R' };
    };
    const runner = createRunner({ spoolDir: dir, providerSet: 'claude', launcher: slow });
    await Promise.all([runner.tick(), runner.tick()]);
    assert.equal(maxSeen, 1, 'two runs were launched concurrently');
  });

  test('claims a request so a second tick does not launch it twice', async () => {
    request('r1');
    const runner = createRunner({ spoolDir: dir, providerSet: 'claude', launcher: stubLauncher });
    await runner.tick();
    await runner.tick();
    assert.equal(launches.length, 1, 'the same request was launched twice');
  });

  test('a failed launch is recorded as failed, never left pending', async () => {
    request('r1');
    const failing = async () => { throw new Error('launcher blew up'); };
    const runner = createRunner({ spoolDir: dir, providerSet: 'claude', launcher: failing });
    await runner.tick();
    const s = statusOf('r1');
    assert.equal(s.status, 'failed');
    assert.match(s.detail, /blew up/);
  });

  test('a non-zero exit is failed, not succeeded', async () => {
    request('r1');
    const runner = createRunner({
      spoolDir: dir, providerSet: 'claude',
      launcher: async () => ({ code: 1, runId: 'R1' }),
    });
    await runner.tick();
    assert.equal(statusOf('r1').status, 'failed');
  });

  test('a paused exit is recorded as paused WITH its runId, or it can never be resumed', async () => {
    request('r1', { pauseBeforeWriter: true });
    const runner = createRunner({
      spoolDir: dir, providerSet: 'claude',
      launcher: async () => ({ code: 0, runId: '20260903T010438Z', paused: true }),
    });
    await runner.tick();
    const s = statusOf('r1');
    assert.equal(s.status, 'paused');
    assert.equal(s.runId, '20260903T010438Z');
  });

  test('a stop marker stops the run', async () => {
    request('r1');
    let stopped = false;
    const runner = createRunner({
      spoolDir: dir, providerSet: 'claude',
      launcher: async (req, env, argv, ctl) => {
        spool.writeStop(dir, 'r1');
        await ctl.waitForStop();
        stopped = true;
        return { code: 143, runId: 'R1', stopped: true };
      },
    });
    await runner.tick();
    assert.ok(stopped, 'the stop marker was never observed');
    assert.equal(statusOf('r1').status, 'stopped');
  });

  test('DRY mode walks every path and launches nothing', async () => {
    request('r1');
    let launched = false;
    const runner = createRunner({
      spoolDir: dir, providerSet: 'claude', dry: true,
      launcher: async () => { launched = true; return { code: 0 }; },
    });
    await runner.tick();
    assert.equal(launched, false, 'dry mode launched a real run');
    const s = statusOf('r1');
    assert.equal(s.status, 'dry-run');
    assert.ok(s.detail.includes('EPAM_PROVIDER_SET'), 'a dry run must show what it would have launched');
  });

  test('refuses to run at all with no provider set — never guesses a vendor', () => {
    assert.throws(() => createRunner({ spoolDir: dir, launcher: stubLauncher }), /provider set/i);
  });
});
