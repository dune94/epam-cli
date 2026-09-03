import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * THE INSTALLER MUST DO WHAT IT REPORTS.
 *
 * install.sh has three defects that are all SILENT, which is what makes them worth a test rather
 * than a fix-and-move-on:
 *
 *   1. it copies `.env.sample`, guarded by `[ -f "$ROOT/.env.sample" ]`. The file is called
 *      `.env.example`. The guard is false, the copy never happens, and NOTHING IS SAID — the
 *      operator is left without the file they are then told to fill in.
 *   2. it runs `docker compose up -d` with no `-f`, and there is no docker-compose.yml at the repo
 *      root — only three named files. It ends in `|| true`, so the failure is swallowed.
 *   3. it verifies the build with `[ -f dist/epam.js ]`, which passes on a stub of any size.
 *
 * Each is the same shape as the defects that cost four paid runs this week: a step that does
 * nothing and reports nothing. The installer is the first thing a client ever runs, so a silent
 * no-op here is the worst possible first impression.
 *
 * These tests EXECUTE install.sh against a fixture tree and assert what lands on disk.
 */
const REPO = path.resolve(__dirname, '../../..');
const INSTALLER = path.join(REPO, 'orchestrations-installer/install.sh');

/** A minimal tree with the shape install.sh reads, so the test never touches the real repo. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-'));
  fs.mkdirSync(path.join(dir, 'orchestrations/config'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'orchestrations-installer'), { recursive: true });
  fs.copyFileSync(INSTALLER, path.join(dir, 'orchestrations-installer/install.sh'));
  fs.chmodSync(path.join(dir, 'orchestrations-installer/install.sh'), 0o755);

  // THE SHARED RESOLVER SHIPS, so the fixture carries it. install.sh sources
  // orchestrations-installer/lib/container-runtime.sh rather than restating docker-or-podman a third
  // time; a fixture without it is not a tree anyone would ever install from.
  fs.mkdirSync(path.join(dir, 'orchestrations-installer/lib'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'orchestrations-installer/lib/container-runtime.sh'),
    path.join(dir, 'orchestrations-installer/lib/container-runtime.sh'));

  // the declarations install.sh reads, copied from the real ones so the shapes cannot drift
  for (const f of ['provider-sets.json', 'llm-defaults.claude.json']) {
    const src = path.join(REPO, 'orchestrations/config', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'orchestrations/config', f));
  }
  fs.writeFileSync(path.join(dir, '.env.example'), 'EPAM_PROVIDER_SET=claude\nJIRA_URL=\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
  return dir;
}

const run = (dir: string, args: string[] = []) =>
  spawnSync('bash', [path.join(dir, 'orchestrations-installer/install.sh'), ...args],
    { cwd: dir, encoding: 'utf8', timeout: 120_000, env: { ...process.env, EPAM_NONINTERACTIVE: '1' } });

describe('the installer', () => {
  it('creates .env from the template that actually exists', () => {
    // .env.sample does not exist and never has; .env.example does. The operator is told to fill in
    // a file the installer never created.
    const dir = fixture();
    const r = run(dir, ['--no-docker']);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out.length, 'installer produced no output — vacuous').toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, '.env')),
      `no .env was created. installer said:\n${out.slice(-600)}`).toBe(true);
  });

  it('never silently skips a step it was asked to do', () => {
    // If the template is missing entirely, that is a FAILURE to report, not a no-op to pass over.
    const dir = fixture();
    fs.rmSync(path.join(dir, '.env.example'));
    const r = run(dir, ['--no-docker']);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out, 'a missing template must be named, not passed over in silence')
      .toMatch(/\.env|template|example/i);
  });

  it('names a compose file rather than assuming one at the repo root', () => {
    // `docker compose up -d` with no -f fails here: there is no docker-compose.yml at the root,
    // only docker-compose.observability.yml and friends. Ending in `|| true` hides that.
    const body = fs.readFileSync(INSTALLER, 'utf8');
    const bare = body.split('\n').filter((l) => {
      const t = l.trim();
      if (t.startsWith('#')) return false;                     // a comment naming the defect
      // An INVOCATION, not a mention: `docker compose` must start a command, so it follows the
      // start of the line, a pipe, `&&`, `||`, `;`, or a subshell — never sit inside a message
      // string. An earlier version of this test flagged its own error text, which is a test
      // reporting on itself rather than on the code.
      if (!/(^|[|;&(]|\&\&|\|\|)\s*docker\s+compose\b/.test(t)) return false;
      return !/-f\s/.test(t);
    });
    expect(bare, `compose invoked with no -f:\n${bare.join('\n')}`).toEqual([]);
  });

  it('never calls a stub a build', () => {
    // `[ -f dist/epam.js ]` passes on a 188-byte stub, so the old check reported a successful build
    // for a tree that could not run.
    //
    // But it must not FAIL either, on a stack that does not use that CLI. claude.sh:1649-1650 routes
    // copilot|openai|openrouter|cursor|minimax|epam to $EPAM_CLI and `claude` to $CLAUDE_CMD, and
    // every provider set declares claude or codemie-claude as its runner — which is why this repo
    // runs green with a "Hello, World!" stub in dist/. A hard failure here would refuse an install
    // that works, so the rule is: always REPORT it, fail only when the stack needs it.
    const dir = fixture();
    fs.writeFileSync(path.join(dir, 'dist/epam.js'), '// stub\n');
    const r = run(dir, ['--check']);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out.length).toBeGreaterThan(0);
    expect(out, 'a stub was accepted silently as a real build').not.toMatch(/dist\/epam\.js present/i);
    expect(out, 'the stub must be named, whether or not it is fatal').toMatch(/stub/i);
  });
});

/**
 * A PACKAGED INSTALL HAS NO src/.
 *
 * The whole point of the packaging work is a tree that ships `dist/` and `orchestrations/` without
 * the CLI source (§1.4). `npm run build` runs `tsup`, which needs `src/` and the dev dependencies —
 * neither of which a client install has. Today the installer builds unconditionally, so on the
 * artefact it is meant to install it would fail at the one step that cannot be skipped.
 *
 * The rule: build when there is source to build FROM, verify otherwise, and say which happened.
 * Never silently skip, and never fail on a tree that is already complete.
 */
