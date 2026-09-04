/**
 * pre-run-reset.sh's agent-monitor restart never named its own docker compose PROJECT — it relied
 * on compose's own default resolution, which happened to match every install before today only
 * because no install had ever passed an isolated -p project name for the observability stack.
 *
 * install.sh (lib/isolated-compose-identity.sh, commit a20e8335) now brings a TEST install's
 * observability stack up as "test-install-amsd-pipeline-obs-<hash>" — a project pre-run-reset.sh's
 * naive `docker compose -f ... -f ... up -d --force-recreate agent-monitor` (no -p) can never find,
 * because with no -p it resolves to the compose file's own declared name ("dev-amsd-pipeline") or
 * the directory basename — never the isolated one. Found live 2026-09-04 against a genuinely fresh
 * install (pipeline-tests-6): "nginx /logs/healing-events.jsonl not reachable... DO NOT run
 * pipeline" on every real run, every time, for any install that isn't the hand-run dev checkout.
 *
 * Docker itself is STUBBED (records argv, exits 0 instantly) — this proves the ARGV the script
 * actually constructs, not that a real container restarted. REPO_ROOT is not overridable in
 * pre-run-reset.sh (resolved from the script's own path), so this necessarily runs against the
 * real dev checkout's own docker-compose.observability.yml — COMPOSE_OVERRIDE is still redirected
 * to an isolated path per the B29 no-repo-pollution rule already established for this script.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../..');
const RESET = join(REPO_ROOT, 'orchestrations/scripts/pre-run-reset.sh');
const IDENTITY_LIB = join(REPO_ROOT, 'orchestrations-installer/lib/isolated-compose-identity.sh');

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** The SAME function install.sh itself uses to name the observability project. Not re-derived by
 * hand here — a hand-typed expectation could drift from the real formula and pass for the wrong
 * reason. */
function expectedObsProject(root: string): string {
  const r = spawnSync('bash', ['-c', `. ${JSON.stringify(IDENTITY_LIB)}; isolated_project_name ${JSON.stringify(root)} obs`], { encoding: 'utf8' });
  return r.stdout.trim();
}

function fixture() {
  const work = mkdtempSync(join(tmpdir(), 'prr-agentmonitor-'));
  const bin = join(work, 'bin');
  mkdirSync(bin, { recursive: true });
  const dockerLog = join(work, 'docker.log');
  writeFileSync(join(bin, 'docker'), `#!/bin/bash\nprintf 'ARGV: %s\\n' "$*" >> ${JSON.stringify(dockerLog)}\nexit 0\n`);
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

describe('pre-run-reset.sh restarts agent-monitor in the SAME project the install actually used', () => {
  it('passes -p with the isolated project name install.sh would have used — never the compose file default', () => {
    const f = fixture();
    const r = spawnSync('bash', [RESET, '--prd', f.prd, '--log-dir', f.logDir], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, COMPOSE_OVERRIDE: f.override },
    });
    expect(r.status, `pre-run-reset.sh failed:\n${r.stdout}\n${r.stderr}`).toBe(0);

    const log = require('node:fs').existsSync(f.dockerLog) ? readFileSync(f.dockerLog, 'utf8') : '';
    const forceRecreateCall = log.split('\n').find((l) => l.includes('force-recreate') && l.includes('agent-monitor'));
    expect(forceRecreateCall, `no force-recreate call reached docker at all:\n${log}`).toBeTruthy();

    const expected = expectedObsProject(REPO_ROOT);
    expect(expected.length, 'could not derive the expected project name from isolated-compose-identity.sh itself').toBeGreaterThan(0);
    expect(forceRecreateCall, `agent-monitor was restarted without the isolated project name (expected -p ${expected}):\n${forceRecreateCall}`)
      .toMatch(new RegExp(`-p\\s+${expected}\\b`));
  });
});
