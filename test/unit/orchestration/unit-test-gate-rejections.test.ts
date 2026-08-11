/**
 * THE UNIT-TEST GATE'S REJECTIONS WERE UNTESTED — ALL SEVEN OF THEM.
 *
 * Found 2026-08-09 by a mutation sweep of every rejecting gate in the pipeline: neuter each
 * gate's `return 1` paths, run the tests that name it, and see whether anything notices. Twelve
 * of fifteen gates were covered. These were not:
 *
 *     run_unit_tests_gate         7 rejection paths, 1 test naming it   NOT CAUGHT
 *     run_testing_gates           1 rejection path,  3 tests naming it  NOT CAUGHT
 *     run_interstitial_e2e_phase  1 rejection path,  0 tests            UNTESTED
 *
 * run_unit_tests_gate is Step 4.5 — vitest plus the type check. Every one of its refusals could
 * be turned into an approval and the suite stayed green, which is the precise condition under
 * which a gate stops working and nobody learns of it for weeks. It is also the gate whose
 * failure is MOST expensive to miss: it is the last thing between a broken phase and the
 * downstream quality gates that cost real model time.
 *
 * The gate is deliberately generous about SKIPPING — no package.json, no node binary, no
 * unit-test stories in the phase, all return 0 — and that is right: it should not fail a phase
 * for being a shape it does not apply to. The distinction that matters, and that nothing tested,
 * is between "does not apply" and "applies and failed".
 *
 * Every case below runs the real function against a real directory.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const SRC = readFileSync(ORCH, 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function lift(name: string): string {
  const start = SRC.indexOf(`${name}() {`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  return SRC.slice(start, SRC.indexOf('\n}\n', start) + 3);
}

/**
 * A project the gate will actually engage with: package.json present, a node binary, and a
 * phase that has unit-test stories. Individual pieces are removed per test.
 */
function project(opts: {
  nodeModules?: boolean;
  vitestBin?: boolean;
  vitestExit?: number;
  tscExit?: number;
  installExit?: number;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'utgate-')); dirs.push(dir);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  // THE PROJECT DECLARES HOW IT VERIFIES ITSELF. The gate no longer invokes a compiler; it runs
  // this command through orchestrations/plugins/verification-plugin.js. A project that declares
  // nothing reports UNKNOWN and is REFUSED — deliberately, because the old behaviour was to skip
  // (which every caller read as "verified"). A healthy fixture therefore declares one, exactly
  // as a real codeline does.
  mkdirSync(join(dir, '.epam'), { recursive: true });
  writeFileSync(join(dir, '.epam', 'verification.json'),
    JSON.stringify({ typecheck: { command: `exit ${opts.tscExit ?? 0}` } }));
  // The gate asks the PRD whether this phase has unit-test stories, with jq, and returns 0
  // when it does not. A shell stub cannot answer that — the function computes it into a local
  // — so the fixture supplies a real PRD. Without this every case below returned 0 for the
  // uninteresting reason and the rejection paths were never reached.
  writeFileSync(join(dir, 'prd.json'), JSON.stringify({
    implementationOrder: { core: ['S1'] },
    stories: [{ id: 'S1', unitTests: true }],
  }));

  if (opts.nodeModules !== false) {
    const bin = join(dir, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    if (opts.vitestBin !== false) {
      writeFileSync(join(bin, 'vitest'), `#!/usr/bin/env bash\necho "vitest ran"\nexit ${opts.vitestExit ?? 0}\n`);
      chmodSync(join(bin, 'vitest'), 0o755);
    }
    writeFileSync(join(bin, 'tsc'), `#!/usr/bin/env bash\necho "tsc ran"\nexit ${opts.tscExit ?? 0}\n`);
    chmodSync(join(bin, 'tsc'), 0o755);
  }

  // A node binary that just runs whatever script it is handed, so ./node_modules/.bin/vitest
  // and .bin/tsc above are what actually decide the outcome.
  const node = join(dir, 'fake-node');
  writeFileSync(node, '#!/usr/bin/env bash\nexec bash "$@"\n');
  chmodSync(node, 0o755);

  // npm, only reached when node_modules is absent.
  const npmDir = join(dir, 'fakebin'); mkdirSync(npmDir, { recursive: true });
  writeFileSync(join(npmDir, 'npm'),
    `#!/usr/bin/env bash\n${opts.installExit === 124 ? 'sleep 30\n' : ''}exit ${opts.installExit ?? 0}\n`);
  chmodSync(join(npmDir, 'npm'), 0o755);
  return { dir, node, npmDir };
}

