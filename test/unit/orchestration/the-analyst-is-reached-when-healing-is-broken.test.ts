/**
 * A LADDER ON AN AGENT NOBODY CALLS IS NOT LADDER ACCESS.
 *
 * WRITTEN BEFORE THE FIX, AND RED WHEN WRITTEN.
 *
 * "Every agent can escalate" has three layers, and I have now claimed each one while testing
 * only the layer below it:
 *
 *   1. DECLARED   the archetype carries a `ladder` field.
 *   2. RESOLVED   that declaration maps to a model in the calling process. Layer 1 was checked
 *                 and layer 2 claimed on 2026-08-11; every-seam-can-reach-its-ladder.test.ts
 *                 exists because of it, and it is a good test.
 *   3. REACHED    the code path actually INVOKES the agent, so the seam runs at all.
 *
 * impl-failure-analyst declares HIGHEST (layer 1) and resolves to a model (layer 2). It is
 * never called (layer 3). claude.sh routes a DETERMINISTIC_CHECK_FAILURE straight past
 * run_failure_analyst — correctly on the first occurrence, because the check's own message
 * already names the violation and a gate-model call to restate it is waste.
 *
 * The skip never re-evaluates. By the time the loop sets HEALING_BROKEN it has established
 * something the skip's premise does not cover: the remedy has been injected repeatedly and has
 * NOT worked. The violation is still known; why the known remedy keeps failing is not, and that
 * is the analyst's only job.
 *
 * Live on 2026-08-14 (AMSD-2041, metrolinx): the story climbed rung 0 -> 1 -> 2, declared
 * HealingBroken three times, aborted at max rung, and the analyst was invoked ZERO times.
 *
 * WHY THE EXISTING TESTS PASSED. Sixty-eight tests cover this area. The ladder ones call
 * agent_ladder_model directly -- given N recorded failures, return rung N -- which is true and
 * stays true when nothing records a failure because nothing invokes the agent. Testing the
 * helper cannot see that its call site is unreachable. So this test never calls the helper: it
 * drives the REAL retry loop and COUNTS INVOCATIONS AT THE SEAM.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const PRD = join(ROOT, 'orchestrations/projects/metrolinx/prd.json');
const CFG_DIR = join(ROOT, 'orchestrations/projects/metrolinx');
const NODE_BIN = join(process.env.HOME || '', '.nvm/versions/node/v20.20.0/bin/node');

/**
 * claude.sh derives AUTOMATION_DIR (and therefore LOG_DIR, PROGRESS_LOG, CLAUDE_OUTPUT_DIR)
 * from its OWN location -- `LOG_DIR="$AUTOMATION_DIR/logs"`, with no `:-` default, so the
 * environment cannot redirect it. The harness therefore places a copy inside the fixture tree
 * and lets the script derive its own paths, rather than exporting values it will ignore.
 *
 * Exactly ONE line differs from the shipped script: the trailing `main "$@"` is suppressed so
 * the file can be sourced. Everything the loop calls is the real implementation.
 */
function buildFixture(): { dir: string; calls: string } {
  const dir = join(tmpdir(), `analyst-reach-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  for (const d of ['scripts', 'logs/claude_outputs', 'agents', 'proj', 'bin']) {
    mkdirSync(join(dir, d), { recursive: true });
  }

  const src = readFileSync(CLAUDE_SH, 'utf8');
  const sourceable = src.replace(/^main "\$@"$/m, '# main suppressed: sourced by test harness');
  // Guard against a silent no-op rename: if the entrypoint line ever changes shape, sourcing
  // would EXECUTE the orchestrator instead of defining its functions.
  if (sourceable === src) throw new Error('could not suppress `main "$@"` — claude.sh entrypoint changed shape');
  writeFileSync(join(dir, 'scripts/claude.sh'), sourceable);

  symlinkSync(join(SCRIPTS, 'lib'), join(dir, 'scripts/lib'));
  symlinkSync(join(ROOT, 'orchestrations/config'), join(dir, 'config'));
  for (const f of ['profiles.json', 'invocation-profiles.json']) {
    const p = join(ROOT, 'orchestrations/agents', f);
    if (existsSync(p)) writeFileSync(join(dir, 'agents', f), readFileSync(p));
  }

  // The writer always "succeeds", so control reaches external verification rather than dying
  // in the invocation-failure branch, which is a different path with different handling.
  const stub = join(dir, 'bin/epam');
  writeFileSync(stub, '#!/usr/bin/env bash\necho \'{"result":"stub","total_cost_usd":0.01,' +
    '"usage":{"input_tokens":10,"output_tokens":5}}\'\nexit 0\n');
  chmodSync(stub, 0o755);

  return { dir, calls: join(dir, 'analyst-calls.txt') };
}

/**
 * Drive the real implement_story with a violation that NEVER changes -- the "same violation
 * repeated" condition the loop itself watches for -- and record the model the analyst is asked
 * with on every invocation.
 */
const AGENT_REGISTRY = join(ROOT, 'orchestrations/agents/invocation-profiles.json');

function runLoop(fx: { dir: string; calls: string }) {
  const script = `
    set -uo pipefail
    export ANALYST_CALLS='${fx.calls}'; : > "$ANALYST_CALLS"
    export PRD_FILE='${PRD}'
    export PROJECT_ROOT='${fx.dir}/proj'
    export NODE_BIN='${NODE_BIN}'
    export EPAM_PROJECT_CONFIG_DIR='${CFG_DIR}'
    export EPAM_PERIMETER_WRITE_ROLES='contentstack-live-preview-integration-engineer'
    # The analyst's declared tier (HIGHEST) and its real chain, so the climb is measured
    # against the declaration rather than a value invented by the test.
    export EPAM_MODEL_LADDER_HIGHEST='MiniMax-M3=z-ai/glm-5.2|z-ai/glm-5.2=moonshotai/kimi-k3'
    export EPAM_ANALYST_START_MODEL='MiniMax-M3'
    export AGENT_PROFILES_REGISTRY='${AGENT_REGISTRY}'
    export PATH='${fx.dir}/bin':"$PATH"
    git -C '${fx.dir}/proj' init -q 2>/dev/null

    source '${fx.dir}/scripts/claude.sh' >/dev/null 2>&1

    # The violation is identical every time: the remedy is being applied and is not working.
    run_external_verification() {
        DETERMINISTIC_CHECK_FAILURE=1
        VERIFICATION_FAILURE="the prescribed helper getContentByKey EXISTS but does not appear in the change"
        return 1
    }
    # THE OBSERVATION POINT — and a FAITHFUL stand-in, not an inert one.
    #
    # The real run_failure_analyst is where the climb happens, so a stub that only records the
    # call makes the ladder unobservable: the model never moves because the thing that moves it
    # was replaced. This stub does what the real one does on an unusable answer — records the
    # failure and asks the shared handler for the next rung — using the real agent-ladder.sh
    # functions and the real declared chain.
    gate_model="\${EPAM_ANALYST_START_MODEL:-}"
    run_failure_analyst() {
        echo "\${gate_model:-UNSET}" >> "$ANALYST_CALLS"
        agent_ladder_record_failure "impl-failure-analyst" "\$1"
        local _n; _n=\$(agent_ladder_model "impl-failure-analyst" "\$1" "\${gate_model:-}")
        [ -n "\$_n" ] && gate_model="\$_n"
        return 0
    }

    MAX_RETRIES=4
    implement_story "AMSD-2041"
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 180_000 });
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  const calls = existsSync(fx.calls)
    ? readFileSync(fx.calls, 'utf8').split('\n').filter(Boolean)
    : [];
  return { log, calls };
}

