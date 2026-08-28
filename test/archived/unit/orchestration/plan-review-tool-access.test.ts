/**
 * review_and_correct_plan shares HEAL-BLIND's exact exposure — closed the
 * same way, before it produces its own live incident.
 *
 * Its registry entry (agent-tool-access.test.ts) recorded needsTools=false:
 * "plan_text and dependency_contracts are both fully injected as text in the
 * prompt — nothing left to read." That reasoning is IDENTICAL to what the
 * failure-analyst's own entry said before HEAL-BLIND — and it held only for
 * what dependency_contracts happens to cover (a story's declared internal
 * dependencies), not any fact the plan might reference outside that. This
 * gate exists specifically to catch a plan that CONTRADICTS reality
 * ("does the plan reference any file path... that CONTRADICTS the
 * dependency contracts?") — the one thing it cannot do is check anything
 * dependency_contracts didn't already hand it.
 *
 * Fixed the same way, reusing the same shared mechanism: ORCH_GATE_ALLOWED_TOOLS
 * (no analyst-specific tool list), EPAM_MAX_TOOL_CALLS (bounded — this runs
 * before every story's implementation, not just on retry), and a prompt
 * instruction to verify before asserting a mismatch.
 *
 * Scoped to the FIRST invocation only (the review/verdict call). The SECOND
 * invocation in this function (the corrective re-plan) rewrites the plan
 * from corrections the first call already computed — a pure text transform,
 * correctly self-contained per its own registry entry — granting it tools
 * would be scope creep with no defect behind it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');
const ORCH_SRC = readFileSync(join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

function reviewInvocation(): string {
  const i = SRC.indexOf('review_output=$(echo "$review_prompt"');
  expect(i, 'the plan-review invocation is gone — this is anchored to nothing').toBeGreaterThan(-1);
  return SRC.slice(i, i + 500);
}

function correctiveInvocation(): string {
  const i = SRC.indexOf('corrected_plan=$(echo "$corrective_prompt"');
  expect(i, 'the corrective re-plan invocation is gone').toBeGreaterThan(-1);
  return SRC.slice(i, i + 500);
}

describe('the plan-review gate is granted tools from the existing shared allowlist', () => {
  it('sets AI_GATE_ALLOW_TOOLS on the review/verdict call', () => {
    expect(reviewInvocation(), 'the plan reviewer still cannot verify a claim against ' +
      'reality — the same gap that let the failure-analyst confidently misdiagnose a ' +
      'fully-installed package as missing')
      .toMatch(/AI_GATE_ALLOW_TOOLS=1/);
  });

  it('reuses ORCH_GATE_ALLOWED_TOOLS — no new tool list invented', () => {
    expect(reviewInvocation()).toMatch(/ORCH_GATE_ALLOWED_TOOLS/);
  });

  it('sets a tool-call budget', () => {
    expect(reviewInvocation(), 'tools granted with no budget — this gate runs before EVERY ' +
      'story\'s implementation, not just on retry, so an unbounded grant is worse than the ' +
      'assessment mistake it would repeat').toMatch(/EPAM_MAX_TOOL_CALLS/);
  });

  it('the budget is overridable, not a silent bare literal', () => {
    const m = reviewInvocation().match(/EPAM_MAX_TOOL_CALLS="([^"]*)"/);
    expect(m, 'EPAM_MAX_TOOL_CALLS is set but not from a variable').toBeTruthy();
    expect(m![1]).toMatch(/\$\{?[A-Z_]/);
  });
});

describe('the corrective re-plan stays untouched — it is a pure text transform', () => {
  it('does NOT gain tool access', () => {
    // Scope discipline: the second call rewrites the plan from corrections
    // the FIRST call already computed. It has nothing new to verify — adding
    // tools here would be unjustified scope creep, not a fix for anything.
    expect(correctiveInvocation()).not.toMatch(/AI_GATE_ALLOW_TOOLS=1/);
  });
});

describe('the prompt tells the reviewer to verify, not just receive tools', () => {
  it('instructs checking a claim before asserting a mismatch', () => {
    const i = SRC.indexOf('local review_prompt="You are reviewing an implementation PLAN');
    expect(i).toBeGreaterThan(-1);
    const promptEnd = SRC.indexOf('\n\n    local review_output', i);
    const promptText = SRC.slice(i, promptEnd === -1 ? i + 2000 : promptEnd);
    expect(promptText, 'tools were granted but the prompt never tells the reviewer to use ' +
      'them before asserting a mismatch')
      .toMatch(/verify|check.*before|do not assume/i);
  });
});

describe('the registry reflects the fix, not the stale reasoning', () => {
  it('the shared allowlist stays read-only by default (inherited property, not altered here)', () => {
    const i = ORCH_SRC.indexOf('ORCH_GATE_ALLOWED_TOOLS="${ORCH_GATE_ALLOWED_TOOLS:-');
    expect(i).toBeGreaterThan(-1);
    const line = ORCH_SRC.slice(i, ORCH_SRC.indexOf('\n', i));
    expect(line).not.toMatch(/write_file/);
  });
});
