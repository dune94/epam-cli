/**
 * Audit (2026-07-08) triggered by a live incident: spec-validator, wired
 * WITH tool access via run_orch_prompt_with_tools, still self-reported every
 * criterion as "untestable" ("unable to access the actual files... through
 * the tools provided") on one run while SAST — wired identically — used its
 * tools successfully in parallel. Investigating whether this was a wiring
 * bug turned up FOUR separate, real, previously-unnoticed wiring bugs
 * elsewhere in the pipeline: agents whose own prompts explicitly instruct
 * real file reads/writes (`jq` against the PRD, writing profiles.json,
 * running browser E2E tests, flock-appending JSONL) but were invoked via
 * plain run_orch_prompt / a bare ai-run.sh call with no AI_GATE_ALLOW_TOOLS —
 * meaning ai-run.sh's epam-umbrella branch defaulted to --no-tools, and the
 * agent had no way to do what its own prompt told it to do. It could only
 * fabricate a plausible-looking response.
 *
 * Fixed:
 *   - claude.sh run_plan_mode           (told to "Read orchestrations/prd.json")
 *   - claude.sh run_pre_phase_assessment (told to run jq + write profiles.json)
 *   - run-agent-orchestration.sh Step 0.5 pre-phase assessment (same prompt, same bug)
 *   - run-agent-orchestration.sh Step 3.5 post-parallel assessment (writes reports/PRD)
 *   - run-agent-orchestration.sh Step 0.6 hybrid pre-coordination (flock-appends JSONL)
 *   - run-agent-orchestration.sh Step 4.6 browser E2E routing (told to RUN Playwright/Lightpanda)
 *
 * This test enumerates EVERY agent invocation site in both orchestration
 * scripts and asserts each one's tool-access wiring matches what its own
 * prompt actually requires — so a future prompt change that adds a
 * file-operation instruction without updating the wiring gets caught here,
 * instead of surfacing live as a silently-hallucinated agent response.
 *
 * This only tests WIRING (a structural/mechanical fact about the source),
 * not agent behavior — an agent WITH tool access can still choose not to use
 * it (the original spec-validator incident). That's a separate, LLM-
 * reliability concern the grounding-check fixes address; this test's job is
 * narrower and fully deterministic: does the call site grant what the
 * prompt demands.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const ORCH_SH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const orchSrc = readFileSync(ORCH_SH, 'utf8');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

type Site = {
  label: string;
  src: string;
  /** Anchor text that uniquely locates the invocation line/call. */
  callAnchor: string;
  needsTools: boolean;
  /** Why this agent does or doesn't need real file/tool access. */
  reason: string;
};

