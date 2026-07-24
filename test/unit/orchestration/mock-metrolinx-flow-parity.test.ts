/**
 * mock1 / mock2 must exercise the SAME pipeline flow as the real Metrolinx run.
 *
 * User directive (2026-07-24): "these tests need to match the current pipeline flow
 * for metrolinx in terms of stages and steps no difference in piping", and "I am
 * against using real runs to test — it breaks so many aspects of dogma". The mocks
 * are meant to REPLACE the live run as the verification mechanism, which only holds
 * if they configure the pipeline identically. A mock that silently skips a gate the
 * real run enforces gives false confidence — the failure mode this whole session
 * has been fighting.
 *
 * These assertions are deliberately CHEAP and deterministic (they read config, they
 * do not launch anything), so they run in every regression pass and catch drift the
 * moment metrolinx's config changes — including the case where someone tightens the
 * real run's gates and forgets the mocks.
 *
 * The expensive end-to-end mocks themselves are gated behind RUN_REAL_PIPELINE_MOCK.
 * This file is the guard that keeps them HONEST when they do run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = (p: string) => join(__dirname, '../../../', p);
const METRO_CFG = readFileSync(root('orchestrations/projects/metrolinx/config.env'), 'utf8');
const MOCK1 = readFileSync(root('test/unit/orchestration/brownfield-mock-e2e.test.ts'), 'utf8');
const MOCK2 = readFileSync(root('test/unit/orchestration/brownfield-mock-e2e-2-worktree-topology.test.ts'), 'utf8');
const LAUNCHER = readFileSync(root('orchestrations/scripts/tier3-metrolinx-run.sh'), 'utf8');
const MOCK_LAUNCHER = readFileSync(root('orchestrations/scripts/tier3-mock-run.sh'), 'utf8');

/** Values metrolinx sets that materially change which stages/gates execute. */
function metrolinxValue(key: string): string | null {
  const m = METRO_CFG.match(new RegExp(`^${key}=("?)([^"\\n#]*)\\1`, 'm'));
  return m ? m[2].trim() : null;
}

// Flags that decide whether a STAGE RUNS AT ALL. Drift here means the mock is
// testing a different pipeline than production.
const FLOW_FLAGS = [
  'EPAM_BROWNFIELD',
  'JIRA_PIPELINE',
  'AC_GATE_AUTO_ELABORATE',
  'SEMBLE_ENABLED',
  'SKIP_REGRESSION_GUARD',
  'SKIP_BROWSER_E2E_ROUTING',
];

describe('mock1/mock2 flow parity with the real Metrolinx run', () => {
  for (const flag of FLOW_FLAGS) {
    const expected = metrolinxValue(flag);
    it.runIf(expected !== null)(`both mocks set ${flag} exactly as metrolinx does (${expected})`, () => {
      for (const [name, src] of [['mock1', MOCK1], ['mock2', MOCK2]] as const) {
        // No deviations: mock2 was brought onto the real Jira ingest path on
        // 2026-07-24, so BOTH mocks now match metrolinx on every flow flag.
        const m = src.match(new RegExp(`${flag}\\s*:\\s*['"]([^'"]*)['"]`));
        expect(m, `${name} never sets ${flag} — metrolinx sets it to "${expected}"`).toBeTruthy();
        expect(m![1], `${name} sets ${flag}="${m?.[1]}" but metrolinx uses "${expected}"`).toBe(expected);
      }
    });
  }

  it('both mocks invoke the SAME entrypoint the launcher does', () => {
    expect(LAUNCHER).toMatch(/run-agent-orchestration\.sh/);
    for (const [name, src] of [['mock1', MOCK1], ['mock2', MOCK2]] as const) {
      expect(src, `${name} must drive run-agent-orchestration.sh, not a re-implementation`)
        .toMatch(/run-agent-orchestration\.sh/);
    }
  });

  // NOTE: launcher BEHAVIOUR (flags, retry) is delegated to tier3-mock-run.sh —
  // the mock's own launcher — so it is asserted THERE, not in the test sources.
  // An earlier version of this file checked the test files for '--reset' and
  // SKIP_GATE_REMEDIATION and reported false drift: asserting on the wrong
  // artifact. Env FLAGS still belong to the tests, since that is where they are set.
  it('the mock launcher passes --phase and --reset, exactly as the metrolinx launcher does', () => {
    for (const flag of ['--phase', '--reset']) {
      expect(LAUNCHER, `metrolinx launcher missing ${flag}`).toContain(flag);
      expect(MOCK_LAUNCHER, `tier3-mock-run.sh missing ${flag}`).toContain(flag);
    }
  });

  it('the mock launcher mirrors the exit-2 gate-remediation self-heal retry', () => {
    // tier3 retries once with SKIP_GATE_REMEDIATION=1 on exit 2. Without it a mock
    // FAILS for a reason production would have recovered from — a false negative.
    expect(LAUNCHER).toMatch(/SKIP_GATE_REMEDIATION=1/);
    expect(MOCK_LAUNCHER, 'tier3-mock-run.sh must mirror the exit-2 self-heal retry')
      .toMatch(/SKIP_GATE_REMEDIATION=1/);
  });

  it('neither mock sets a SKIP_* flag that metrolinx does not set', () => {
    // The cardinal sin: a mock quietly disabling a gate the real run enforces.
    for (const [name, src] of [['mock1', MOCK1], ['mock2', MOCK2]] as const) {
      const used = [...src.matchAll(/\b(SKIP_[A-Z_]+)\s*:\s*['"]([^'"]*)['"]/g)];
      for (const [, flag, val] of used) {
        if (flag === 'SKIP_GATE_REMEDIATION') continue;  // the launcher's own retry
        const expected = metrolinxValue(flag);
        expect(expected, `${name} sets ${flag}=${val} but metrolinx never sets it`).not.toBeNull();
        expect(val, `${name} sets ${flag}=${val}, metrolinx uses ${expected}`).toBe(expected);
      }
    }
  });

  it('neither mock sets SKIP_TESTING_GATES — the full QA gate chain must run', () => {
    for (const [name, src] of [['mock1', MOCK1], ['mock2', MOCK2]] as const) {
      expect(src, `${name} must not bypass the testing gates`)
        .not.toMatch(/SKIP_TESTING_GATES\s*:\s*['"]true['"]/);
    }
  });
});
