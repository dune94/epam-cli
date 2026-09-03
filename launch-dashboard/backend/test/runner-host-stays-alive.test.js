import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE WATCHER MUST STILL BE RUNNING A SECOND LATER.
 *
 * runner-host.js printed "watching <spool>" and then exited 0, immediately, watching nothing. A run
 * created in the UI sat at "pending" forever and no launch ever happened — with no error anywhere,
 * because exiting 0 after saying "watching" is indistinguishable from working until you look for
 * the process.
 *
 * The cause was one line in runner.js start():
 *
 *     timer = setInterval(() => { tick().catch(() => {}); }, pollMs);
 *     timer.unref?.();
 *
 * unref() tells node this timer must not hold the process open. In a daemon whose only job IS that
 * timer, that is an instruction to exit.
 *
 * WHY 68 PASSING TESTS MISSED IT: every one of them calls tick() directly. tick() was always
 * correct — the defect lives in start(), and only in the process that relies on start() to stay
 * alive. Testing the unit proved the unit; nothing tested the daemon.
 *
 * So this test EXECUTES runner-host.js as a process and asserts on the process:
 *   1. it is still alive after the poll interval has passed several times over
 *   2. it actually consumes a spooled request while alive
 *
 * Assertion 1 alone would pass on a runner that stayed up and did nothing, so 2 is what proves it
 * is still watching rather than merely still running.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = path.join(HERE, '..', 'src', 'runner-host.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-host-'));
  fs.mkdirSync(path.join(dir, 'spool', 'requests'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'spool', 'status'), { recursive: true });
  return dir;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('runner-host keeps watching instead of exiting the moment it starts', async () => {
  const dir = fixture();
  const child = spawn(process.execPath, [HOST, '--dry'], {
    env: {
      ...process.env,
      SPOOL_DIR: path.join(dir, 'spool'),
      EPAM_HOME: dir,
      LAUNCH_PASSWORD: 'test-password',
      EPAM_PROVIDER_SET: 'claude',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  let exitedEarly = null;
  child.on('exit', (code) => { exitedEarly ??= code; });

  try {
    // Long enough for the default poll to have fired many times over.
    await sleep(1500);

    assert.equal(
      exitedEarly, null,
      `runner-host exited with code ${exitedEarly} instead of watching. Output:\n${out}`);
    assert.ok(alive(child.pid), `runner-host is not running. Output:\n${out}`);
    // Not vacuous: it must have got far enough to say what it is watching.
    assert.match(out, /watching/, `runner-host never reported what it watches:\n${out}`);

    // AND IT MUST STILL BE CONSUMING WORK. Alive-but-idle would satisfy the checks above.
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    fs.writeFileSync(
      path.join(dir, 'spool', 'requests', `${id}.json`),
      JSON.stringify({ id, ticket: 'TEST-1', requestedBy: 'test', pauseAfterMint: 0, pauseBeforeWriter: 0 }));

    let status = null;
    for (let i = 0; i < 60 && status === null; i += 1) {
      await sleep(100);
      const f = path.join(dir, 'spool', 'status', `${id}.json`);
      if (fs.existsSync(f)) {
        try { status = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* mid-write */ }
      }
    }
    assert.ok(status, `the running watcher never picked up a spooled request. Output:\n${out}`);
  } finally {
    child.kill('SIGKILL');
  }
});
