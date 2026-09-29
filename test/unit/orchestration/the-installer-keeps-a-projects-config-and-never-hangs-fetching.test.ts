/**
 * THE INSTALLER KEEPS A PROJECT'S CONFIG, AND NEVER HANGS FETCHING A REF IT ALREADY HAS.
 *
 * Two installer defects found installing AMSD-2974 on 2026-09-28:
 *
 *   1. The Project step, given JIRA_URL / JIRA_PROJECT_KEY / JIRA_CODELINE_ROOT, REPLACED the
 *      project's config.env with five lines — its pauses, baseline branch, JQL and field mappings
 *      gone. It now sets those keys where they stand and keeps everything else.
 *   2. Packaging ran `git fetch --tags` unconditionally, unbounded and interactive: over ssh it sat
 *      for 20 minutes with no output while packaging a local HEAD. It now fetches only for a ref the
 *      checkout does not hold, non-interactively, within EPAM_INSTALL_FETCH_TIMEOUT.
 *
 * Both EXECUTE the real install.sh against a fixture tree; the remote is an ssh that hangs and
 * records that it was called.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../..');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** The smallest tree the installer runs to completion in: the claude stack, one project. */
function fixture(projectConfig: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-project-')); dirs.push(dir);
  for (const d of ['orchestrations/config', 'orchestrations/scripts/lib', 'dist', 'orchestrations-installer/lib', 'orchestrations/projects/demo']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'orchestrations-installer/install.sh'), path.join(dir, 'orchestrations-installer/install.sh'));
  for (const f of ['container-runtime.sh', 'wait-for-health.sh', 'isolated-compose-identity.sh', 'generate-env-example.sh', 'preserve-run-state.sh']) {
    fs.copyFileSync(path.join(REPO, 'orchestrations-installer/lib', f), path.join(dir, 'orchestrations-installer/lib', f));
  }
  fs.copyFileSync(path.join(REPO, 'orchestrations/scripts/lib/set-credentials.sh'), path.join(dir, 'orchestrations/scripts/lib/set-credentials.sh'));
  fs.writeFileSync(path.join(dir, 'orchestrations/config/provider-sets.json'), JSON.stringify({ defaultSet: 'claude', sets: { claude: { settingsFile: 'llm-defaults.claude.json', credentials: [] } } }));
  fs.writeFileSync(path.join(dir, 'orchestrations/config/llm-defaults.claude.json'), JSON.stringify({ runners: { claude: {} } }));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
  fs.writeFileSync(path.join(dir, '.env'), '');
  fs.writeFileSync(path.join(dir, 'orchestrations/projects/demo/config.env'), projectConfig);
  return dir;
}

