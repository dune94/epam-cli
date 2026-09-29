/**
 * PRE-FLIGHT ASKS THE SET WHETHER THIS MACHINE CAN CALL ITS STACK — AND REFUSES THE LAUNCH WHEN NOT.
 *
 * A set whose calls ride a session declares `signInProbe` (config/provider-sets.json). The codemie-web
 * probe checks the CodeMie sign-in, that every model the ladder can climb to is in CodeMie's catalog,
 * and that the codemie-plugins environment the installer builds is present — each otherwise fails
 * every rung of every story mid-run.
 *
 * Executed: preflight_sign_in, taken from preflight-check.sh as the script defines it, running the
 * real probe (plugins/providers/codemie-web/probe.js) through the real SDK against CodeMie stood in for
 * (test/mock-agent/codemie.ts). The first version of this section ran `node` with no script — the
 * probe's last argument was dropped — and printed nothing at all; every case here asserts a line.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, execSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockAgent } from '../../mock-agent/agent';
import { MockCodeMie } from '../../mock-agent/codemie';
import { builtPythonEnv } from '../../mock-agent/python-env';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const PREFLIGHT = readFileSync(join(SCRIPTS, 'preflight-check.sh'), 'utf8');
const FN = (/^preflight_sign_in\(\) \{[\s\S]*?^\}$/m.exec(PREFLIGHT) || [''])[0];
const CODEMIE = (() => { try { return execSync('command -v codemie', { encoding: 'utf8', shell: '/bin/bash' }).trim(); } catch { return ''; } })();
const ladder = (set: string): string[] => JSON.parse(spawnSync(process.execPath, [join(SCRIPTS, 'lib/handlers/ladder-models.js')], { encoding: 'utf8', env: { ...process.env, EPAM_PROVIDER_SET: set } }).stdout);

let dir = ''; let agent: MockAgent; let full: MockCodeMie; let short: MockCodeMie; let fullAgent: MockAgent; let venv = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'preflight-signin-'));
  fullAgent = new MockAgent(join(ROOT, 'orchestrations'), join(dir, 'j1')); await fullAgent.start();
  full = await new MockCodeMie(fullAgent, join(dir, 'j1'), ladder('codemie-web')).start();
  agent = new MockAgent(join(ROOT, 'orchestrations'), join(dir, 'j2')); await agent.start();
  short = await new MockCodeMie(agent, join(dir, 'j2'), ladder('codemie-web').slice(1)).start();   // the catalog lacks one rung
  venv = CODEMIE ? builtPythonEnv(ROOT, 'codemie-web')!.env : '';
}, 900_000);
afterAll(async () => { for (const s of [full, short]) await s?.stop(); for (const a of [fullAgent, agent]) await a?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });

/** Spawned, awaited — never spawnSync: CodeMie stands in inside this process, and a blocked event loop cannot answer. */
function signIn(env: Record<string, string>) {
  const script = ['ok(){ echo "  ✓ $*"; }; fail(){ echo "  ✗ $*"; }', `SCRIPT_DIR=${JSON.stringify(SCRIPTS)}`, FN, 'preflight_sign_in'].join('\n');
  return new Promise<{ status: number | null; out: string }>((resolve) => {
    const c = spawn('bash', ['-c', `set -euo pipefail\n${script}`], { env: { ...process.env, NODE_BIN: process.execPath, ...env } });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), 120_000);
    c.on('close', (status) => { clearTimeout(t); resolve({ status, out }); });
  });
}

describe('pre-flight sign-in', () => {
  it('is defined in preflight-check.sh and called there', () => {
    expect(FN.length).toBeGreaterThan(0);
    expect(PREFLIGHT).toMatch(/^preflight_sign_in$/m);
  });

  it('a set that declares no probe is not judged — and says so', async () => {
    const r = await signIn({ EPAM_PROVIDER_SET: 'claude' });
    expect(r.out).toMatch(/✓ sign-in: the active provider set \(claude\) declares no sign-in probe/);
    expect(r.out).not.toMatch(/✗/);
  });

  describe.skipIf(!CODEMIE)('the codemie-web set', () => {
    const cw = (m: MockCodeMie, a: MockAgent, extra: Record<string, string> = {}) => ({ EPAM_PROVIDER_SET: 'codemie-web', EPAM_CODEMIE_WEB_URL: a.url, EPAM_CODEMIE_PLUGIN_ENGINE_URI: m.engineUri, EPAM_CODEMIE_PLUGINS_VENV: venv, ...extra });

    it('signed in, every rung in the catalog, the plugin environment present: each check is reported, nothing refused', async () => {
      const r = await signIn(cw(full, fullAgent));
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/✓ sign-in: signed in; assistants go to project 'rehearsal@codemie\.local'/);
      expect(r.out).toMatch(/✓ sign-in: every ladder model is in the catalog/);
      expect(r.out).toMatch(/✓ sign-in: codemie-plugins environment present/);
      expect(r.out).not.toMatch(/✗/);
    });

    it('a ladder rung missing from the catalog refuses the launch, naming the model', async () => {
      const missing = ladder('codemie-web')[0];
      const r = await signIn(cw(short, agent));
      expect(r.out).toMatch(/✗ sign-in: the codemie-web set's probe refused/);
      expect(r.out).toContain(missing);
    });

    it('a missing codemie-plugins environment refuses the launch, naming what to do', async () => {
      const r = await signIn(cw(full, fullAgent, { EPAM_CODEMIE_PLUGINS_VENV: join(dir, 'no-such-venv') }));
      expect(r.out).toMatch(/✗ sign-in: .*codemie-plugins environment cannot host a plugin .*ENOENT.* — the installer provisions/);
    });

    it('an interpreter without codemie-plugins refuses the launch too — present is not the same as able to host', async () => {
      const bare = join(dir, 'bare-venv'); mkdirSync(join(bare, 'bin'), { recursive: true });
      symlinkSync(execSync('command -v python3', { encoding: 'utf8', shell: '/bin/bash' }).trim(), join(bare, 'bin/python'));
      expect(spawnSync(join(bare, 'bin/python'), ['-c', 'import codemie']).status, 'this machine\'s python3 has codemie-plugins — the case proves nothing here').not.toBe(0);
      const r = await signIn(cw(full, fullAgent, { EPAM_CODEMIE_PLUGINS_VENV: bare }));
      expect(r.out).toMatch(/✗ sign-in: .*codemie-plugins environment cannot host a plugin .*exit 1.* — the installer provisions/);
    });
  });
});
