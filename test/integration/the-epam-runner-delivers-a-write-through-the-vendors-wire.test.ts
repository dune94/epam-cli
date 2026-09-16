/**
 * THE EPAM RUNNER DELIVERS A WRITE THROUGH THE VENDOR'S WIRE.
 *
 * The production stack (provider set `openrouter`: OpenRouter + MiniMax through `epam run`) had
 * no £0 cell: the mockserver set drives plain Claude Code, so the parser at
 * src/providers/minimax/MiniMaxProvider.ts and its twin in OpenRouterProvider.ts were reached by
 * paid runs only. Run 20260915T101555Z, REGI-001A: 32 write_file calls reached the tool with no
 * arguments — the vendor streamed them in fragments, a read boundary fell inside an event, and the
 * parser dropped the slice and handed the tool `{}`. Six attempts, $4.18, nothing delivered.
 *
 * This drives the REAL runner binary (`epam run`, the arm claude.sh invokes for a story) against
 * the stand-in's vendor-shaped, socket-chunked reply — the same builders and the same chunking
 * every seam of the £0 harness now uses — and asserts what the RECEIVER got: the file on disk,
 * byte for byte. Both vendors of the openrouter set, both base URLs the pipeline forwards.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { MiniMockServer } from './lib/mini-mockserver';
import { engineSource } from '../lib/engine-source';

const ROOT = join(__dirname, '../../');
const NODE20 = process.execPath;
// The binary claude.sh invokes (`$EPAM_CLI run`), not a dev entry: the arm under test is the built one.
const EPAM = join(ROOT, 'dist/epam.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const b = require(join(ROOT, 'orchestrations/scripts/mock-expectations.js'));

const mock = new MiniMockServer();
const dirs: string[] = [];
const priorSet = process.env.EPAM_PROVIDER_SET;
beforeAll(async () => { process.env.EPAM_PROVIDER_SET = 'mockserver'; await mock.start(); });
afterAll(async () => {
  await mock.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  if (priorSet === undefined) delete process.env.EPAM_PROVIDER_SET; else process.env.EPAM_PROVIDER_SET = priorSet;
});

function put(payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${mock.url}/mockserver/expectation`, { method: 'PUT', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve()); });
    req.on('error', reject); req.end(JSON.stringify(payload));
  });
}

/** A file's worth of content — many fragments, many chunks, never one read. */
const CONTENT = Array.from({ length: 60 }, (_, i) => `def threshold_${i}() -> float:\n    return 0.70  # — default when unset\n`).join('');

/** Two turns as the stand-in serves them: the write, then the answer. Chunked by the set's wire. */
async function registerWriterTurns(target: string) {
  const hdr = { 'content-type': ['text/event-stream; charset=utf-8'], 'x-seam': ['story-writer:test'] };
  const { chunkBytes } = b.wire();
  await put({ priority: 10, times: { remainingTimes: 1, unlimited: false },
    httpRequest: { method: 'POST', path: '/api/v1/chat/completions' },
    httpResponse: { statusCode: 200, headers: hdr, connectionOptions: { chunkSize: chunkBytes },
      body: b.sseToolCalls([{ name: 'write_file', input: { path: target, content: CONTENT } }]) } });
  await put({ priority: 9, times: { remainingTimes: 1, unlimited: false },
    httpRequest: { method: 'POST', path: '/api/v1/chat/completions' },
    httpResponse: { statusCode: 200, headers: hdr, connectionOptions: { chunkSize: chunkBytes },
      body: b.sse('written') } });
}

// SPAWN, NOT spawnSync: the stand-in serves from THIS process's event loop, which a synchronous
// spawn blocks — the runner would wait on a reply that can never be written.
function runEpam(provider: string, model: string, cwd: string, env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(NODE20, [EPAM, 'run', '--provider', provider, '--model', model, '--json', '-'], {
      cwd, env: { ...process.env, EPAM_DANGEROUS_SKIP_APPROVAL: '1', EPAM_MAX_ITERATIONS: '3', NODE_OPTIONS: '--max-old-space-size=1024',
        LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '', ...env },
    });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), 60_000);
    c.on('close', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
    c.stdin.end('write the file');
  });
}

describe('the epam runner delivers a write through the vendor\'s wire', () => {
  it('the runner binary is built — the pipeline runs dist/epam.js, and so does this', () => {
    expect(existsSync(EPAM), `${EPAM} is missing: build it (tsup) before trusting this suite`).toBe(true);
  });

  it('the content crosses more than one socket chunk — otherwise this proves nothing', () => {
    const body: string = b.sseToolCalls([{ name: 'write_file', input: { path: '/x', content: CONTENT } }]);
    expect(Buffer.byteLength(body)).toBeGreaterThan(b.wire().chunkBytes * 10);
  });

  for (const [provider, model, urlEnv, keyEnv] of [
    ['minimax', 'MiniMax-M3', 'MINIMAX_BASE_URL', 'MINIMAX_API_KEY'],
    ['openrouter', 'z-ai/glm-5.2', 'OPENROUTER_BASE_URL', 'OPENROUTER_API_KEY'],
  ]) {
    it(`${provider}: write_file lands the declared content on disk, byte for byte`, async () => {
      const ws = mkdtempSync(join(tmpdir(), `wire-${provider}-`)); dirs.push(ws);
      const target = join(ws, 'regintel', 'config.py');
      await registerWriterTurns(target);
      const r = await runEpam(provider, model, ws, { [urlEnv]: `${mock.url}/api/v1`, [keyEnv]: 'stand-in' });
      expect(r.status, `epam run failed:\n${r.stderr}\n${r.stdout}`).toBe(0);
      expect(existsSync(target), `the file was not written — the runner said:\n${r.stdout}\n${r.stderr}`).toBe(true);
      expect(engineSource(target)).toBe(CONTENT);
      expect(r.stdout + r.stderr).not.toMatch(/paths\[0\]|Received undefined/);
    });
  }

  it('arguments the vendor itself cut short are refused to the model as a failed result, and no tool runs on nothing', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'wire-broken-')); dirs.push(ws);
    const hdr = { 'content-type': ['text/event-stream; charset=utf-8'], 'x-seam': ['story-writer:test'] };
    const ev = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const broken = ev({ role: 'assistant', content: '', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: `{"path": "${join(ws, 'a.py')}", "content": "abc` } }] }, null)
      + ev({}, 'tool_calls') + 'data: [DONE]\n\n';
    await put({ priority: 10, times: { remainingTimes: 1, unlimited: false }, httpRequest: { method: 'POST', path: '/api/v1/chat/completions' },
      httpResponse: { statusCode: 200, headers: hdr, body: broken } });
    await put({ priority: 9, times: { remainingTimes: 1, unlimited: false }, httpRequest: { method: 'POST', path: '/api/v1/chat/completions' },
      httpResponse: { statusCode: 200, headers: hdr, body: b.sse('gave up') } });
    const r = await runEpam('minimax', 'MiniMax-M3', ws, { MINIMAX_BASE_URL: `${mock.url}/api/v1`, MINIMAX_API_KEY: 'stand-in' });
    expect(r.status).toBe(0);
    expect(existsSync(join(ws, 'a.py')), 'nothing may be written from arguments that did not arrive').toBe(false);
    const second = mock.hits.filter((h) => h.seam === 'story-writer:test').at(-1)!;
    expect(second.body, 'the model must be told, in the tool result, that its call was refused and why').toMatch(/was not executed: arguments for write_file are not valid JSON/);
    expect(r.stdout + r.stderr).not.toMatch(/paths\[0\]|Received undefined/);
  });
});
