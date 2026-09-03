/**
 * THE REAL LAUNCHER — wraps the pipeline's own launcher. Tested WITHOUT launching one.
 *
 * A paid run is not a unit test. Every assertion here uses a stub script on disk, so the seam that
 * has cost this project the most — how the environment and argv reach tier3-*-run.sh — is exercised
 * for free and for real: a shell script that records what it received.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLauncher } from '../src/launcher.js';

let dir, script, record;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-'));
  record = path.join(dir, 'received.txt');
  script = path.join(dir, 'fake-launcher.sh');
  // A stand-in for tier3-metrolinx-run.sh: records the environment and argv it was given.
  fs.writeFileSync(script, `#!/usr/bin/env bash
{
  echo "ARGV=$*"
  echo "EPAM_PROVIDER_SET=\${EPAM_PROVIDER_SET:-}"
  echo "EPAM_RESUME_RUN=\${EPAM_RESUME_RUN:-}"
  echo "EPAM_PAUSE_AFTER_AGENT_MINT=\${EPAM_PAUSE_AFTER_AGENT_MINT:-}"
  echo "EPAM_PAUSE_BEFORE_WRITER=\${EPAM_PAUSE_BEFORE_WRITER:-}"
} > "${record}"
echo "RUN NUMBER:  20260903T010438Z"
exit \${FAKE_EXIT:-0}
`);
  fs.chmodSync(script, 0o755);
});

const received = () => Object.fromEntries(
  fs.readFileSync(record, 'utf8').trim().split('\n').map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)];
  }),
);

describe('the launcher', () => {
  test('passes every value in the ENVIRONMENT, and only --yes in argv', async () => {
    // The 2026-09-02 defect: these were passed as positional arguments, the launcher reads them
    // from the environment, so the run started FRESH and reset the codeline.
    const launch = createLauncher({ script, cwd: dir });
    await launch({ ticket: 'A-1' },
      { EPAM_PROVIDER_SET: 'claude', EPAM_RESUME_RUN: '20260903T010438Z' }, ['--yes']);
    const got = received();
    assert.equal(got.ARGV, '--yes');
    assert.equal(got.EPAM_PROVIDER_SET, 'claude');
    assert.equal(got.EPAM_RESUME_RUN, '20260903T010438Z');
  });

  test('an unset pause arrives unset, not as an empty string the pipeline might read as truthy', async () => {
    const launch = createLauncher({ script, cwd: dir });
    await launch({ ticket: 'A-1' }, { EPAM_PROVIDER_SET: 'claude' }, ['--yes']);
    assert.equal(received().EPAM_PAUSE_BEFORE_WRITER, '');
  });

  test('reports the exit code rather than swallowing it', async () => {
    const launch = createLauncher({ script, cwd: dir, extraEnv: { FAKE_EXIT: '3' } });
    const r = await launch({ ticket: 'A-1' }, { EPAM_PROVIDER_SET: 'claude' }, ['--yes']);
    assert.equal(r.code, 3);
  });

  test('extracts the pipeline runId from the output — without it a resume is impossible', async () => {
    const launch = createLauncher({ script, cwd: dir });
    const r = await launch({ ticket: 'A-1' }, { EPAM_PROVIDER_SET: 'claude' }, ['--yes']);
    assert.equal(r.runId, '20260903T010438Z');
  });

  test('detects a PAUSE from the pipeline output, so the UI can offer Resume', async () => {
    fs.appendFileSync(script, '');
    const paused = path.join(dir, 'paused.sh');
    fs.writeFileSync(paused, `#!/usr/bin/env bash
echo "RUN NUMBER:  20260903T010438Z"
echo "PAUSED — inputs ready, writer NOT started"
exit 0
`);
    fs.chmodSync(paused, 0o755);
    const launch = createLauncher({ script: paused, cwd: dir });
    const r = await launch({ ticket: 'A-1' }, { EPAM_PROVIDER_SET: 'claude' }, ['--yes']);
    assert.equal(r.paused, true);
    assert.equal(r.runId, '20260903T010438Z');
  });

  test('refuses to launch a script that does not exist, rather than reporting a mystery failure', async () => {
    const launch = createLauncher({ script: path.join(dir, 'nope.sh'), cwd: dir });
    await assert.rejects(() => launch({ ticket: 'A-1' }, { EPAM_PROVIDER_SET: 'claude' }, ['--yes']),
      /not found|does not exist|ENOENT/i);
  });

  test('does not inherit an ambient provider set from the runner process', async () => {
    // The runner's own environment must not leak a vendor into the launch. Live lesson: an
    // inherited API key outranked the subscription for seven runs before anyone noticed.
    process.env.EPAM_PROVIDER_SET = 'openrouter';
    try {
      const launch = createLauncher({ script, cwd: dir });
      await launch({ ticket: 'A-1' }, { EPAM_PROVIDER_SET: 'claude' }, ['--yes']);
      assert.equal(received().EPAM_PROVIDER_SET, 'claude');
    } finally {
      delete process.env.EPAM_PROVIDER_SET;
    }
  });
});
