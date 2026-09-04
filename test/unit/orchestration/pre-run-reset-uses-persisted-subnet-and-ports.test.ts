/**
 * The -p fix (pre-run-reset-restarts-the-right-agent-monitor.test.ts) made pre-run-reset.sh
 * restart agent-monitor in the CORRECT isolated docker compose PROJECT. It still fails, every
 * time, for any install other than the hand-run dev checkout: the restart's `docker compose ...
 * --force-recreate agent-monitor` call never sets EPAM_OBS_SUBNET (or the 4 EPAM_OBS_*_PORT
 * vars), so it resolves to docker-compose.observability.yml's own bare defaults
 * (172.31.0.0/16, 8123/3100/8092/3001) — which are NOT the subnet/ports the network was actually
 * created with for an isolated install.
 *
 * Confirmed live 2026-09-04 against pipeline-tests-7: `docker network inspect
 * test-install-amsd-pipeline-obs-925946_default` reported the REAL subnet 172.25.0.0/16, while
 * pre-run-reset.sh's own restart command (no EPAM_OBS_SUBNET set) would resolve to 172.31.0.0/16
 * — a mismatch that makes --force-recreate fail with "container ... is not connected to the
 * network test-install-amsd-pipeline-obs-925946_default", exit 1.
 *
 * install.sh's compose_up() already persists exactly these 5 values — OBS_SUBNET,
 * OBS_CLICKHOUSE_PORT, OBS_LANGFUSE_PORT, OBS_DASHBOARD_PORT, OBS_GRAFANA_PORT — to
 * .pipeline-services-state.env on every successful bring-up (install.sh:634-646), specifically so
 * a LATER command against the same install can reuse the same identity instead of re-rolling a
 * different one. pipeline-services.sh --start already reads this file for its own `up -d` call
 * (pipeline-services.sh:128-139). pre-run-reset.sh's restart never did.
 *
 * WHY DEV NEVER SAW THIS: dev's own checkout has no .pipeline-services-state.env at all (it was
 * never brought up through install.sh's isolated path), so BOTH its original hand-run `up -d` and
 * pre-run-reset.sh's restart consistently fall back to the SAME bare default — no mismatch, no
 * failure. It is the identical bug class the -p fix already covered, just for subnet/ports
 * instead of project name.
 *
 * Docker is STUBBED — this proves the ENV the script actually hands to the restart's docker
 * compose invocation, not that a real container reconnected. REPO_ROOT is not overridable in
 * pre-run-reset.sh, so the state file this script reads must be overridable separately (same B29
 * no-repo-pollution rule as COMPOSE_OVERRIDE) — real runs read the repo's actual
 * .pipeline-services-state.env if one exists; a test never touches it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../..');
const RESET = join(REPO_ROOT, 'orchestrations/scripts/pre-run-reset.sh');

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fixture() {
  const work = mkdtempSync(join(tmpdir(), 'prr-subnet-'));
  const bin = join(work, 'bin');
  mkdirSync(bin, { recursive: true });
  const dockerLog = join(work, 'docker.log');
  // Records argv AND the 5 env vars the fix must set, one line per invocation.
  writeFileSync(join(bin, 'docker'), [
    '#!/bin/bash',
    `{ printf 'ARGV: %s\\n' "$*"; printf 'ENV: SUBNET=%s CH=%s LF=%s DASH=%s GRAF=%s\\n' \\`,
    `  "\${EPAM_OBS_SUBNET:-}" "\${EPAM_OBS_CLICKHOUSE_PORT:-}" "\${EPAM_OBS_LANGFUSE_PORT:-}" "\${EPAM_OBS_DASHBOARD_PORT:-}" "\${EPAM_OBS_GRAFANA_PORT:-}"; } >> ${JSON.stringify(dockerLog)}`,
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'docker'), 0o755);

  const prdDir = mkdtempSync(join(tmpdir(), 'prr-prd-'));
  const logDir = mkdtempSync(join(tmpdir(), 'prr-logs-'));
  const overrideDir = mkdtempSync(join(tmpdir(), 'prr-ovr-'));
  mkdirSync(join(logDir, 'kb-scratchpad'), { recursive: true });
  const prd = join(prdDir, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [] }));
  cleanups.push(() => { for (const d of [work, prdDir, logDir, overrideDir]) rmSync(d, { recursive: true, force: true }); });

  return { work, bin, dockerLog, prd, logDir, override: join(overrideDir, 'override.yml') };
}

function run(f: ReturnType<typeof fixture>, extraEnv: Record<string, string>) {
  return spawnSync('bash', [RESET, '--prd', f.prd, '--log-dir', f.logDir], {
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, COMPOSE_OVERRIDE: f.override, ...extraEnv },
  });
}

function forceRecreateLine(log: string): string | undefined {
  const lines = log.split('\n');
  const idx = lines.findIndex((l) => l.includes('force-recreate') && l.includes('agent-monitor'));
  return idx >= 0 ? lines[idx + 1] : undefined; // the ENV: line immediately follows the ARGV: line
}

describe('pre-run-reset.sh restarts agent-monitor with the SAME subnet/ports the install actually used', () => {
  it('reads a persisted .pipeline-services-state.env and hands its subnet/ports to the restart', () => {
    const f = fixture();
    const stateFile = join(f.work, 'pipeline-services-state.env');
    writeFileSync(stateFile, [
      'OBS_PROJECT=test-install-amsd-pipeline-obs-925946',
      'OBS_SUBNET=172.25.0.0/16',
      'OBS_CLICKHOUSE_PORT=8123',
      'OBS_LANGFUSE_PORT=3100',
      'OBS_DASHBOARD_PORT=8092',
      'OBS_GRAFANA_PORT=3001',
      '',
    ].join('\n'));

    const r = run(f, { PIPELINE_SERVICES_STATE_FILE: stateFile });
    expect(r.status, `pre-run-reset.sh failed:\n${r.stdout}\n${r.stderr}`).toBe(0);

    const log = existsSync(f.dockerLog) ? readFileSync(f.dockerLog, 'utf8') : '';
    const envLine = forceRecreateLine(log);
    expect(envLine, `no ENV: line recorded for the force-recreate call:\n${log}`).toBeTruthy();
    expect(envLine).toBe('ENV: SUBNET=172.25.0.0/16 CH=8123 LF=3100 DASH=8092 GRAF=3001');
  });

  it('leaves the subnet/ports unset (compose-file defaults) when no state file exists — the dev-checkout path', () => {
    const f = fixture();
    const missingStateFile = join(f.work, 'no-such-state-file.env');

    const r = run(f, { PIPELINE_SERVICES_STATE_FILE: missingStateFile });
    expect(r.status, `pre-run-reset.sh failed:\n${r.stdout}\n${r.stderr}`).toBe(0);

    const log = existsSync(f.dockerLog) ? readFileSync(f.dockerLog, 'utf8') : '';
    const envLine = forceRecreateLine(log);
    expect(envLine, `no ENV: line recorded for the force-recreate call:\n${log}`).toBeTruthy();
    expect(envLine).toBe('ENV: SUBNET= CH= LF= DASH= GRAF=');
  });
});
