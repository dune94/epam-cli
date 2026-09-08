/**
 * THE INSTALLER FINDS PORTS THAT ARE ACTUALLY FREE, AND SAYS SO IN THE .env IT LEAVES BEHIND.
 *
 * TWO LIVE FAILURES, ONE CAUSE — the installer never asked whether a port was free.
 *
 * 1. It derived ports from a hash offset and only discovered a clash when compose failed. Live
 *    2026-09-07 compose exited 0 over containers stuck in `created` ("address already in use"),
 *    so the clash was never even discovered: six containers never started and the install
 *    reported ready.
 *
 * 2. The tree it leaves behind names ports it does not own. This install allocated Langfuse on
 *    3120, while its .env still read LANGFUSE_BASE_URL=http://localhost:3100 — a previous
 *    install's Langfuse. langfuse-emit.js resolves `env.LANGFUSE_BASE_URL || allocatedBase()`,
 *    so the stale literal WINS and every trace from this run would be written into another
 *    install's database.
 *
 * Probing is the only honest answer: a port is free when binding it succeeds, not when arithmetic
 * says it should be.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { createServer, Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(process.cwd(), 'orchestrations-installer', 'lib', 'container-runtime.sh');
const dirs: string[] = [];
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) { try { s.close(); } catch { /* already closed */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** Really occupies a port for the duration of the test — not a stub. */
function occupy(port: number): Promise<void> {
  return new Promise((res, rej) => {
    const s = createServer(() => {});
    servers.push(s);
    s.once('error', rej);
    s.listen(port, '0.0.0.0', () => res());
  });
}

function callLib(line: string): string {
  const drive = join(tmp('drv-'), 'drive.sh');
  writeFileSync(drive, ['#!/usr/bin/env bash', 'set -uo pipefail',
    `. ${JSON.stringify(LIB)}`, line].join('\n'));
  try { return execFileSync('bash', [drive], { encoding: 'utf8', timeout: 30_000 }).trim(); }
  catch (e: any) { return `${e.stdout || ''}${e.stderr || ''}`.trim(); }
}

describe('finding a free port', () => {
  it('returns the requested port when it is genuinely free', () => {
    const out = callLib('find_free_port 39411');
    expect(out, 'a free port was not accepted').toBe('39411');
  });

  it('THE DEFECT: steps past a port something is already listening on', async () => {
    await occupy(39421);
    const out = callLib('find_free_port 39421');
    expect(out, 'the installer handed back a port already in use — compose then creates a '
      + 'container that cannot start, and (before the verification fix) reported success')
      .not.toBe('39421');
    expect(Number(out), 'no usable port returned at all').toBeGreaterThan(39421);
  });

  it('keeps stepping while ports stay occupied', async () => {
    await occupy(39431); await occupy(39432); await occupy(39433);
    const out = callLib('find_free_port 39431');
    expect(Number(out), 'stopped at the first occupied port instead of finding a free one')
      .toBeGreaterThanOrEqual(39434);
  });

  it('fails loudly rather than returning a port it could not verify', () => {
    // A range with nowhere to go must not fall back to "probably fine".
    const out = callLib('find_free_port 39441 0; echo "rc=$?"');
    expect(out, 'a zero-width search reported a port anyway').toMatch(/rc=[1-9]/);
  });
});

describe('the .env the installer leaves behind', () => {
  it('NAMES THIS INSTALL\'S OWN LANGFUSE, not whatever the copied file said', () => {
    const dir = tmp('env-');
    const envFile = join(dir, '.env');
    writeFileSync(envFile, [
      'EPAM_PROVIDER_SET=codemie',
      'LANGFUSE_BASE_URL=http://localhost:3100',   // a previous install's port
      'LANGFUSE_PUBLIC_KEY=pk-lf-epam-dev',
    ].join('\n') + '\n');

    callLib(`reconcile_env_endpoint ${JSON.stringify(envFile)} LANGFUSE_BASE_URL http://localhost:3120`);

    const after = readFileSync(envFile, 'utf8');
    expect(after, 'the stale port survived — langfuse-emit.js prefers env.LANGFUSE_BASE_URL, so '
      + "every trace would land in another install's database").toContain('http://localhost:3120');
    expect(after, 'the old value is still present').not.toContain('localhost:3100');
    expect(after, 'unrelated settings were disturbed').toContain('EPAM_PROVIDER_SET=codemie');
    expect(after, 'unrelated settings were disturbed').toContain('LANGFUSE_PUBLIC_KEY=pk-lf-epam-dev');
  });

  it('adds the value when the file does not declare it at all', () => {
    const dir = tmp('env-');
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'EPAM_PROVIDER_SET=claude\n');
    callLib(`reconcile_env_endpoint ${JSON.stringify(envFile)} LANGFUSE_BASE_URL http://localhost:3130`);
    expect(readFileSync(envFile, 'utf8')).toContain('LANGFUSE_BASE_URL=http://localhost:3130');
  });
});
