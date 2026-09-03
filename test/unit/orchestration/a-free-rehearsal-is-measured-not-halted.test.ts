/**
 * A RUN THAT CANNOT SPEND IS MEASURED, NEVER HALTED.
 *
 * The coverage gate exists for one stated reason, in its own words: "untested code is the most
 * expensive thing this pipeline runs ... The money was spent before the defect was reachable."
 * Every word of that is about SPEND. A rehearsal answered by MockServer spends nothing, so the
 * justification does not reach it — and applying it there is not merely over-strict, it is a
 * deadlock:
 *
 *   the launch stage sits at 2.3% because its code is inline, and inline code is only executed
 *   when the script RUNS  →  the one mechanism that executes it is a free mock run
 *   →  the free mock run is refused by the gate, for being below 2.3%
 *
 * So the gate blocks the only thing that can satisfy the gate. That is the exact failure the gate's
 * own comment already names one level down — "a gate nobody can satisfy is worse than no gate,
 * because it teaches people to route around it" — which was handled for unit tests via
 * EPAM_COVERAGE_GATED and never handled for rehearsals.
 *
 * THE SHORTFALL IS STILL REPORTED. Standing down is not the same as passing: a free run that hid
 * the number would let coverage rot behind a mock, which is how the gate becomes decorative.
 *
 * The discriminator is the one that already exists — free_run_requested(), driven by EPAM_FREE_RUN.
 * No second notion of freeness, and no set name anywhere near this decision.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = process.cwd();
const GATE = join(REPO, 'orchestrations/scripts/lib/stage-coverage-gate.sh');
const HANDLER = join(REPO, 'orchestrations/scripts/lib/handlers/stage-coverage.js');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';

/** Ask the gate about one stage, as a stage in a gated run would. */
function gate(stage: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c',
    `. ${JSON.stringify(GATE)}; require_stage_coverage ${JSON.stringify(stage)}; echo "EXIT=$?"`],
    {
      encoding: 'utf8', timeout: 120000, cwd: REPO,
      // INHERIT THE ENVIRONMENT, THEN CONTROL ONLY WHAT IS UNDER TEST.
      //
      // A hand-built { PATH, HOME } reads as careful isolation and silently defeats measurement:
      // the shell coverage collector instruments children through BASH_ENV and BASH_XTRACEFD, so
      // replacing the environment strips the instrumentation and every line the suite executes is
      // invisible to the meter. The variables this suite decides are still set explicitly below,
      // and EPAM_FREE_RUN is cleared first so an inherited one cannot answer for it.
      env: (() => {
        const e: any = { ...process.env };
        delete e.EPAM_FREE_RUN;
        return { ...e, NODE_BIN: NODE20, EPAM_COVERAGE_GATED: '1', ...env };
      })(),
    });
  const out = (r.stdout || '') + (r.stderr || '');
  return { exit: /EXIT=(\d+)/.exec(r.stdout || '')?.[1], out };
}

/** A stage the project's own report puts BELOW its threshold, discovered rather than named. */
function belowThresholdStage(): string | null {
  const all = spawnSync(NODE20, [HANDLER, '--all'], { encoding: 'utf8', timeout: 180000, cwd: REPO });
  const pol = spawnSync(NODE20, [HANDLER, '--policy'], { encoding: 'utf8', timeout: 60000, cwd: REPO });
  let threshold = 60;
  try { threshold = Number(JSON.parse(pol.stdout || '{}').threshold ?? 60); } catch { /* default */ }
  for (const line of (all.stdout || '').split('\n')) {
    const m = /^(\S+)\s+([\d.]+)/.exec(line.trim());
    if (m && Number(m[2]) < threshold) return m[1];
  }
  return null;
}

const STAGE = belowThresholdStage();

describe('a free rehearsal is measured, not halted', () => {
  it('there IS a stage below threshold — otherwise every assertion here is vacuous', () => {
    expect(STAGE, 'no stage is below threshold, so this test proves nothing about halting')
      .not.toBeNull();
  }, 200_000);

  it('THE REGRESSION: a free run is not halted by it', () => {
    const r = gate(STAGE!, { EPAM_FREE_RUN: '1' });
    expect(r.exit, `the gate halted a run that spends nothing:\n${r.out}`).toBe('0');
  }, 200_000);

  it('and the shortfall is still reported — standing down is not passing', () => {
    const r = gate(STAGE!, { EPAM_FREE_RUN: '1' });
    expect(r.out, 'the free run was waved through with no number, so coverage can rot behind a mock')
      .toMatch(/below|shortfall|not halting|spends nothing/i);
    expect(r.out, 'the stage is not even named in the report').toContain(STAGE!);
  }, 200_000);

  it('a SPENDING run below threshold still halts — the gate is not disarmed', () => {
    // The negative half. Without it, "not halted" could be achieved by breaking the gate outright.
    const r = gate(STAGE!, {});
    expect(r.exit, `the gate let a PAYING run execute ${STAGE} below threshold:\n${r.out}`).toBe('1');
  }, 200_000);

  it('the decision reads the declared free-run predicate, not a provider set name', () => {
    // EPAM_PROVIDER_SET=mockserver must NOT be what earns the stand-down: a mock is data a run may
    // use, never a thing the engine reasons about.
    const r = gate(STAGE!, { EPAM_PROVIDER_SET: 'mockserver' });
    expect(r.exit, 'the gate inferred freeness from a set name instead of the declaration').toBe('1');
  }, 200_000);
});
