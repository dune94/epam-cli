/**
 * Gate agents must be bounded by ITERATIONS, not only by wall clock.
 *
 * Live metrolinx 2026-07-25: the phase assessment agent produced a ZERO-BYTE log
 * and was killed by its timeout — first at 120s, then again at 300s after I raised
 * it. A slow-but-working agent emits something; a 0-byte log over five minutes is a
 * stall, so raising the timeout treated the symptom and just spent more wall clock
 * failing. My reasoning-model-latency argument for that raise was wrong.
 *
 * The cause: run_orch_prompt sets no EPAM_MAX_ITERATIONS, and the assessment runs
 * through run_orch_prompt_with_tools — a summariser WITH TOOLS, free to explore
 * indefinitely. Nothing bounded the loop except the clock.
 *
 * Same class as B28 (an invocation site missing a required parameter), for
 * iterations rather than output tokens. An iteration cap fails fast and
 * deterministically instead of burning a timeout, and it is what the original
 * 2026-07-23 incident actually needed: "a stuck agent (reached maximum iterations
 * without completing) consumed the entire pipeline run's wall-clock budget".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { orchestratorSource } from '../../helpers/orchestrator-source';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
// Reads the orchestrator AND the libs carved out of it — run_orch_prompt and the gate verdict
// logic now live in lib/. See test/helpers/orchestrator-source.ts: the property is about the
// shipped path, not about which file happens to hold it today.
const orch = orchestratorSource();

describe('gate agents cannot loop forever', () => {
  it('run_orch_prompt sets an iteration bound', () => {
    const i = orch.indexOf('run_orch_prompt() {');
    expect(i, 'run_orch_prompt not found').toBeGreaterThan(-1);
    const body = orch.slice(i, i + 2500);
    expect(body,
      'no EPAM_MAX_ITERATIONS — a tool-using gate agent can loop until the wall ' +
      'clock kills it, which is how the assessment produced a 0-byte log twice')
      .toMatch(/EPAM_MAX_ITERATIONS/);
  });

  it('the bound is overridable per site but generous enough for real gates', () => {
    const m = orch.match(/EPAM_MAX_ITERATIONS="\$\{([A-Z_]+):-(\d+)\}"/);
    expect(m, 'the bound is hardcoded rather than overridable').toBeTruthy();
    const n = Number(m![2]);
    // Low enough to stop a runaway loop, high enough that QA gates which
    // legitimately read source files are not strangled.
    expect(n).toBeGreaterThanOrEqual(12);
    expect(n).toBeLessThanOrEqual(40);
  });
});

describe('the repro-test-writer has enough budget to actually write', () => {
  it('allows more than the 15 iterations that failed live', () => {
    const src = readFileSync(join(SCRIPTS, 'brownfield-repro-test-writer.sh'), 'utf8');
    const m = src.match(/REPRO_TEST_WRITER_MAX_ITERATIONS:-(\d+)/);
    expect(m, 'the writer budget default vanished').toBeTruthy();
    // Live: attempts 1 and 2 both died with class=max_iterations at 15, on two
    // different models — the agent explored and never wrote. The prompt also now
    // asks it to typecheck its own output, which costs turns.
    expect(Number(m![1]),
      '15 was demonstrably too small for a real brownfield story')
      .toBeGreaterThan(15);
  });
});
