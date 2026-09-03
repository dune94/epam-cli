#!/usr/bin/env bash
# orchestration-resume.sh — SHOULD THIS RUN PICK UP WHERE ANOTHER LEFT OFF?
#
# Extracted verbatim from run-agent-orchestration.sh, where it sat as a top-level block among that
# file's function definitions and could therefore be reached only by running the whole pipeline.
#
# What it decides is not small: a resume restores a checkpoint, works out which steps to skip, and
# then continues the run or refuses it. Three refusals guard it, and the file prices the last one —
# a resume that skips the spec pass against a PRD carrying none of its output hands the writer a
# story with nothing to aim at, measured 2026-08-10 at $11.76 and no code.
#
# PURE CODE MOVEMENT. Assignments without `local` stay global, so ORCH_RUN_ID and the exported skip
# environment reach the rest of the run exactly as before, and `exit` still exits the script.
#
# Requires from its caller: is_parent, restore_run_checkpoint, list_run_checkpoints,
# resume_skip_env, resume_spec_output_present, error/info/success, and PRD_FILE.

apply_resume_if_requested() {
    if is_parent && [ -n "${EPAM_RESUME_RUN:-}" ]; then
        # The roster and its briefs are stored against the run that minted them, so a resumed run
        # must BE that run — otherwise the store reads as another run's and is not re-applied.
        export ORCH_RUN_ID="$EPAM_RESUME_RUN"
    
        if ! restore_run_checkpoint "$EPAM_RESUME_RUN"; then
            error "[orch] cannot resume run '${EPAM_RESUME_RUN}' — refusing to continue against un-restored state."
            error "[orch] available checkpoints: $(list_run_checkpoints | tr '\n' ' ' 2>/dev/null || echo none)"
            exit 1
        fi
    
        if ! _resume_env=$(resume_skip_env "$EPAM_RESUME_RUN"); then
            error "[orch] cannot determine what to skip for run '${EPAM_RESUME_RUN}' — refusing to guess."
            exit 1
        fi
        while IFS= read -r _assign; do
            [ -n "$_assign" ] || continue
            export "${_assign?}"
            info "[orch]   resume: ${_assign}"
        done <<< "$_resume_env"
        # Skipping the spec pass is only safe while its output still exists. restore_run_checkpoint
        # and resume_skip_env both refuse rather than guess; this is the third case and was the
        # silent one. Gated on the skip actually being in force — a resume that is about to RUN the
        # spec pass has nothing to protect.
        if [ "${EPAM_SPEC_MODE:-1}" = "0" ] && ! resume_spec_output_present "$PRD_FILE"; then
            error "[orch] resume '${EPAM_RESUME_RUN}' skips the spec pass (EPAM_SPEC_MODE=0), but the PRD"
            error "[orch] at ${PRD_FILE} carries none of its output — no fixSiteAnalysis, no"
            error "[orch] verificationCriteria, no declared files, no specification block."
            error "[orch] Something overwrote the PRD after the spec pass ran. Running now would hand the"
            error "[orch] writer a story with nothing to aim at — measured 2026-08-10 at \$11.76 and no code."
            error "[orch] Recover with ONE of:"
            error "[orch]   - restore the PRD that carries the spec (git, or a run archive), then resume again"
            error "[orch]   - re-run the spec pass for this run: EPAM_SPEC_MODE=1 with the same EPAM_RESUME_RUN"
            exit 1
        fi
        success "[orch] RESUMED run ${EPAM_RESUME_RUN} — continuing from its checkpoint"
    fi
}
