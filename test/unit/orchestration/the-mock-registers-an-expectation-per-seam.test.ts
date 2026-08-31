/**
 * THE REGISTRATION PASS — what actually loads the expectations into MockServer.
 *
 * The framings are covered elsewhere; this is the part that decides WHICH seam gets WHICH answer,
 * and it is the half that can silently under-deliver. A seam with no expectation registered does not
 * error: MockServer simply has nothing to say for it, the client reads an empty turn, and the
 * rehearsal reports a model that said nothing.
 *
 * `--host` is a parameter, so the pass can be pointed at a stand-in server — and that is how the
 * refusals below are exercised without MockServer, docker, or a run.
 *
 * WHAT IS NOT TESTED HERE, AND WHY. A COMPLETED registration is not asserted, because the pass scans
 * the whole run archive to find captured replies: 475MB across 11,607 files at the time of writing,
 * and it did not finish inside two minutes. That is worth knowing on its own — every rehearsal setup
 * pays that cost, the archive only grows, and the pass produces no output while it runs, so a slow
 * start is indistinguishable from a hang. Bounding that scan would change WHICH recordings are
 * found, so it is reported rather than changed here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer, Server } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');
const SCRIPT = join(S, 'mock-expectations.js');

/** A stand-in MockServer that records every expectation PUT to it. */
let server: Server;
let host = '';
const puts: { path: string; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      puts.push({ path: req.url || '', body });
      res.writeHead(201); res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  host = `http://127.0.0.1:${(server.address() as any).port}`;
}, 60_000);

afterAll(() => { try { server.close(); } catch { /* already closed */ } });

/**
 * A PRD IS REQUIRED, and refusing without one is right: every per-story stand-in would answer for no
 * story and the run would fail at assignment. That refusal is asserted below; here we satisfy it.
 */
function prdFile() {
  const f = join(mkdtempSync(join(tmpdir(), 'mockprd-')), 'prd.json');
  writeFileSync(f, JSON.stringify({
    stories: [
      { id: 'S-1', title: 'A distinctive first title', phase: 'core' },
      { id: 'S-2', title: 'A quite different second title', phase: 'core' }],
    implementationOrder: { core: ['S-1', 'S-2'] },
    project: { name: 'p' },
  }));
  return f;
}

function register(extra: string[] = [], env: Record<string, string> = {}) {
  puts.length = 0;
  const r = spawnSync(process.execPath, [SCRIPT, '--host', host, ...extra], {
    encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, EPAM_COVERAGE_GATED: '0', PRD_FILE: prdFile(), ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

describe('the registration pass refuses rather than half-registering', () => {
  it('REFUSES without a PRD — a per-story stand-in for no story fails at assignment', () => {
    // Its own refusal: every per-story stand-in would answer for no story and the run would fail at
    // assignment. Registering anyway produces a rehearsal that breaks later, further from the cause.
    const r = spawnSync(process.execPath, [SCRIPT, '--host', host], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, EPAM_COVERAGE_GATED: '0', PRD_FILE: '', EPAM_PROJECT_CONFIG_DIR: '' },
    });
    expect(r.status, 'it registered stand-ins for a project with no stories').not.toBe(0);
    expect(r.stderr, 'the refusal does not say how to supply a project').toMatch(/PRD_FILE/);
  }, 240_000);

  it('and the refusal explains the consequence, not just the missing input', () => {
    // "Set PRD_FILE" tells an operator what to type; saying WHY tells them whether it matters.
    const r = spawnSync(process.execPath, [SCRIPT, '--host', host], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, EPAM_COVERAGE_GATED: '0', PRD_FILE: '', EPAM_PROJECT_CONFIG_DIR: '' },
    });
    expect(r.stderr, 'the refusal states no consequence').toMatch(/no story|assignment|fail/i);
  }, 240_000);
});
