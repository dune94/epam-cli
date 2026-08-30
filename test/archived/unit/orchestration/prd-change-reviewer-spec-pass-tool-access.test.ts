/**
 * prd-change-reviewer's SECOND call site — spec-mode-runner.js's
 * reviewPrdChange(), used during the spec pass (AC/description/title/split
 * review) — gets the same fix as its claude.sh sibling (run_prd_change_reviewer,
 * covered by agent-tool-access.test.ts).
 *
 * Full agent audit, 2026-07-31 (same class as HEAL-BLIND): the reviewer's own
 * profile requires judging profile_addendum/profile_creation changes "from
 * the manifests, config and source actually present in THIS codeline" — but
 * this call site had zero tool access. A live incident already occurred via
 * the claude.sh call site (rejected correct Contentstack advice for
 * Metrolinx with no way to check the real stack); this call site had the
 * identical gap, just never tripped it yet.
 *
 * Also fixes a model-tier inconsistency: buildGateExec() never honored
 * ESCALATION_MODEL_HIGH, so this call site silently ran a cheaper model than
 * claude.sh's run_prd_change_reviewer for the identical review job, despite
 * both being "review every persisted write with the highest-quality model"
 * by design.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const specModeRunner = require('../../../orchestrations/scripts/spec-mode-runner.js');
const SRC = readFileSync(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

describe('buildGateExec — model-tier consistency', () => {
  it('honors ESCALATION_MODEL_HIGH when set, matching claude.sh run_prd_change_reviewer precedence', () => {
    const exec = specModeRunner.buildGateExec('ai-run.sh', {
      ORCH_GATE_PROVIDER: 'openrouter',
      ORCH_GATE_MODEL: 'z-ai/glm-5.2',
      ESCALATION_MODEL_HIGH: 'z-ai/glm-5.1',
    });
    expect(exec.args).toEqual(['--provider', 'openrouter', '--model', 'z-ai/glm-5.1']);
  });

  it('falls back to ORCH_GATE_MODEL when ESCALATION_MODEL_HIGH is unset', () => {
    const exec = specModeRunner.buildGateExec('ai-run.sh', {
      ORCH_GATE_PROVIDER: 'openrouter',
      ORCH_GATE_MODEL: 'z-ai/glm-5.2',
    });
    expect(exec.args).toEqual(['--provider', 'openrouter', '--model', 'z-ai/glm-5.2']);
  });

  it('falls back to MiniMax-M3/minimax when nothing is configured', () => {
    const exec = specModeRunner.buildGateExec('ai-run.sh', {});
    expect(exec.args).toEqual(['--provider', 'minimax', '--model', 'MiniMax-M3']);
  });
});

describe('reviewPrdChange (spec-pass call site) — tool access wiring', () => {
  function reviewCallSite(): string {
    const i = SRC.indexOf('const gateExec = buildGateExec(aiRunnerCmd);');
    expect(i, 'the spec-pass reviewPrdChange call site is gone — this is anchored to nothing').toBeGreaterThan(-1);
    return SRC.slice(i, i + 900);
  }

  it('grants AI_GATE_ALLOW_TOOLS on the runClaude call', () => {
    expect(reviewCallSite(), 'the spec-pass prd-change-reviewer call still has no tool access — ' +
      'the same gap that let it reject correct Contentstack advice with no way to check the ' +
      'real stack, just via a different call site than the one already fixed')
      .toMatch(/AI_GATE_ALLOW_TOOLS:\s*'1'/);
  });

  it('reuses ORCH_GATE_ALLOWED_TOOLS — no new tool list invented', () => {
    expect(reviewCallSite()).toMatch(/ORCH_GATE_ALLOWED_TOOLS/);
  });

  it('sets an overridable tool-call budget', () => {
    expect(reviewCallSite()).toMatch(/EPAM_MAX_TOOL_CALLS:\s*process\.env\.PRD_CHANGE_REVIEWER_MAX_TOOL_CALLS/);
  });

  it('the prompt tells the reviewer to verify before rejecting on a stack/tech claim', () => {
    const i = SRC.indexOf('const prompt = `${reviewerProfile}');
    expect(i).toBeGreaterThan(-1);
    const promptEnd = SRC.indexOf('\n\n  try {', i);
    const promptText = SRC.slice(i, promptEnd === -1 ? i + 2000 : promptEnd);
    expect(promptText, 'tools were granted but the prompt never tells the reviewer to verify ' +
      'a stack/tech claim before rejecting on that basis')
      .toMatch(/verify|do not judge.*alone/i);
  });
});