const sites: Site[] = [
  // ── claude.sh ──────────────────────────────────────────────────────────
  {
    label: 'run_plan_mode (planning agent, non-SDK path)',
    src: 'claude.sh',
    callAnchor: 'bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \\\n                ${_orch_model:+--model "$_orch_model"} \\\n                > "$plan_json"',
    needsTools: true,
    reason: 'prompt explicitly says "Read orchestrations/prd.json for story ${story_id}" — no PRD content is injected as text',
  },
  {
    label: 'run_planning_phase (high-tier story planner)',
    src: 'claude.sh',
    callAnchor: 'bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \\\n                ${_orch_model:+--model "$_orch_model"} \\\n                2>/dev/null || echo "")\n        fi\n    fi\n\n    rm -f "$plan_result_file"',
    needsTools: false,
    reason: 'acceptance criteria are pre-fetched via jq and injected as text ("${ac}") — the prompt never asks the agent to read anything itself',
  },
  {
    label: 'review_and_correct_plan — plan vs. dependency-contract review',
    src: 'claude.sh',
    callAnchor: 'bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \\\n        ${ORCH_GATE_MODEL:+--model "$ORCH_GATE_MODEL"} \\\n        2>/dev/null || echo "")\n\n    # Robust JSON extraction',
    needsTools: false,
    reason: 'plan_text and dependency_contracts are both fully injected as text in the prompt — nothing left to read',
  },
  {
    label: 'review_and_correct_plan — corrective re-plan',
    src: 'claude.sh',
    callAnchor: 'bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \\\n        ${STORY_PLANNER_MODEL:+--model "$STORY_PLANNER_MODEL"} \\\n        2>/dev/null || echo "")\n\n    if [ -n "$corrected_plan" ]',
    needsTools: false,
    reason: 'original plan text + reviewer corrections are both injected inline — self-contained',
  },
  {
    label: 'assess_model_escalation (inference ladder coordinator)',
    src: 'claude.sh',
    callAnchor: 'bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \\\n            ${gate_model:+--model "$gate_model"} \\\n            2>/dev/null); then',
    needsTools: false,
    reason: 'failure evidence, log tail, test output, and cross-run history are all injected as text — no file access requested in the prompt',
  },
  {
    label: 'run_prd_change_reviewer (validates AC/TC/skill_note/profile changes)',
    src: 'claude.sh',
    callAnchor: 'bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \\\n        ${gate_model:+--model "$gate_model"} \\\n        2>/dev/null || echo \'{"verdict":"pass"',
    needsTools: false,
    reason: 'BEFORE/AFTER JSON excerpts are injected directly into the prompt — reviewer never needs to read a file itself',
  },
  {
    label: 'run_prd_change_summarizer (rewrites rejected self-heal text)',
    src: 'claude.sh',
    callAnchor: 'bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \\\n        ${gate_model:+--model "$gate_model"} \\\n        2>/dev/null | head -c "$output_cap"',
    needsTools: false,
    reason: 'the rejected text and reviewer issues are injected inline — pure text rewriting, no file access needed',
  },
  {
    label: 'run_failure_analyst (diagnoses test failures, proposes fixes)',
    src: 'claude.sh',
    callAnchor: 'bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \\\n                ${gate_model:+--model "$gate_model"} \\\n                2>>"$output_file"); then',
    needsTools: false,
    reason: 'ACs/TCs, skill addendum, and dependency contracts (ground-truth exports) are all injected as text — analyst reasons over given evidence, does not read files itself',
  },
  {
    label: 'run_pre_phase_assessment (claude.sh variant)',
    src: 'claude.sh',
    callAnchor: 'AI_GATE_ALLOW_TOOLS=1 \\\n            AI_PROVIDER="$_orch_provider" \\\n            AI_MODEL="$_orch_model" \\\n            EPAM_CLI="$EPAM_CLI" \\\n            bash "$SCRIPT_DIR/ai-run.sh" --provider "$_orch_provider" \\\n            ${_orch_model:+--model "$_orch_model"} \\\n            2>&1 | tee "$assessment_log"',
    needsTools: true,
    reason: 'prompt instructs running real jq commands against the PRD and reading/writing profiles.json directly (FIXED 2026-07-08)',
  },

  // ── run-agent-orchestration.sh ───────────────────────────────────────────
  {
    label: 'Step 0.5 pre-phase skill assessment',
    src: 'orch',
    // Anchor updated (2026-07-13): the call was wrapped in a 3-attempt
    // retry-on-violation loop — the prompt variable is now per-attempt
    // ($_pfa_prompt_this_attempt, rebuilt each iteration with a corrective
    // note on retry) and the old `if ...; then step_emit "pass"` shape
    // became `... || _pfa_call_ok=0` followed by separate violation checks.
    // Anchor updated (2026-07-22): the story_id argument ("${PHASE:-unknown}")
    // was removed — passing the phase name as story_id polluted agent-activity's
    // story_id field, breaking "stories touched" counts (a 1-story PRD showed 2
    // distinct story_id values). This call has no story_id now — it's phase-level.
    // Anchor updated (2026-07-27): the trailing `|| _pfa_call_ok=0` is gone. It
    // could never fire — the call is a PIPELINE, so its exit status is tee's,
    // which is always 0. The real status now comes from PIPESTATUS[0], and an
    // agent that exhausts its iteration cap is caught by _pfa_capability_failed.
    // See pre-assessment-capability-failure.test.ts.
    callAnchor: 'run_orch_prompt_with_tools "$_pfa_prompt_this_attempt" "team-lead-agent" 2>&1 | tee "$assessment_log"',
    needsTools: true,
    reason: 'prompt instructs jq against the PRD, profiles.json read/write, and flock JSONL appends (FIXED 2026-07-08)',
  },
  {
    label: 'Step 3.5 post-parallel assessment',
    src: 'orch',
    // Anchor updated (2026-07-12): the `if ... ; then success ...` wrapper
    // was replaced with an explicit PIPESTATUS[0] capture (this script has
    // no `set -o pipefail`, so `if cmd | tee file; then` always evaluated
    // tee's exit status, never the real tool call's -- see the
    // phase-assessment real-output-gate fix).
    // Anchor updated (2026-07-22): story_id argument removed — see the matching
    // note at Step 0.5 above.
    callAnchor: 'run_orch_prompt_with_tools "$_pa_prompt" "team-lead-agent" 2>&1 | tee "$assessment_log"',
    needsTools: true,
    reason: 'prompt instructs writing a report file, updating PRD agentRole fields, and flock JSONL appends (FIXED 2026-07-08)',
  },
  {
    label: 'Step 0.6 hybrid pre-coordination',
    src: 'orch',
    // Anchor updated (2026-07-22): story_id argument removed — see the matching
    // note at Step 0.5 above.
    callAnchor: 'run_orch_prompt_with_tools "$_hpc_prompt" "spec-coordinator" 2>&1 | tee "$coord_log"',
    needsTools: true,
    reason: 'prompt instructs reading the PRD and flock-appending real JSONL messages (FIXED 2026-07-08)',
  },
  {
    label: 'Step 0.9 PRD model coordinator',
    src: 'orch',
    callAnchor: 'AI_GATE_ALLOW_TOOLS=1 \\\n            AI_PROVIDER="${ORCH_GATE_PROVIDER:-minimax}" \\\n            AI_MODEL="${ORCH_GATE_MODEL:-MiniMax-M3}" \\\n            EPAM_DANGEROUS_SKIP_APPROVAL=1',
    needsTools: true,
    reason: 'prompt instructs writing the updated PRD back to the file',
  },
  {
    label: 'Step 4.2a SAST sentinel',
    src: 'orch',
    // Call site migrated to _run_qa_gate_with_retry (H3–H9 retry fix); tool
    // access is preserved — the helper uses AI_GATE_ALLOW_TOOLS=1 internally.
    callAnchor: '_run_qa_gate_with_retry "$sast_prompt" "qa-gate:sast"',
    needsTools: true,
    reason: 'must read changed source files to analyse them (tsc output is also injected as a bonus, but source reading still needs tools)',
  },
  {
    label: 'Step 4.2b spec-validator',
    src: 'orch',
    callAnchor: '_run_qa_gate_with_retry "$spec_prompt" "qa-gate:spec-validator"',
    needsTools: true,
    reason: 'must read package.json/tsconfig.json/etc. content to verify file-level criteria (vitest results + story ACs are injected, but file CONTENT checks still need Read)',
  },
  {
    label: 'Step 4.3a review-ranger',
    src: 'orch',
    callAnchor: '_run_qa_gate_with_retry "$review_prompt" "qa-gate:review-ranger"',
    needsTools: true,
    reason: 'must read changed source files to perform code review',
  },
  {
    label: 'Step 4.3b mutant-hunter',
    src: 'orch',
    callAnchor: '_run_qa_gate_with_retry "$mutant_prompt" "qa-gate:mutant-hunter"',
    needsTools: true,
    reason: 'must read test files and source to reason about mutation coverage',
  },
  {
    label: 'Step 4.4a fuzz-weaver',
    src: 'orch',
    callAnchor: '_run_qa_gate_with_retry "$fuzz_prompt" "qa-gate:fuzz-weaver"',
    needsTools: true,
    reason: 'must run `git diff` and read changed source files to propose fuzz cases',
  },
  {
    label: 'Step 4.4b perf-sentinel',
    src: 'orch',
    callAnchor: '_run_qa_gate_with_retry "$perf_prompt" "qa-gate:perf-sentinel"',
    needsTools: true,
    reason: 'must read changed source files to analyse algorithmic complexity/perf hotspots',
  },
  {
    label: 'Step 4.6 browser E2E routing (playwright-agent/lightpanda-agent)',
    src: 'orch',
    callAnchor: '_run_qa_gate_with_retry "$prompt" "qa-gate:e2e"',
    needsTools: true,
    reason: 'profile explicitly instructs RUNNING real Playwright/Lightpanda browser tests — impossible without Bash tool access (FIXED 2026-07-08)',
  },
  {
    label: 'gate-finding-analyst (self-heal remediation, agent 1/3)',
    src: 'orch',
    callAnchor: '_gfa_raw=$(echo "$_gfa_prompt" | \\\n                        AI_GATE_ALLOW_TOOLS=1',
    needsTools: true,
    reason: 'must re-read the gate log and PRD to ground its finding',
  },
  {
    label: 'story-ac-remediator (self-heal remediation, agent 2/3)',
    src: 'orch',
    callAnchor: '_acr_raw=$(echo "$_acr_prompt" | \\\n                        AI_PROVIDER=',
    needsTools: false,
    reason: 'FIXED 2026-07-11: previously had tool access and was instructed to write the PRD itself, but the agent narrating "I wrote the file" was never actually persisted (confirmed live) — the orchestrator now applies the agent\'s proposed ACs to the PRD deterministically from its JSON output, so no tool access is needed or granted',
  },
  {
    label: 'profile-augmentor (self-heal remediation, agent 3/3)',
    src: 'orch',
    callAnchor: '_prof_result=$(echo "$_pfa3_prompt" | \\\n                        AI_GATE_ALLOW_TOOLS=1',
    needsTools: true,
    reason: 'prompt instructs writing the updated profiles.json back to the file',
  },
  {
    label: 'profile_addendum reviewer (validates profile-augmentor\'s change)',
    src: 'orch',
    callAnchor: 'BEFORE (excerpt, last 500 chars):\n${_profiles_before: -500}',
    needsTools: false,
    reason: 'BEFORE/AFTER excerpts are injected directly into the prompt — reviewer never reads a file itself',
  },
];

