/**
 * THE REHEARSAL SERVICE BELONGS TO THE INSTALL THAT USES IT.
 *
 * Two defects found on 2026-09-04 while preparing a free mockserver rehearsal in a fresh install.
 *
 * ── 1. MockServer is not wired into the installer at all ────────────────────────────────────────
 *
 * `grep -c 'mock' install.sh` is zero. The install ships llm-defaults.mockserver.json pointing
 * every one of the 40 seams at http://localhost:1080, ships the compose file that could serve it,
 * and provides no way to start it. So the only running instance was one belonging to a DIFFERENT
 * tree — `docker inspect` reported working_dir=<the dev checkout> — and a "test install rehearsal"
 * would in fact have been driven by the developer's own container.
 *
 * That matters beyond tidiness: pipeline-services.sh --stop is the operator's "pause everything".
 * A service it does not know about keeps running and keeps its memory after everything else has
 * been stopped.
 *
 * The identity must come from the SAME place the other two stacks get theirs — the persisted
 * state file — so a stop uses what the install actually resolved to and never re-decides. And it
 * must NOT come up on a normal --start: a rehearsal server running permanently is a JVM holding
 * memory for a run nobody asked for.
 *
 * ── 2. A fresh install points metrolinx at the REAL client repositories ─────────────────────────
 *
 * The shipped default is JIRA_CODELINE_ROOT=/home/bradleyjerome/projects/metrolinx — the operator's
 * actual client checkouts. The standing rule is that runs go against the fixtures under
 * .../tests/codelines and never the real thing. Every install therefore starts pointed at the real
 * repositories until somebody remembers to correct it by hand, which is a rule enforced by memory.
 *
 * A default that is dangerous when forgotten is not a default. There is no safe machine-specific
 * absolute path to ship, so the project ships NONE and says so: the run resolves it from the
 * environment, and a missing value is a loud failure rather than a silent write to a client repo.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../..');
const SCRIPT_REL = 'orchestrations-installer/pipeline-services.sh';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** The same fixture shape pipeline-services-start-stop.test.ts uses, plus the mock stack. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-service-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(dir, 'orchestrations-installer/lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'orchestrations/mock-llm'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(REPO, SCRIPT_REL), path.join(dir, SCRIPT_REL));
  fs.chmodSync(path.join(dir, SCRIPT_REL), 0o755);
  for (const f of ['container-runtime.sh', 'runner-host-control.sh', 'snapshot-watch-control.sh']) {
    const src = path.join(REPO, 'orchestrations-installer/lib', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'orchestrations-installer/lib', f));
  }
  fs.writeFileSync(path.join(dir, 'docker-compose.observability.yml'), 'services: {}\n');
  fs.mkdirSync(path.join(dir, 'launch-dashboard'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'launch-dashboard/docker-compose.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(dir, 'orchestrations/mock-llm/docker-compose.yml'), 'services: {}\n');

  const dockerLog = path.join(dir, 'docker.log');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash
{ printf 'ARGV: %s\\n' "$*"; printf 'EPAM_MOCK_SUBNET=%s\\n' "\${EPAM_MOCK_SUBNET:-}"; } >> ${JSON.stringify(dockerLog)}
exit 0
`);
  fs.chmodSync(path.join(bin, 'docker'), 0o755);
  return { dir, bin, dockerLog };
}

function writeState(dir: string, extra: Record<string, string> = {}) {
  const fields: Record<string, string> = {
    OBS_PROJECT: 'inst-obs-123456', OBS_SUBNET: '172.24.0.0/16',
    LAUNCH_PROJECT: 'inst-launch-123456', LAUNCH_SUBNET: '172.25.0.0/16', LAUNCH_UI_PORT: '18199',
    MOCK_PROJECT: 'inst-mock-123456', MOCK_SUBNET: '172.29.0.0/16',
    ...extra,
  };
  fs.writeFileSync(path.join(dir, '.pipeline-services-state.env'),
    Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}

const run = (f: { dir: string; bin: string }, args: string[]) =>
  spawnSync('bash', [path.join(f.dir, SCRIPT_REL), ...args], {
    cwd: f.dir, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, EPAM_NONINTERACTIVE: '1', EPAM_CONTAINER_RUNTIME: 'docker' },
  });

describe('the installer owns the rehearsal service', () => {
  it('--stop brings the mock stack down too, using the install\'s OWN saved identity', () => {
    const f = fixture();
    writeState(f.dir);
    const r = run(f, ['--stop']);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const log = fs.readFileSync(f.dockerLog, 'utf8');
    expect(log, [
      '"pause everything" left the rehearsal server running. It is a JVM holding memory for a run',
      'nobody asked for, and it belongs to whichever tree happened to start it — on 2026-09-04 the',
      'only instance belonged to the DEV checkout while a TEST install was about to rehearse.',
    ].join('\n')).toMatch(/-p\s+inst-mock-123456/);
    expect(log, 'a stop is a pause, never an uninstall').not.toMatch(/--rmi/);
  });

  it('--start does NOT bring it up — a rehearsal server is not a permanent service', () => {
    const f = fixture();
    writeState(f.dir);
    const r = run(f, ['--start']);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const log = fs.readFileSync(f.dockerLog, 'utf8');
    const upLines = log.split('\n').filter((l) => /ARGV:.*up\s+-d/.test(l));
    expect(upLines.join('\n'),
      'the mock stack came up on a normal start; it must be asked for, or every install pays a JVM')
      .not.toMatch(/inst-mock-123456/);
  });

  it('--start --mock DOES bring it up, with the saved project and subnet', () => {
    const f = fixture();
    writeState(f.dir);
    const r = run(f, ['--start', '--mock']);
    expect(r.status, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).toBe(0);
    const log = fs.readFileSync(f.dockerLog, 'utf8');
    expect(log, `the mock stack was not started:\n${log}`).toMatch(/-p\s+inst-mock-123456/);
    expect(log, 'the saved subnet did not reach compose — an allocated one fails on an exhausted pool')
      .toMatch(/EPAM_MOCK_SUBNET=172\.29\.0\.0\/16/);
  });

  it('an install with no saved mock identity says so rather than inventing one', () => {
    // Never re-decide: a guessed project name means the next stop cannot find what it started.
    const f = fixture();
    writeState(f.dir, { MOCK_PROJECT: '' });
    const r = run(f, ['--start', '--mock']);
    const out = `${r.stdout}${r.stderr}`;
    expect(out, 'nothing said the mock stack could not be identified').toMatch(/mock/i);
    const log = fs.existsSync(f.dockerLog) ? fs.readFileSync(f.dockerLog, 'utf8') : '';
    expect(log.split('\n').filter((l) => /up\s+-d/.test(l)).join('\n'),
      'it started a mock stack under an invented identity')
      .not.toMatch(/mock-llm/);
  });
});

describe('the installer records the rehearsal service\'s identity', () => {
  const install = fs.readFileSync(path.join(REPO, 'orchestrations-installer/install.sh'), 'utf8');

  it('install.sh derives and persists MOCK_PROJECT and MOCK_SUBNET', () => {
    expect(install, [
      'install.sh never resolves an identity for the mock stack, so pipeline-services.sh has',
      'nothing to read back and the rehearsal server can only be started by hand.',
    ].join('\n')).toMatch(/MOCK_PROJECT/);
    expect(install).toMatch(/MOCK_SUBNET/);
  });

  it('and derives them the SAME way as the other stacks, never with a literal', () => {
    const near = install.slice(Math.max(0, install.indexOf('MOCK_PROJECT') - 2000),
      install.indexOf('MOCK_PROJECT') + 2000);
    expect(near, 'the mock identity is hardcoded rather than isolated per destination')
      .toMatch(/isolated_project_name|isolated_subnet_candidates/);
  });
});

function scriptsThatGlob() {
  return fs.readdirSync(path.join(REPO, 'orchestrations/scripts'))
    .filter((f) => f.endsWith('.sh'))
    .filter((f) => /for\s+\w+\s+in\s+"\$JIRA_CODELINE_ROOT"\/\*/.test(
      fs.readFileSync(path.join(REPO, 'orchestrations/scripts', f), 'utf8')))
    .map((script) => ({ script }));
}

