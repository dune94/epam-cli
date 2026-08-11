/**
 * The failure-analyst gets tools from the SAME place every other gate does.
 *
 * Live metrolinx 2026-07-31 (run 10). @metrolinx/cx-shared is a real,
 * extensively-used internal package — fully installed, built, the exact
 * subpaths the agent imported exist on disk. The failure-analyst diagnosed
 * "package not installed" anyway, three times, HEALING_BROKEN fired. Traced
 * to: run_failure_analyst is the ONLY gate agent in this file that does not
 * go through the shared run_orch_prompt_with_tools wrapper — it hand-rolls
 * its own ai-run.sh call, and AI_GATE_ALLOW_TOOLS=1 is set at exactly two
 * OTHER call sites (run_plan_mode, run_pre_phase_assessment). The analyst
 * has never had ReadFile, Bash, or any way to verify a claim against the
 * real filesystem — it answers from three static, pre-injected text blocks
 * and nothing else. A guess stated with full confidence is not a diagnosis.
 *
 * THE FIX MUST NOT INVENT A NEW TOOL LIST. ORCH_GATE_ALLOWED_TOOLS already
 * exists, already defaults to a read-only set (bash,read_file,list_files,
 * search — no write_file), and is already the single config-driven source
 * every other gate agent's tool grant draws from
 * (run-agent-orchestration.sh:1050, consumed at :1099 and :1285). The
 * analyst reuses that SAME variable — no analyst-specific allowlist, no
 * hardcoded tool names anywhere in this change.
 *
 * A tool grant with no bound repeats a mistake already fixed once tonight:
 * the post-phase assessment ran unbudgeted and reached 184k input tokens
 * reviewing a one-line diff. The analyst runs on the critical path of every
 * retry, so it gets the same protection (EPAM_MAX_TOOL_CALLS), not an
 * unbounded grant.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineAndPrompt, analystPromptBody } from '../../helpers/analyst-prompt';

const SRC = engineAndPrompt(readFileSync(join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8'));
// ORCH_GATE_ALLOWED_TOOLS's default lives in the orchestrator, not claude.sh.
const ORCH_SRC = readFileSync(join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

function analystInvocation(): string {
  const i = SRC.indexOf('if analyst_raw=$(echo "$analyst_prompt"');
  expect(i, 'the analyst invocation is gone — this is anchored to nothing').toBeGreaterThan(-1);
  return SRC.slice(Math.max(0, i - 600), i + 900);
}

describe('the failure-analyst is granted tools from the existing shared allowlist', () => {
  it('sets AI_GATE_ALLOW_TOOLS on its invocation', () => {
    expect(analystInvocation(), 'the analyst still runs with no tools — it cannot verify ' +
      'any claim not already pre-injected, which is exactly how it confidently misdiagnosed ' +
      'a fully-installed package as missing')
      .toMatch(/AI_GATE_ALLOW_TOOLS=1/);
  });

  it('reuses ORCH_GATE_ALLOWED_TOOLS — no analyst-specific tool list invented', () => {
    expect(analystInvocation(), 'a new, analyst-only tool list was introduced instead of ' +
      'reusing the existing shared, config-driven allowlist')
      .toMatch(/ORCH_GATE_ALLOWED_TOOLS/);
  });

  it('the shared allowlist itself stays read-only by default', () => {
    // Not this change's job to alter — confirms the property the analyst is
    // inheriting is actually the safe one.
    const i = ORCH_SRC.indexOf('ORCH_GATE_ALLOWED_TOOLS="${ORCH_GATE_ALLOWED_TOOLS:-');
    expect(i).toBeGreaterThan(-1);
    const line = ORCH_SRC.slice(i, ORCH_SRC.indexOf('\n', i));
    expect(line, 'the shared default now includes write_file').not.toMatch(/write_file/);
  });
});

describe('the tool grant is bounded, not unlimited', () => {
  it('sets a tool-call budget on the analyst call', () => {
    expect(analystInvocation(), 'tools were granted with no budget — the same unbounded-turn ' +
      'mistake already fixed once tonight for the post-phase assessment (184k tokens on a ' +
      'one-line diff), now on a call that runs every single retry')
      .toMatch(/EPAM_MAX_TOOL_CALLS/);
  });

  it('the budget is overridable per project, not hardcoded to one number silently', () => {
    const inv = analystInvocation();
    const m = inv.match(/EPAM_MAX_TOOL_CALLS="([^"]*)"/);
    expect(m, 'EPAM_MAX_TOOL_CALLS is set but not from a variable').toBeTruthy();
    expect(m![1], 'the budget is a bare literal with no env override').toMatch(/\$\{?[A-Z_]/);
  });
});

describe('the prompt tells the analyst to use the tools, not just receive them', () => {
  it('instructs verification before stating a claim as fact', () => {
    // The prompt left claude.sh on 2026-08-11 and is now a project-authority JSON file, so
    // there is no heredoc to slice. Read the prompt itself — the artifact that reaches the
    // model — rather than the engine that renders it.
    const template = analystPromptBody();
    expect(template, 'tools were granted but the prompt never tells the analyst to use ' +
      'them before asserting a fact — a model with unused tool access behaves identically ' +
      'to one with none')
      .toMatch(/verify|check.*before|do not assume/i);
  });
});
