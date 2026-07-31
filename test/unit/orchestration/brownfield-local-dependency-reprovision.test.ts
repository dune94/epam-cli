/**
 * Local dependency re-provisioning (2026-07-31): brownfield-preflight-reset.sh
 * must re-apply a codeline's localDependencyOverrides EVERY launch, after the
 * git reset — entirely inside node_modules (npm install --no-save), never
 * touching package.json/package-lock.json. This is the durable, engine-side
 * answer to "the fix will be wiped by the next git reset --hard" that does
 * NOT require ever committing anything to a client repo (standing rule:
 * feedback_no_client_repo_writes_or_hardcoding.md — never commit to a client
 * repo, not even locally, no exceptions).
 *
 * Concrete motivating case: @metrolinx/cx-shared resolves via GitHub Packages,
 * which requires a GH_TOKEN this environment doesn't have — a 401 left
 * next.upexpress.com's node_modules half-installed and every build broken.
 * The client already has the real package source cloned locally as its own
 * codeline (cx-shared). This mechanism re-provisions it from there, every run.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPT_PATH = join(REPO_ROOT, 'orchestrations/scripts/brownfield-preflight-reset.sh');

const cleanupDirs: string[] = [];
afterEach(() => { for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function scratch(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}

/** A real, minimal, installable local npm package — no network needed. */
function localPackageSource(name: string, version = '1.0.0') {
  const d = scratch('local-pkg-');
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
  writeFileSync(join(d, 'index.js'), `module.exports = { from: 'local-source', name: ${JSON.stringify(name)} };\n`);
  return d;
}

/**
 * Reproduces the exact live shape of @metrolinx/cx-shared: a package with a
 * peerDependency (a fake "peer-lib") that ALSO happens to have its own real
 * copy of that package sitting in its own node_modules (normal for local
 * development — cx-shared needs react to build/test itself), plus a `files`
 * field that deliberately does NOT include node_modules or src/.
 */
function localPackageWithPeerDependency() {
  const d = scratch('local-pkg-peer-');
  writeFileSync(join(d, 'package.json'), JSON.stringify({
    name: '@metrolinx/cx-shared',
    version: '1.0.0',
    main: 'build/index.js',
    files: ['build'],
    peerDependencies: { 'peer-lib': '^1.0.0' },
  }));
  mkdirSync(join(d, 'build'), { recursive: true });
  writeFileSync(join(d, 'build/index.js'), 'module.exports = require("peer-lib");\n');
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src/should-not-be-installed.ts'), 'export const raw = true;\n');
  mkdirSync(join(d, 'node_modules/peer-lib'), { recursive: true });
  writeFileSync(join(d, 'node_modules/peer-lib/package.json'), JSON.stringify({ name: 'peer-lib', version: '1.0.0', main: 'index.js' }));
  writeFileSync(join(d, 'node_modules/peer-lib/index.js'), 'module.exports = "SOURCE-PACKAGE-OWN-COPY";\n');
  return d;
}

/** A codeline: real git repo (so brownfield-preflight-reset.sh's baseline-branch
 *  path is a no-op — no JIRA_BASELINE_BRANCH set here, only the override matters),
 *  named by its own directory basename to match a localDependencyOverrides entry. */
function codelineFixture(dirName: string): string {
  const root = scratch('codeline-parent-');
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--quiet'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init', '--quiet'], { cwd: dir });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  return dir;
}

function manifestDir(overrides?: Array<{ codeline: string; package: string; localSourcePath: string }>) {
  const d = scratch('manifest-');
  if (overrides !== undefined) {
    writeFileSync(join(d, 'dependency-check.json'), JSON.stringify({ localDependencyOverrides: overrides }));
  }
  return d;
}

function runPreflight(projectRoot: string, env: Record<string, string> = {}) {
  const stateDir = scratch('state-');
  const r = spawnSync('bash', [SCRIPT_PATH, projectRoot], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, EPAM_BROWNFIELD_STATE_DIR: stateDir, ...env },
  });
  return { out: (r.stdout || '') + (r.stderr || ''), code: r.status ?? -1 };
}

