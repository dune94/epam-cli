import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * THE INSTALLER MUST INSTALL ON THE RUNTIME IT REPORTS.
 *
 * install.sh already discovers docker-or-podman and PRINTS which one it picked — and then both the
 * health probe and the compose call say `docker` literally:
 *
 *     docker_up() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }
 *     ... docker compose -f "$COMPOSE_FILE" up -d ...
 *
 * So on a podman-only machine the installer announces "runtime: podman" and then starts nothing,
 * reporting either "docker is not running" or, with --docker, a hard failure. The report and the
 * behaviour disagree, which is the exact defect class the other installer tests exist for.
 *
 * WHY PODMAN AT ALL: Docker Desktop requires a paid subscription above 250 employees or $10M
 * revenue. That is a procurement conversation, and it is what stalls a client rollout — not a
 * technical preference.
 *
 * These tests EXECUTE install.sh with STUB runtimes that record every invocation, and assert which
 * binary was actually asked to bring the services up.
 */
const REPO = path.resolve(__dirname, '../../..');
const INSTALLER = path.join(REPO, 'orchestrations-installer/install.sh');

/**
 * A fixture tree plus a stub-binary directory placed FIRST on PATH.
 *
 * Both runtimes are stubbed, and each appends its argv to its own log. Stubbing both is what makes
 * the negative assertion possible: "podman was used" is weak on a machine where docker also
 * answers, so the test also proves docker was NOT the one asked to run compose.
 */
function fixture(runtimes: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-podman-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(dir, 'orchestrations/config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(dir, 'orchestrations-installer'), { recursive: true });
  fs.copyFileSync(INSTALLER, path.join(dir, 'orchestrations-installer/install.sh'));
  fs.chmodSync(path.join(dir, 'orchestrations-installer/install.sh'), 0o755);

  // the shared resolvers the installer is expected to consult
  fs.mkdirSync(path.join(dir, 'orchestrations-installer/lib'), { recursive: true });
  for (const f of ['container-runtime.sh', 'isolated-compose-identity.sh']) {
    const libSrc = path.join(REPO, 'orchestrations-installer/lib', f);
    if (fs.existsSync(libSrc)) {
      fs.copyFileSync(libSrc, path.join(dir, 'orchestrations-installer/lib', f));
    }
  }
  for (const f of ['provider-sets.json', 'llm-defaults.claude.json']) {
    const src = path.join(REPO, 'orchestrations/config', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'orchestrations/config', f));
  }
  fs.writeFileSync(path.join(dir, '.env.example'), 'EPAM_PROVIDER_SET=claude\nJIRA_URL=\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));

  // a real compose file, so a refusal cannot be blamed on a missing one
  fs.writeFileSync(path.join(dir, 'docker-compose.observability.yml'), "services: {}\n");

  for (const rt of runtimes) {
    const log = path.join(dir, `${rt}.log`);
    // ABSOLUTE INTERPRETER — the stub must not depend on PATH to find its own shell.
    fs.writeFileSync(path.join(bin, rt),
      `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
    fs.chmodSync(path.join(bin, rt), 0o755);
  }
  return { dir, bin };
}

const logOf = (dir: string, rt: string) => {
  const p = path.join(dir, `${rt}.log`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

/**
 * PATH IS PREFIXED, NOT REPLACED: install.sh needs node, uname, grep and friends. The stubs shadow
 * the real runtimes because they come first.
 */
const run = (f: { dir: string; bin: string }, args: string[], env: Record<string, string> = {}) =>
  spawnSync('bash', [path.join(f.dir, 'orchestrations-installer/install.sh'), ...args], {
    cwd: f.dir, encoding: 'utf8', timeout: 120_000,
    // EPAM_BIN_DIR STAYS IN THE FIXTURE. Without it the installer writes a real shim into
    // ~/.local/bin/epam pointing at this temp tree, and deleting the tree leaves the operator's
    // own `epam` command broken. A test must not reach outside its fixture.
    env: {
      ...process.env, PATH: `${f.bin}:${process.env.PATH}`,
      EPAM_NONINTERACTIVE: '1', EPAM_BIN_DIR: path.join(f.dir, 'bin-shim'), ...env,
    },
  });

describe('the installer on podman', () => {
  it('brings the services up with the declared runtime, not with docker', () => {
    // Both runtimes answer. podman is DECLARED, so podman is what must run compose.
    const f = fixture(['docker', 'podman']);
    const r = run(f, ['--docker'], { EPAM_CONTAINER_RUNTIME: 'podman' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out.length, 'installer produced no output — vacuous').toBeGreaterThan(0);

    const pod = logOf(f.dir, 'podman');
    const dock = logOf(f.dir, 'docker');
    expect(pod, `podman was never invoked. installer said:\n${out.slice(-900)}`)
      .toMatch(/compose .*up -d/);
    expect(dock, `docker ran compose even though podman was the declared runtime:\n${dock}`)
      .not.toMatch(/compose/);
  });

  it('treats no runtime at all as a supported install, not a failure', () => {
    // DISCOVERY ORDER IS NOT TESTED HERE — it is tested in the resolver's own suite, under a fully
    // isolated PATH. This PATH cannot be isolated: install.sh needs node, grep and uname, which
    // live in the same /usr/bin as the real docker, so a "docker is absent" fixture is not
    // constructible at this level. Shadowing docker with a failing stub does not work either:
    // `command -v` tests executability, not exit status, so discovery would still pick it.
    //
    // What IS this installer's own branch is the one below: a machine with no runtime must still
    // install. The pipeline runs without containers, and --no-docker is a supported install, so
    // reporting "none" and continuing is correct and exiting non-zero would be a regression.
    const f = fixture([]);
    const r = run(f, [], { EPAM_CONTAINER_RUNTIMES: 'no-such-runtime' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out.length, 'installer produced no output — vacuous').toBeGreaterThan(0);
    expect(out, 'the installer did not report that it found no runtime').toMatch(/runtime: none/);
    expect(r.status, `no container runtime must not fail the install:\n${out.slice(-900)}`).toBe(0);
  });
});
