/**
 * PYTHON IS CHECKED WHETHER OR NOT THE STACK DECLARES A RUNNER.
 *
 * install.sh calls python3 a runtime dependency — "88 handlers need it" — and then checked for it
 * INSIDE `if [ -n "$RUNNER" ]`. A stack whose settings file declares no runner therefore skipped a
 * stated hard requirement, and the install reported ready on a machine that cannot execute a
 * single handler. pipeline-health.sh has always checked python3 unconditionally, so the two
 * disagreed about whether the box was fit — and the installer, which an operator trusts first,
 * was the lenient one.
 *
 * The check is asserted by EXECUTION, not by reading the nesting: the block is lifted and run
 * twice, once with a runner declared and once without, with python3 removed from PATH both times.
 * A nesting bug that returns silently is exactly what a source-level assertion misses.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const INSTALL = join(__dirname, '../../../orchestrations-installer/install.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/**
 * Runs install.sh's runner+python prerequisite block with a chosen RUNNER, on a PATH where
 * python3 does not exist. Returns what it reported and whether it set FAILED.
 */
function checkPrereqs(runner: string): { out: string; failed: boolean } {
  const src = readFileSync(INSTALL, 'utf8');
  const start = src.indexOf('if [ -n "$RUNNER" ]; then');
  expect(start, 'the prerequisite block was not found in install.sh').toBeGreaterThan(0);
  const end = src.indexOf('# ── Credentials', start);
  expect(end, 'the end of the block was not found').toBeGreaterThan(start);

  const dir = mkdtempSync(join(tmpdir(), 'prereq-'));
  dirs.push(dir);
  // A PATH THAT LACKS PYTHON3 — NOT ONE THAT LACKS EVERYTHING.
  //
  // This used to put only awk/sed/grep/cat wrappers on PATH, which left no `bash` for Node to
  // exec and no `env` for the wrappers' own shebangs. execFileSync threw ENOENT, `out` came back
  // empty, and all three cases failed reporting "python3 was not reported at all" — about an
  // installer block that reports it correctly. The harness was the defect, and it hid the very
  // check it exists to prove.
  //
  // Symlinks to the real tools, so the block runs for real; python3 is simply not among them.
  const bin = join(dir, 'bin'); mkdirSync(bin);
  for (const t of ['bash', 'sh', 'env', 'awk', 'sed', 'grep', 'cat', 'printf', 'head', 'tr']) {
    for (const d of ['/usr/bin', '/bin']) {
      if (existsSync(join(d, t))) { symlinkSync(join(d, t), join(bin, t)); break; }
    }
  }
  expect(existsSync(join(bin, 'bash')), 'no shell on the harness PATH — the block cannot run')
    .toBe(true);
  expect(existsSync(join(bin, 'python3')), 'python3 must be ABSENT for this test to mean anything')
    .toBe(false);
  const drive = join(dir, 'drive.sh');
  writeFileSync(drive, ['#!/usr/bin/env bash', 'set -uo pipefail',
    'FAILED=0', 'STACK=teststack',
    '_ok()  { printf "OK %s\\n" "$*"; }',
    '_bad() { printf "BAD %s\\n" "$*"; }',
    `RUNNER=${JSON.stringify(runner)}`,
    src.slice(start, end),
    'echo "FAILED=$FAILED"',
  ].join('\n'));

  let out = '';
  try {
    out = execFileSync('bash', [drive], {
      encoding: 'utf8', timeout: 60_000,
      env: { PATH: bin, HOME: process.env.HOME || '' },
    });
  } catch (e: any) { out = `${e.stdout || ''}${e.stderr || ''}`; }
  return { out, failed: /FAILED=1/.test(out) };
}

describe('the installer prerequisite check', () => {
  it('GUARD: with a runner declared, a missing python3 fails the install', () => {
    // The path that always worked. If this ever stops failing, the harness has stopped removing
    // python3 and every assertion here is vacuous.
    const r = checkPrereqs('claude');
    expect(r.out, 'python3 was not reported at all').toMatch(/python3/);
    expect(r.failed, 'a missing python3 did not fail the install').toBe(true);
  });

  it('WITH NO RUNNER DECLARED, a missing python3 STILL fails the install', () => {
    /**
     * The defect. With RUNNER empty the whole block was skipped, python3 was never mentioned, and
     * the install proceeded to report ready on a machine that cannot run one handler.
     */
    const r = checkPrereqs('');
    expect(r.out,
      'python3 was never checked because the stack declares no runner — a stated hard requirement '
      + 'was skipped and the install would report ready without it')
      .toMatch(/python3/);
    expect(r.failed, 'a missing python3 did not fail an install for a runner-less stack').toBe(true);
  });

  it('a declared runner that is missing still fails, independently', () => {
    // The two checks must not have become entangled while separating them.
    const r = checkPrereqs('definitely-not-on-path');
    expect(r.out).toMatch(/definitely-not-on-path/);
    expect(r.failed).toBe(true);
  });
});
