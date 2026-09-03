import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * --uninstall MUST BE STRUCTURALLY INCAPABLE OF TOUCHING THE DEV ENVIRONMENT — not merely
 * unlikely to, by construction. Confirmed live 2026-09-03: the real hand-run dev stacks declare
 * their own literal project names ("dev-amsd-pipeline" / "dev-amsd-pipeline-launch", via each
 * compose file's top-level `name:` key); isolated_project_name() always produces
 * "test-install-amsd-pipeline-<suffix>-<number>". Those prefixes cannot collide, so a
 * `docker compose -p <computed-name> down` can never resolve to the dev stack's own containers,
 * network, or volumes — verified directly against Docker's real project namespacing (docker
 * volume ls / docker network inspect showed completely distinct names and subnets for the dev
 * stack vs. a test install, with zero code needed to make that true).
 *
 * --uninstall removes ONLY the docker footprint (containers, network, volumes) of the install at
 * $ROOT (or --dest) — never the files on disk. Run evidence and .env live under a directory that
 * is untouched either way.
 */
const REPO = path.resolve(__dirname, '../../..');
const INSTALLER_REL = 'orchestrations-installer/install.sh';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-uninstall-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(dir, 'orchestrations-installer/lib'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(REPO, INSTALLER_REL), path.join(dir, INSTALLER_REL));
  fs.chmodSync(path.join(dir, INSTALLER_REL), 0o755);
  for (const f of ['container-runtime.sh', 'isolated-compose-identity.sh']) {
    fs.copyFileSync(path.join(REPO, 'orchestrations-installer/lib', f), path.join(dir, 'orchestrations-installer/lib', f));
  }
  fs.writeFileSync(path.join(dir, 'docker-compose.observability.yml'), 'services: {}\n');
  fs.mkdirSync(path.join(dir, 'launch-dashboard'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'launch-dashboard/docker-compose.yml'), 'services: {}\n');
  // A file that must SURVIVE uninstall — proof this never touches the filesystem, only docker.
  fs.mkdirSync(path.join(dir, 'orchestrations/logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'orchestrations/logs/real-run-evidence.json'), 'must survive');

  const log = path.join(dir, 'docker.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
printf 'ARGV: %s\\n' "$*" >> ${JSON.stringify(log)}
exit 0
`);
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  return { dir, bin, log };
}

const run = (f: { dir: string; bin: string }, args: string[]) =>
  spawnSync('bash', [path.join(f.dir, INSTALLER_REL), ...args], {
    cwd: f.dir, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, EPAM_NONINTERACTIVE: '1', EPAM_CONTAINER_RUNTIME: 'docker' },
  });

describe('install.sh --uninstall', () => {
  it('tears down BOTH compose projects, scoped by -p, with volumes removed', () => {
    const f = fixture();
    const r = run(f, ['--uninstall']);
    const log = fs.readFileSync(f.log, 'utf8');
    expect(log, `docker was never invoked:\n${r.stdout}${r.stderr}`).toMatch(/compose/);
    expect(log, 'no -p (project) scoping reached the down command').toMatch(/-p\s+test-install-amsd-pipeline-obs-\d+/);
    expect(log, 'no -p (project) scoping reached the down command').toMatch(/-p\s+test-install-amsd-pipeline-launch-\d+/);
    expect(log, 'volumes must be removed too, or a re-install inherits stale data').toMatch(/down.*-v|-v.*down/);
    expect(log, 'locally-built images must be removed too, or a re-install inherits a stale build').toMatch(/--rmi\s+local/);
  });

  it('the computed project name can never match the dev environment\'s own shape ("dev-amsd-pipeline*", no numeric suffix)', () => {
    const f = fixture();
    run(f, ['--uninstall']);
    const log = fs.readFileSync(f.log, 'utf8');
    // Every -p argument captured must match the isolated shape, never the literal "dev-amsd-
    // pipeline"/"dev-amsd-pipeline-launch" names the hand-run dev compose files declare.
    const projects = [...log.matchAll(/-p\s+(\S+)/g)].map((m) => m[1]);
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) {
      expect(p, `a -p value did not match the isolated shape: ${p}`).toMatch(/^test-install-amsd-pipeline-(obs|launch)-\d+$/);
      expect(p).not.toBe('dev-amsd-pipeline');
      expect(p).not.toBe('dev-amsd-pipeline-launch');
    }
  });

  it('never touches files on disk — only the docker footprint', () => {
    const f = fixture();
    run(f, ['--uninstall']);
    const evidence = path.join(f.dir, 'orchestrations/logs/real-run-evidence.json');
    expect(fs.existsSync(evidence), 'uninstall deleted files it must never touch').toBe(true);
    expect(fs.readFileSync(evidence, 'utf8')).toBe('must survive');
  });

  it('with --dest, uninstalls the NAMED install, not wherever install.sh happens to be sitting', () => {
    const f = fixture();
    // `other` needs its OWN compose file too, or nothing is there to attempt tearing down at all.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-uninstall-dest-'));
    fs.writeFileSync(path.join(other, 'docker-compose.observability.yml'), 'services: {}\n');

    const r = run(f, ['--uninstall', '--dest', other]);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const destLog = fs.readFileSync(f.log, 'utf8'); // the stub docker still lives under f.bin
    const destProjects = [...destLog.matchAll(/-p\s+(\S+)/g)].map((m) => m[1]);
    expect(destProjects.length, `--dest run never invoked compose:\n${r.stdout}${r.stderr}`).toBeGreaterThan(0);

    fs.rmSync(f.log); // isolate the second invocation's log from the first
    const fDirRun = run(f, ['--uninstall']);
    expect(fDirRun.status).toBe(0);
    const fDirProjects = [...fs.readFileSync(f.log, 'utf8').matchAll(/-p\s+(\S+)/g)].map((m) => m[1]);

    // Two DIFFERENT roots must hash to two DIFFERENT project names — proves --dest actually
    // changed which install got targeted, not just that both runs happened to succeed.
    expect(destProjects[0]).not.toBe(fDirProjects[0]);
  });

  it('is a no-op success, never an error, when nothing is currently running', () => {
    // The stub docker always exits 0 regardless, so this specifically proves the SCRIPT's own
    // logic treats "down succeeded" (even on nothing) as success, not a failure to report.
    const f = fixture();
    const r = run(f, ['--uninstall']);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
  });

  it('reports what it removed, so an operator is never left guessing', () => {
    const f = fixture();
    const r = run(f, ['--uninstall']);
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toMatch(/test-install-amsd-pipeline-obs-\d+/);
    expect(out).toMatch(/test-install-amsd-pipeline-launch-\d+/);
  });
});
