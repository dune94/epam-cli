/**
 * B20 — a single transient network error aborted the entire pipeline.
 *
 * Live (2026-07-24 19:36:58, metrolinx run): four seconds in, before any work
 * started —
 *
 *   [ingest] Failed to fetch issues: connect ETIMEDOUT 13.227.180.4:443
 *   [ERROR] [jira] Ingestion failed (exit 1).
 *   [tier3-metrolinx] ✗ Phase 'core' failed (exit 1) — aborting pipeline
 *
 * Jira was healthy: the same credentials returned HTTP 200 in 196ms moments later,
 * and AMSD-1820 fetched fine. One network blip killed a run that had already done
 * the codeline teardown and a 31-repo CodeGraph preflight.
 *
 * `request()` had no retry and no socket timeout, so any blip was fatal and a hung
 * connection would hang forever.
 *
 * RETRY ONLY WHAT IS RETRYABLE. A 401/403/404 means bad credentials, no permission,
 * or a missing issue — retrying cannot help, wastes time, and hammering auth
 * endpoints risks lockout. Only network-level failures and 429/5xx get retried.
 *
 * The GET-only write guard MUST survive: jira-client is the layer that makes writes
 * to a client system structurally impossible (no method parameter exists). Adding
 * retry must not introduce one.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
const CLIENT_PATH = join(__dirname, '../../../orchestrations/scripts/lib/jira-client.js');
const SRC = readFileSync(CLIENT_PATH, 'utf8');

const servers: Server[] = [];
afterAll(() => { for (const s of servers.splice(0)) s.close(); });

/** Server that fails `failTimes` requests (mode) then serves the payload. */
function startServer(failTimes: number, mode: 'destroy' | 503 | 429 | 401): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const srv = createServer((req, res) => {
    hits++;
    if (hits <= failTimes) {
      if (mode === 'destroy') { req.socket.destroy(); return; }   // ETIMEDOUT/ECONNRESET class
      res.statusCode = mode; res.end(JSON.stringify({ errorMessages: ['boom'] })); return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ issues: [{ key: 'AMSD-1820' }], total: 1 }));
  });
  servers.push(srv);
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () =>
    resolve({ port: (srv.address() as any).port, hits: () => hits })));
}

function loadClient(port: number) {
  delete require_.cache[require_.resolve(CLIENT_PATH)];
  process.env.JIRA_URL = `http://127.0.0.1:${port}`;
  process.env.JIRA_EMAIL = 'a@b.c';
  process.env.JIRA_TOKEN = 'tok';
  process.env.JIRA_RETRY_BASE_MS = '10';        // keep the test fast
  return require_(CLIENT_PATH);
}

describe('B20 — transient failures are retried', () => {
  it('recovers from a dropped connection instead of killing the run', async () => {
    const { port, hits } = await startServer(2, 'destroy');
    const c = loadClient(port);
    const r = await c.searchIssues('issue = AMSD-1820');
    expect(r.issues?.[0]?.key).toBe('AMSD-1820');
    expect(hits()).toBeGreaterThan(1);           // it actually retried
  }, 20000);

  it('retries a 503', async () => {
    const { port } = await startServer(1, 503);
    const c = loadClient(port);
    expect((await c.searchIssues('x')).total).toBe(1);
  }, 20000);

  it('retries a 429 (rate limit)', async () => {
    const { port } = await startServer(1, 429);
    const c = loadClient(port);
    expect((await c.searchIssues('x')).total).toBe(1);
  }, 20000);
});

describe('B20 — non-retryable failures fail FAST', () => {
  it('does NOT retry a 401 (bad credentials — retrying risks lockout)', async () => {
    const { port, hits } = await startServer(99, 401);
    const c = loadClient(port);
    await expect(c.searchIssues('x')).rejects.toThrow(/401/);
    expect(hits(), 'a 401 must not be retried').toBe(1);
  }, 20000);

  it('gives up after a bounded number of attempts rather than hanging', async () => {
    const { port, hits } = await startServer(99, 503);
    const c = loadClient(port);
    await expect(c.searchIssues('x')).rejects.toThrow();
    expect(hits()).toBeLessThanOrEqual(4);
  }, 30000);
});

describe('B20 — the write guard must survive', () => {
  it('still has no method parameter (writes to a client system stay impossible)', () => {
    expect(SRC).toMatch(/method:\s*'GET'/);
    expect(SRC).not.toMatch(/method:\s*(method|opts\.method|options\.method)/);
  });

  it('sets a socket timeout so a hung connection cannot stall the pipeline forever', () => {
    expect(SRC).toMatch(/setTimeout|timeout:/);
  });
});
