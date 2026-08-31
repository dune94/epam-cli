/**
 * THE REGISTRATION PASS — what loads an expectation into MockServer for every seam.
 *
 * This is the half that can silently under-deliver. A seam with no expectation registered does not
 * error: MockServer simply has nothing to say for it, the client reads an empty turn, and the
 * rehearsal reports a model that said nothing.
 *
 * SPAWN, NOT spawnSync. A synchronous spawn blocks this process's event loop, so the stand-in server
 * below can never answer the child — the child's first PUT hangs forever and the pass looks like it
 * is scanning something enormous. It is not: it completes in under a second. I lost an hour to that
 * before noticing the deadlock was in the harness, and the note is here so nobody repeats it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, Server } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');
const SCRIPT = join(S, 'mock-expectations.js');

let server: Server;
let host = '';
let puts: { path: string; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { puts.push({ path: req.url || '', body }); res.writeHead(201); res.end('{}'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  host = `http://127.0.0.1:${(server.address() as any).port}`;
}, 60_000);

afterAll(() => { try { server.close(); } catch { /* already closed */ } });

function prdFile() {
  const f = join(mkdtempSync(join(tmpdir(), 'mockprd-')), 'prd.json');
  writeFileSync(f, JSON.stringify({
    stories: [{ id: 'S-1', title: 'A distinctive first title', phase: 'core' },
      { id: 'S-2', title: 'A quite different second title', phase: 'core' }],
    implementationOrder: { core: ['S-1', 'S-2'] },
    project: { name: 'p' },
  }));
  return f;
}

/** Run the pass to completion, asynchronously, and return what it registered. */
function register(env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  puts = [];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, '--host', host], {
      env: { ...process.env, EPAM_COVERAGE_GATED: '0', PRD_FILE: prdFile(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    p.on('exit', (code) => resolve({ code: code ?? -1, out }));
  });
}

describe('the registration pass gives every seam an answer', () => {
  let run: { code: number; out: string };
  let registered: { path: string; body: string }[] = [];

  beforeAll(async () => {
    run = await register({ MOCK_ARCHIVE_SCAN: '20' });
    registered = [...puts];
  }, 120_000);

  it('completes, and registers expectations — a pass that registers nothing serves nothing', () => {
    expect(run.code, run.out.slice(0, 600)).toBe(0);
    expect(registered.length, 'the pass completed without registering a single expectation')
      .toBeGreaterThan(0);
  }, 120_000);

  it('RESETS MockServer first, or yesterday expectations answer today requests', () => {
    expect(registered[0]?.path, 'the pass did not reset before registering').toMatch(/reset/);
  }, 120_000);

  it('covers many seams, not one — the registry declares dozens', () => {
    const declared = Object.keys(
      JSON.parse(readFileSync(join(S, '../agents/invocation-profiles.json'), 'utf8')).profiles || {});
    expect(declared.length, 'the registry declares nothing; this proves nothing').toBeGreaterThan(10);
    expect(registered.length, `only ${registered.length} expectations for ${declared.length} profiles`)
      .toBeGreaterThan(10);
  }, 120_000);

  it('every expectation carries a body and something to match on', () => {
    // Without a matcher the first expectation answers everything, so every seam replays one seam's
    // recording — which looks like the pipeline behaving oddly rather than the mock mis-registered.
    for (const p of registered.filter((x) => !/reset/.test(x.path))) {
      expect(p.body.length, `an expectation was registered with no payload: ${p.path}`)
        .toBeGreaterThan(2);
      expect(p.body, `an expectation has nothing to match on: ${p.path}`)
        .toMatch(/httpRequest|body|path/i);
    }
  }, 120_000);

  it('reports which seams it covered from real captures', () => {
    // A silent success and a silent no-op look identical, and the operator needs to know which seams
    // will replay a real answer and which will get a stand-in.
    expect(run.out, 'the pass did not say what it covered').toMatch(/covered|seam/i);
  }, 120_000);

  it('SAYS when it searched only part of the archive', () => {
    // 991 recorded runs and growing. Bounding the search is right; doing it silently would mean a
    // seam whose only capture is old quietly gets a stand-in instead.
    expect(run.out, 'it bounded the archive search without saying so')
      .toMatch(/most recent|MOCK_ARCHIVE_SCAN/);
  }, 120_000);

  it('REFUSES without a PRD — a per-story stand-in for no story fails at assignment', async () => {
    const r = await register({ PRD_FILE: '', EPAM_PROJECT_CONFIG_DIR: '' });
    expect(r.code, 'it registered stand-ins for a project with no stories').not.toBe(0);
    expect(r.out, 'the refusal does not say how to supply a project').toMatch(/PRD_FILE/);
    expect(r.out, 'the refusal states no consequence').toMatch(/no story|assignment|fail/i);
  }, 120_000);
});
