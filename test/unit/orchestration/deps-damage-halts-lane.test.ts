/**
 * A lane whose gates cannot run must not continue toward a verdict.
 *
 * Live metrolinx 2026-07-29:
 *
 *   [deps-install] REPAIR DESTROYED WHAT IT FOUND in next.gotransit.com:
 *                  1134 entries -> 1011
 *     The codeline is now in a worse state than before this ran, and its
 *     gates cannot run.
 *
 * The guard detected the damage, said the gates could not run — and the run
 * carried on with 15 processes. `ensure_node_modules_healthy` propagates its
 * verdict correctly; its only caller threw it away:
 *
 *   ensure_node_modules_healthy "$_rg_root" "$_rg_node" "$_rg_bin" || true
 *
 * WHY THIS IS ITS OWN FAILURE CLASS. The halt rule covers "failed after retries
 * and self-heal completed". This is different: nothing failed, and nothing can
 * be trusted either. A regression guard run against a wrecked node_modules does
 * not report a regression — it reports whatever a broken toolchain happens to
 * emit, which is as likely to be a false PASS as a failure. That is the same
 * shape as the review gates that would have passed on zero files: a verdict
 * with no evidence behind it.
 *
 * So the contract is three-valued, not two: pass / fail / CANNOT-VERIFY, and
 * cannot-verify is never pass.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const SRC = readFileSync(ORCH, 'utf8');

describe('the dependency verdict is not discarded', () => {
  it('does not swallow ensure_node_modules_healthy with `|| true`', () => {
    // The exact live defect. `|| true` converts "this codeline cannot be
    // verified" into "carry on".
    const swallowed = SRC.split('\n').filter(
      (l) => l.includes('ensure_node_modules_healthy') && /\|\|\s*true/.test(l) && !/^\s*#/.test(l));
    expect(swallowed,
      `the health verdict is discarded, so a wrecked codeline still runs its gates:\n  ${swallowed.join('\n  ')}`)
      .toEqual([]);
  });

  it('acts on the verdict at the call site', () => {
    const line = SRC.split('\n').find(
      (l) => l.includes('ensure_node_modules_healthy "$_rg_root"') && !/^\s*#/.test(l));
    expect(line, 'the regression guard no longer checks dependency health').toBeTruthy();
    expect(line!, 'the return value is still unused')
      .toMatch(/if\s|_deps_ok|\|\||&&/);
  });
});

describe('cannot-verify is reported as its own outcome, not as pass', () => {
  /** Run the real Step 5 block with a stubbed health check that fails. */
  function runStep5(healthRc: number) {
    const dir = mkdtempSync(join(tmpdir(), 'deps-halt-'));
    const logDir = join(dir, 'logs');
    mkdirSync(logDir, { recursive: true });
    const root = join(dir, 'codeline');
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'f', scripts: { test: 'exit 0' } }));
    writeFileSync(join(root, 'package-lock.json'), '{}');
    const stub = join(root, 'node_modules/.bin/anything');
    writeFileSync(stub, '#!/bin/sh\nexit 0\n');
    chmodSync(stub, 0o755);

    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'npm'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'npm'), 0o755);

    const start = SRC.indexOf('if [ "${SKIP_REGRESSION_GUARD:-false}" != "true" ]; then');
    const marker = 'Step 5: Regression guard skipped (SKIP_REGRESSION_GUARD=true)';
    const end = SRC.indexOf('\nfi', SRC.indexOf(marker, start)) + 3;
    const block = SRC.slice(start, end);

    const script = join(dir, 'drive.sh');
    writeFileSync(script, [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      `PROJECT_ROOT=${JSON.stringify(root)}`,
      `LOG_DIR=${JSON.stringify(logDir)}`,
      'PHASE=core',
      'EPAM_BROWNFIELD=1',
      'log(){ echo "LOG: $*"; }', 'info(){ echo "INFO: $*"; }',
      'warning(){ echo "WARN: $*"; }', 'success(){ echo "SUCCESS: $*"; }',
      'error(){ echo "ERROR: $*"; }',
      'step_emit(){ echo "STEP_EMIT: $1 $2"; }',
      'resolve_codeline_node(){ command -v node; }',
      `ensure_node_modules_healthy(){ echo "HEALTH_STUB rc=${healthRc}"; return ${healthRc}; }`,
      block,
    ].join('\n'));

    const r = spawnSync('bash', [script], {
      encoding: 'utf8', timeout: 90000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  }

  it('a healthy codeline still passes — the guard is not broken', () => {
    const r = runStep5(0);
    expect(r.out, `expected a pass:\n${r.out}`).toMatch(/STEP_EMIT: 5 pass/);
  });

  it('a codeline whose dependencies are wrecked does NOT report pass', () => {
    // The live case: the guard would otherwise run tests against a broken
    // toolchain and report whatever that emits.
    const r = runStep5(1);
    expect(r.out, `a wrecked codeline was passed as verified:\n${r.out}`)
      .not.toMatch(/STEP_EMIT: 5 pass/);
  });

  it('says the codeline cannot be verified, rather than that tests failed', () => {
    // Different diagnosis, different fix. "Tests failed" sends someone to the
    // test suite; the real problem is the dependency tree.
    const r = runStep5(1);
    expect(r.out, 'the operator is told the wrong thing')
      .toMatch(/cannot be verified|dependencies|unusable|cannot run/i);
  });

  it('stops the phase rather than continuing', () => {
    expect(runStep5(1).code, 'the phase continued on an unverifiable codeline').not.toBe(0);
  });
});
