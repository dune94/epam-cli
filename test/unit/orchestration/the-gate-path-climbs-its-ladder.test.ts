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
// run_orch_prompt now lives in lib/orch-prompt.sh: it was moved out of the 11,213-line
// orchestrator so a test could reach it without running the pipeline. Same function, new home.
const ORCH = join(ROOT, 'orchestrations/scripts/lib/orch-prompt.sh');
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

  it('there is no fixed gate default left for a seam to have to win over', () => {
    // WAS: asserted the seam resolved BEFORE `local gate_model=${EPAM_MODEL:-${ORCH_GATE_MODEL:-
    // <a vendor model>}}`, so its answer would win the substitution. Ordering was the best that
    // shape allowed, but it still left two other sources that answered whenever the seam did not
    // — and because the literal always answered, two of the ladder's three positions resolved no
    // model for months and nothing noticed.
    //
    // The ladder is now the only source, so there is nothing to out-rank: the model either comes
    // from the seam or the gate refuses to run.
    const body = modelResolution();
    // Comments record WHAT WAS REMOVED and quote the old shape verbatim, so they must not be
    // scanned — otherwise the explanation of the fix reads as the defect.
    const code = body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code, 'the seam is no longer consulted at all').toMatch(/seam_ladder_export|seam_model_or_fail/);
    expect(code, 'a run-wide model pin is back in the gate path')
      .not.toMatch(/\$\{ORCH_GATE_MODEL:-|\$\{EPAM_MODEL:-\$\{/);
    expect(code, 'a vendor model name is back in the gate path')
      .not.toMatch(/MiniMax-M|z-ai\/glm|moonshotai\/kimi/);
    expect(code, 'an unresolvable model is substituted rather than refused')
      .toMatch(/refusing to invoke|return 1/);
  });
});

describe('the bridge actually resolves a real seam', () => {
  it('exports a ladder for a seam the registry declares', () => {
    // Executed, not asserted from source: a bridge that silently returns nothing would pass
    // every source-text check while leaving every gate on the fixed model.
    const dir = mkdtempSync(join(tmpdir(), 'seam-ladder-'));
    // DERIVED, NOT NAMED. This hardcoded `qa-gate:sast` as its example of a seam declaring `top`.
    // That seam moved to `mid` on 2026-08-25 in a ladder redistribution, and the test failed for a
    // reason with nothing to do with the bridge it exists to check. Any seam declaring `top` will
    // do — so ask the registry which ones do.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const reg = JSON.parse(require('node:fs').readFileSync(
      join(__dirname, '../../../orchestrations/agents/invocation-profiles.json'), 'utf8'));
    const tops: string[] = [];
    (function walk(o: Record<string, unknown>) {
      for (const k of Object.keys(o)) {
        const v = o[k] as Record<string, unknown>;
        if (v && typeof v === 'object') {
          if (typeof v.template === 'string' && v.ladder === 'top') tops.push(k);
          walk(v);
        }
      }
    }((reg.profiles || reg) as Record<string, unknown>));
    expect(tops.length, 'no seam declares ladder `top` — this case would prove nothing')
      .toBeGreaterThan(0);
    const TOP_SEAM = tops[0];
    try {
      const res = spawnSync('bash', ['-c', `
        set -uo pipefail
        export TOP_SEAM=${JSON.stringify(TOP_SEAM)}
        export NODE_BIN=${JSON.stringify(process.execPath)}
        export EPAM_MODEL_LADDER_HIGHEST="a->b"
        export EPAM_MODEL_LADDER_TIER_ORDER="medium high highest"
        source ${JSON.stringify(SEAM_LADDER)}
        seam_ladder_export "${TOP_SEAM}"
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
