import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';

/**
 * wait_for_health() IS THE "DEEM THE APP UP" CHECK — an install must not claim a service is ready
 * the instant `docker compose up -d` exits (which happens the moment containers are CREATED, not
 * when they can answer a request). Tested directly against a REAL local HTTP server rather than a
 * fake docker container, since the logic under test is the polling/timeout, not container startup.
 */
const LIB = path.resolve(__dirname, '../../../orchestrations-installer/lib/wait-for-health.sh');
const NODE_BIN = process.execPath;

let server: http.Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve((server!.address() as any).port));
  });
}

/**
 * ASYNC, NOT spawnSync. The health server this test spins up runs IN THIS SAME PROCESS —
 * spawnSync BLOCKS the whole event loop for as long as the child runs, so the server could never
 * actually accept the child's connection and every case looked like a failure regardless of what
 * wait_for_health itself did. Found by tracing exactly this: the isolated shell command succeeded
 * every time run standalone, and only failed when the server lived in the same process as the
 * spawnSync call.
 */
function waitFor(url: string, tries: number, interval: number): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c',
      `set -uo pipefail; NODE_BIN=${JSON.stringify(NODE_BIN)}; . ${JSON.stringify(LIB)}; wait_for_health "$1" "$2" "$3"`,
      '--', url, String(tries), String(interval)]);
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

describe('wait_for_health', () => {
  it('succeeds immediately when the endpoint answers 200 {"ok":true}', async () => {
    const port = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
    const r = await waitFor(`http://127.0.0.1:${port}/api/health`, 3, 0);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
  });

  it('fails when the endpoint answers 200 but NOT {"ok":true} — a 200 alone is not proof', async () => {
    const port = await serve((_req, res) => { res.writeHead(200); res.end('{"ok":false}'); });
    const r = await waitFor(`http://127.0.0.1:${port}/api/health`, 2, 0);
    expect(r.status).not.toBe(0);
  });

  it('fails when the endpoint answers a non-200 status', async () => {
    const port = await serve((_req, res) => { res.writeHead(500); res.end('boom'); });
    const r = await waitFor(`http://127.0.0.1:${port}/api/health`, 2, 0);
    expect(r.status).not.toBe(0);
  });

  it('retries: succeeds once the endpoint comes up mid-poll, not just on the first try', async () => {
    let ready = false;
    setTimeout(() => { ready = true; }, 400);
    const port = await serve((_req, res) => {
      if (!ready) { res.destroy(); return; }
      res.writeHead(200); res.end('{"ok":true}');
    });
    const r = await waitFor(`http://127.0.0.1:${port}/api/health`, 10, 1);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
  }, 15_000);

  it('gives up and fails after exhausting its tries against nothing listening at all', async () => {
    // A port nothing is bound to — connection refused on every attempt.
    const r = await waitFor('http://127.0.0.1:1/api/health', 2, 0);
    expect(r.status).not.toBe(0);
  });
});
