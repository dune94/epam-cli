/**
 * Step 5 — the regression guard, EXECUTED rather than pattern-matched.
 *
 * It has now failed twice on a green client codebase, both times our fault, and
 * both defects shipped because every existing test asserted the SOURCE TEXT of
 * this step rather than running it.
 *
 *   Run 5: invoked `<node> <runner> run`. `run` is vitest's "run once"
 *          subcommand and a test PATH PATTERN in jest, so jest searched 874 test
 *          files for paths matching "run", found none, exited 1 — and the guard
 *          reported a passing baseline as broken.
 *
 *   Run 6: after switching to the project's own `npm test`, it reported
 *          "declares a test script but it could not be executed" with
 *          `node_modules: empty` — because the emptiness probe was a `find`
 *          expression that never matched, and because node_modules had in fact
 *          been emptied under it.
 *
 * A gate that decides whether a baseline can be trusted is worth executing in a
 * test. These build real fixture repos — a manifest, a lockfile, an installed
 * node_modules, a passing or failing test command — and drive the REAL Step 5
 * block extracted from the orchestrator, asserting on what it decides.
 *
 * Nothing here names a runner. The fixtures' "test" scripts are plain shell
 * (`exit 0` / `exit 1`), which is the point: the guard must honour whatever the
 * project declares, including something neither of us has seen.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function scratch(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** The real Step 5 block, from `if [ "${SKIP_REGRESSION_GUARD` to its closing fi. */
function step5Block(): string {
  const start = orchSrc.indexOf('if [ "${SKIP_REGRESSION_GUARD:-false}" != "true" ]; then');
  expect(start, 'Step 5 block not found').toBeGreaterThan(-1);
  const marker = 'Step 5: Regression guard skipped (SKIP_REGRESSION_GUARD=true)';
  const end = orchSrc.indexOf(marker, start);
  expect(end, 'Step 5 block end not found').toBeGreaterThan(start);
  return orchSrc.slice(start, orchSrc.indexOf('\nfi', end) + 3);
}

/**
 * A codeline fixture.
 *  - testExit: what the project's own `test` script does
 *  - installed: whether node_modules/.bin has entries
 */
function codeline(opts: { testScript?: string; installed?: boolean; lock?: boolean } = {}) {
  const d = scratch('rg-exec-');
  const manifest: Record<string, unknown> = { name: 'fixture' };
  if (opts.testScript !== undefined) manifest.scripts = { test: opts.testScript };
  writeFileSync(join(d, 'package.json'), JSON.stringify(manifest));
  if (opts.lock !== false) writeFileSync(join(d, 'package-lock.json'), '{}');
  if (opts.installed) {
    mkdirSync(join(d, 'node_modules/.bin'), { recursive: true });
    const stub = join(d, 'node_modules/.bin/anything');
    writeFileSync(stub, '#!/bin/sh\nexit 0\n');
    chmodSync(stub, 0o755);
  }
  return d;
}

/** Run the real Step 5 against a fixture, with a stub `npm` honouring scripts.test. */
function runStep5(root: string, env: Record<string, string> = {}) {
  const harness = scratch('rg-harness-');
  const logDir = join(harness, 'logs');
  mkdirSync(logDir, { recursive: true });

  // A stub package manager: `npm test` runs the manifest's test script through
  // sh. Keeps the test offline and independent of any real runner.
  const bin = join(harness, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'npm'), [
    '#!/usr/bin/env bash',
    '[ "$1" = "test" ] || exit 0',
    'script=$(node -e \'try{const p=require(process.cwd()+"/package.json");process.stdout.write((p.scripts&&p.scripts.test)||"")}catch(e){}\')',
    '[ -n "$script" ] || exit 0',
    'sh -c "$script"',
  ].join('\n'));
  chmodSync(join(bin, 'npm'), 0o755);

  const script = join(harness, 'drive.sh');
  writeFileSync(script, [
    '#!/usr/bin/env bash',
    'set -uo pipefail',
    `PROJECT_ROOT=${JSON.stringify(root)}`,
    `LOG_DIR=${JSON.stringify(logDir)}`,
    'PHASE=core',
    'EPAM_BROWNFIELD=0',
    'log()     { echo "LOG: $*"; }',
    'info()    { echo "INFO: $*"; }',
    'warning() { echo "WARN: $*"; }',
    'success() { echo "SUCCESS: $*"; }',
    'error()   { echo "ERROR: $*"; }',
    'step_emit() { echo "STEP_EMIT: $1 $2 ${4:-}"; }',
    // The guard resolves the codeline's node; here, whatever is on PATH.
    'resolve_codeline_node() { command -v node; }',
    'ensure_node_modules_healthy() { :; }',
    step5Block(),
  ].join('\n'));

  const r = spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('a green baseline passes', () => {
  it('PASSES when the project\'s own test command succeeds', () => {
    // Run 5's exact false negative: the suite was fine and the guard failed it.
    const r = runStep5(codeline({ testScript: 'exit 0', installed: true }));
    expect(r.out, `expected pass, got:\n${r.out}`).toMatch(/STEP_EMIT: 5 pass/);
    expect(r.out).not.toMatch(/STEP_EMIT: 5 fail/);
  });

  it('does not pass a subcommand the project never asked for', () => {
    // `run` as an argument is what broke jest. A test script that fails if it
    // receives ANY argument proves nothing extra is appended.
    const c = codeline({ testScript: '[ $# -eq 0 ] || exit 1; exit 0', installed: true });
    expect(runStep5(c).out).toMatch(/STEP_EMIT: 5 pass/);
  });
});

describe('a red baseline fails loudly', () => {
  it('FAILS when the project\'s own test command fails', () => {
    const r = runStep5(codeline({ testScript: 'exit 1', installed: true }));
    expect(r.out).toMatch(/STEP_EMIT: 5 fail/);
    expect(r.out).toMatch(/tests broken before phase/i);
  });

  it('exits non-zero so the phase stops', () => {
    // An unverified baseline must not be accepted silently.
    expect(runStep5(codeline({ testScript: 'exit 1', installed: true })).code).not.toBe(0);
  });
});

describe('it tells "no tests" apart from "could not run the tests"', () => {
  it('SKIPS a project that declares no test script', () => {
    const r = runStep5(codeline({ installed: true }));
    expect(r.out).toMatch(/STEP_EMIT: 5 skip/);
    expect(r.out).not.toMatch(/STEP_EMIT: 5 fail/);
  });

  it('FAILS a project that declares tests but has no installed dependencies', () => {
    // Run 6: node_modules had been emptied under the guard. Accepting that
    // silently is how an unverified baseline slips through.
    const r = runStep5(codeline({ testScript: 'exit 0', installed: false }));
    expect(r.out).toMatch(/STEP_EMIT: 5 fail/);
    expect(r.out).toMatch(/could not be executed/i);
  });

  it('reports WHICH precondition was missing', () => {
    // "node/vitest not found" described the symptom for every case and told the
    // operator nothing actionable.
    const r = runStep5(codeline({ testScript: 'exit 0', installed: false }));
    expect(r.out).toMatch(/node_modules/i);
  });
});

describe('the bypass still works', () => {
  it('skips entirely when SKIP_REGRESSION_GUARD=true', () => {
    const r = runStep5(codeline({ testScript: 'exit 1', installed: true }),
                       { SKIP_REGRESSION_GUARD: 'true' });
    expect(r.out).toMatch(/STEP_EMIT: 5 skip/);
    expect(r.out).not.toMatch(/STEP_EMIT: 5 fail/);
  });
});
