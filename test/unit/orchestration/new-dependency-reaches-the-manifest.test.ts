/**
 * THE WRITER IS TOLD NEW DEPENDENCIES ARE INSTALLED FOR IT. THAT HAS TO BE TRUE.
 *
 * claude.sh:2120 injects this into every brownfield writer's prompt:
 *
 *   "## Adding a New Dependency
 *    If the fix genuinely requires a package this project does not yet declare, import it
 *    directly and continue — do not stop to ask whether this is possible or search for an
 *    alternative that avoids it. Missing imports are detected and installed automatically
 *    after your change; this does not need your permission or a separate step."
 *
 * and claude.sh:3128 states the policy outright: "only NEW dependencies should be added
 * via the manifest".
 *
 * The mechanism fulfilling that promise was `npm install --no-save`, which puts the
 * package in node_modules and NEVER touches package.json. So the promise was false: the
 * build passes, tsc passes, the tests pass, and the change cannot work for a real user
 * because nothing declares the package.
 *
 * Live metrolinx 20260804T225443Z, AMSD-2041. The writer checked, found
 * @contentstack/live-preview-utils absent from package.json, wrote in its own source
 * "@contentstack/live-preview-utils is not installed in this project", and built a
 * URL-param workaround instead of the prescribed SDK integration. The reviewer called the
 * result "dead code from a runtime perspective". Everything downstream — the cascading
 * type errors against an SDK it half-used, the HealingBroken loop, three rejected lanes —
 * follows from the writer correctly refusing to trust an instruction the pipeline did not
 * honour. metrolinx still has live-preview-utils in node_modules and absent from its
 * package.json: the exact state --no-save produces.
 *
 * These tests execute the REAL configured install command against a REAL npm project.
 * A local-path package is used so the install is hermetic — no registry, no network.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const DEP_CONFIG = join(REPO_ROOT, 'orchestrations/projects/metrolinx/dependency-check.json');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');

const NODE20_BIN = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin';
const npmPath = () =>
  existsSync(join(NODE20_BIN, 'npm')) ? `${NODE20_BIN}:${process.env.PATH}` : process.env.PATH;
const haveNpm = () =>
  spawnSync('npm', ['--version'], { env: { ...process.env, PATH: npmPath() } }).status === 0;

/** A minimal npm project plus a local package it can install without a registry. */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'dep-'));
  const app = join(root, 'app');
  const sdk = join(root, 'fake-sdk');
  mkdirSync(app, { recursive: true });
  mkdirSync(sdk, { recursive: true });
  writeFileSync(
    join(sdk, 'package.json'),
    JSON.stringify({ name: 'fake-sdk', version: '1.0.0', main: 'index.js' }),
  );
  writeFileSync(join(sdk, 'index.js'), 'module.exports = {};\n');
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'app', version: '1.0.0', dependencies: {} }, null, 2),
  );
  return { root, app, sdk };
}

/** Run the project's OWN configured installCommand, with {package} substituted. */
function runConfiguredInstall(app: string, pkg: string) {
  const cfg = JSON.parse(readFileSync(DEP_CONFIG, 'utf8'));
  const cmd: string = cfg.installCommand.replace('{package}', pkg);
  const r = spawnSync('bash', ['-c', cmd], {
    cwd: app,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, PATH: npmPath() },
  });
  return {
    cmd,
    status: r.status,
    manifest: JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')),
    out: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

describe('the configured install reaches the manifest', () => {
  it.skipIf(!haveNpm())('THE PROMISE: installing a new package updates package.json', () => {
    const p = project();
    const r = runConfiguredInstall(p.app, p.sdk);
    expect(r.status, `install failed:\n${r.cmd}\n${r.out}`).toBe(0);
    expect(
      r.manifest.dependencies,
      `the writer's prompt promises new dependencies are "installed automatically" and the ` +
        `engine's own policy says they are "added via the manifest". With --no-save neither ` +
        `is true: node_modules gains the package, package.json does not, and the change ` +
        `cannot work for a real user. Command was: ${r.cmd}`,
    ).toHaveProperty('fake-sdk');
  });

  it.skipIf(!haveNpm())('a lockfile is produced, so the install is reproducible', () => {
    const p = project();
    runConfiguredInstall(p.app, p.sdk);
    expect(
      existsSync(join(p.app, 'package-lock.json')),
      'all three metrolinx codelines track a lockfile; a dependency added without one is ' +
        'not reproducible for anyone else',
    ).toBe(true);
  });

  // Guards against the test being vacuous: prove the assertion above can FAIL, by running
  // the same install with the flag that caused the defect.
  it.skipIf(!haveNpm())('CONTROL: --no-save demonstrably does NOT update the manifest', () => {
    const p = project();
    const r = spawnSync('bash', ['-c', `npm install --no-save --ignore-scripts ${p.sdk}`], {
      cwd: p.app,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, PATH: npmPath() },
    });
    expect(r.status, `control install failed:\n${r.stderr}`).toBe(0);
    const manifest = JSON.parse(readFileSync(join(p.app, 'package.json'), 'utf8'));
    expect(
      manifest.dependencies,
      'if this ALSO saved, the test above would prove nothing about the flag',
    ).not.toHaveProperty('fake-sdk');
    expect(existsSync(join(p.app, 'node_modules/fake-sdk')), 'the package still lands on disk')
      .toBe(true);
  });
});