/** install.sh, awaited — never spawnSync, so a hang is measured rather than inherited. */
function install(dir: string, args: string[], env: Record<string, string>, timeoutMs: number) {
  return new Promise<{ status: number | null; out: string; ms: number }>((resolve) => {
    const t0 = Date.now();
    const c = spawn('bash', [path.join(dir, 'orchestrations-installer/install.sh'), '--no-docker', '--stack', 'claude', ...args],
      { cwd: dir, detached: true, env: { ...process.env, EPAM_NONINTERACTIVE: '1', EPAM_BIN_DIR: path.join(dir, 'bin'), NODE_BIN: process.execPath, ...env } });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => { try { process.kill(-c.pid!, 'SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    c.on('close', (status) => { clearTimeout(t); resolve({ status, out: out.replace(/\x1b\[[0-9;]*m/g, ''), ms: Date.now() - t0 }); });
  });
}

const PROJECT = ['# the project\'s own settings', 'EPAM_PAUSE_AFTER_AGENT_MINT=1', 'EPAM_PAUSE_BEFORE_WRITER=1', 'JIRA_URL=https://old.example.net', 'JIRA_BASELINE_BRANCH=develop', 'JIRA_JQL="issue = X-1"', ''].join('\n');
const JIRA = { EPAM_PROJECT: 'demo', JIRA_URL: 'https://jira.example.net', JIRA_PROJECT_KEY: 'DEMO', JIRA_CODELINE_ROOT: '/srv/codelines' };

describe('the installer\'s Project step', () => {
  it('sets the three Jira values in the project\'s config.env and keeps everything else in it', async () => {
    const dir = fixture(PROJECT);
    const r = await install(dir, [], JIRA, 60_000);
    const cfg = fs.readFileSync(path.join(dir, 'orchestrations/projects/demo/config.env'), 'utf8');
    expect(r.out, r.out.slice(-600)).toMatch(/JIRA_URL, JIRA_PROJECT_KEY, JIRA_CODELINE_ROOT/);
    for (const kept of ['EPAM_PAUSE_AFTER_AGENT_MINT=1', 'EPAM_PAUSE_BEFORE_WRITER=1', 'JIRA_BASELINE_BRANCH=develop', 'JIRA_JQL="issue = X-1"', "# the project's own settings"]) expect(cfg).toContain(kept);
    expect(cfg).toContain('JIRA_URL=https://jira.example.net');
    expect(cfg).not.toContain('old.example.net');
    expect(cfg.match(/^JIRA_URL=/gm)).toHaveLength(1);
    expect(cfg).toMatch(/^JIRA_PROJECT_KEY=DEMO$/m);
    expect(cfg).toMatch(/^JIRA_CODELINE_ROOT=\/srv\/codelines$/m);
  }, 90_000);

  it('run twice, sets each key once — no duplicates', async () => {
    const dir = fixture(PROJECT);
    await install(dir, [], JIRA, 60_000);
    await install(dir, [], JIRA, 60_000);
    const cfg = fs.readFileSync(path.join(dir, 'orchestrations/projects/demo/config.env'), 'utf8');
    for (const k of ['PROJECT_NAME', 'JIRA_URL', 'JIRA_PROJECT_KEY', 'JIRA_CODELINE_ROOT']) expect(cfg.match(new RegExp(`^${k}=`, 'gm')), k).toHaveLength(1);
  }, 180_000);
});

describe('packaging a ref', () => {
  /** The fixture as a git checkout whose remote answers through an ssh that hangs and logs the call. */
  function checkout() {
    const dir = fixture(PROJECT);
    const log = path.join(dir, '..', `${path.basename(dir)}-ssh.log`); dirs.push(log);
    const ssh = path.join(dir, '..', `${path.basename(dir)}-ssh`); dirs.push(ssh);
    fs.writeFileSync(ssh, `#!/usr/bin/env bash\necho called >> ${JSON.stringify(log)}\nsleep 600\n`, { mode: 0o755 });
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
    git('init', '-q'); git('add', '-A'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'fixture');
    git('remote', 'add', 'origin', 'ssh://git@unreachable.invalid/repo.git');
    const dest = path.join(dir, '..', `${path.basename(dir)}-dest`); dirs.push(dest);
    return { dir, dest, log, env: { GIT_SSH_COMMAND: ssh, EPAM_INSTALL_FETCH_TIMEOUT: '3' } };
  }

  it('a ref the checkout already holds is packaged without touching the remote', async () => {
    const c = checkout();
    const r = await install(c.dir, ['--dest', c.dest, '--ref', 'HEAD'], c.env, 60_000);
    expect(r.out, r.out.slice(-600)).toMatch(/packaged HEAD into/);
    expect(fs.existsSync(c.log), 'the installer went to the remote for a ref it already had').toBe(false);
  }, 90_000);

  it('a ref the checkout does not hold is fetched within the bound — and refused, not waited on forever', async () => {
    const c = checkout();
    const r = await install(c.dir, ['--dest', c.dest, '--ref', 'v-no-such-tag'], c.env, 60_000);
    expect(fs.existsSync(c.log), 'a missing ref must be fetched').toBe(true);
    expect(r.ms).toBeLessThan(30_000);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/does not exist in this checkout/);
  }, 90_000);
});
