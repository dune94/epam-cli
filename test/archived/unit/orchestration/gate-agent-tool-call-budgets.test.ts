/**
 * Full agent audit, 2026-07-31: three tool-bearing gate agents held tool
 * access with no EPAM_MAX_TOOL_CALLS budget, unlike every sibling gate
 * agent that received one after a documented cost incident (team-lead-agent
 * burning 615K input tokens / 83% of a run's cost on a one-line-diff
 * review). None of the three had caused a live incident yet, but the same
 * unbounded-turn shape was already fixed once for other agents in this
 * file — closing it here proactively rather than waiting for a repeat.
 *
 * - tc-writer-agent (orchestrations/scripts/post-impl-tc-writer.sh)
 * - profile-augmentor (orchestrations/scripts/run-agent-orchestration.sh,
 *   Agent 3 of self-heal remediation)
 * - prd-model-coordinator (orchestrations/scripts/run-agent-orchestration.sh)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SRC = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
const TC_WRITER_SRC = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/post-impl-tc-writer.sh'), 'utf8');

describe('tc-writer-agent — tool-call budget', () => {
  it('sets an overridable EPAM_MAX_TOOL_CALLS on the epam run invocation', () => {
    const i = TC_WRITER_SRC.indexOf('"$EPAM_BIN" run "$TC_PROMPT"');
    expect(i, 'tc-writer invocation is gone — this is anchored to nothing').toBeGreaterThan(-1);
    const window = TC_WRITER_SRC.slice(Math.max(0, i - 300), i);
    expect(window).toMatch(/EPAM_MAX_TOOL_CALLS="\$\{TC_WRITER_MAX_TOOL_CALLS:-\d+\}"/);
  });
});

describe('profile-augmentor — tool-call budget', () => {
  it('sets an overridable EPAM_MAX_TOOL_CALLS alongside its AI_GATE_ALLOW_TOOLS grant', () => {
    const i = ORCH_SRC.indexOf('_prof_result=$(echo "$_pfa3_prompt"');
    expect(i, 'profile-augmentor invocation is gone').toBeGreaterThan(-1);
    const window = ORCH_SRC.slice(i, i + 500);
    expect(window).toMatch(/AI_GATE_ALLOW_TOOLS=1/);
    expect(window).toMatch(/EPAM_MAX_TOOL_CALLS="\$\{PROFILE_AUGMENTOR_MAX_TOOL_CALLS:-\d+\}"/);
  });
});

describe('prd-model-coordinator — tool-call budget', () => {
  it('sets an overridable EPAM_MAX_TOOL_CALLS alongside its AI_GATE_ALLOW_TOOLS grant', () => {
    const i = ORCH_SRC.indexOf('_mc_result=$(echo "$_mc_prompt"');
    expect(i, 'prd-model-coordinator invocation is gone').toBeGreaterThan(-1);
    const window = ORCH_SRC.slice(i, i + 500);
    expect(window).toMatch(/AI_GATE_ALLOW_TOOLS=1/);
    expect(window).toMatch(/EPAM_MAX_TOOL_CALLS="\$\{PRD_MODEL_COORDINATOR_MAX_TOOL_CALLS:-\d+\}"/);
  });
});
