/**
 * THE LAUNCH DASHBOARD MUST SAY WHAT THE PIPELINE IS DOING RIGHT NOW.
 *
 * Operator, 2026-09-04: "also show on UI what is being processed currently in pipeline right now
 * dashboard not useful at all."
 *
 * They are right, and the cause is small and total. runner.js writes the run's status exactly
 * THREE times in its whole life:
 *
 *     writeStatus(..., { status: 'running', stage: 'starting' })    <- once, at launch
 *     writeStatus(..., { status, runId, detail: `exit ${code}` })   <- once, at the end
 *
 * Nothing writes in between. So for the two-and-a-half hours of a real run the dashboard shows
 * "running — starting", and after ten minutes StatusDot correctly gives up and shows
 * "running — no update in 10m". The operator asked the only question the dashboard exists to
 * answer — is it stuck? — and it could not answer, on a perfectly healthy run.
 *
 * THE DATA ALREADY EXISTS AND IS ALREADY LIVE. The pipeline maintains
 * orchestrations/logs/step-status.json — every step with pass/fail/skip/running and a detail line
 * carrying the model — and rewrites it as it goes (`updatedAt` moved 4 minutes before the run
 * aborted). agent-status.json carries the finer-grained events beside it. Neither is read by the
 * launch dashboard. Nothing needs to be invented; it needs to be surfaced.
 *
 * NOTHING IS HARDCODED: no step list, no step name, no phase. The current step is whichever one
 * the pipeline itself marks running, and the label is the pipeline's own.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createRunner } from '../src/runner.js';
import * as spool from '../src/spool.js';

const HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runner-host.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'live-stage-'));
  const spoolDir = join(dir, 'spool');
  spool.init(spoolDir);
  const logs = join(dir, 'logs');
  mkdirSync(logs, { recursive: true });
  return { dir, spoolDir, stepFile: join(logs, 'step-status.json'),
           cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const steps = (arr, updatedAt = new Date().toISOString()) =>
  JSON.stringify({ phase: 'core', updatedAt, steps: arr });

const statusOf = (spoolDir, id) =>
  JSON.parse(readFileSync(join(spoolDir, 'status', `${id}.json`), 'utf8'));

function request(spoolDir, id = 'r1') {
  spool.writeRequest(spoolDir, {
    id, ticket: 'AMSD-1919', requestedBy: 'op', providerSet: 'claude',
    pauseAfterMint: false, pauseBeforeWriter: false,
  });
  return id;
}

describe('a run in flight reports the step it is on', () => {
  test('the stage names the step the PIPELINE says is running', async () => {
    const f = fixture();
    try {
      const id = request(f.spoolDir);
      writeFileSync(f.stepFile, steps([
        { id: '1', label: 'Step 1: Specification pass', status: 'pass', detail: '' },
        { id: '5', label: 'Step 5: Regression guard', status: 'running', detail: 'claude-sonnet-5' },
        { id: '6', label: 'Step 6: mkdir', status: 'pending', detail: '' },
      ]));

      // A launcher that stays in flight long enough for at least one progress poll.
      let seen = null;
      const launcher = async () => {
        await new Promise((r) => setTimeout(r, 120));
        seen = statusOf(f.spoolDir, id);
        return { code: 0, runId: 'run-1' };
      };

      const runner = createRunner({
        spoolDir: f.spoolDir, launcher, progressFile: f.stepFile, progressMs: 20,
      });
      await runner.tick();

      assert.ok(seen, 'the launcher never observed a status');
      assert.notEqual(seen.stage, 'starting',
        'the stage is still "starting" while the pipeline is on Step 5. This is the whole defect: '
        + 'the dashboard shows "running — starting" for the entire run and then goes stale.');
      assert.match(String(seen.stage), /Regression guard/,
        'the stage does not name the step the pipeline reported as running');
    } finally { f.cleanup(); }
  });

  test('and it FOLLOWS the pipeline — a later step replaces an earlier one', async () => {
    // A stage written once is barely better than "starting". This proves it keeps up.
    const f = fixture();
    try {
      const id = request(f.spoolDir);
      writeFileSync(f.stepFile, steps([
        { id: '1', label: 'Step 1: Specification pass', status: 'running', detail: '' },
      ]));

      const observed = [];
      const launcher = async () => {
        await new Promise((r) => setTimeout(r, 80));
        observed.push(statusOf(f.spoolDir, id).stage);
        writeFileSync(f.stepFile, steps([
          { id: '1', label: 'Step 1: Specification pass', status: 'pass', detail: '' },
          { id: '8', label: 'Step 8: Main-branch stories', status: 'running', detail: '' },
        ]));
        await new Promise((r) => setTimeout(r, 120));
        observed.push(statusOf(f.spoolDir, id).stage);
        return { code: 0, runId: 'run-1' };
      };

      const runner = createRunner({
        spoolDir: f.spoolDir, launcher, progressFile: f.stepFile, progressMs: 20,
      });
      await runner.tick();

      assert.match(String(observed[0]), /Specification pass/, 'the first stage was wrong');
      assert.match(String(observed[1]), /Main-branch stories/,
        'the stage never moved on — it is sampled once, not followed');
    } finally { f.cleanup(); }
  });

  test('the run stays identified as running throughout', async () => {
    const f = fixture();
    try {
      const id = request(f.spoolDir);
      writeFileSync(f.stepFile, steps([
        { id: '5', label: 'Step 5: Regression guard', status: 'running', detail: '' },
      ]));
      let mid = null;
      const launcher = async () => {
        await new Promise((r) => setTimeout(r, 100));
        mid = statusOf(f.spoolDir, id);
        return { code: 0, runId: 'run-1' };
      };
      const runner = createRunner({
        spoolDir: f.spoolDir, launcher, progressFile: f.stepFile, progressMs: 20,
      });
      await runner.tick();
      assert.equal(mid.status, 'running',
        'progress reporting changed the run STATUS; only the stage may move while it is in flight');
    } finally { f.cleanup(); }
  });
});

describe('progress reporting can never damage the run it reports on', () => {
  test('the FINAL status wins — progress must not overwrite the outcome', async () => {
    // A watcher that kept ticking after the launcher returned would replace "succeeded" with
    // "running", and a finished run would look live forever.
    const f = fixture();
    try {
      const id = request(f.spoolDir);
      writeFileSync(f.stepFile, steps([
        { id: '5', label: 'Step 5: Regression guard', status: 'running', detail: '' },
      ]));
      const runner = createRunner({
        spoolDir: f.spoolDir,
        launcher: async () => { await new Promise((r) => setTimeout(r, 60)); return { code: 0, runId: 'run-1' }; },
        progressFile: f.stepFile, progressMs: 10,
      });
      await runner.tick();
      await new Promise((r) => setTimeout(r, 80));   // any surviving timer gets its chance here

      const final = statusOf(f.spoolDir, id);
      assert.equal(final.status, 'succeeded', 'the terminal status was overwritten by a progress tick');
      assert.equal(final.runId, 'run-1', 'the runId was lost — without it the run can never be resumed');
    } finally { f.cleanup(); }
  });

  test('a missing progress file is not an error — the run proceeds', async () => {
    const f = fixture();
    try {
      const id = request(f.spoolDir);
      const runner = createRunner({
        spoolDir: f.spoolDir,
        launcher: async () => ({ code: 0, runId: 'run-1' }),
        progressFile: join(f.dir, 'logs', 'does-not-exist.json'), progressMs: 10,
      });
      const r = await runner.tick();
      assert.equal(r.status, 'succeeded');
      assert.equal(statusOf(f.spoolDir, id).status, 'succeeded');
    } finally { f.cleanup(); }
  });

  test('a HALF-WRITTEN progress file is not an error either', async () => {
    // The pipeline rewrites this file constantly; a poll will eventually read one mid-write.
    // Observability must never fail the run it observes.
    const f = fixture();
    try {
      const id = request(f.spoolDir);
      writeFileSync(f.stepFile, '{"phase":"core","steps":[{"id":"5","lab');
      const runner = createRunner({
        spoolDir: f.spoolDir,
        launcher: async () => { await new Promise((r) => setTimeout(r, 60)); return { code: 0, runId: 'run-1' }; },
        progressFile: f.stepFile, progressMs: 10,
      });
      const r = await runner.tick();
      assert.equal(r.status, 'succeeded');
      assert.equal(statusOf(f.spoolDir, id).status, 'succeeded');
    } finally { f.cleanup(); }
  });

  test('progress reporting leaves no timer behind', async () => {
    // A leaked interval holds the daemon's event loop open and keeps writing to a finished run.
    const f = fixture();
    try {
      request(f.spoolDir);
      writeFileSync(f.stepFile, steps([{ id: '1', label: 'Step 1', status: 'running', detail: '' }]));
      const before = process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
      const runner = createRunner({
        spoolDir: f.spoolDir,
        launcher: async () => { await new Promise((r) => setTimeout(r, 40)); return { code: 0 }; },
        progressFile: f.stepFile, progressMs: 10,
      });
      await runner.tick();
      const after = process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
      assert.ok(after <= before,
        `a progress timer outlived the run it watched (${before} -> ${after})`);
    } finally { f.cleanup(); }
  });
});

/**
 * AN UNWIRED FEATURE IS NO FEATURE. The cases above drive createRunner directly with an explicit
 * progressFile — which proves the mechanism and proves nothing about production. This spawns the
 * REAL runner-host.js, the process the installer actually runs, with a fake launcher standing in
 * for the pipeline: the same proven pattern as runner-host-langfuse-passthrough.test.js.
 *
 * The path is not asserted as a string. The fake launcher WRITES step-status.json where the
 * pipeline writes it, relative to EPAM_HOME, and the test reads back what the operator would see.
 */