describe('agent tool-access wiring — every invocation site (structural)', () => {
  it.each(sites)('$label — needsTools=$needsTools', ({ label, src, callAnchor, needsTools, reason }) => {
    const source = src === 'claude.sh' ? claudeSrc : orchSrc;
    const idx = source.indexOf(callAnchor);
    expect(idx, `anchor not found for "${label}" — source may have moved/changed:\n${callAnchor}`).toBeGreaterThan(-1);

    // Look backward up to 900 chars for either an explicit AI_GATE_ALLOW_TOOLS=1
    // or a run_orch_prompt_with_tools call wrapping this invocation.
    const windowStart = Math.max(0, idx - 900);
    const window = source.slice(windowStart, idx + callAnchor.length);
    // _run_qa_gate_with_retry is the retry-wrapping successor to run_orch_prompt_with_tools
    // for QA gate agents; it internally uses AI_GATE_ALLOW_TOOLS=1.
    const hasToolAccess = /AI_GATE_ALLOW_TOOLS=1|run_orch_prompt_with_tools|_run_qa_gate_with_retry/.test(window);

    if (needsTools) {
      expect(hasToolAccess, `"${label}" needs tool access (${reason}) but no AI_GATE_ALLOW_TOOLS=1/run_orch_prompt_with_tools found nearby`).toBe(
        true,
      );
    } else {
      // Not a hard requirement (granting tools when unneeded isn't a live bug),
      // but flags drift: if a later prompt change actually needs tools, this
      // assertion in the OPPOSITE test above should be updated to needsTools:true
      // rather than silently living with a mismatch either way.
      expect(hasToolAccess, `"${label}" is documented as NOT needing tools (${reason}) but has AI_GATE_ALLOW_TOOLS=1 nearby — if a prompt change now requires tools, update this table's needsTools flag instead of leaving it inconsistent`).toBe(
        false,
      );
    }
  });
});

