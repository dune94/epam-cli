/**
 * LANGFUSE MUST REACH THE PIPELINE LAUNCH, OR A PROVIDER SWAP IS INVISIBLE IN TRACES.
 *
 * launcher.js builds childEnv from a MINIMAL base plus exactly what runner-host.js declares in
 * extraEnv — deliberately, to stop an ambient credential leaking into a launch (2026-09-02: an
 * inherited API key outranked the subscription for seven runs). That same design means LANGFUSE_*
 * env vars on the operator's own shell do NOT reach a launch-dashboard-triggered run unless
 * runner-host.js explicitly passes them through — found while verifying the provider-swap feature
 * end-to-end: extraEnv only carried NODE_OPTIONS, so Langfuse tracing was silently off for every
 * launch-dashboard run regardless of what was configured on the host.
 *
 * This spawns runner-host.js for REAL (not a stub of it) with a fake EPAM_LAUNCHER script that
 * records the environment it actually received, the same proven pattern as launcher.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = path.join(HERE, '..', 'src', 'runner-host.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-host-langfuse-'));
  fs.mkdirSync(path.join(dir, 'spool', 'requests'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'spool', 'status'), { recursive: true });
  const record = path.join(dir, 'received-env.txt');
  const script = path.join(dir, 'fake-launcher.sh');
  fs.writeFileSync(script, `#!/usr/bin/env bash
{
  echo "LANGFUSE_SECRET_KEY=\${LANGFUSE_SECRET_KEY:-}"
  echo "LANGFUSE_PUBLIC_KEY=\${LANGFUSE_PUBLIC_KEY:-}"
  echo "LANGFUSE_BASE_URL=\${LANGFUSE_BASE_URL:-}"
} > "${record}"
echo "RUN NUMBER:  20260903T010438Z"
exit 0
`);
  fs.chmodSync(script, 0o755);
  return { dir, record, script };
}

async function runOnce(extraProcessEnv) {
  const { dir, record, script } = fixture();
  const env = {
    ...process.env,
    ...extraProcessEnv,
    SPOOL_DIR: path.join(dir, 'spool'),
    EPAM_HOME: dir,
    EPAM_LAUNCHER: script,
    LAUNCH_PASSWORD: 'test-password',
  };
  // Explicit unset, not just "not overridden": ...process.env may already carry these on a real
  // dev box, and a second spread cannot remove a key the first one set.
  for (const [k, v] of Object.entries(extraProcessEnv)) if (v === undefined) delete env[k];
  const child = spawn(process.execPath, [HOST], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  try {
    await sleep(500); // let it start watching
    const id = 'bbbbbbbb-0000-4000-8000-000000000002';
    fs.writeFileSync(
      path.join(dir, 'spool', 'requests', `${id}.json`),
      JSON.stringify({ id, ticket: 'TEST-1', requestedBy: 'test', providerSet: 'claude' }));

    for (let i = 0; i < 60 && !fs.existsSync(record); i += 1) await sleep(100);
    assert.ok(fs.existsSync(record), `the fake launcher never ran. Output:\n${out}`);
    return Object.fromEntries(
      fs.readFileSync(record, 'utf8').trim().split('\n').map((l) => {
        const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)];
      }),
    );
  } finally {
    child.kill('SIGKILL');
  }
}

test('LANGFUSE_* on the runner-host process reaches the pipeline launch', async () => {
  const received = await runOnce({
    LANGFUSE_SECRET_KEY: 'sk-test-123',
    LANGFUSE_PUBLIC_KEY: 'pk-test-456',
    LANGFUSE_BASE_URL: 'http://localhost:3100',
  });
  assert.equal(received.LANGFUSE_SECRET_KEY, 'sk-test-123');
  assert.equal(received.LANGFUSE_PUBLIC_KEY, 'pk-test-456');
  assert.equal(received.LANGFUSE_BASE_URL, 'http://localhost:3100');
});

test('absent LANGFUSE_* stays absent — never a placeholder, never an error', async () => {
  const received = await runOnce({
    LANGFUSE_SECRET_KEY: undefined,
    LANGFUSE_PUBLIC_KEY: undefined,
    LANGFUSE_BASE_URL: undefined,
  });
  assert.equal(received.LANGFUSE_SECRET_KEY, '');
  assert.equal(received.LANGFUSE_PUBLIC_KEY, '');
});