describe('no install starts out pointed at the real client repositories', () => {
  const configs = fs.readdirSync(path.join(REPO, 'orchestrations/projects'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ project: d.name, file: path.join(REPO, 'orchestrations/projects', d.name, 'config.env') }))
    .filter((c) => fs.existsSync(c.file));

  it('there are project configs to check', () => {
    expect(configs.length).toBeGreaterThan(0);
  });

  /**
   * REMOVING THE DEFAULT WITHOUT A GUARD WOULD BE FAR WORSE THAN THE DEFAULT.
   *
   * tier3-metrolinx-run.sh iterates `for _cl_dir in "$JIRA_CODELINE_ROOT"/*\/`. With the variable
   * empty that glob is `/*\/` — EVERY top-level directory on the machine — and each one is handed
   * to brownfield-preflight-reset.sh, which runs `git reset --hard` and `clean -fd`. So the guard
   * is not defensive tidiness; it is the thing that makes removing the default safe at all.
   */
  it('THE HAZARD IS REAL: the bare glob would iterate the filesystem root', () => {
    // Not a requirement — the JUSTIFICATION for the guard tested below, executed so it cannot
    // become folklore. The glob is inherently "/*/" when the variable is empty; what protects the
    // machine is refusing before reaching it, so this asserts the danger rather than its absence.
    const scripts = scriptsThatGlob();
    expect(scripts.length, 'no script globs off JIRA_CODELINE_ROOT — this check has drifted')
      .toBeGreaterThan(0);

    const src = fs.readFileSync(path.join(REPO, 'orchestrations/scripts', scripts[0].script), 'utf8');
    const line = src.split('\n').find((l) => /for\s+\w+\s+in\s+"\$JIRA_CODELINE_ROOT"\/\*/.test(l))!;
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-glob-'));
    try {
      const f = path.join(probe, 'p.sh');
      fs.writeFileSync(f, ['#!/bin/bash', 'JIRA_CODELINE_ROOT=""', 'n=0',
        line.trim().replace(/;\s*do\s*$/, '; do'), '  n=$((n+1))', 'done',
        'echo "ITERATIONS=$n"'].join('\n'));
      const r = spawnSync('bash', [f], { encoding: 'utf8', timeout: 20_000 });
      const n = Number((r.stdout.match(/ITERATIONS=(\d+)/) || [])[1] ?? -1);
      expect(n, [
        'the empty-root glob iterated nothing, so the guard below guards against nothing and this',
        'whole family of checks is vacuous. Expected it to sweep the filesystem root.',
      ].join('\n')).toBeGreaterThan(1);
    } finally { fs.rmSync(probe, { recursive: true, force: true }); }
  });

  it.each(scriptsThatGlob())('$script refuses to run at all with no codeline root', ({ script }) => {
    // The loop above proves the glob is dangerous. This proves the script never reaches it.
    const src = fs.readFileSync(path.join(REPO, 'orchestrations/scripts', script), 'utf8');
    const guardBefore = src.slice(0, src.search(/for\s+\w+\s+in\s+"\$JIRA_CODELINE_ROOT"\/\*/));
    expect(guardBefore, [
      `${script} reaches its codeline loop with no check that JIRA_CODELINE_ROOT names a real`,
      'directory. Empty expands to "/*/" and every top-level directory is hard-reset.',
    ].join('\n')).toMatch(/require_codeline_root\s/);
  });

  it.each(configs)('$project ships no absolute machine path as its codeline root', ({ file, project }) => {
    const declared = (fs.readFileSync(file, 'utf8')
      .match(/^\s*(?:export\s+)?JIRA_CODELINE_ROOT=(.*)$/m) || [])[1];
    if (declared === undefined) return;      // declares none: the run must supply it
    expect(declared.trim(), [
      `${project} ships JIRA_CODELINE_ROOT=${declared} — an absolute path on one machine, baked into`,
      'every install. For metrolinx that path is the operator\'s REAL client checkouts, while the',
      'standing rule is that runs go against the fixtures and never the real repositories. A',
      'default that is dangerous when forgotten is not a default: resolve it from the environment,',
      'so an unset value fails loudly instead of writing to a client repo.',
    ].join('\n')).not.toMatch(/^["']?\//);
  });
});
