/**
 * Severe live-run defect (2026-07-03, run #7): Step 0.9's prd-model-
 * coordinator agent has tool access (AI_GATE_ALLOW_TOOLS=1) and can write
 * the PRD directly via WriteFile — but the reviewer/revert gate only ran
 * `if [ "${_mc_assigned_count:-0}" -gt 0 ]`, gated on the agent's OWN
 * self-reported JSON summary. When the agent silently mutated the PRD
 * (in this case, splitting SKY-001 and cascading into ~27 nonsensical
 * split-story IDs) while reporting "no assignments made", the gate never
 * even looked at the file — no reviewer call, no revert. The corruption
 * was never caught until manual inspection.
 *
 * Fix: gate on whether the PRD FILE actually changed (before vs after
 * snapshot comparison), OR the self-reported count — whichever is true.
 * A self-report of 0 can no longer mask a real file mutation.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');

describe('Step 0.9 — PRD mutation is gated on actual file diff, not self-reported count', () => {
  it('captures _mc_prd_after unconditionally (not only inside the assigned_count>0 branch)', () => {
    const countIdx = orchSrc.indexOf('_mc_assigned_count=$(echo "$_mc_result"');
    const afterIdx = orchSrc.indexOf('_mc_prd_after=$(cat "$_mc_prd_target"', countIdx);
    const gateIdx = orchSrc.indexOf('if [ "${_mc_assigned_count:-0}" -gt 0 ]', countIdx);
    expect(afterIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(-1);
    // The after-snapshot must be taken BEFORE the gate condition is evaluated,
    // so the diff-comparison in the gate itself has data to compare against.
    expect(afterIdx).toBeLessThan(gateIdx);
  });

  it('the gate condition ORs in a before/after file diff check, not just assigned_count', () => {
    const gateIdx = orchSrc.indexOf('if [ "${_mc_assigned_count:-0}" -gt 0 ]');
    const gateLine = orchSrc.slice(gateIdx, orchSrc.indexOf('\n', gateIdx));
    expect(gateLine).toMatch(/\|\|/);
    expect(gateLine).toMatch(/"\$_mc_prd_before" != "\$_mc_prd_after"/);
  });

  it('reaches the (now-deterministic) reviewer gate even when assigned_count is 0, as long as the file changed', () => {
    const gateIdx = orchSrc.indexOf('if [ "${_mc_assigned_count:-0}" -gt 0 ]');
    const block = orchSrc.slice(gateIdx, gateIdx + 4000);
    // The reviewer gate was replaced (2026-07-09) with a deterministic
    // Python diff — see prd-model-coordinator-deterministic-reviewer.test.ts
    // — because the old LLM call fed only the last 1000 characters of the
    // PRD as a text excerpt, structurally blind to a change anywhere else
    // in a real multi-KB file.
    expect(block).toMatch(/ALLOWED_FIELDS = \{'model', 'aiProvider', 'reasoningEffort'\}/);
    expect(block).toMatch(/REJECTED by reviewer — reverting PRD/);
  });

  it('documents the root cause in an adjacent comment (agent tool access can bypass self-reporting)', () => {
    const gateIdx = orchSrc.indexOf('if [ "${_mc_assigned_count:-0}" -gt 0 ]');
    const before = orchSrc.slice(Math.max(0, gateIdx - 900), gateIdx);
    expect(before).toMatch(/AI_GATE_ALLOW_TOOLS/);
    expect(before).toMatch(/silently split/i);
  });
});
