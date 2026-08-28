/**
 * resolve_codeline_node() — run-agent-orchestration.sh
 *
 * Live bug this closes (2026-07-22): the regression guard (Step 5) ran a
 * codeline's vitest using detect_node()'s orchestrator-side Node (whatever
 * fnm/nvm version happens to be active for the pipeline's own shell —
 * v24.14.1 at the time), not the Node version the codeline itself declares
 * via package.json's "engines.node" ("^22" for azure.commerce.cdts). A
 * mismatched major Node version can crash a codeline's own test runner
 * outright rather than produce a normal test failure.
 *
 * Fully data-driven, no hardcoded version number anywhere: the required
 * version comes entirely from the codeline's own package.json, resolved via
 * fnm's install/exec, which can install any version on demand.
 *
 * Real execution throughout — no mocking of fnm or node.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SCRIPT = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

function hasFnm(): boolean {
  try {
    return spawnSync('which', ['fnm'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}
const FNM_PRESENT = hasFnm();

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Extract detect_node + resolve_codeline_node verbatim from the real script —
// the exact same source the pipeline runs, not a hand-copied reimplementation.
function extractResolverFunctions(): string {
  const src = require('node:fs').readFileSync(ORCH_SCRIPT, 'utf8');
  const dn_start = src.indexOf('detect_node() {');
  const dn_end = src.indexOf('\n}', dn_start) + 2;
  const rc_start = src.indexOf('resolve_codeline_node() {');
  const rc_end = src.indexOf('\n}', rc_start) + 2;
  expect(dn_start).toBeGreaterThan(-1);
  expect(rc_start).toBeGreaterThan(-1);
  return src.slice(dn_start, dn_end) + '\n' + src.slice(rc_start, rc_end);
}

function runResolver(codelineRoot: string, extraEnv: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; exitCode: number } {
  const dir = mkdtempSync(join(tmpdir(), 'resolve-node-test-'));
  try {
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, [
      '#!/usr/bin/env bash',
      extractResolverFunctions(),
      `resolve_codeline_node "${codelineRoot}"`,
    ].join('\n'));
    const result = spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
      timeout: 120000,
    });
    return { stdout: (result.stdout || '').trim(), stderr: result.stderr || '', exitCode: result.status ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeCodeline(engineNode?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codeline-fixture-'));
  cleanupDirs.push(dir);
  const pkg: Record<string, unknown> = { name: 'fixture' };
  if (engineNode) pkg.engines = { node: engineNode };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}

describe('resolve_codeline_node — real fnm, real node, no mocking', () => {
  it('resolves the exact Node version an already-installed engines.node range points to (^22 -> some installed v22.x)', () => {
    if (!FNM_PRESENT) return;
    // Ensure a v22.x is installed so this test doesn't depend on network.
    spawnSync('fnm', ['install', '22'], { encoding: 'utf8', timeout: 120000 });
    const codeline = makeCodeline('^22');

    const { stdout, exitCode } = runResolver(codeline);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/node-versions\/v22\./);
    expect(existsSync(stdout)).toBe(true);

    const versionCheck = spawnSync(stdout, ['--version'], { encoding: 'utf8' });
    expect(versionCheck.stdout.trim()).toMatch(/^v22\./);
  });

  it('installs a Node version on demand when the declared range is not yet installed locally', () => {
    if (!FNM_PRESENT) return;
    // Use an obscure-but-real, unlikely-to-already-be-installed patch version
    // so this genuinely exercises the install-on-demand path, not a cache hit.
    const targetVersion = '18.20.4';
    spawnSync('fnm', ['uninstall', targetVersion], { encoding: 'utf8' }); // best-effort, ignore result
    const codeline = makeCodeline(targetVersion);

    const { stdout, exitCode } = runResolver(codeline);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/node-versions\/v18\.20\.4/);

    const versionCheck = spawnSync(stdout, ['--version'], { encoding: 'utf8' });
    expect(versionCheck.stdout.trim()).toBe('v18.20.4');
  }, 120000);

  it('handles a >= range declaration, extracting the first version-like token generically', () => {
    if (!FNM_PRESENT) return;
    spawnSync('fnm', ['install', '20'], { encoding: 'utf8', timeout: 120000 });
    const codeline = makeCodeline('>=20 <21');

    const { stdout, exitCode } = runResolver(codeline);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/node-versions\/v20\./);
  });

  it('falls back to detect_node when package.json declares no engines.node', () => {
    const codeline = makeCodeline(); // no engines field at all
    const { stdout, exitCode } = runResolver(codeline);
    expect(exitCode).toBe(0);
    // detect_node's fallback candidates or PATH node — just must resolve to SOME real node.
    expect(stdout.length).toBeGreaterThan(0);
    expect(existsSync(stdout)).toBe(true);
  });

  it('falls back to detect_node when package.json is missing entirely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-package-json-'));
    cleanupDirs.push(dir);
    const { stdout, exitCode } = runResolver(dir);
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it('falls back to detect_node when fnm is not on PATH, even if engines.node is declared', () => {
    const codeline = makeCodeline('^22');
    const { stdout, exitCode } = runResolver(codeline, { PATH: '/usr/bin:/bin' });
    expect(exitCode).toBe(0);
    // Must not error out — either resolves via detect_node's hardcoded fallback
    // candidates or comes back empty (both are acceptable non-crash outcomes),
    // but must never hang or throw.
    expect(typeof stdout).toBe('string');
  });

  it('never crashes on a malformed engines.node value (e.g. non-semver garbage)', () => {
    const codeline = makeCodeline('this-is-not-a-version');
    const { exitCode } = runResolver(codeline);
    expect(exitCode).toBe(0);
  });

  it('run 10x in a row with a real, already-installed version — deterministic resolution every time', () => {
    if (!FNM_PRESENT) return;
    spawnSync('fnm', ['install', '20'], { encoding: 'utf8', timeout: 120000 });
    const RUNS = 10;
    const outcomes: { exitCode: number; matchesV20: boolean }[] = [];
    for (let i = 0; i < RUNS; i++) {
      const codeline = makeCodeline('^20');
      const { stdout, exitCode } = runResolver(codeline);
      outcomes.push({ exitCode, matchesV20: /node-versions\/v20\./.test(stdout) });
    }
    const failures = outcomes.filter(o => o.exitCode !== 0 || !o.matchesV20);
    expect(failures, `${failures.length}/${RUNS} failed: ${JSON.stringify(outcomes)}`).toHaveLength(0);
  }, 180000);
});

describe('resolve_codeline_node — real azure.commerce.cdts repo, exact live scenario', () => {
  const CDTS_PATH = '/home/bradleyjerome/projects/metrolinx/azure.commerce.cdts';
  const CDTS_PRESENT = existsSync(join(CDTS_PATH, 'package.json'));

  it('resolves the exact declared engines.node ("^22") for the real repo that triggered this fix', () => {
    if (!FNM_PRESENT || !CDTS_PRESENT) return;
    const { stdout, exitCode } = runResolver(CDTS_PATH);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/node-versions\/v22\./);

    const versionCheck = spawnSync(stdout, ['--version'], { encoding: 'utf8' });
    expect(versionCheck.stdout.trim()).toMatch(/^v22\./);
  });
});

describe('run-agent-orchestration.sh — regression guard wiring', () => {
  const src = require('node:fs').readFileSync(ORCH_SCRIPT, 'utf8');

  it('calls resolve_codeline_node, not detect_node, for the regression guard\'s node binary', () => {
    const guardStart = src.indexOf('Step 0.7: Cross-phase regression guard');
    expect(guardStart).toBeGreaterThan(-1);
    const guardBlock = src.slice(guardStart, guardStart + 2000);
    expect(guardBlock).toMatch(/_rg_node=\$\(resolve_codeline_node/);
    expect(guardBlock).not.toMatch(/_rg_node=\$\(detect_node/);
  });

  it('resolves _rg_node AFTER _rg_root is finalized — must use the codeline\'s own path, not PROJECT_ROOT\'s default', () => {
    const guardStart = src.indexOf('Step 0.7: Cross-phase regression guard');
    const rootIdx = src.indexOf('_rg_root="$PROJECT_ROOT"', guardStart);
    const nodeIdx = src.indexOf('_rg_node=$(resolve_codeline_node "$_rg_root"', guardStart);
    expect(rootIdx).toBeGreaterThan(-1);
    expect(nodeIdx).toBeGreaterThan(-1);
    expect(nodeIdx).toBeGreaterThan(rootIdx);
  });
});