describe('the installer on a packaged tree (no src/)', () => {
  const packaged = () => {
    const dir = fixture();
    fs.rmSync(path.join(dir, 'src'), { recursive: true, force: true });
    // a real-looking bundle, as a release would ship
    fs.writeFileSync(path.join(dir, 'dist/epam.js'), `#!/usr/bin/env node\n${'// bundled\n'.repeat(6000)}`);
    return dir;
  };

  it('does not try to build when there is no source to build from', () => {
    const dir = packaged();
    const r = run(dir, ['--no-docker']);
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out.length).toBeGreaterThan(0);
    expect(out, 'it attempted a build on a tree with no src/ — that is the packaged case failing')
      .not.toMatch(/build failed/i);
  });

  it('accepts the shipped bundle and says it was not built here', () => {
    const dir = packaged();
    const out = `${run(dir, ['--no-docker']).stdout ?? ''}`;
    expect(out, 'a packaged install must state that it used the shipped bundle, not imply it built one')
      .toMatch(/shipped|packaged|pre-?built|no src/i);
  });

  it('names a stub bundle on a packaged tree, so nobody reads "ready" and assumes a build', () => {
    const dir = packaged();
    fs.writeFileSync(path.join(dir, 'dist/epam.js'), '// stub\n');
    const out = `${run(dir, ['--no-docker']).stdout ?? ''}`;
    expect(out, 'a stub bundle went unmentioned').toMatch(/stub/i);
  });
});