describe('agent tool-access wiring — regression guards for the specific live bugs found', () => {
  it('run_plan_mode grants tool access (was silently broken — agent told to Read but had none)', () => {
    const idx = claudeSrc.indexOf('elif echo "$plan_prompt" | \\\n                AI_GATE_ALLOW_TOOLS=1');
    expect(idx).toBeGreaterThan(-1);
  });

  it('claude.sh run_pre_phase_assessment grants tool access', () => {
    const idx = claudeSrc.indexOf('elif echo "$assessment_prompt" | \\\n            AI_GATE_ALLOW_TOOLS=1');
    expect(idx).toBeGreaterThan(-1);
  });

  it('run-agent-orchestration.sh Step 0.5/3.5 assessment calls use run_orch_prompt_with_tools, not plain run_orch_prompt', () => {
    // Step 0.5's call site variable was renamed from $assessment_prompt to
    // $_pfa_prompt_this_attempt (2026-07-13) when it was wrapped in a
    // 3-attempt retry loop that appends a corrective note per attempt —
    // still run_orch_prompt_with_tools, just a per-attempt prompt variable
    // instead of the original single prompt. Step 3.5's own call site is
    // unaffected and still uses $assessment_prompt directly.
    // M5 retry fix (2026-07-19): Step 3.5 prompt var renamed from $assessment_prompt
    // to $_pa_prompt when wrapped in a 2-attempt retry loop.
    const occurrences = [
      ...orchSrc.matchAll(/run_orch_prompt(_with_tools)?\s*"\$assessment_prompt"\s*"team-lead-agent"/g),
      ...orchSrc.matchAll(/run_orch_prompt(_with_tools)?\s*"\$_pfa_prompt_this_attempt"\s*"team-lead-agent"/g),
      ...orchSrc.matchAll(/run_orch_prompt(_with_tools)?\s*"\$_pa_prompt"\s*"team-lead-agent"/g),
    ];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    for (const m of occurrences) {
      expect(m[1], 'found a plain run_orch_prompt call for the assessment agent — tool access regressed').toBe('_with_tools');
    }
  });

  it('run-agent-orchestration.sh hybrid pre-coordination uses run_orch_prompt_with_tools', () => {
    // M1 retry fix (2026-07-19): prompt var renamed from $coord_prompt to $_hpc_prompt
    expect(orchSrc).toMatch(/run_orch_prompt_with_tools "\$_hpc_prompt" "spec-coordinator"/);
    expect(orchSrc).not.toMatch(/run_orch_prompt "\$_hpc_prompt" "spec-coordinator"/);
  });

  it('run-agent-orchestration.sh browser E2E routing uses _run_qa_gate_with_retry (tool access preserved via AI_GATE_ALLOW_TOOLS=1 inside helper)', () => {
    expect(orchSrc).toMatch(/_run_qa_gate_with_retry "\$prompt" "qa-gate:e2e"/);
    // Old bare call must be gone (the helper replaced it)
    expect(orchSrc).not.toMatch(/run_orch_prompt_with_tools "\$prompt" "qa-gate:e2e"/);
  });

  it('no invocation site anywhere calls plain run_orch_prompt for a prompt that requires it (no other agent_type is missed)', () => {
    // Every remaining plain run_orch_prompt call (not _with_tools) must be one
    // of the confirmed no-tools-needed agent types from the table above.
    const knownNoToolsAgentTypes = ['spec-coordinator', 'team-lead-agent'];
    const plainCalls = [...orchSrc.matchAll(/(?<!_with_tools\s)run_orch_prompt\s+"\$[a-zA-Z_]+"\s+"([a-zA-Z0-9_:-]+)"/g)];
    for (const m of plainCalls) {
      // "assessment" and "spec-coordinator" now only appear via _with_tools
      // (already asserted above) — any surviving plain-call match here for
      // those specific labels means the fix regressed.
      expect(knownNoToolsAgentTypes).not.toContain(m[1]);
    }
  });
});
