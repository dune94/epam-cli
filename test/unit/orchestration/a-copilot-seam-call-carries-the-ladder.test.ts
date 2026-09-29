/**
 * A SEAM CALL ON THE COPILOT SET CARRIES THE LADDER'S SETTINGS TO THE MODEL — through the real CLI.
 *
 * Operator, 2026-09-27: "ensure llm calls to ghcp have proper settings from ladder". The proof is what
 * reached the model: the real llm-handler.sh, on the copilot provider set, runs the real `copilot` binary
 * pointed at a recording server (the CLI's own BYOK redirect, offline — nothing reaches GitHub, £0). The
 * server records every request the CLI makes; the assertions are on those requests.
 *
 * Skipped only when the `copilot` binary is not installed on this machine.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const HANDLER = join(ROOT, 'orchestrations/scripts/llm-handler.sh');
const CATALOG = join(ROOT, 'test/fixtures/copilot/models-20260927.json');
const COPILOT = (() => { try { return execSync('command -v copilot', { encoding: 'utf8', shell: '/bin/bash' }).trim(); } catch { return ''; } })();

type Req = { model?: string; reasoning_effort?: string; tools?: { function: { name: string } }[]; [k: string]: unknown };
let server: Server; let port = 0; const requests: Req[] = []; let mode: 'ok' | '402' = 'ok';
let dir = ''; let shim = ''; let argvLog = '';
/** The arguments of every copilot invocation, one JSON array per line. */
const argvs = (): string[][] => (existsSync(argvLog) ? readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-seam-'));
  // A RECORDING WRAPPER around the real binary. It logs the exact argument list and forwards all of it
  // EXCEPT --reasoning-effort: in BYOK offline mode the CLI has no model catalog, so it refuses an effort
  // for every model (even one Copilot's own catalog lists it for). What the effort does at the real
  // service is proven by the live smoke call; here it is proven to be ON THE COMMAND LINE, at the
  // catalog-derived level, or absent where the catalog says the model takes none.
  argvLog = join(dir, 'argv.jsonl'); shim = join(dir, 'copilot-recording');
  writeFileSync(shim, [
    '#!/usr/bin/env bash',
    `node -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2))+"\\n")' ${JSON.stringify(argvLog)} "$@"`,
    'out=(); skip=0; for a in "$@"; do if [ "$skip" = 1 ]; then skip=0; continue; fi; if [ "$a" = "--reasoning-effort" ]; then skip=1; continue; fi; out+=("$a"); done',
    `exec ${JSON.stringify(COPILOT)} "\${out[@]}"`,
  ].join('\n'), { mode: 0o755 });
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      const r = JSON.parse(body || '{}') as Req; requests.push(r);
      if (mode === '402') { res.writeHead(402, { 'content-type': 'application/json' }); res.end('{"error":{"message":"insufficient balance"}}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: object, finish: string | null, usage?: object) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: r.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
      res.write(chunk({ role: 'assistant', content: 'ANSWER-FROM-THE-RECORDER' }, null));
      res.write(chunk({}, 'stop', { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107 }));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; ok(); }));
});
afterAll(() => { server?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

function call(env: Record<string, string>) {
  requests.length = 0; if (argvLog && existsSync(argvLog)) rmSync(argvLog);
  const logs = join(dir, 'logs'); const out = join(dir, `result-${Date.now()}.json`);
  return new Promise<{ status: number | null; stdout: string; stderr: string; json: Record<string, any>; logs: string }>((resolve) => {
    const p = spawn('bash', [HANDLER, '--provider', 'copilot'], { cwd: dir, env: {
      ...process.env, EPAM_PROVIDER_SET: 'copilot', COPILOT_CMD: shim,
      COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${port}/v1`, COPILOT_PROVIDER_API_KEY: 'recorder', COPILOT_OFFLINE: 'true',
      EPAM_COPILOT_HOME: join(dir, 'home'), EPAM_COPILOT_CATALOG: CATALOG, LOG_DIR: logs, ORCH_JSON_RESULT: out,
      EPAM_CALL_MAX_ATTEMPTS: '1', EPAM_TIMEOUT_SECS: '120', EPAM_PLAN_TIMEOUT_SECS: '90', EPAM_DANGEROUS_SKIP_APPROVAL: '1', ...env } });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    p.stdin.end('Say something.');
    p.on('close', (status) => {
      let json = {}; try { json = JSON.parse(readFileSync(out, 'utf8')); } catch { /* none */ }
      resolve({ status, stdout, stderr, json, logs });
    });
  });
}

describe.skipIf(!COPILOT)('a seam call on the copilot set', () => {
  it('reaches the model as Copilot\'s id for the ladder\'s model, at the ladder\'s effort, with only the granted tools', async () => {
    const r = await call({ AI_MODEL: 'claude-opus-4-8', EPAM_REASONING_EFFORT: 'xhigh', AI_GATE_ALLOW_TOOLS: '1', EPAM_ALLOWED_TOOLS: 'read_file,search' });
    expect(r.status, r.stderr).toBe(0);
    // The hub asks for a plan first (tool-free), then the answer: every request carries the ladder's
    // model and effort; the answer call carries the grant.
    expect(requests.length).toBeGreaterThan(1);
    for (const x of requests) expect(x.model).toBe('claude-opus-4.8');
    const av = argvs();
    expect(av.length).toBeGreaterThan(1);
    for (const a of av) { expect(a[a.indexOf('--model') + 1]).toBe('claude-opus-4.8'); expect(a[a.indexOf('--reasoning-effort') + 1]).toBe('xhigh'); }
    // THE PLAN PASS IS TOOL-FREE: the hub declares it with a tool budget of 0 (EPAM_MAX_TOOL_CALLS=0).
    expect((requests[0].tools || []).map((t) => t.function.name), 'the plan request was offered tools').toEqual([]);
    const q = requests[requests.length - 1];
    expect(q.model).toBe('claude-opus-4.8');
    expect((q.tools || []).map((t) => t.function.name).sort()).toEqual(['grep', 'view']);
    expect(r.stdout.trim()).toBe('ANSWER-FROM-THE-RECORDER');
    expect(r.json).toMatchObject({ type: 'result', is_error: false, result: 'ANSWER-FROM-THE-RECORDER' });
    expect(r.json.usage.output_tokens).toBe(7);
  }, 180_000);

  it('a model without effort support is called without one — no refusal, no guess', async () => {
    const r = await call({ AI_MODEL: 'claude-haiku-4-5-20251001', EPAM_REASONING_EFFORT: 'high' });
    expect(r.status, r.stderr).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    for (const x of requests) expect(x.model).toBe('claude-haiku-4.5');
    for (const a of argvs()) expect(a).not.toContain('--reasoning-effort');
    expect(r.stderr).toMatch(/effort high -> <not passed>/);
  }, 180_000);

  it('the call\'s raw events are kept in the run\'s logs', async () => {
    await call({ AI_MODEL: 'claude-sonnet-5' });
    const kept = existsSync(join(dir, 'logs/copilot-calls')) ? readdirSync(join(dir, 'logs/copilot-calls')) : [];
    expect(kept.length).toBeGreaterThan(0);
  }, 180_000);

  it('a 402 is a failed call — never an empty success — and says it is out of credit', async () => {
    mode = '402';
    try {
      const r = await call({ AI_MODEL: 'claude-sonnet-5' });
      expect(r.status).not.toBe(0);
      expect(r.stdout.trim()).toBe('');
      expect(r.stderr).toMatch(/\[copilot\] call failed \(credit 402\)/);
      expect(r.json).toMatchObject({ is_error: true, error: { class: 'credit' } });
    } finally { mode = 'ok'; }
  }, 180_000);

  it('runs the CLI the operator runs — not the stale bundled build a pin falls back to', async () => {
    // 2026-09-28: --no-auto-update (and COPILOT_AUTO_UPDATE=false) did not merely stop a download —
    // they made the loader run the npm-bundled 1.0.18 instead of the current 1.0.85, which does not
    // know claude-sonnet-5: the first live call was refused "not available". The CLI logs the build
    // it started as; that must be the build `copilot --version` reports.
    const want = execSync(`${JSON.stringify(COPILOT)} --version`, { encoding: 'utf8' }).match(/\d+\.\d+\.\d+/)?.[0];
    expect(want, 'copilot --version reported no version').toBeTruthy();
    await call({ AI_MODEL: 'claude-sonnet-5' });
    const logs = join(dir, 'home', 'logs');
    const started = (existsSync(logs) ? readdirSync(logs) : []).flatMap((f) => readFileSync(join(logs, f), 'utf8').match(/Starting Copilot CLI: (\d+\.\d+\.\d+)/g) || []);
    expect(started.length, 'the CLI left no start record — nothing to judge').toBeGreaterThan(0);
    for (const line of started) expect(line).toBe(`Starting Copilot CLI: ${want}`);
  }, 180_000);

  it('a model the account is not served is refused before any request is made', async () => {
    const r = await call({ AI_MODEL: 'claude-opus-9' });
    expect(r.status).not.toBe(0);
    expect(requests.length).toBe(0);
    expect(r.stderr).toMatch(/claude-opus-9.*not in the Copilot catalog/);
  }, 180_000);
});