describe('the real runner-host reports live progress', () => {
  test('a run launched through runner-host.js shows the pipeline\'s current step', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-host-progress-'));
    let child;
    try {
      mkdirSync(join(dir, 'spool', 'requests'), { recursive: true });
      mkdirSync(join(dir, 'spool', 'status'), { recursive: true });
      // Exactly where the pipeline publishes it: $EPAM_HOME/orchestrations/logs/step-status.json
      mkdirSync(join(dir, 'orchestrations', 'logs'), { recursive: true });

      const script = join(dir, 'fake-launcher.sh');
      writeFileSync(script, `#!/usr/bin/env bash
cat > "${join(dir, 'orchestrations', 'logs', 'step-status.json')}" <<'JSON'
{"phase":"core","updatedAt":"2026-09-04T19:20:28+00:00","steps":[
  {"id":"1","label":"Step 1: Specification pass","status":"pass","detail":""},
  {"id":"5","label":"Step 5: Regression guard","status":"running","detail":"claude-sonnet-5"}]}
JSON
sleep 3
echo "RUN NUMBER:  20260904T190854Z"
exit 0
`);
      fs.chmodSync(script, 0o755);

      const spoolDir = join(dir, 'spool');
      spool.writeRequest(spoolDir, {
        id: 'live-1', ticket: 'AMSD-1919', requestedBy: 'op', providerSet: 'claude',
        pauseAfterMint: false, pauseBeforeWriter: false,
      });

      child = spawn(process.execPath, [HOST], {
        env: {
          ...process.env,
          SPOOL_DIR: spoolDir,
          EPAM_HOME: dir,
          EPAM_LAUNCHER: script,
          LAUNCH_PASSWORD: 'test-password',
          // Poll fast enough to observe inside the fake launcher's lifetime. Production leaves
          // this at its 5s default; the value under test is the WIRING, not the interval.
          EPAM_PROGRESS_MS: '200',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Poll for the stage the operator would see, up to the fake launcher's lifetime.
      let stage = null;
      for (let i = 0; i < 60; i++) {
        await sleep(250);
        try {
          const s = JSON.parse(readFileSync(join(spoolDir, 'status', 'live-1.json'), 'utf8'));
          if (s.stage && s.stage !== 'starting') { stage = s.stage; break; }
          if (s.status && s.status !== 'running' && s.status !== 'pending') break;
        } catch { /* not written yet */ }
      }

      assert.ok(stage, 'runner-host.js never reported a stage beyond "starting". The progress '
        + 'watcher is not wired into the process the installer actually runs, so the operator '
        + 'still sees "running — starting" and then "no update in 10m".');
      assert.match(stage, /Regression guard/, `the stage did not name the running step: ${stage}`);
      assert.match(stage, /claude-sonnet-5/, 'the step detail (which carries the model) was dropped');
    } finally {
      if (child) child.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
