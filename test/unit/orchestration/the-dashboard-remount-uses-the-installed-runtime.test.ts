/**
 * THE RUN'S LOG MOUNT IS MADE BY THE RUNTIME THAT IS INSTALLED — not by "docker".
 *
 * pre-run-reset.sh restarts agent-monitor so it serves THIS run's log dir and PRD. It called
 * `docker compose ... up -d --force-recreate agent-monitor` literally, and swallowed any failure
 * into an info line: "Docker not available or agent-monitor not running — skipping container
 * restart". On a podman install that branch is taken every time, the mount is never made, and the
 * run dies ~30s later at a pre-flight gate it cannot ever satisfy:
 *
 *   ✗ nginx /logs/healing-events.jsonl not reachable — docker /logs-dir mount may be wrong
 *   ━━━ ✗ 1 check(s) FAILED — DO NOT run pipeline ━━━
 *
 * Live 2026-09-08 on pipeline-tests-39: a clean, healthy podman install that the installer's own
 * health check called "✓ ready" could not start a run at all. The health check probes HOST PORTS,
 * so a mount that was never made is invisible to it — which is why this shipped.
 *
 * container_compose() in orchestrations-installer/lib/container-runtime.sh already resolves the
 * runtime and knows podman needs PODMAN_COMPOSE_PROVIDER and a real runtime dir, and it is
 * shipped inside every install. The seam is driven here with fake docker/podman recorders on
 * PATH, so what is asserted is the command actually executed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = join(__dirname, '../../../');
const RESET = join(REPO_ROOT, 'orchestrations/scripts/pre-run-reset.sh');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Extracts the container-restart block and runs it with recorders for both runtimes on PATH. */
function restartUnder(runtime: string, opts: { failRestart?: boolean } = {}) {
  const src = readFileSync(RESET, 'utf8');
  // The runtime helpers and the restart block are ONE unit: the block is unrunnable without them,
  // and extracting only the block tests a shell that has neither.
  const start = src.indexOf('_obs_runtime_lib() {');
  expect(start, 'the runtime resolution helpers moved — this test no longer covers them')
    .toBeGreaterThan(-1);
  const guard = src.indexOf('if [ "${EPAM_SKIP_CONTAINER_RESTART:-0}" = "1" ]; then', start);
  expect(guard, 'the container-restart block moved — this test no longer covers it')
    .toBeGreaterThan(-1);
  const end = src.indexOf('\nfi\n', guard) + 4;
  const block = src.slice(start, end);

  const dir = mkdtempSync(join(tmpdir(), 'remount-')); dirs.push(dir);
  const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true });
  const log = join(dir, 'calls.txt');
  const rc = opts.failRestart ? 1 : 0;
  for (const rt of ['docker', 'podman']) {
    writeFileSync(join(bin, rt), `#!/usr/bin/env bash\nprintf '${rt} %s\\n' "$*" >> ${JSON.stringify(log)}\nexit ${rc}\n`);
    chmodSync(join(bin, rt), 0o755);
  }
  writeFileSync(join(bin, 'podman-compose'), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(bin, 'podman-compose'), 0o755);

  const script = join(dir, 'drive.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash', 'set -uo pipefail',
    'info()    { printf "INFO %s\\n" "$*"; }',
    'success() { printf "OK %s\\n" "$*"; }',
    'warn()    { printf "WARN %s\\n" "$*"; }',
    'error()   { printf "ERR %s\\n" "$*"; }',
    `COMPOSE_BASE=${JSON.stringify(join(dir, 'base.yml'))}`,
    `COMPOSE_OVERRIDE=${JSON.stringify(join(dir, 'override.yml'))}`,
    'OBS_PROJECT=testproj', 'PRD_PRESENT=1',
    `PRD_DIR=${JSON.stringify(dir)}`, 'PRD_BASENAME=prd.json', `LOG_DIR=${JSON.stringify(dir)}`,
    `INSTALLER_LIB=${JSON.stringify(join(REPO_ROOT, 'orchestrations-installer/lib/container-runtime.sh'))}`,
    block,
  ].join('\n'));
  writeFileSync(join(dir, 'base.yml'), 'services: {}\n');
  writeFileSync(join(dir, 'override.yml'), 'services: {}\n');

  const r = spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, EPAM_CONTAINER_RUNTIME: runtime },
  });
  return { out: `${r.stdout}${r.stderr}`, calls: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

describe('the dashboard remount uses the installed runtime', () => {
  it('GUARD: the block runs and calls a compose at all', () => {
    const r = restartUnder('docker');
    expect(r.calls, 'no runtime was invoked — every assertion below is vacuous').toMatch(/compose/);
  });

  it('UNDER PODMAN IT USES PODMAN — the mount a run depends on actually gets made', () => {
    const r = restartUnder('podman');
    expect(r.calls, 'pre-run-reset still shells out to docker on a podman install, so this run\'s '
      + 'log dir is never mounted and the pre-flight gate can never pass')
      .toMatch(/^podman /m);
    expect(r.calls).not.toMatch(/^docker /m);
    expect(r.out, 'it did not report the remount').toMatch(/agent-monitor restarted/);
  });

  it('UNDER DOCKER IT STILL USES DOCKER — the working path is unchanged', () => {
    const r = restartUnder('docker');
    expect(r.calls).toMatch(/^docker /m);
    expect(r.calls).not.toMatch(/^podman /m);
    expect(r.out).toMatch(/agent-monitor restarted/);
  });

  it('A FAILED REMOUNT IS NOT REPORTED AS AN ABSENT RUNTIME', () => {
    // The old text blamed a missing docker for every failure, including one where the runtime is
    // present and the restart itself failed -- which is what sent me diagnosing "containers stuck
    // in Created" while the real cause was the hardcoded runtime.
    const r = restartUnder('podman', { failRestart: true });
    expect(r.out, 'a failed remount still claims the runtime is unavailable, which points the '
      + 'next reader at the wrong cause').not.toMatch(/not available/i);
    expect(r.out, 'a failed remount said nothing identifying it as a remount failure')
      .toMatch(/agent-monitor|remount|restart/i);
  });
});
