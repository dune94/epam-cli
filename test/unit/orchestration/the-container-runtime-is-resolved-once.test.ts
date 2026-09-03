import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ONE PLACE RESOLVES THE CONTAINER RUNTIME.
 *
 * Three call sites invoke compose today and every one hardcodes `docker`:
 *   install.sh, dashboard-health-check.sh, pre-run-reset.sh
 *
 * Podman is already first-class elsewhere in this codebase — run-agent-orchestration.sh:4075 and
 * lib/sandbox-invoke.sh:42 both do `for _rt in docker podman` — so the pattern exists and the
 * compose path simply never adopted it. Plan §5.1a makes Podman the Windows default, because
 * Docker Desktop needs a paid subscription above 250 employees or $10M revenue.
 *
 * The rule this pins: the runtime is resolved ONCE, from a declaration, and the caller asks. Three
 * copies of a resolution rule is how they drift — the same defect class as the writer and gate each
 * holding their own idea of what a test file is.
 */
const REPO = path.resolve(__dirname, '../../..');
const LIB = path.join(REPO, 'orchestrations/scripts/lib/container-runtime.sh');

/** A fake runtime on PATH, so nothing here depends on what this machine happens to have. */
function fakeRuntime(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  const bin = path.join(dir, name);
  // ABSOLUTE INTERPRETER. `#!/usr/bin/env bash` makes env resolve bash via PATH, and PATH here is
  // isolated to this directory — so the stub silently failed to execute and the assertion saw an
  // empty string rather than a wrong command.
  fs.writeFileSync(bin, `#!/bin/bash\necho "${name} $*"\nexit 0\n`);
  fs.chmodSync(bin, 0o755);
  return dir;
}

/**
 * PATH IS THE FIXTURE, so it contains ONLY what the test declares.
 *
 * An earlier version appended /usr/bin:/bin "so bash works" — and this machine has a real docker
 * there, so discovery found it whatever the fixture said, and the podman case passed for the wrong
 * reason while the none case could not fail at all. `command -v` is a shell builtin, so an isolated
 * PATH costs nothing.
 */
const ask = (fn: string, pathDir: string, env: Record<string, string> = {}) =>
  spawnSync('/bin/bash', ['-c', `set -uo pipefail; . "${LIB}"; ${fn}`],
    { encoding: 'utf8', timeout: 60_000,
      env: { PATH: pathDir, HOME: process.env.HOME ?? '/tmp', ...env } });

describe('the container runtime', () => {
  it('is resolved from the declaration when one is given', () => {
    const r = ask('container_runtime', fakeRuntime('podman'), { EPAM_CONTAINER_RUNTIME: 'podman' });
    expect(`${r.stdout}`.trim()).toBe('podman');
  });

  it('discovers one in a declared order when nothing is declared', () => {
    expect(`${ask('container_runtime', fakeRuntime('docker')).stdout}`.trim()).toBe('docker');
    expect(`${ask('container_runtime', fakeRuntime('podman')).stdout}`.trim()).toBe('podman');
  });

  it('says so, and fails, when neither is present — never guesses', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'none-'));
    const r = ask('container_runtime', empty);
    expect(r.status, 'a missing runtime must fail, not return an empty string a caller then uses')
      .not.toBe(0);
  });

  it('refuses a declared runtime it cannot drive rather than falling back', () => {
    const r = ask('container_runtime', fakeRuntime('docker'), { EPAM_CONTAINER_RUNTIME: 'containerd' });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/containerd/);
  });

  it('builds a compose command for whichever runtime is in play', () => {
    const d = ask('container_compose -f x.yml up -d', fakeRuntime('docker'),
      { EPAM_CONTAINER_RUNTIME: 'docker' });
    expect(`${d.stdout}`).toMatch(/^docker compose -f x\.yml up -d/);

    const p = ask('container_compose -f x.yml up -d', fakeRuntime('podman'),
      { EPAM_CONTAINER_RUNTIME: 'podman' });
    expect(`${p.stdout}`, 'podman was not used for a podman install').toMatch(/^podman compose -f x\.yml up -d/);
  });

  it('never invokes compose without naming a file', () => {
    // `docker compose up -d` with no -f is what made install.sh report "docker is up" having
    // started nothing: there is no docker-compose.yml at the repo root, only named files.
    const r = ask('container_compose up -d', fakeRuntime('docker'), { EPAM_CONTAINER_RUNTIME: 'docker' });
    expect(r.status, 'compose ran with no -f').not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/-f|compose file/i);
  });
});
