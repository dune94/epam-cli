/**
 * An unbudgeted review agent re-sends its whole context every turn.
 *
 * Measured 2026-07-30 across mock3 and metrolinx. Every team-lead-agent call:
 *
 *   turns   duration      input tokens   cost
 *   1       0.1 min         2.8k         $0.002
 *   5-6     1.6-2.0 min    25-30k        $0.02
 *   9       3.3-3.8 min    48k           $0.06
 *   14      2.7-4.7 min   166-185k       $0.07-0.09
 *
 * Input tokens scale with turns, because each turn re-sends the accumulated
 * transcript. Fourteen turns pulled 184,627 input tokens to review a ONE-LINE
 * diff. Cost therefore falls faster than time when turns are capped.
 *
 * team-lead-agent was 40-51% of a mock3 lane's wall clock — the single largest
 * item — and EPAM_MAX_TOOL_CALLS was set at exactly ONE of its three call
 * sites: the pre-phase assessment. The post-phase assessment and the code
 * review ran unbudgeted, which is precisely where the 9-14 turn calls came from.
 *
 * The budget is not a kill. At the limit AgentRunner withdraws the tools and
 * demands the answer, so "keep querying instead of committing" stops being
 * reachable — the same mechanism already relied on by the detective and the
 * pre-phase assessment.
 *
 * 6 is chosen from the table, not invented: 5-6 turn calls produce usable
 * reviews at ~28k tokens, while 9+ turn calls cost 2-3x the time for 5x the
 * tokens. Env-overridable so a project that genuinely needs more can raise it
 * without editing the engine.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const SRC = readFileSync(ORCH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * Run a call site's env prelude for real and report what EPAM_MAX_TOOL_CALLS
 * the invoked command actually receives. Asserting on source text alone would
 * pass for a variable that is set but never exported to the call.
 */
