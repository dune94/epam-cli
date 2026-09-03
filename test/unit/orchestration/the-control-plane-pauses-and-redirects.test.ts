/**
 * THE CONTROL PLANE — how an operator stops a run in flight. 233 lines, no test.
 *
 * The orchestrator polls $LOG_DIR/PAUSED between stories, so a pause that does not create that
 * sentinel is a pause that does nothing: the operator sees an acknowledgement and the run carries on
 * spending. Redirects are the same — a redirect written to the wrong place is a request the story
 * runner never sees, and nothing reports it.
 *
 * The operator's own launch procedure uses two pauses on every metrolinx run. This is the mechanism
 * behind them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/control-plane.js');

let proc: ChildProcess;
let port = 0;
let logDir = '';

/** One HTTP call to the control plane. */
function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
    (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: d }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  logDir = mkdtempSync(join(tmpdir(), 'control-'));
  // Port 0 is not offered, so pick a high one and let a clash fail loudly rather than silently
  // sharing another instance's sentinel directory.
  port = 18000 + Math.floor(Math.random() * 2000);
  proc = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, CONTROL_PLANE_PORT: String(port), LOG_DIR: logDir },
    stdio: 'pipe',
  });
  await new Promise((r) => setTimeout(r, 1500));
}, 60_000);

afterAll(async () => {
  // SIGTERM, not SIGKILL. A killed process never runs its exit handlers, so V8 never flushes the
  // coverage it collected — 233 lines of exercised code reported as zero. Asking it to stop, and
  // waiting briefly, is the difference between measuring this file and not.
  try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  await new Promise((r) => { proc.once('exit', r); setTimeout(r, 3000); });
  try { proc.kill('SIGKILL'); } catch { /* already exited */ }
});

describe('the control plane pauses a run by the sentinel the orchestrator polls', () => {
  it('is alive and answers /health', async () => {
    // Without this every assertion below could pass on a server that never started.
    const r = await call('GET', '/health');
    expect(r.status, 'the control plane never came up').toBe(200);
  }, 60_000);

  it('POST /pause CREATES the sentinel file — an acknowledgement alone pauses nothing', () => {
    // The orchestrator polls $LOG_DIR/PAUSED between stories. A 200 that writes no file is a pause
    // the operator believes in and the run ignores.
    return call('POST', '/pause').then((r) => {
      expect(r.status).toBe(200);
      expect(existsSync(join(logDir, 'PAUSED')),
        'the pause was acknowledged but no sentinel was written').toBe(true);
    });
  }, 60_000);

  it('GET /status then reports paused', async () => {
    const r = await call('GET', '/status');
    expect(JSON.parse(r.text).paused, 'the status disagrees with the sentinel on disk').toBe(true);
  }, 60_000);

  it('POST /resume REMOVES it, or the run stays stopped after being resumed', async () => {
    await call('POST', '/resume');
    expect(existsSync(join(logDir, 'PAUSED')),
      'resume was acknowledged but the sentinel remains, so the run stays paused').toBe(false);
    const s = await call('GET', '/status');
    expect(JSON.parse(s.text).paused).toBe(false);
  }, 60_000);

  it('pausing twice is harmless — an operator may press it again', async () => {
    await call('POST', '/pause');
    const r = await call('POST', '/pause');
    expect(r.status).toBe(200);
    expect(existsSync(join(logDir, 'PAUSED'))).toBe(true);
    await call('POST', '/resume');
  }, 60_000);

  it('resuming a run that is not paused is harmless too', async () => {
    const r = await call('POST', '/resume');
    expect(r.status).toBe(200);
  }, 60_000);

  it('POST /redirect writes a request the story runner can find', async () => {
    // Written to the wrong place it is a request nothing ever reads, and nothing reports that.
    const r = await call('POST', '/redirect/S-1', { targetAgent: 'senior-engineer' });
    expect(r.status).toBe(200);
    const f = join(logDir, 'redirect-S-1.json');
    expect(existsSync(f), 'the redirect was acknowledged but written nowhere the runner looks')
      .toBe(true);
    const doc = JSON.parse(readFileSync(f, 'utf8'));
    expect(doc.targetAgent, 'the redirect does not carry the agent it asked for')
      .toBe('senior-engineer');
    expect(doc.requestedAt, 'the redirect carries no timestamp').toBeTruthy();
  }, 60_000);

  it('and /status lists it as pending', async () => {
    const r = await call('GET', '/status');
    expect(JSON.stringify(JSON.parse(r.text).pendingRedirects),
      'a written redirect is not reported as pending').toContain('S-1');
  }, 60_000);

  it('an unknown route is refused rather than answered 200', async () => {
    // A control plane that answers everything tells an operator their request was accepted.
    const r = await call('POST', '/not-a-route');
    expect(r.status, 'an unknown route was answered as success').not.toBe(200);
  }, 60_000);
});