let out: { log: string; calls: string[] };
let fx: { dir: string; calls: string };
beforeAll(() => {
  fx = buildFixture();
  out = runLoop(fx);
}, 200_000);

describe('THE HARNESS ACTUALLY DROVE THE LOOP', () => {
  // Without these, every assertion below could pass on a script that never ran -- the vacuous
  // pass that makes a negative assertion worthless.
  it('the retry loop executed and reached the deterministic-check path', () => {
    expect(out.log, 'the loop never reached the deterministic-check branch — the harness is not driving the real path')
      .toContain('[DeterministicCheck]');
  });

  it('the loop exhausted its remedy and said so', () => {
    // This is the precondition of the requirement: the system has PROVEN its own remedy failed.
    expect(out.log, 'HealingBroken was never reached, so the situation under test did not occur')
      .toContain('HealingBroken');
  });

  it('the story ladder itself climbed, so ladder machinery is live in this harness', () => {
    expect(out.log, 'no rung advance at all — the harness is not exercising the ladder')
      .toMatch(/rung 1|Rung1/);
  });
});

describe('THE ANALYST IS REACHED WHEN THE PIPELINE DECLARES ITS HEALING BROKEN', () => {
  it('the failure analyst is invoked at least once', () => {
    // RED until the skip re-evaluates on repeat. Live on 2026-08-14 this was 0 while the story
    // climbed every rung it had and aborted.
    expect(out.calls.length,
      'the loop declared HealingBroken and aborted without ever invoking the failure analyst — ' +
      'the only agent that can diagnose why the known remedy keeps failing was skipped by a ' +
      'condition that was correct on attempt 1 and never re-evaluated')
      .toBeGreaterThan(0);
  });

  it('the analyst is NOT invoked on the first occurrence, when the violation is genuinely new', () => {
    // The skip is right the first time: the check names the violation exactly, and paying a
    // gate-model call to restate it is waste. The fix must not turn into "always call the
    // analyst" -- that would trade one defect for a bill.
    const firstSkip = out.log.indexOf('Skipping failure-analyst');
    const firstBroken = out.log.indexOf('HealingBroken');
    expect(firstSkip, 'the first-occurrence skip is gone — the fix over-corrected into always calling the analyst')
      .toBeGreaterThan(-1);
    expect(firstSkip, 'the skip must come BEFORE healing is declared broken, not after')
      .toBeLessThan(firstBroken);
  });
});

describe('ONCE INVOKED, THE ANALYST CLIMBS ITS OWN LADDER', () => {
  it('repeated unusable answers move the analyst off its starting model', () => {
    // The rung-up assertion, made on the SEQUENCE of models observed at the seam rather than by
    // calling agent_ladder_model directly. A helper that returns rung N for N failures is true
    // and useless when nothing ever records a failure.
    if (out.calls.length < 2) {
      expect.fail(`the analyst was invoked ${out.calls.length} time(s) — a ladder cannot be ` +
        `observed to climb until the agent is reached repeatedly`);
    }
    expect(new Set(out.calls).size,
      `the analyst was asked with the same model every time (${out.calls.join(' -> ')}) — ` +
      `it is not climbing the ladder its archetype declares`)
      .toBeGreaterThan(1);
  });
});
