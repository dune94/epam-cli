/**
 * THE DASHBOARDS WATCHER DIES WITH ITS RUN.
 *
 * Measured 2026-09-14 on this host: five Eleventy watchers from five FINISHED £0 harness runs
 * (one of them a run that exited 0) still alive, 4GB resident between them, reparented to init.
 * start_dashboards_watch() launches `npx @11ty/eleventy`, and npx spawns eleventy as ITS child;
 * stop_dashboards_watch() killed the watcher's direct children and the watcher — eleventy was a
 * grandchild, and survived every run's exit.
 *
 * Judged by executing the real stop_dashboards_watch() against a watcher shaped like the real
 * one — a parent that spawns a grandchild — and asserting the grandchild is gone.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, spawn } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const ORCH = resolve(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function extractFn(name: string, mustContain: RegExp): string {
  const lines = readFileSync(ORCH, 'utf8').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^${name}\\(\\)\\s*\\{`).test(l));
  if (start < 0) throw new Error(`${name}() not found`);
  const end = lines.findIndex((l, i) => i > start && /^\}/.test(l));
  const body = lines.slice(start, end + 1).join('\n');
  if (!mustContain.test(body)) throw new Error(`extracted the wrong block for ${name}`);
  return body;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the dashboards watcher dies with its run', () => {
  it('stop_dashboards_watch() kills the watcher AND the grandchild npx spawned', async () => {
    const d = mkdtempSync(join(tmpdir(), 'dashwatch-')); dirs.push(d);
    const pidFile = join(d, 'dashboards-watch.pid');
    // The real shape: a parent (npx) whose CHILD (eleventy) does the work. The pid the orchestrator
    // records is the parent's — exactly what start_dashboards_watch() records.
    const marker = join(d, 'grandchild.pid');
    const parent = spawn('bash', ['-c', `bash -c 'echo $$ > "${marker}"; exec sleep 300' & wait`], { stdio: 'ignore' });
    for (let i = 0; i < 50; i += 1) { try { if (readFileSync(marker, 'utf8').trim()) break; } catch { /* not yet */ } await wait(50); }
    const grandchild = Number(readFileSync(marker, 'utf8').trim());
    expect(alive(parent.pid!)).toBe(true);
    expect(alive(grandchild)).toBe(true);
    writeFileSync(pidFile, String(parent.pid));

    const script = [
      'set -u', 'info() { :; }',
      `DASHBOARD_WATCH_PID_FILE="${pidFile}"`,
      `DASHBOARD_WATCH_PID=${parent.pid}`, 'DASHBOARD_WATCH_OWNED=true',
      extractFn('_epam_kill_tree', /pgrep -P/),
      extractFn('stop_dashboards_watch', /DASHBOARD_WATCH_OWNED/),
      'stop_dashboards_watch',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    await wait(300);
    expect(alive(parent.pid!), 'the watcher itself').toBe(false);
    expect(alive(grandchild), 'the grandchild the watcher spawned — the 4GB that stayed').toBe(false);
    if (alive(grandchild)) process.kill(grandchild, 'SIGKILL');
  });
});
