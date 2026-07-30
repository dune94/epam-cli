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

describe('the post-phase assessment is budgeted', () => {
  const ANCHOR = 'run_orch_prompt_with_tools "$_pa_prompt" "team-lead-agent"';

  it('passes a turn budget to the call', () => {
    const site = callSite('# No story_id', ANCHOR);
    expect(site, 'the post-phase assessment still runs unbudgeted — this is one of ' +
      'the two sites that produced 14-turn, 184k-token reviews of a one-line diff')
      .toMatch(/EPAM_MAX_TOOL_CALLS=/);
  });

  it('the budget actually reaches the invoked command', () => {
    const site = callSite('local _pa_tool_budget', ANCHOR).replace(/\$_pa_prompt/g, '"p"');
    const seen = budgetSeenByCall(`_pa_prompt="p"\n${site}`);
    expect(seen, 'the variable is set but never reaches the call — asserting on ' +
      'source text alone would have passed here').toMatch(/^\d+$/);
    expect(Number(seen)).toBeGreaterThan(0);
    expect(Number(seen), 'the budget is above the 9-14 turn range it exists to cap')
      .toBeLessThanOrEqual(8);
  });

  it('is overridable per project without editing the engine', () => {
    const site = callSite('local _pa_tool_budget', ANCHOR).replace(/\$_pa_prompt/g, '"p"');
    const seen = budgetSeenByCall(`_pa_prompt="p"\n${site}`, { POST_ASSESSMENT_MAX_TOOL_CALLS: '12' });
    expect(seen, 'the budget is hardcoded — a project needing more cannot raise it')
      .toBe('12');
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