/**
 * A dependency addition is only real if it is REVIEWABLE. The manifest change has to
 * reach the writer-output manifest (what every gate is handed as its scope) and the
 * staging helper, or the reviewer judges the code and never sees the new package.
 */
describe('the dependency change is visible to the gates', () => {
  const STORY_OUTPUTS = join(REPO_ROOT, 'orchestrations/scripts/lib/story-outputs.sh');
  const GIT_OPS = join(REPO_ROOT, 'orchestrations/scripts/lib/git-ops.sh');

  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).stdout.trim();

  /** A brownfield repo where the story added a dependency. */
  function repoWithNewDep() {
    const root = mkdtempSync(join(tmpdir(), 'depvis-'));
    const repo = join(root, 'client');
    const logDir = join(root, 'logs');
    mkdirSync(repo, { recursive: true });
    mkdirSync(logDir, { recursive: true });
    git(root, 'init', '--quiet', '-b', 'develop', 'client');
    git(repo, 'config', 'user.email', 't@e.com');
    git(repo, 'config', 'user.name', 'T');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'c', dependencies: {} }, null, 2));
    writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ name: 'c', lockfileVersion: 3 }, null, 2));
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', 'baseline');
    writeFileSync(join(logDir, 'phase-baseline-sha.txt'), `${git(repo, 'rev-parse', 'HEAD')}\n`);

    // The story adds the dependency, exactly as a real install would.
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'c', dependencies: { 'some-sdk': '^1.0.0' } }, null, 2),
    );
    writeFileSync(
      join(repo, 'package-lock.json'),
      JSON.stringify({ name: 'c', lockfileVersion: 3, packages: { 'node_modules/some-sdk': {} } }, null, 2),
    );
    return { repo, logDir };
  }

  it('package.json and the lockfile are recorded as writer output', () => {
    const f = repoWithNewDep();
    const script = join(mkdtempSync(join(tmpdir(), 'so-')), 'run.sh');
    writeFileSync(
      script,
      [
        'set -uo pipefail',
        'log(){ :; }; info(){ :; }; warning(){ :; }; error(){ :; }; success(){ :; }',
        'PHASE=core',
        `source ${JSON.stringify(STORY_OUTPUTS)}`,
        `story_outputs_record ${JSON.stringify(f.repo)} ${JSON.stringify(f.logDir)}`,
      ].join('\n'),
    );
    spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    const manifest = readFileSync(join(f.logDir, 'story-outputs-core.txt'), 'utf8');
    expect(
      manifest,
      'the manifest is what gates are handed as scope — a dependency addition absent from ' +
        'it is a change the reviewer never sees',
    ).toContain('package.json');
    expect(manifest).toContain('package-lock.json');
  });

  it('and they are staged for commit, not filtered as engine noise', () => {
    const f = repoWithNewDep();
    const script = join(mkdtempSync(join(tmpdir(), 'ga-')), 'run.sh');
    writeFileSync(
      script,
      [
        'set -uo pipefail',
        'log(){ :; }; info(){ :; }; warning(){ :; }; error(){ :; }; success(){ :; }',
        `source ${JSON.stringify(GIT_OPS)}`,
        `git_add_client_outputs ${JSON.stringify(f.repo)}`,
      ].join('\n'),
    );
    spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    const staged = git(f.repo, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
    expect(staged).toContain('package.json');
    expect(staged).toContain('package-lock.json');
  });
});

describe('the prompt and the mechanism do not contradict each other', () => {
  const cfg = JSON.parse(readFileSync(DEP_CONFIG, 'utf8'));
  const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

  it('the writer is still told to import a needed package directly', () => {
    expect(
      claudeSrc,
      'if this directive is removed, the writer must instead be given an explicit way to ' +
        'report that it is blocked — silently working around a missing dependency is what ' +
        'produced the dead-code fix on AMSD-2041',
    ).toMatch(/Adding a New Dependency/);
  });

  it('so the configured install must NOT discard the manifest write', () => {
    expect(
      cfg.installCommand,
      'the prompt promises the package is installed for the writer and the engine\'s policy ' +
        'says new dependencies are added via the manifest — --no-save breaks both, and the ' +
        'writer caught the lie and stopped trusting the instruction',
    ).not.toMatch(/--no-save/);
  });
});
