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
  if (!m) return null;
  const raw = m[2].trim();
  // Bypass flags are declared as `${FLAG:-default}` so a launch-time value wins
  // over the project default (a config that overwrote an explicit
  // SKIP_REGRESSION_GUARD=true silently blocked a run on 2026-07-30). Parity is
  // about the EFFECTIVE value with an empty launch environment — the mocks
  // mirror what the flag resolves to, not how it is spelled.
  const defaulted = raw.match(/^\$\{[A-Z_]+:-([^}]*)\}$/);
  return (defaulted ? defaulted[1] : raw).trim();
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

/**
 * The AGENT ROUTING family. Drift here does not skip a stage — it runs the stage
 * through a different provider entirely.
 *
 * Live 2026-07-27, mock1 run 6: metrolinx sets SPEC_MODE_PROVIDER=qwen and takes
 * the fast path ("skipping MiniMax"). mock1 set no SPEC_MODE_* at all, so the
 * spec pass fell through to callMiniMaxWithTool, which throws immediately
 * without a MiniMax key — four attempts, eighteen seconds, "openspec returned
 * null", run dead at Step 1.
 *
 * Two costs. The run never reached anything it was launched to verify. And the
 * four green mock1 runs before it were exercising a provider path production
 * does not use — the mock was not testing the pipeline, it was testing a
 * neighbouring one.
 */
describe('agent routing parity — the mock must call the same providers', () => {
  // PARITY IS THE RULE; WHAT IT COMPARES MOVED.
  //
  // This listed SPEC_MODE_OPENSPEC_MODEL and SPEC_MODE_SPECKIT_MODEL — model PINS. On 2026-08-25
  // every model pin was removed from project config, because a pinned model outranked the seam's
  // ladder for every consumer that read it (found on the wire: a request for glm-5.2 while the
  // resolver had chosen glm-5.3). Production no longer sets them, so "mock1 sets it too" now
  // enforces the defect rather than parity.
  //
  // The rule that mattered — the mock must route like production, which is what killed mock1 run 6
  // at Step 1 — is unchanged, and is stronger stated as: whatever production sets, mock1 sets; and
  // whatever production no longer pins, mock1 must not pin either.
  const ROUTING = ['SPEC_MODE_PROVIDER'];
  const MUST_NOT_PIN = [
    'SPEC_MODE_OPENSPEC_MODEL', 'SPEC_MODE_SPECKIT_MODEL', 'SPEC_MODE_MODEL', 'ORCH_GATE_MODEL',
  ];

  for (const key of ROUTING) {
    it(`mock1 sets ${key}`, () => {
      const want = metrolinxValue(key);
      expect(want, `${key} is not set in metrolinx config — update this list`).toBeTruthy();
      expect(MOCK1,
        `mock1 does not set ${key}, so its spec pass routes through a different ` +
        'provider than production. This is what killed mock1 run 6 at Step 1.')
        .toMatch(new RegExp(key));
    });
  }

  for (const key of MUST_NOT_PIN) {
    it(`neither production nor mock1 pins ${key} — the ladder decides`, () => {
      expect(metrolinxValue(key),
        `${key} is pinned in metrolinx config again; a fixed model outranks every seam ladder`)
        .toBeFalsy();
      expect(MOCK1,
        `mock1 pins ${key} while production does not — the mock would route to a model the real ` +
        'run never uses, which is exactly the divergence this suite exists to catch')
        .not.toMatch(new RegExp(`^\\s*export\\s+${key}=`, 'm'));
    });
  }
});
