/**
 * THE GATE PATH CLIMBS ITS LADDER.
 *
 * Two invocation paths existed side by side, and the registry only governed one of them:
 *
 *   seam path   ladder position -> project tier -> escalation chain   (spec-mode-runner, 6 uses)
 *   gate path   ${ORCH_GATE_MODEL:-<a fixed model>}, no registry      (run-agent-orchestration, 13)
 *
 * So the six QA sentinels declared `ladder: top` and never used it. They were invoked through
 * the gate path, which swaps ORCH_GATE_MODEL to ESCALATION_MODEL_HIGH on retry — an ad-hoc
 * two-step escalation, while the registry claimed a full chain.
 *
 * The registry was describing a pipeline the runtime did not run. Worse, the ladder tests
 * written earlier the same day all PASSED: they assert the DECLARATION is coherent — every
 * seam names a position, every project resolves it, every tier has hops — and never that the
 * runtime consults it. A declaration nothing reads is documentation, not configuration.
 *
 * This test closes that gap from the other side: it asserts the gate path RESOLVES the seam
 * before choosing a model, so a seam's declared ladder is the one it actually climbs.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const SEAM_LADDER = join(ROOT, 'orchestrations/scripts/lib/seam-ladder.sh');

/** Extract run_orch_prompt's model-resolution region from the shipped script. */
function modelResolution(): string {
  const src = readFileSync(ORCH, 'utf8');
  const at = src.indexOf('run_orch_prompt() {');
  expect(at, 'run_orch_prompt not found').toBeGreaterThan(-1);
  const end = src.indexOf('\n}\n', at);
  return src.slice(at, end);
}

describe('the gate path consults the registry', () => {
  it('run_orch_prompt resolves the seam before picking a model', () => {
    const body = modelResolution();
    expect(body, 'the gate path still picks a model with no reference to the seam registry')
      .toMatch(/seam_ladder_export/);
  });

  it('the shell bridge it uses reads the SAME registry as the JS side', () => {
    // One registry, two languages. A second source of truth here would let the two paths
    // disagree about what a seam is configured to do, which is the defect being closed.
    const src = readFileSync(SEAM_LADDER, 'utf8');
    expect(src).toMatch(/seam-invocation\.js/);
    expect(src).toMatch(/AGENT_PROFILES_REGISTRY|invocation-profiles\.json/);
  });

  it('a seam-resolved model WINS over the fixed gate default', () => {
    // Otherwise the registry is decoration: the ladder resolves, and the fixed model is used
    // anyway. The seam's answer has to be the one that reaches the runner.
    const body = modelResolution();
    const seamAt = body.indexOf('seam_ladder_export');
    const modelAt = body.indexOf('local gate_model=');
    expect(seamAt, 'seam not resolved at all').toBeGreaterThan(-1);
    expect(modelAt, 'gate_model assignment not found').toBeGreaterThan(-1);
    expect(seamAt, 'the seam is resolved AFTER the model is chosen, so it cannot affect it')
      .toBeLessThan(modelAt);
  });
});

describe('the bridge actually resolves a real seam', () => {
  it('exports a ladder for a seam the registry declares', () => {
    // Executed, not asserted from source: a bridge that silently returns nothing would pass
    // every source-text check while leaving every gate on the fixed model.
    const dir = mkdtempSync(join(tmpdir(), 'seam-ladder-'));
    try {
      const res = spawnSync('bash', ['-c', `
        set -uo pipefail
        export NODE_BIN=${JSON.stringify(process.execPath)}
        export EPAM_MODEL_LADDER_HIGHEST="a->b"
        export EPAM_MODEL_LADDER_TIER_ORDER="medium high highest"
        source ${JSON.stringify(SEAM_LADDER)}
        seam_ladder_export "qa-gate:sast"
        echo "LADDER=\${EPAM_MODEL_LADDER:-<unset>}"
        echo "EFFORT=\${EPAM_REASONING_EFFORT:-<unset>}"
      `], { encoding: 'utf8' });
      const out = (res.stdout || '') + (res.stderr || '');
      // The sentinel declares ladder `top`, which resolves through the tier order to
      // `highest` — so the ladder it exports must be the one supplied for that tier.
      expect(out, `bridge produced nothing:\n${out}`).toContain('LADDER=a->b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
