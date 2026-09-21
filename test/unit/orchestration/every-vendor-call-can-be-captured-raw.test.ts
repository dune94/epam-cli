/**
 * EVERY VENDOR CALL THROUGH THE CENTRAL HANDLER CAN BE CAPTURED RAW.
 *
 * regintel 140717Z (2026-09-21): MiniMax-M3 answers reached the pipeline as `dict":"approved"` —
 * the first five bytes missing — four times, and no record anywhere held the raw stream, so every
 * hypothesis was a guess. The CLI now captures the SSE payloads it read when
 * EPAM_STREAM_CAPTURE_DIR is set; the central handler points it at LOG_DIR/stream-captures for
 * every call it dispatches, so the next occurrence is evidence, not a mystery.
 *
 * Drives the REAL llm-handler.sh with a stub EPAM_CLI that records the environment it received.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const HANDLER = join(ROOT, 'orchestrations/scripts/llm-handler.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('every vendor call through the central handler can be captured raw', () => {
  it('the CLI it dispatches receives EPAM_STREAM_CAPTURE_DIR under LOG_DIR, and the directory exists', () => {
    const d = mkdtempSync(join(tmpdir(), 'raw-capture-')); dirs.push(d);
    const logDir = join(d, 'logs'); mkdirSync(logDir);
    const seen = join(d, 'env.txt'); const stub = join(d, 'epam');
    writeFileSync(stub, `#!/usr/bin/env bash\ncat >/dev/null\nprintf 'CAP=%s\\n' "\${EPAM_STREAM_CAPTURE_DIR-<unset>}" > "${seen}"\nprintf '{"result":"ok","cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}\\n'\n`);
    chmodSync(stub, 0o755);
    const r = spawnSync('bash', [HANDLER, '--provider', 'minimax'], {
      encoding: 'utf8', timeout: 60_000, input: 'say ok',
      env: { ...process.env, EPAM_CLI: stub, LOG_DIR: logDir, EPAM_PROVIDER_SET: 'openrouter', AI_PROVIDER: 'minimax',
        MINIMAX_API_KEY: 'none', OPENROUTER_API_KEY: 'none', AI_MODEL: 'MiniMax-M3', EPAM_PROJECT_CONFIG_DIR: join(ROOT, 'orchestrations/projects/metrolinx') },
    });
    const out = (r.stdout || '') + (r.stderr || '');
    expect(existsSync(seen), `the stub CLI was never invoked:\n${out.slice(-1200)}`).toBe(true);
    const cap = /CAP=(.*)/.exec(readFileSync(seen, 'utf8'))?.[1];
    expect(cap).toBe(join(logDir, 'stream-captures'));
    expect(existsSync(join(logDir, 'stream-captures'))).toBe(true);
  });
});
