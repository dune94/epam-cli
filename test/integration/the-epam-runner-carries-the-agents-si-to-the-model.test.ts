/**
 * THE EPAM RUNNER CARRIES THE AGENT'S STANDING INSTRUCTIONS TO THE MODEL.
 *
 * Operator, 2026-09-29: "Ensure each provider has a proper agent si transit." The openrouter set
 * (OpenRouter and MiniMax through `epam run`) sent the model epam's own session prompt and nothing
 * of the agent. The hub now resolves the agent's SI into EPAM_SI_FILE; `epam run` appends it to its
 * system prompt, after the session prompt (which still states the tools this agent has).
 *
 * Whole path: the REAL hub, on the openrouter set, runs the REAL built runner (dist/epam.js) against
 * the stand-in vendor; what is asserted is the request the vendor received.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { MiniMockServer } from './lib/mini-mockserver';

const ROOT = join(__dirname, '../../');
const HUB = join(ROOT, 'orchestrations/scripts/llm-handler.sh');
const EPAM = join(ROOT, 'dist/epam.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const b = require(join(ROOT, 'orchestrations/scripts/mock-expectations.js'));
const reg = JSON.parse(readFileSync(join(ROOT, 'orchestrations/agents/invocation-profiles.json'), 'utf8')).profiles;
const [MINE, OTHER] = Object.keys(reg).filter((s) => reg[s].si && s !== 'story-writer');
const firstLine = (s: string) => s.split('\n').find((l) => l.trim().length > 20) as string;

const mock = new MiniMockServer();
let dir = '';
beforeAll(async () => { await mock.start(); dir = mkdtempSync(join(tmpdir(), 'epam-si-')); });
afterAll(async () => { await mock.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });

function put(payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${mock.url}/mockserver/expectation`, { method: 'PUT', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve()); });
    req.on('error', reject); req.end(JSON.stringify(payload));
  });
}

/** One call through the hub as `agent`; returns every request body the vendor received. */
async function viaHub(agent: string, extra: Record<string, string> = {}): Promise<{ status: number | null; stderr: string; bodies: string }> {
  await put({ priority: 10, times: { remainingTimes: 1, unlimited: false },
    httpRequest: { method: 'POST', path: '/api/v1/chat/completions' },
    httpResponse: { statusCode: 200, headers: { 'content-type': ['text/event-stream; charset=utf-8'], 'x-seam': [`si-${agent}`] }, body: b.sse('done') } });
  const cli = join(dir, 'epam'); writeFileSync(cli, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(EPAM)} "$@"\n`); chmodSync(cli, 0o755);
  const before = mock.hits.length;
  return new Promise((resolve) => {
    const c = spawn('bash', [HUB, '--provider', 'openrouter', '--model', 'z-ai/glm-5.2'], {
      cwd: dir, env: { ...process.env, EPAM_PROVIDER_SET: 'openrouter', EPAM_CLI: cli, EPAM_AGENT_NAME: agent,
        OPENROUTER_BASE_URL: `${mock.url}/api/v1`, OPENROUTER_API_KEY: 'stand-in', EPAM_PLAN_EXECUTE: '0',
        EPAM_CALL_MAX_ATTEMPTS: '1', EPAM_DANGEROUS_SKIP_APPROVAL: '1', LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '',
        EPAM_PROJECT_CONFIG_DIR: '', NODE_OPTIONS: '--max-old-space-size=1024', ...extra },
    });
    let stderr = '';
    c.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), 120_000);
    c.on('close', (status) => { clearTimeout(t); resolve({ status, stderr, bodies: mock.hits.slice(before).map((h) => String(h.body)).join('\n') }); });
    c.stdin.end('THE TASK ONLY');
  });
}

describe('the epam runner carries the agent\'s SI to the model', () => {
  it('the vendor receives THIS agent\'s SI in the system prompt — and no other agent\'s', async () => {
    const r = await viaHub(MINE);
    expect(r.bodies.length, `the vendor received nothing:\n${r.stderr.slice(-1500)}`).toBeGreaterThan(0);
    expect(r.bodies).toContain('THE TASK ONLY');
    expect(r.bodies, 'the agent\'s SI never reached the vendor').toContain(JSON.stringify(firstLine(reg[MINE].si)).slice(1, -1));
    expect(r.bodies, 'another agent\'s SI reached the vendor').not.toContain(JSON.stringify(firstLine(reg[OTHER].si)).slice(1, -1));
  }, 180_000);
});
