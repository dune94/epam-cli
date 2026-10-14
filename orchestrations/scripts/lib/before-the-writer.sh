#!/usr/bin/env bash
# before-the-writer.sh — the steps every lane passes before its writer starts. Sourced by
# run-agent-orchestration.sh; PRD_FILE, PHASE, ORCH_RUN_ID and the step helpers are in scope as they
# are for the main lane. Moved out of the main, which defines nothing but its entrypoint.

# before_the_writer <stories> — THE STEPS EVERY LANE PASSES BEFORE ITS WRITER STARTS: the spec review
# must have cleared, the pre-writer checkpoint is saved, and pause 2 stops the run when it is set.
# One definition for the main lane and the worktree lanes — a brownfield story runs in a worktree
# lane (2026-10-02), and pause 2 must hold there too: a writer never starts unattended.
before_the_writer() {
    local non_review_main="${1:-}"
        # ── Gate: the specification review must have cleared these stories ───
        # The reviewer runs with filesystem access and checks each manifest against the
        # repository. Live 2026-08-04 it returned needs_review on all three lanes — two of
        # which had a manifest naming a file that does not exist — and the pipeline went
        # straight to implementation, because the only verdict the code branched on was
        # 'fail' and the schema never emits it. Enforced here, before the writer spends
        # anything. SPEC_REVIEW_ENFORCE=0 overrides deliberately.
        if ! spec_review_gate "$PRD_FILE"; then
            error "[orch] Halting phase '${PHASE}' before implementation — the spec review did not clear."
            exit 1
        fi

        # ── Checkpoint / pause: PRE-WRITER ───────────────────────────────────
        # Everything the writer consumes is settled by now — the spec pass, the CPA
        # pre-pass, the skill assessment and the detective have all run and written
        # their output into the PRD. This is the last point at which those inputs can
        # be inspected before any code is generated. Saved unconditionally: an artefact
        # that exists only in memory is a project violation.
        if _ckpt_path=$(save_run_checkpoint "$PHASE" pre-writer 2>&1); then
            info "[orch] pre-writer checkpoint saved: ${_ckpt_path}"
            # THE PLAN OF RECORD — the plan as it stands at pause 2, written once (lib/plan-of-record.sh).
            declare -F record_plan_of_record >/dev/null 2>&1 || . "$SCRIPT_DIR/lib/plan-of-record.sh"
            record_plan_of_record "$PRD_FILE"
        else
            warning "[orch] could not save the pre-writer checkpoint: ${_ckpt_path}"
        fi
        if should_pause_before_writer; then
            echo ""
            echo -e "${GREEN}╔════════════════════════════════════════════════════════════════════╗${NC}"
            echo -e "${GREEN}║  PAUSED — inputs ready, writer NOT started                         ║${NC}"
            echo -e "${GREEN}╚════════════════════════════════════════════════════════════════════╝${NC}"
            echo ""
            echo -e "  RUN NUMBER:  ${GREEN}${ORCH_RUN_ID}${NC}"
            echo -e "  Phase:       ${PHASE}"
            echo -e "  Stories:     $(printf '%s\n' "$non_review_main" | awk 'NF{n++} END{print n+0}') queued for the writer"
            echo -e "  Artefacts:   ${_ckpt_path:-<not saved>}"
            echo ""
            echo -e "  Resume implementation with:"
            echo -e "    ${GREEN}EPAM_RESUME_RUN=${ORCH_RUN_ID}${NC} <your launcher>"
            echo ""
            step_emit "8" "skip" "Step 8: Main-branch stories" "paused before the writer (EPAM_PAUSE_BEFORE_WRITER)"
            record_run_pause pre-writer
            exit 0
        fi
}