/** Runs the real gate. Returns its exit code and everything it printed. */
function runGate(p: ReturnType<typeof project>, env: Record<string, string> = {}) {
  const res = execFileSync('bash', ['-c',
    `PATH=${JSON.stringify(p.npmDir)}:$PATH
     PROJECT_ROOT=${JSON.stringify(p.dir)}
     LOG_DIR=${JSON.stringify(join(p.dir, 'logs'))}
     EPAM_INSTALL_TIMEOUT_SECS=2
     PHASE=core
     PRD_FILE=${JSON.stringify(join(p.dir, 'prd.json'))}
     ${Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join('\n     ')}
     log() { echo "LOG:$*"; }; info() { echo "INFO:$*"; }
     warning() { echo "WARN:$*"; }; error() { echo "ERR:$*"; }; success() { echo "OK:$*"; }
     is_truthy() { case "\${1:-}" in true|1|yes) return 0 ;; *) return 1 ;; esac; }
     detect_node() { echo ${JSON.stringify(p.node)}; }
     step_emit() { :; }
     ${'AUTOMATION_DIR=' + JSON.stringify(join(__dirname, '../../../orchestrations'))}
     ${'NODE_CMD=' + JSON.stringify(process.execPath)}
     ${lift('_run_project_verification')}
${lift('run_unit_tests_gate')}
     run_unit_tests_gate core; echo "RC=$?"`,
  ], { encoding: 'utf8' });
  return { rc: Number((res.match(/RC=(\d+)/) || [])[1]), out: res };
}

describe('the fixture reaches the part of the gate that gates', () => {
  it('a healthy project passes', () => {
    const r = runGate(project());
    expect(r.rc, `gate did not reach the run — ${r.out.slice(0, 300)}`).toBe(0);
  });
});

describe('THE DEFECT: every refusal is a refusal', () => {
  it('a failing test suite fails the gate', () => {
    const r = runGate(project({ vitestExit: 1 }));
    expect(r.rc, 'a red suite passed the gate that exists to catch it').not.toBe(0);
  });

  it('a failing type check fails the gate', () => {
    const r = runGate(project({ tscExit: 2 }));
    expect(r.rc).not.toBe(0);
    expect(r.out).toMatch(/type check/i);
  });

  it('a missing vitest binary fails rather than passing silently', () => {
    // "vitest is not installed" reads identically to "all tests passed" if it returns 0 —
    // a phase would be certified by a suite that never ran.
    const r = runGate(project({ vitestBin: false }));
    expect(r.rc).not.toBe(0);
    expect(r.out).toMatch(/vitest/i);
  });

  it('a failed npm install fails the gate', () => {
    const r = runGate(project({ nodeModules: false, installExit: 1 }));
    expect(r.rc).not.toBe(0);
    expect(r.out).toMatch(/install/i);
  });

  it('an npm install that times out fails the gate and says so', () => {
    const r = runGate(project({ nodeModules: false, installExit: 124 }));
    expect(r.rc).not.toBe(0);
    expect(r.out).toMatch(/TIMED OUT|timed out/i);
  });
});

describe('"does not apply" stays distinct from "applies and failed"', () => {
  it('an explicit skip passes', () => {
    expect(runGate(project(), { SKIP_UNIT_TEST_GATE: 'true' }).rc).toBe(0);
  });

  it('a project with no package.json is skipped, not failed', () => {
    const p = project();
    rmSync(join(p.dir, 'package.json'));
    const r = runGate(p);
    expect(r.rc, 'a project the gate does not apply to was failed by it').toBe(0);
  });

  it('the skip paths say why, so a silent pass is never mistaken for a green run', () => {
    const out = runGate(project(), { SKIP_UNIT_TEST_GATE: 'true' }).out;
    expect(out).toMatch(/skip/i);
  });
});
