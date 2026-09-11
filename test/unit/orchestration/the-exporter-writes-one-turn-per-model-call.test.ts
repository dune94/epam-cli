/**
 * THE EXPORTER WRITES ONE TURN PER MODEL CALL.
 *
 * Two recorders write the same calls to Langfuse: the provider decorator, one trace per call named
 * `agent · story`; the cost seam, one trace per ATTEMPT named by the agent alone with every tool
 * call of the attempt aggregated. The exporter wrote both as turns. The per-attempt file of
 * qa-gate:runtime-boundary in run 20260910T222155Z held 33 tool calls in one turn: the loop
 * executed all of them and asked for a turn the recording did not have. Three gates unreplayable.
 * Found by the per-seam replay test, 2026-09-11 (REPLAY-EXPORT-1).
 *
 * The REAL exporter runs here against a stub Langfuse serving a session that holds both kinds, and
 * the cassette it writes is what is asserted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, Server } from 'node:http';

const ROOT = join(__dirname, '../../../');
const EXPORTER = join(ROOT, 'orchestrations/scripts/cassette-export.js');
const STORE = join(ROOT, 'orchestrations/scripts/lib/cassette-store.js');

const call = (name: string, ts: string, output: any, extra: any = {}) =>
  ({ name, timestamp: ts, output, metadata: { provider: 'chain', model: 'm', ...extra } });
const attempt = (name: string, ts: string, output: any, story: string, extra: any = {}) =>
  ({ name, timestamp: ts, output, metadata: { phase: 'core', story_id: story, provider: 'openrouter', ladder_rung: null, ...extra } });

/** A session as Langfuse would answer it: a gate recorded both ways, and a seam recorded only per attempt. */
const SESSION = [
  call('qa-gate:x · core', '2026-09-11T10:00:01Z', { text: '', toolCalls: [{ name: 'read_file', input: { path: 'a' } }] }),
  call('qa-gate:x · core', '2026-09-11T10:00:02Z', { text: '', toolCalls: [{ name: 'read_file', input: { path: 'b' } }] }),
  call('qa-gate:x · core', '2026-09-11T10:00:03Z', { text: 'verdict', toolCalls: [] }),
  attempt('qa-gate:x', '2026-09-11T10:00:04Z', { text: 'verdict', toolCalls: [{ name: 'read_file', input: { path: 'a' } }, { name: 'read_file', input: { path: 'b' } }] }, 'core'),
  attempt('team-lead-review', '2026-09-11T10:00:05Z', { text: 'APPROVED', toolCalls: [] }, 'core'),
  // The declared granularity wins over the shape, both ways.
  call('spec-agent · S-1', '2026-09-11T10:00:06Z', { text: 'spec', toolCalls: [] }, { granularity: 'call', story_id: 'S-1' }),
  attempt('spec-agent', '2026-09-11T10:00:07Z', { text: 'spec', toolCalls: [] }, 'S-1', { granularity: 'attempt' }),
];

let server: Server; let port = 0;
const dirs: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname === '/api/public/traces') {
      const page = Number(url.searchParams.get('page') || 1);
      const data = page === 1 ? [...SESSION].reverse() : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data, meta: { totalItems: SESSION.length } }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as any).port;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The stub server lives on this worker's event loop, so the exporter must be awaited, never spawnSync'd. */
async function exportSession() {
  const out = join(mkdtempSync(join(tmpdir(), 'export-')), 'cassette'); dirs.push(join(out, '..'));
  const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const c = spawn(process.execPath, [EXPORTER, '--session', 's1', '--out', out], {
      env: { ...process.env, LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk', LANGFUSE_BASE_URL: `http://127.0.0.1:${port}` },
    });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const store = require(STORE);
  const seams: Record<string, any[]> = {};
  for (const f of readdirSync(out)) if (f !== 'manifest.json') seams[store.decodeSeamFile(f.replace(/\.json$/, ''))] = JSON.parse(readFileSync(join(out, f), 'utf8'));
  return { r, out, seams, manifest: JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) };
}

describe('the exporter writes one turn per model call', () => {
  it('a seam recorded per call is exported per call; its per-attempt summary is folded, not written as turns', async () => {
    const { r, seams, manifest } = await exportSession();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(seams['qa-gate:x · core'].map((t) => t.toolCalls.length), 'the per-call turns').toEqual([1, 1, 0]);
    expect(seams['qa-gate:x'], 'the per-attempt summary was written as a seam of its own — 2 tool calls in one turn, unreplayable').toBeUndefined();
    expect(manifest.attemptTracesFolded).toEqual([{ agent: 'qa-gate:x', traces: 1 }, { agent: 'spec-agent', traces: 1 }]);
    expect(r.stdout).toMatch(/2 per-attempt trace\(s\) of 2 seam\(s\) already recorded per call were folded/);
  });

  it('a seam recorded ONLY per attempt is exported under the label a replay asks for: agent · story', async () => {
    const { seams } = await exportSession();
    expect(seams['team-lead-review · core'], 'the only record of this seam, filed where agentLabel() looks').toEqual([{ text: 'APPROVED', toolCalls: [] }]);
    expect(seams['team-lead-review'], 'filed by the agent alone, a real rehearsal (EPAM_STORY_ID set) never finds it').toBeUndefined();
  });

  it('a declared granularity wins over the shape', async () => {
    const { seams } = await exportSession();
    expect(seams['spec-agent · S-1']).toEqual([{ text: 'spec', toolCalls: [] }]);
    expect(seams['spec-agent']).toBeUndefined();
  });

  it('the recorders declare their granularity', () => {
    const emit = require(join(ROOT, 'orchestrations/scripts/lib/langfuse-emit.js'));
    const body = (emit.buildIngestionBody || emit._buildIngestionBody)?.({ agent: 'a', model: 'm', storyId: 's' }, { traceId: 't' });
    const traceEvent = body && (body.batch || []).find((e: any) => e.type === 'trace-create');
    expect(traceEvent?.body?.metadata?.granularity, 'the cost seam does not declare granularity: attempt').toBe('attempt');
    const traced = readFileSync(join(ROOT, 'src/observability/TracedProvider.ts'), 'utf8');
    expect((traced.match(/granularity: 'call'/g) || []).length, 'both trace sites of TracedProvider declare granularity: call').toBe(2);
  });
});
