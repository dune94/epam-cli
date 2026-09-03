/**
 * Full agent audit, 2026-07-31: gate-finding-analyst gets tool access via
 * TWO DIFFERENT mechanisms at its two call sites:
 *
 *   - lint-gate variant: calls `epam run` DIRECTLY, bypassing ai-run.sh
 *     entirely — ai-run.sh's --no-tools-by-default gating never applies,
 *     so the CLI's own default (tools ON unless --no-tools) is used.
 *   - testing-gate variant (self-heal remediation, agent 1/3): goes through
 *     ai-run.sh with an explicit AI_GATE_ALLOW_TOOLS=1.
 *
 * Both are correct today, and already covered individually (this call site
 * has no dedicated test; the testing-gate one is in agent-tool-access.test.ts
 * and agent-gate-finding-analyst.test.ts). This test exists as the
 * maintainability tripwire the audit called for: if a future refactor moves
 * the lint-gate call through ai-run.sh (e.g. for consistency with the
 * retry/cost-tracking helpers elsewhere in this file) without ALSO adding
 * AI_GATE_ALLOW_TOOLS=1, it silently loses tool access — the same class of
 * bug already fixed once for codeline-bridge-agent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORCH_SRC = readFileSync(join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

describe('gate-finding-analyst — lint-gate variant', () => {
  // Only the actual call statement, not the explanatory comment above it
  // (which deliberately mentions "ai-run.sh" in prose — matching that text
  // would be a false positive, not a real detection of this call being
  // routed through it).
  function callStatement(): string {
    const i = ORCH_SRC.indexOf('_lga_raw="$(echo "$_lga_prompt"');
    expect(i, 'lint-gate gate-finding-analyst call site is gone').toBeGreaterThan(-1);
    return ORCH_SRC.slice(i, i + 300);
  }

  it('still calls epam run directly (not through ai-run.sh, not through run_orch_prompt)', () => {
    // The --provider VALUE changed 2026-09-03 (see change-log/SEAM-CONSISTENCY-ANALYSIS.md):
    // this call used to hardcode ${ORCH_GATE_PROVIDER:-openrouter}, which bypassed
    // EPAM_PROVIDER_SET entirely — src/ has no awareness of it at all, so nothing downstream
    // caught a stale or wrong vendor the way llm-handler.sh's own resolve_primary_provider()
    // does for calls that route through it. The flag is now conditional
    // (${_gate_provider:+--provider "$_gate_provider"}, resolved just above this call) so an
    // unroutable value is corrected and an unset one omits the flag rather than passing "" —
    // but the architectural fact this test protects is unchanged: epam run direct, not ai-run.sh.
    const site = callStatement();
    expect(site).toMatch(/timeout "\$\{EPAM_GATE_TIMEOUT_SECS:-1200\}" epam run \$\{_gate_provider:\+--provider "\$_gate_provider"\}/);
    expect(site).not.toMatch(/ai-run\.sh/);
  });

  it('IF this call is ever routed through ai-run.sh, it MUST also set AI_GATE_ALLOW_TOOLS=1', () => {
    // Guards the actual failure mode, not just the current shape: if the
    // direct-epam-run pattern above is gone (meaning someone refactored this
    // call site to go through ai-run.sh), the call statement itself must
    // show AI_GATE_ALLOW_TOOLS=1, or tool access silently regresses.
    const site = callStatement();
    const routedThroughAiRun = /ai-run\.sh/.test(site);
    if (routedThroughAiRun) {
      expect(site, 'this call site was refactored to route through ai-run.sh but never ' +
        'added AI_GATE_ALLOW_TOOLS=1 — it now silently has no tool access, the same class ' +
        'of bug already fixed once for codeline-bridge-agent')
        .toMatch(/AI_GATE_ALLOW_TOOLS=1/);
    }
  });
});

describe('gate-finding-analyst — testing-gate variant (self-heal remediation, agent 1/3)', () => {
  it('goes through ai-run.sh with an explicit AI_GATE_ALLOW_TOOLS=1', () => {
    const i = ORCH_SRC.indexOf('_gfa_raw=$(echo "$_gfa_prompt" | \\\n                        AI_GATE_ALLOW_TOOLS=1');
    expect(i, 'testing-gate gate-finding-analyst tool grant is gone').toBeGreaterThan(-1);
  });
});
