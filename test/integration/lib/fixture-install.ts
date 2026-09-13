/**
 * AN INSTALL OF THIS WORKING TREE, AND THE EDGE A £0 RUN NEEDS AROUND IT.
 *
 * Shared by the £0 integration tests: what install.sh would extract (tracked files minus run
 * state, plus the built CLI), a no-op container runtime, a process standing in for the snapshot
 * watcher pre-flight looks for, and an .env pointing every observability service at the edge.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const ROOT = join(__dirname, '../../../');
export const NODE = process.execPath;

export function fixtureInstall(dirs: string[]): string {
  const dest = mkdtempSync(join(tmpdir(), 'epam-install-')); dirs.push(dest);
  const runState = JSON.parse(readFileSync(join(ROOT, 'orchestrations-installer/run-state-paths.json'), 'utf8')).paths as string[];
  const excluded = runState.map((p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '(/|$)'));
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { maxBuffer: 64 << 20 })
    .toString('utf8').split('\0').filter((f) => f && !excluded.some((r) => r.test(f)));   // install.sh ships the whole ref, test/ included
  const list = join(dest, '.files'); writeFileSync(list, files.join('\0'));
  execFileSync('bash', ['-c', `cd ${JSON.stringify(ROOT)} && tar --null -T ${JSON.stringify(list)} -cf - | tar -xf - -C ${JSON.stringify(dest)}`]);
  rmSync(list);
  cpSync(join(ROOT, 'dist'), join(dest, 'dist'), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules'), join(dest, 'node_modules'));
  mkdirSync(join(dest, 'orchestrations/logs'), { recursive: true });
  return dest;
}

/** The edge around the install: container runtime, snapshot watcher, service endpoints. */
export function edgeFor(install: string, edgeUrl: string, children: ChildProcess[]): { bin: string } {
  const bin = join(install, '.edge-bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), '#!/bin/bash\nexit 0\n'); chmodSync(join(bin, 'docker'), 0o755);
  const watcher = spawn('sleep', ['7200'], { stdio: 'ignore' }); children.push(watcher);
  writeFileSync(join(install, 'orchestrations/logs/dashboards-watch.pid'), String(watcher.pid));
  writeFileSync(join(install, '.env'), [
    `LANGFUSE_BASE_URL=${edgeUrl}`, 'LANGFUSE_SECRET_KEY=sk-lf-test', 'LANGFUSE_PUBLIC_KEY=pk-lf-test',
    'OPENROUTER_API_KEY=', 'MINIMAX_API_KEY=', 'OPENAI_API_KEY=', '',
  ].join('\n'));
  return { bin };
}

/** The environment a £0 run is launched with: the mockserver set, every endpoint at the edge. */
export function zeroCostEnv(bin: string, edgeUrl: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    PATH: `${bin}:${join(ROOT, 'node_modules/.bin')}:${process.env.PATH}`,
    HOME: process.env.HOME!,
    EPAM_PROVIDER_SET: 'mockserver', EPAM_FREE_RUN: '1',
    EPAM_PAUSE_AFTER_AGENT_MINT: '0',
    EPAM_MOCK_BASE_URL: edgeUrl, EPAM_DASHBOARD_URL: edgeUrl, LANGFUSE_BASE_URL: edgeUrl, EPAM_GRAFANA_URL: edgeUrl,
    ANTHROPIC_API_KEY: 'mock-no-spend',
    EPAM_PREFLIGHT_CACHE_DIR: join(ROOT, 'orchestrations/scripts/.preflight-cache'),
    NODE_BIN: NODE,
    ...extra,
  };
}

/** spawn, awaited: the edge lives in the test process, so nothing may block its event loop. */
export function run(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string>; timeout: number }) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const c = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; }); c.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => { try { process.kill(-c.pid!, 'SIGKILL'); } catch { c.kill('SIGKILL'); } }, opts.timeout);
    c.on('close', (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
  });
}
