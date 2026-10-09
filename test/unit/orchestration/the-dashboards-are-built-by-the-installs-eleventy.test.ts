/**
 * THE DASHBOARDS ARE BUILT BY THE INSTALL'S OWN ELEVENTY.
 *
 * Live AMSD-2974 run 2 (2026-10-09): no Eleventy ran at all. The run's only start sat after the
 * multi-codeline hand-off, which a brownfield run never passes, and when it was reached it looked for
 * eleventy in dashboards/node_modules — the installer puts it in the install root's node_modules — so
 * it fell to `npx @11ty/eleventy`, a registry fetch rather than the installed build.
 *
 * EXECUTED: the real start_dashboards_watch (lib/control-plane.sh) against an install-shaped folder
 * whose eleventy is a stand-in that records how it was called.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/control-plane.sh');
const dirs: string[] = []; const pids: number[] = [];
afterAll(() => {
  for (const p of pids) { try { process.kill(-p, 'SIGKILL'); } catch { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function install() {
  const root = mkdtempSync(join(tmpdir(), 'eleventy-install-')); dirs.push(root);
  const dash = join(root, 'orchestrations/dashboards'); mkdirSync(dash, { recursive: true });
  writeFileSync(join(dash, '.eleventy.js'), 'module.exports = {};');
  mkdirSync(join(root, 'orchestrations/logs'), { recursive: true });
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  const marker = join(root, 'eleventy.called');
  const bin = join(root, 'node_modules/.bin/eleventy');
  writeFileSync(bin, `#!/usr/bin/env bash\necho "$*" > ${JSON.stringify(marker)}\nexec sleep 30\n`);
  chmodSync(bin, 0o755);
  return { root, dash, marker };
}

function start(i: ReturnType<typeof install>, env: Record<string, string> = {}) {
  const logs = join(i.root, 'orchestrations/logs');
  const r = spawnSync('bash', ['-c', `set -u
info(){ echo "INFO $*"; }; warning(){ echo "WARN $*"; }; success(){ :; }; error(){ echo "ERR $*"; }
orch_role(){ if [ -n "\${JIRA_CODELINE_RUN:-}" ]; then printf lane; else printf parent; fi; }; is_lane(){ [ "$(orch_role)" = lane ]; }
. ${JSON.stringify(LIB)} 2>/dev/null
DASHBOARD_WATCH_PID_FILE=${JSON.stringify(join(logs, 'dashboards-watch.pid'))}; DASHBOARD_WATCH_LOG=${JSON.stringify(join(logs, 'dashboards-watch.log'))}
DASHBOARD_WATCH_PID=""; DASHBOARD_WATCH_OWNED=false
start_dashboards_watch; echo "PID=$DASHBOARD_WATCH_PID"`], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, AUTOMATION_DIR: join(i.root, 'orchestrations'), PROJECT_ROOT: i.root, PATH: '/usr/bin:/bin', ...env },
  });
  const pid = Number((r.stdout.match(/^PID=(\d+)$/m) || [])[1] || 0);
  if (pid) pids.push(pid);
  return { out: r.stdout + r.stderr, pid };
}

describe("the dashboards are built by the install's own eleventy", () => {
  it('the parent starts the eleventy in the install root, serving the install\'s dashboards', () => {
    const i = install(); const r = start(i);
    expect(r.pid, r.out).toBeGreaterThan(0);
    for (let n = 0; n < 40 && !existsSync(i.marker); n++) spawnSync('sleep', ['0.05']);
    expect(existsSync(i.marker), `the install's eleventy was not run: ${r.out}`).toBe(true);
    const args = readFileSync(i.marker, 'utf8');
    expect(args).toContain(`--input=${i.dash}`);
    expect(args).toContain(`--output=${join(i.dash, 'live')}`);
    expect(args).toContain('--serve');
    expect(r.out).not.toMatch(/npx/);
  });

  it('a lane starts none — its parent serves it', () => {
    const i = install(); const r = start(i, { JIRA_CODELINE_RUN: '1' });
    expect(r.pid).toBe(0);
    spawnSync('sleep', ['0.3']);
    expect(existsSync(i.marker)).toBe(false);
  });
});