describe('brownfield-preflight-reset.sh — local dependency re-provisioning', () => {
  it('installs the local package into node_modules when the codeline matches an override', () => {
    const pkgSrc = localPackageSource('@metrolinx/cx-shared');
    const codeline = codelineFixture('next.upexpress.com');
    const config = manifestDir([{ codeline: 'next.upexpress.com', package: '@metrolinx/cx-shared', localSourcePath: pkgSrc }]);

    const r = runPreflight(codeline, { EPAM_PROJECT_CONFIG_DIR: config });

    const installed = join(codeline, 'node_modules/@metrolinx/cx-shared/index.js');
    expect(existsSync(installed), `expected local package installed:\n${r.out}`).toBe(true);
    const content = readFileSync(installed, 'utf8');
    expect(content).toMatch(/local-source/);
  });

  it('does NOT modify package.json — no client-repo commit is ever needed for this to survive', () => {
    const pkgSrc = localPackageSource('@metrolinx/cx-shared');
    const codeline = codelineFixture('next.upexpress.com');
    const config = manifestDir([{ codeline: 'next.upexpress.com', package: '@metrolinx/cx-shared', localSourcePath: pkgSrc }]);
    const before = readFileSync(join(codeline, 'package.json'), 'utf8');

    runPreflight(codeline, { EPAM_PROJECT_CONFIG_DIR: config });

    const after = readFileSync(join(codeline, 'package.json'), 'utf8');
    expect(after).toBe(before);
    // node_modules/ shows up as untracked (`??`) — that's correct and expected
    // (it's gitignored in any real project). Only TRACKED-file changes matter.
    const gitStatus = execFileSync('git', ['status', '--porcelain'], { cwd: codeline, encoding: 'utf8' });
    const trackedChanges = gitStatus.split('\n').filter((l) => l && !l.startsWith('??'));
    expect(trackedChanges, 'no tracked file should have changed').toEqual([]);
  });

  it('does NOT install for a codeline whose basename does not match any override', () => {
    const pkgSrc = localPackageSource('@metrolinx/cx-shared');
    const codeline = codelineFixture('next.gotransit.com'); // different codeline name
    const config = manifestDir([{ codeline: 'next.upexpress.com', package: '@metrolinx/cx-shared', localSourcePath: pkgSrc }]);

    runPreflight(codeline, { EPAM_PROJECT_CONFIG_DIR: config });

    expect(existsSync(join(codeline, 'node_modules/@metrolinx/cx-shared'))).toBe(false);
  });

  it('is a no-op when no dependency-check.json exists at all (backward-compatible)', () => {
    const codeline = codelineFixture('next.upexpress.com');
    const emptyConfigDir = scratch('no-manifest-');

    const r = runPreflight(codeline, { EPAM_PROJECT_CONFIG_DIR: emptyConfigDir });

    expect(r.code).toBe(0);
    expect(existsSync(join(codeline, 'node_modules/@metrolinx/cx-shared'))).toBe(false);
  });

  it('is a no-op when the manifest has no localDependencyOverrides field', () => {
    const codeline = codelineFixture('next.upexpress.com');
    const config = manifestDir(); // dependency-check.json absent entirely — same as above, but explicit

    const r = runPreflight(codeline, { EPAM_PROJECT_CONFIG_DIR: config });

    expect(r.code).toBe(0);
  });

  it('warns but does not crash when localSourcePath does not exist', () => {
    const codeline = codelineFixture('next.upexpress.com');
    const config = manifestDir([{ codeline: 'next.upexpress.com', package: '@metrolinx/cx-shared', localSourcePath: '/does/not/exist' }]);

    const r = runPreflight(codeline, { EPAM_PROJECT_CONFIG_DIR: config });

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/does not exist/i);
  });

  it('re-applies even when the codeline is already at baseline with a clean tree (the "nothing to do" git path)', () => {
    // The whole point: re-provisioning must run on EVERY launch, not just
    // when a git reset actually happened — node_modules can be broken
    // independently of git state (e.g. first-ever run, or something else
    // wiped node_modules) and git status alone can never tell.
    const pkgSrc = localPackageSource('@metrolinx/cx-shared');
    const codeline = codelineFixture('next.upexpress.com');
    const config = manifestDir([{ codeline: 'next.upexpress.com', package: '@metrolinx/cx-shared', localSourcePath: pkgSrc }]);

    const r = runPreflight(codeline, { EPAM_PROJECT_CONFIG_DIR: config });

    expect(r.out).toMatch(/already at baseline|nothing known-good to reset/i).not.toBeUndefined;
    expect(existsSync(join(codeline, 'node_modules/@metrolinx/cx-shared/index.js')),
      `re-provisioning must still run on the no-op git path:\n${r.out}`).toBe(true);
  });

  it('does NOT install the source package\'s own node_modules/src — live regression, a direct file:<dir> reference pulled in cx-shared\'s own react copy and produced a dual-React-instance bug', () => {
    const pkgSrc = localPackageWithPeerDependency();
    const codeline = codelineFixture('next.upexpress.com');
    const config = manifestDir([{ codeline: 'next.upexpress.com', package: '@metrolinx/cx-shared', localSourcePath: pkgSrc }]);

    const r = runPreflight(codeline, { EPAM_PROJECT_CONFIG_DIR: config });

    const installedRoot = join(codeline, 'node_modules/@metrolinx/cx-shared');
    expect(existsSync(join(installedRoot, 'build/index.js')), `expected build/ installed:\n${r.out}`).toBe(true);
    expect(existsSync(join(installedRoot, 'node_modules/peer-lib')),
      'the source package\'s OWN peer-lib copy must not be installed — it would shadow the consumer\'s own copy').toBe(false);
    expect(existsSync(join(installedRoot, 'src/should-not-be-installed.ts')),
      'raw src/ (excluded by the files field) must not be installed').toBe(false);
  });

  it('applies MULTIPLE overrides for the same codeline', () => {
    const pkgA = localPackageSource('@metrolinx/cx-shared');
    const pkgB = localPackageSource('@metrolinx/cx-other');
    const codeline = codelineFixture('next.upexpress.com');
    const config = manifestDir([
      { codeline: 'next.upexpress.com', package: '@metrolinx/cx-shared', localSourcePath: pkgA },
      { codeline: 'next.upexpress.com', package: '@metrolinx/cx-other', localSourcePath: pkgB },
    ]);

    runPreflight(codeline, { EPAM_PROJECT_CONFIG_DIR: config });

    expect(existsSync(join(codeline, 'node_modules/@metrolinx/cx-shared/index.js'))).toBe(true);
    expect(existsSync(join(codeline, 'node_modules/@metrolinx/cx-other/index.js'))).toBe(true);
  });
});
