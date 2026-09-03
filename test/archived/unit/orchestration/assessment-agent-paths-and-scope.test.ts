/**
 * B18 — the pre-phase skill-assessment agent ran `find /` for 4m42s.
 *
 * Diagnosed from the mock1 run (2026-07-24, story MOCK-HW-1, a one-line
 * 'hello world' -> 'hello dolly' change). Langfuse iteration 5 issued:
 *
 *     bash: find / -name "profiles.json" -not -path "*!/node_modules/*" | head -10
 *
 * and the next LLM call did not start for 282 SECONDS — essentially the entire
 * "287s of skill assessment" I had wrongly attributed to model latency. The models
 * are fast (direct calls: 14K-token prompt -> 2.1s); one runaway filesystem walk
 * was the impediment.
 *
 * ROOT CAUSE: the prompt names `profiles.json` as a BARE FILENAME eight times. The
 * agent's cwd is the CODELINE, not this repo, so the file is not there. `PRD_REL`
 * already solves exactly this for the PRD (relative when inside PROJECT_ROOT,
 * absolute when outside) — profiles had no equivalent.
 *
 * SECOND DEFECT, same transcript: iteration 14 was `write_file src/hello.ts` — a
 * PRE-PHASE profile-tuning step editing the application source the story is about,
 * before implementation runs. It must be write-scoped to profiles only.
 *
 * Both are on the shared code path, so they affect metrolinx identically.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ORCH = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

/** The assessment prompt body. */
function assessmentPrompt(): string {
  const i = ORCH.indexOf('You are the skill assessment agent running in PRE-PHASE mode');
  expect(i, 'assessment prompt not found').toBeGreaterThan(-1);
  return ORCH.slice(i, i + 6000);
}

describe('B18 — assessment agent must be told WHERE profiles.json is', () => {
  it('computes a path-safe PROFILES_REL, the way PRD_REL already is', () => {
    expect(ORCH).toMatch(/PROFILES_REL=/);
  });

  it('PROFILES_REL falls back to an ABSOLUTE path when outside PROJECT_ROOT', () => {
    // Same ../* handling as PRD_REL — the codeline is not this repo.
    const i = ORCH.indexOf('PROFILES_REL=');
    const near = ORCH.slice(i, i + 400);
    expect(near).toMatch(/\.\.\/\*\)/);
    expect(near).toMatch(/realpath/);
  });

  it('the prompt never refers to a BARE profiles.json (what caused the find /)', () => {
    const p = assessmentPrompt();
    // every mention must be path-qualified via the variable
    const bare = [...p.matchAll(/(^|[\s`'"(])profiles\.json/g)]
      .filter(m => !p.slice(Math.max(0, m.index! - 30), m.index!).includes('PROFILES_REL'));
    expect(bare.length, `${bare.length} bare "profiles.json" references remain`).toBe(0);
  });
});

// The filesystem-walk stall is NOT fixed by blacklisting `find /` — any command
// that outlives its shell has the same effect. It is fixed at the tool boundary by
// making the timeout real (process-group kill), covered behaviourally in
// test/unit/tools/bash-timeout-kills-process-group.test.ts.
// An earlier version of this file asserted the guard lived in ai-run.sh — the wrong
// artifact: ai-run.sh runs PROMPTS, the bash TOOL executes inside `epam run`.

describe('B18 — assessment agent is write-scoped to profiles', () => {
  it('cannot write application source (it wrote src/hello.ts in the mock1 run)', () => {
    // The function is run_pre_phase_assessment (an earlier version of this test
    // anchored on a name that does not exist, so indexOf returned -1 and it
    // silently searched the END of the file — an assertion that could only ever
    // pass or fail by accident).
    const i = ORCH.indexOf('run_pre_phase_assessment() {');
    expect(i, 'run_pre_phase_assessment not found').toBeGreaterThan(-1);
    // 20000: the fix sits ~12.3K chars into the function; a 12000 window missed it by
    // 271 chars and reported a real fix as absent.
    const body = ORCH.slice(i, i + 20000);
    expect(body).toMatch(/EPAM_ALLOWED_WRITE_PATHS/);
    // and it must be scoped to the profiles file, not something broad
    // The scope is now EMPTY, which is strictly stronger than the profiles+PRD
    // scope this asserted before: the agent writes nothing at all. It returns a
    // decision under EPAM_RESPONSE_SCHEMA and lib/assessment_apply.py applies it,
    // because mutating a 136K-char JSON file with no write_file tool is what made
    // this step exhaust its iteration budget in every observed run.
    //
    // The variable is still SET rather than deleted, so a future prompt change
    // cannot quietly regain the write access that produced this bug.
    expect(body, 'the assessment agent can still write files')
      .toMatch(/EPAM_ALLOWED_WRITE_PATHS=""/);
  });
});