/**
 * THE THREE REMAINING DEFECTS from the packaging plan's list.
 *
 * #5 no `epam` PATH shim — the one on this machine hardcodes an absolute repo path, so it is
 *    correct for exactly one checkout and wrong for every install.
 * #6 the installer never asks for or writes JIRA_URL, JIRA_PROJECT_KEY or JIRA_CODELINE_ROOT,
 *    which are the three things it cannot derive and the operator cannot guess.
 * #7 88 python handlers, and no check that python3 exists.
 *
 * On #7 the plan said "no Python env setup, though 88 handlers need it", implying a venv. Measured:
 * every import across all 88 is stdlib, plus one LOCAL module (`_testfile`, imported by siblings in
 * the same directory). So the requirement is the INTERPRETER, nothing more — a much smaller job
 * than the plan assumed, and worth checking before building a venv nobody needs.
 */
describe('the installer completes an install', () => {
  it('checks python3, because 88 handlers are executed with it', () => {
    const dir = fixture();
    const out = `${run(dir, ['--no-docker']).stdout ?? ''}`;
    expect(out, 'python3 is never checked, yet 88 handlers need it').toMatch(/python/i);
  });

  it('creates an epam shim that points at THIS install, not a hardcoded path', () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, 'dist/epam.js'), `#!/usr/bin/env node\n${'// bundled\n'.repeat(6000)}`);
    const binDir = path.join(dir, 'bin');
    const r = spawnSync('bash', [path.join(dir, 'orchestrations-installer/install.sh'), '--no-docker'],
      { cwd: dir, encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, EPAM_NONINTERACTIVE: '1', EPAM_BIN_DIR: binDir } });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const shim = path.join(binDir, 'epam');
    expect(fs.existsSync(shim), `no shim was created. installer said:\n${out.slice(-500)}`).toBe(true);
    const body = fs.readFileSync(shim, 'utf8');
    expect(body, 'the shim points somewhere other than this install').toContain(dir);
    expect((fs.statSync(shim).mode & 0o111) !== 0, 'the shim is not executable').toBe(true);
  });

  it('records the Jira answers it is given, since it cannot derive them', () => {
    const dir = fixture();
    fs.mkdirSync(path.join(dir, 'orchestrations/projects/demo'), { recursive: true });
    const r = spawnSync('bash', [path.join(dir, 'orchestrations-installer/install.sh'), '--no-docker'],
      { cwd: dir, encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, EPAM_NONINTERACTIVE: '1',
               EPAM_PROJECT: 'demo',
               JIRA_URL: 'https://example.atlassian.net',
               JIRA_PROJECT_KEY: 'DEMO',
               JIRA_CODELINE_ROOT: dir } });
    const cfg = path.join(dir, 'orchestrations/projects/demo/config.env');
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(fs.existsSync(cfg), `no config.env written. installer said:\n${out.slice(-500)}`).toBe(true);
    const body = fs.readFileSync(cfg, 'utf8');
    expect(body).toMatch(/JIRA_URL=https:\/\/example\.atlassian\.net/);
    expect(body).toMatch(/JIRA_PROJECT_KEY=DEMO/);
    expect(body).toMatch(new RegExp(`JIRA_CODELINE_ROOT=${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('never writes a credential into project config — secrets live in .env alone', () => {
    const dir = fixture();
    fs.mkdirSync(path.join(dir, 'orchestrations/projects/demo'), { recursive: true });
    spawnSync('bash', [path.join(dir, 'orchestrations-installer/install.sh'), '--no-docker'],
      { cwd: dir, encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, EPAM_NONINTERACTIVE: '1', EPAM_PROJECT: 'demo',
               JIRA_URL: 'https://example.atlassian.net', JIRA_PROJECT_KEY: 'DEMO',
               JIRA_CODELINE_ROOT: dir,
               JIRA_TOKEN: 'should-never-be-written', ANTHROPIC_API_KEY: 'sk-must-not-appear' } });
    const cfg = path.join(dir, 'orchestrations/projects/demo/config.env');
    if (!fs.existsSync(cfg)) return;      // covered by the previous test
    const body = fs.readFileSync(cfg, 'utf8');
    expect(body, 'a token reached project config').not.toMatch(/should-never-be-written/);
    expect(body, 'an API key reached project config').not.toMatch(/sk-must-not-appear/);
  });
});

/**
 * THE INSTALL RECORDS WHAT IT IS — runtime, replay, mode.
 *
 * Plan §5.1a: the container runtime is DECLARED (docker | podman), never inferred. Podman is the
 * Windows default because Docker Desktop needs a paid subscription above 250 employees or $10M
 * revenue — a procurement conversation, not a technical preference, is what stalls a rollout.
 *
 * Plan §5.1c: replay is a config option. Langfuse is the RECORDER, not a dashboard: a run executed
 * without it can never be replayed, and the loss is one-way — the turns were never captured.
 *
 * Both must be WRITTEN DOWN. An install whose mode can only be inferred from which containers
 * happen to be running is an install nobody can reason about later.
 */
describe('the install records what it is', () => {
  const manifestOf = (dir: string) => {
    const p = path.join(dir, 'install-manifest.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  };

  const install = (dir: string, env: Record<string, string> = {}, args = ['--no-docker']) =>
    spawnSync('bash', [path.join(dir, 'orchestrations-installer/install.sh'), ...args],
      { cwd: dir, encoding: 'utf8', timeout: 120_000,
        env: { ...process.env, EPAM_NONINTERACTIVE: '1', ...env } });

  it('writes an install manifest naming the stack, runtime and replay mode', () => {
    const dir = fixture();
    const r = install(dir);
    const m = manifestOf(dir);
    expect(m, `no install-manifest.json. installer said:\n${(r.stdout ?? '').slice(-500)}`).toBeTruthy();
    expect(m.stack).toBeTruthy();
    expect(m.containerRuntime).toBeTruthy();
    expect(m.replay).toBeTruthy();
    expect(m.installedAt).toBeTruthy();
  });

  it('honours a declared container runtime rather than inferring one', () => {
    const dir = fixture();
    install(dir, { EPAM_CONTAINER_RUNTIME: 'podman' });
    expect(manifestOf(dir).containerRuntime).toBe('podman');
  });

  it('REPORTS the runtime it will use, so it is never a silent assumption', () => {
    const dir = fixture();
    const out = `${install(dir, { EPAM_CONTAINER_RUNTIME: 'podman' }).stdout ?? ''}`;
    expect(out).toMatch(/podman/i);
  });

  it('replay defaults to off, and says what that costs', () => {
    // Off is the right default — 2.36GB of images for a recorder is not a silent opt-in. But the
    // consequence is one-way and must be stated: runs made now can never be replayed later.
    const dir = fixture();
    const out = `${install(dir).stdout ?? ''}`;
    expect(manifestOf(dir).replay).toBe('off');
    expect(out, 'replay: off must state that runs will not be replayable')
      .toMatch(/replay.*(off|not be replay|cannot be replay)/i);
  });

  it('replay: on demands the Langfuse keys, because recording without them is silent', () => {
    // LangfuseTracer.ts:30 gates on BOTH keys. A fresh install has empty volumes, so no project and
    // no keys exist — and tracing is silently off while the containers run and capture nothing.
    const dir = fixture();
    const r = install(dir, { EPAM_REPLAY: 'on', LANGFUSE_SECRET_KEY: '', LANGFUSE_PUBLIC_KEY: '' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out, 'replay: on with no keys must be reported, not silently recording nothing')
      .toMatch(/LANGFUSE_SECRET_KEY|LANGFUSE_PUBLIC_KEY|langfuse.*key/i);
    // NAMING IT IS NOT ENOUGH. Mentioning the keys stays true whether the install fails or passes,
    // so an earlier version of this test could not tell those apart — changing _bad to _ok left it
    // green. The plan requires a FAILURE here, because the loss is one-way: a run executed without
    // recording can never be replayed, and nothing recovers it afterwards.
    expect(r.status, 'replay: on with no keys must FAIL the install, not warn').not.toBe(0);
  });

  it('rejects a runtime it does not support rather than falling back to one', () => {
    const dir = fixture();
    const r = install(dir, { EPAM_CONTAINER_RUNTIME: 'containerd' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    expect(out).toMatch(/containerd/);
    expect(r.status, 'an unsupported runtime must fail the install').not.toBe(0);
  });
});
