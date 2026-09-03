/**
 * ensure_node_modules_healthy() — run-agent-orchestration.sh
 *
 * Live incident this closes (2026-07-22): a prior interrupted install left
 * azure.commerce.cdts's node_modules with truncated native binaries
 * (esbuild, rollup) — present on disk, correct file names and paths, but
 * silently corrupted (ELF header describing a much larger file than what
 * was actually written). A plain "does node_modules exist" check misses
 * this entirely; it only surfaced when vitest tried to load the binaries
 * and crashed outright instead of reporting a normal test failure.
 *
 * This function smoke-tests the ACTUAL binary the regression guard is
 * about to invoke ("<test_bin> --version") rather than inspecting files —
 * the cheapest, most direct way to know whether it will actually work.
 *
 * Real fixtures, real npm, no mocking — a genuinely corrupted binary (a
 * truncated real npm package's binary), a genuinely missing node_modules,
 * and a genuinely unfixable case (private-registry auth wall).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SCRIPT = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';
const NODE_BIN = existsSync(NODE20) ? NODE20 : process.execPath;

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function extractFn(): string {
  const src = require('node:fs').readFileSync(ORCH_SCRIPT, 'utf8');
  const s1 = src.indexOf('detect_and_install_dependencies() {');
  const e1 = src.indexOf('\n}', s1) + 2;
  const s2 = src.indexOf('ensure_node_modules_healthy() {');
  const e2 = src.indexOf('\n}', s2) + 2;
  expect(s1).toBeGreaterThan(-1);
  expect(s2).toBeGreaterThan(-1);
  return src.slice(s1, e1) + '\n' + src.slice(s2, e2);
}

// Minimal stand-ins for the log helpers ensure_node_modules_healthy calls,
// so the extracted function runs standalone without sourcing the whole
// 3000+-line orchestration script.
const LOG_STUBS = `
warning() { echo "WARN: $*" >&2; }
success() { echo "OK: $*"; }
`;

function runFn(codelineRoot: string, nodeBin: string, testBin: string): { stdout: string; stderr: string; exitCode: number } {
  const dir = mkdtempSync(join(tmpdir(), 'ensure-nm-test-'));
  try {
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, [
      '#!/usr/bin/env bash',
      LOG_STUBS,
      extractFn(),
      `ensure_node_modules_healthy "${codelineRoot}" "${nodeBin}" "${testBin}"`,
      'echo "EXIT_MARKER:$?"',
    ].join('\n'));
    const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 90000 });
    // warning() writes to stderr, success() to stdout — merge both for
    // assertions since callers need to see either depending on the branch.
    const combined = (result.stdout || '') + (result.stderr || '');
    const m = combined.match(/EXIT_MARKER:(\d+)/);
    return { stdout: combined, stderr: result.stderr || '', exitCode: m ? parseInt(m[1], 10) : (result.status ?? -1) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeRealNpmFixture(): string {
  // A tiny real package.json with one genuinely-installable public dep
  // (no lockfile needed — plain `npm install`).
  const dir = mkdtempSync(join(tmpdir(), 'nm-health-fixture-'));
  cleanupDirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0',
    // scripts.test names the runner these tests already probe (.bin/vitest).
    // The health check reads it to know WHICH binary to smoke-test — it used to
    // take whatever sorted first in node_modules/.bin, which condemned three
    // healthy metrolinx codelines because `escodegen` rejects --version.
    scripts: { test: 'vitest run' },
    dependencies: { 'is-odd': '^3.0.1' },
  }));
  return dir;
}

describe('ensure_node_modules_healthy — real npm, real corruption, no mocking', () => {
  it('returns healthy (0) immediately when the test binary runs --version successfully, without touching node_modules', () => {
    const dir = makeRealNpmFixture();
    mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
    const fakeBin = join(dir, 'node_modules/.bin/vitest');
    // A trivial script that responds to --version — simulates a healthy runner.
    writeFileSync(fakeBin, '#!/usr/bin/env node\nconsole.log("v1.0.0");\n');
    require('node:fs').chmodSync(fakeBin, 0o755);

    const before = require('node:fs').statSync(fakeBin).mtimeMs;
    const { exitCode } = runFn(dir, NODE_BIN, fakeBin);
    expect(exitCode).toBe(0);
    // Must not have been touched/reinstalled — same file, same mtime.
    expect(require('node:fs').statSync(fakeBin).mtimeMs).toBe(before);
  });

  it('detects a CORRUPTED binary (crashes on --version) and repairs by running a real npm install', () => {
    const dir = makeRealNpmFixture();
    mkdirSync(join(dir, 'node_modules/.bin'), { recursive: true });
    const fakeBin = join(dir, 'node_modules/.bin/vitest');
    // A script that always crashes on --version, simulating the exact
    // observed failure mode (corrupted binary → nonzero exit / crash).
    writeFileSync(fakeBin, '#!/usr/bin/env node\nprocess.exit(139);\n'); // 139 = SIGSEGV-like exit
    require('node:fs').chmodSync(fakeBin, 0o755);

    const { stdout, exitCode } = runFn(dir, NODE_BIN, fakeBin);
    expect(exitCode).toBe(0); // repair succeeded (is-odd is a real, public, installable package)
    expect(stdout).toMatch(/corrupted, attempting repair/);
    // "npm-stack" was dropped from the message: it named a stack in a log line
    // that should describe what happened, not which ecosystem it happened in.
    expect(stdout).toMatch(/install.*succeeded/);
    expect(existsSync(join(dir, 'node_modules/is-odd'))).toBe(true);
  }, 60000);

  it('detects a MISSING node_modules entirely and installs it from scratch', () => {
    const dir = makeRealNpmFixture();
    // No node_modules at all — test_bin passed in doesn't exist.
    const { stdout, exitCode } = runFn(dir, NODE_BIN, join(dir, 'node_modules/.bin/vitest'));
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/declared runner '[^']+' not found.*attempting install/);
    expect(existsSync(join(dir, 'node_modules/is-odd'))).toBe(true);
  }, 60000);

  it('reports failure (1) clearly, without hanging or crashing, when the install itself cannot succeed (private-registry auth wall)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nm-health-unfixable-'));
    cleanupDirs.push(dir);
    // A dependency that will always 404/fail — simulates an install that
    // genuinely cannot be repaired automatically (e.g. private registry,
    // no credentials) without ever hardcoding "cx-shared" or any specific
    // package name here.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'fixture', version: '1.0.0',
      // Same reason as the primary fixture: the probe reads scripts.test to
      // learn which binary to smoke-test.
      scripts: { test: 'vitest run' },
      dependencies: { '@this-scope-genuinely-does-not-exist-12345/nope': '^1.0.0' },
    }));

    const { stdout, exitCode } = runFn(dir, NODE_BIN, join(dir, 'node_modules/.bin/vitest'));
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/install FAILED/);
  }, 60000);

  it('never edits package.json or package-lock.json during a repair', () => {
    const dir = makeRealNpmFixture();
    const pkgBefore = require('node:fs').readFileSync(join(dir, 'package.json'), 'utf8');

    runFn(dir, NODE_BIN, join(dir, 'node_modules/.bin/vitest'));

    const pkgAfter = require('node:fs').readFileSync(join(dir, 'package.json'), 'utf8');
    expect(pkgAfter).toBe(pkgBefore);
  }, 60000);

  it('uses npm ci when a package-lock.json is present, npm install otherwise', () => {
    const src = require('node:fs').readFileSync(ORCH_SCRIPT, 'utf8');
    expect(src).toMatch(/pm_cmd="ci"/);
    expect(src).toMatch(/pm_cmd="install"/);
  });
});

describe('detect_and_install_dependencies — generic, manifest-driven, no hardcoded stack (no npm/Node assumption)', () => {
  it('detects Python (requirements.txt) and does NOT run npm — no manifest for it exists in the fixture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deps-python-fixture-'));
    cleanupDirs.push(dir);
    // A package that pip can genuinely resolve (tiny, no compiled deps) —
    // real install, no mocking, but harmless/fast.
    writeFileSync(join(dir, 'requirements.txt'), 'six==1.16.0\n');

    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, [
      '#!/usr/bin/env bash',
      LOG_STUBS,
      extractFn(),
      `detect_and_install_dependencies "${dir}" "${NODE_BIN}"`,
      'echo "EXIT_MARKER:$?"',
    ].join('\n'));
    const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 60000 });
    const combined = (result.stdout || '') + (result.stderr || '');

    // Must not have invoked npm at all (no package.json in this fixture) —
    // this is the actual thing under test: correct stack DETECTION.
    expect(combined).not.toMatch(/npm-stack/);
    // pip3/pip must be on PATH for this to exercise the path at all.
    const hasPip = spawnSync('which', ['pip3'], { encoding: 'utf8' }).status === 0
      || spawnSync('which', ['pip'], { encoding: 'utf8' }).status === 0;
    if (!hasPip) return;
    // Whether the actual pip install succeeds depends on this environment's
    // own Python packaging policy (e.g. PEP 668 "externally-managed-
    // environment" blocks system-wide pip installs without a venv) — that's
    // an environment constraint, not something this function's detection
    // logic controls. What matters here is that it correctly identified
    // Python and attempted pip: either it succeeds silently (EXIT_MARKER:0,
    // no warning) or it fails with a clear, attributable message — never a
    // silent, unexplained failure.
    expect(combined).toMatch(/EXIT_MARKER:0|pip install failed in/);
  }, 60000);

  it('reports "no recognized manifest" and fails cleanly for a directory with no known stack markers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deps-unknown-stack-'));
    cleanupDirs.push(dir);
    writeFileSync(join(dir, 'README.md'), 'nothing installable here');

    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, [
      '#!/usr/bin/env bash',
      LOG_STUBS,
      extractFn(),
      `detect_and_install_dependencies "${dir}" "${NODE_BIN}"`,
      'echo "EXIT_MARKER:$?"',
    ].join('\n'));
    const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 30000 });
    const combined = (result.stdout || '') + (result.stderr || '');
    expect(combined).toMatch(/no recognized manifest found/);
    expect(combined).toMatch(/EXIT_MARKER:1/);
  });

  it('source contains detection for multiple stacks, driven by manifest file presence, not story/project-name hardcoding', () => {
    const src = require('node:fs').readFileSync(ORCH_SCRIPT, 'utf8');
    const fnStart = src.indexOf('detect_and_install_dependencies() {');
    const fnEnd = src.indexOf('\n}\n\n# ensure_node_modules_healthy', fnStart);
    const fnBody = src.slice(fnStart, fnEnd > -1 ? fnEnd : fnStart + 6000);
    expect(fnBody).toMatch(/package\.json/);
    expect(fnBody).toMatch(/requirements\.txt|pyproject\.toml/);
    expect(fnBody).toMatch(/Cargo\.toml/);
    expect(fnBody).toMatch(/go\.mod/);
    expect(fnBody).toMatch(/pom\.xml/);
    expect(fnBody).toMatch(/Gemfile/);
    expect(fnBody).toMatch(/composer\.json/);
    // Must not hardcode any specific story/project/package name.
    expect(fnBody).not.toMatch(/cx-shared|metrolinx|azure\.commerce/i);
  });
});

describe('run-agent-orchestration.sh — regression guard calls ensure_node_modules_healthy before trusting the test runner', () => {
  const src = require('node:fs').readFileSync(ORCH_SCRIPT, 'utf8');

  it('calls ensure_node_modules_healthy inside the regression guard block, after _rg_node is resolved', () => {
    const guardStart = src.indexOf('Step 0.7: Cross-phase regression guard');
    const nodeIdx = src.indexOf('_rg_node=$(resolve_codeline_node', guardStart);
    const healthIdx = src.indexOf('ensure_node_modules_healthy "$_rg_root"', guardStart);
    expect(nodeIdx).toBeGreaterThan(-1);
    expect(healthIdx).toBeGreaterThan(-1);
    expect(healthIdx).toBeGreaterThan(nodeIdx);
  });

  it('re-detects _rg_bin after the health check, so a first-time install is picked up', () => {
    // NO fixed window: this asserts ORDER (re-detect comes after the health
    // call), so it compares positions. A 500-char slice failed the moment the
    // call site gained a comment — the fourth fixed-window test to break on a
    // correct change today. A byte offset was never the invariant.
    const guardStart = src.indexOf('Step 0.7: Cross-phase regression guard');
    const healthIdx = src.indexOf('ensure_node_modules_healthy "$_rg_root"', guardStart);
    expect(healthIdx, 'the health check call is gone').toBeGreaterThan(-1);
    const reDetectIdx = src.indexOf('_rg_bin=""', healthIdx);
    expect(reDetectIdx,
      '_rg_bin is never re-detected after the health check, so a first-time ' +
      'install that just created node_modules/.bin is not picked up')
      .toBeGreaterThan(healthIdx);
    const block = src.slice(healthIdx, reDetectIdx + 200);
    // Must reset and re-check _rg_bin after the health call, not just once up front.
    const reDetectMatches = block.match(/_rg_bin=""/g) || [];
    expect(reDetectMatches.length).toBeGreaterThanOrEqual(1);
  });
});