function budgetSeenByCall(prelude: string, env: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'budget-'));
  dirs.push(d);
  const out = join(d, 'seen.txt');
  const script = join(d, 'run.sh');
  // Wrapped in a function: the real call site sits inside one and uses `local`,
  // which errors at top level and — under set -u — leaves the budget unbound and
  // aborts before the call. That is a harness artifact, not a defect.
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
run_orch_prompt_with_tools() { printf '%s' "\${EPAM_MAX_TOOL_CALLS-<unset>}" > ${JSON.stringify(out)}; }
_site() {
${prelude}
}
_site
`);
  spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
  return existsSync(out) ? readFileSync(out, 'utf8').trim() : '<not called>';
}

/**
 * The exact prelude+call as written in the script.
 *
 * `from` must be a marker that begins a COMPLETE statement. An earlier version
 * sliced back to the nearest blank line and landed inside the preceding string
 * assignment, dragging in a stray `fi` — bash then failed to parse and the stub
 * was never called, which read as "the budget never reaches the call".
 */
function callSite(from: string, anchor: string): string {
  const i = SRC.indexOf(anchor);
  expect(i, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
  const start = SRC.lastIndexOf(from, i);
  expect(start, `prelude marker not found: ${from}`).toBeGreaterThan(-1);
  return SRC.slice(start, i + anchor.length);
}

describe('the post-phase assessment no longer needs a turn budget at all', () => {
  // Full agent audit, 2026-07-31 (mock1 investigation): the 9-14 turn/184k-
  // token problem this whole file exists to cap came from asking the agent
  // to read TWO raw files itself (cost log + PRD), dedupe/cross-reference
  // them, and write THREE outputs — with only a 6-tool-call budget and no
  // write_file tool. Budgeting that turned out to be the wrong fix: it was
  // measured live in mock1 (2026-07-31) still timing out at 300s on attempt
  // 1, succeeding only on a model-escalated retry. The actual fix is
  // structural, the same one already applied to every QA gate this
  // session: precompute the dedupe/cross-reference/arithmetic
  // deterministically in bash/python, inject the finished data, and narrow
  // the LLM to pure judgment with NO tools at all (same shape as
  // openspec/speckit) — so there is no multi-turn transcript to bound in
  // the first place, not a smaller one.
  const ANCHOR = 'run_orch_prompt "$_pa_prompt" "team-lead-agent"';

  it('calls plain run_orch_prompt, not run_orch_prompt_with_tools', () => {
    const i = SRC.indexOf(ANCHOR);
    expect(i, 'the post-phase assessment call site is gone — this is anchored to nothing').toBeGreaterThan(-1);
    expect(SRC.slice(i, i + ANCHOR.length + 20)).not.toMatch(/run_orch_prompt_with_tools/);
  });

  it('sets no AI_GATE_ALLOW_TOOLS / EPAM_MAX_TOOL_CALLS near the call (no tools requested)', () => {
    const i = SRC.indexOf(ANCHOR);
    const window = SRC.slice(Math.max(0, i - 600), i);
    expect(window, 'a tool grant reappeared on this call — the whole point of the fix ' +
      'was to remove the need for tools, not re-budget them')
      .not.toMatch(/AI_GATE_ALLOW_TOOLS|EPAM_MAX_TOOL_CALLS/);
  });

  it('the deterministic precompute step runs BEFORE the LLM call, real python execution', () => {
    const i = SRC.indexOf(ANCHOR);
    expect(i).toBeGreaterThan(-1);
    const before = SRC.slice(Math.max(0, i - 4000), i);
    expect(before, 'the precompute block is gone — the agent would be back to reading files itself')
      .toMatch(/ASSESS_PRECOMPUTE_PY/);
  });

  it('still keeps the 300s timeout as a resilience backstop, not because the task needs it', () => {
    const i = SRC.indexOf(ANCHOR);
    const before = SRC.slice(Math.max(0, i - 2000), i);
    expect(before).toMatch(/PHASE_ASSESSMENT_TIMEOUT_SECS:-300/);
  });
});

describe('the code review is a story agent, not an unbudgeted assessment', () => {
  // Correcting a misreading made while writing this file: the 9-14 turn calls
  // are the two ASSESSMENTS, not the code review. Review stories run through
  // run_story_with_watchdog, which carries the story-agent controls
  // (STORY_MAX_ITERATIONS / STORY_MAX_OUTPUT_TOKENS) — a different path with its
  // own bounds. Forcing an assessment budget in here would have been a change to
  // the wrong mechanism, justified by a number that came from elsewhere.
  it('review stories are dispatched through the story path', () => {
    const i = SRC.indexOf('Step 21: Running review stories');
    expect(i, 'the review step is gone — this is anchored to nothing').toBeGreaterThan(-1);
    expect(SRC.slice(i, i + 1200), 'review stories no longer use the story-agent path, ' +
      'so they no longer inherit its bounds and need a budget of their own')
      .toMatch(/run_story_with_watchdog/);
  });
});

describe('the existing pre-phase budget is untouched', () => {
  // It was already correct. A calibration must not disturb the one call site
  // that was already bounded.
  it('still passes its own budget', () => {
    const i = SRC.indexOf('run_orch_prompt_with_tools "$_pfa_prompt_this_attempt"');
    expect(i).toBeGreaterThan(-1);
    expect(SRC.slice(Math.max(0, i - 400), i)).toMatch(/EPAM_MAX_TOOL_CALLS="\$\{_pfa_tool_budget\}"/);
  });
});

describe('every team-lead-agent invocation is bounded', () => {
  it('no call site is left unbudgeted', () => {
    // The sweep that would have caught this originally: three call sites, one
    // budget. Any future site added without a budget re-opens the same hole.
    const sites = [...SRC.matchAll(/run_orch_prompt_with_tools\s+"[^"]*"\s+"team-lead-agent"/g)];
    expect(sites.length, 'no team-lead-agent call sites found — the sweep is inert')
      .toBeGreaterThan(0);
    const unbudgeted = sites
      .map((m) => ({ idx: m.index as number, text: m[0] }))
      .filter(({ idx }) => !/EPAM_MAX_TOOL_CALLS=/.test(SRC.slice(Math.max(0, idx - 800), idx)))
      .map(({ idx }) => `offset ${idx}: ${SRC.slice(idx, idx + 60)}`);
    expect(unbudgeted, 'a team-lead-agent call runs with no turn budget:\n' + unbudgeted.join('\n'))
      .toEqual([]);
  });
});
