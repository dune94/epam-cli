#!/usr/bin/env bash
# greenfield-lifecycle.sh — what a GREENFIELD run does around the orchestrator, with no project named.
#
# A greenfield project builds its codeline from nothing: the output directory is torn down and
# recreated each run, the PRD is restored from the project's authored canonical file, and the
# declared phases (scaffold, then core) run in order with pre-phase remediation and the exit-2
# self-heal retry. All of that lived in tier3-skyscanner-app-run.sh, which names its project by
# hand (project_config_dir skyscanner; the travel-app canonical path), so the second greenfield
# project — regintel, 2026-09-11 — was data with nothing able to launch it. tier3-run.sh, the
# generic launcher, read none of the greenfield declarations.
#
# Everything here is driven by the project's own config.env:
#   EPAM_BROWNFIELD=0      selects this lifecycle
#   OUTPUT_DIR             where the codeline is built (required)
#   PRD_CANONICAL          the authored PRD, repo-relative or absolute (optional; else pre-run-reset
#                          restores from prd.authored.json beside PRD_FILE)
#   EPAM_PHASES            the phases to run, in order (e.g. "scaffold core")
#
# Sourced by tier3-run.sh. The orchestrator and remediation scripts are resolved beside this
# library and are overridable (EPAM_ORCHESTRATOR_BIN, EPAM_PRD_REMEDIATE_BIN) so the lifecycle can
# be executed under test with stand-ins — the same seam AI_RUNNER_CMD provides for model calls.
# Callers provide info/success/fail, as every launcher does.

_gfl_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=phase-exit.sh
[ -f "$_gfl_dir/phase-exit.sh" ] && . "$_gfl_dir/phase-exit.sh"

# greenfield_prepare_output_dir <output_dir> <project_config_dir> <project_name>
#
# Tear down and recreate. Force write access first: node_modules from a previous install can be
# 0444/0555, and `rm -rf` needs WRITE on each containing directory, so a prior run's tree could
# silently defeat the teardown (found live; the skyscanner launcher carries the same note). Sibling
# "<dir>-wt-*" worktrees from a previous parallel phase go with it. The result is an empty git
# repository with one init commit, and .epam/ seeded with the project's manifests — the
# dependency-check, contract-generation and known-fixes declarations the run's gates read from the
# CODELINE, never from the engine.
greenfield_prepare_output_dir() {
    local out="${1:?output dir}" proj="${2:?project config dir}" name="${3:-project}"
    [ -d "$out" ] && chmod -R u+w "$out" 2>/dev/null || true
    info "Tearing down output directory: $out"
    rm -rf "$out"
    local _wt
    for _wt in "${out}-wt-"*; do
        [ -e "$_wt" ] || continue
        chmod -R u+w "$_wt" 2>/dev/null || true
        rm -rf "$_wt" && info "Removed leftover worktree: $_wt"
    done
    mkdir -p "$out"
    git -C "$out" init --quiet
    git -C "$out" -c user.email=pipeline@local -c user.name=pipeline commit --allow-empty -m "init: ${name}" --quiet
    info "Output directory clean (deleted and reinitialised)"
    mkdir -p "$out/.epam"
    local _m
    for _m in dependency-check.json contract-generation.json known-fixes.json; do
        if [ -f "$proj/$_m" ]; then
            cp "$proj/$_m" "$out/.epam/$_m"
        else
            echo "[tier3] WARNING: $_m not found in $proj — .epam/$_m NOT written" >&2
        fi
    done
}

# greenfield_restore_prd <prd_canonical> <prd_file> <repo_root>
#
# The authored PRD IS the base state; the run's own writes to PRD_FILE are discarded, not
# accumulated. A canonical that is declared and missing is a refusal: launching on whatever the
# previous run left in PRD_FILE is how stale assignments reach a fresh run.
greenfield_restore_prd() {
    local canonical="${1:?PRD_CANONICAL}" prd="${2:?PRD_FILE}" repo="${3:?repo root}"
    case "$canonical" in /*) ;; *) canonical="$repo/$canonical" ;; esac
    if [ ! -f "$canonical" ]; then
        fail "PRD_CANONICAL is declared but not found at $canonical — cannot restore a clean PRD. Aborting."
    fi
    cp "$canonical" "$prd"
    local _n; _n=$(jq '.stories | length' "$prd" 2>/dev/null || echo '?')
    info "PRD restored from canonical file ($_n base user stories)"
}

# greenfield_run_phases "<phases>" <prd_file> <log_file>
#
# Each phase: remediate the PRD for that phase, run the orchestrator with --reset, and on exit 2
# — a gate applied a remediation — remediate mid-phase and retry ONCE with the gate remediation
# skipped. Any other non-zero exit aborts: the next phase must never start on a failed one.
greenfield_run_phases() {
    local phases="${1:?phases}" prd="${2:?PRD_FILE}" log="${3:-/dev/null}"
    local orch="${EPAM_ORCHESTRATOR_BIN:-$_gfl_dir/../run-agent-orchestration.sh}"
    local rem="${EPAM_PRD_REMEDIATE_BIN:-$_gfl_dir/../prd-remediate.sh}"
    local phase
    for phase in $phases; do
        info "━━━ Phase: $phase ━━━"
        info "  Pre-phase PRD remediation..."
        if ! bash "$rem" --prd "$prd" --phase "$phase" 2>&1 | tee -a "$log"; then
            fail "PRD remediation failed for phase '$phase' — aborting. Fix the PRD before relaunching."
        fi
        local phase_exit=0
        bash "$orch" --phase "$phase" --reset 2>&1 | tee -a "$log" || phase_exit=${PIPESTATUS[0]}
        if command -v phase_exit_is_retryable >/dev/null 2>&1 && phase_exit_is_retryable "$phase_exit"; then
            info "  Self-healing: gate remediation applied — resetting and retrying phase '$phase'..."
            if ! bash "$rem" --prd "$prd" --phase "$phase" --mid-phase-retry 2>&1 | tee -a "$log"; then
                fail "PRD remediation failed during self-healing retry for phase '$phase'"
            fi
            phase_exit=0
            SKIP_GATE_REMEDIATION=1 bash "$orch" --phase "$phase" --reset 2>&1 | tee -a "$log" || phase_exit=${PIPESTATUS[0]}
            if [ "$phase_exit" -ne 0 ]; then
                fail "Phase '$phase' failed after self-healing retry (exit $phase_exit) — aborting pipeline"
            fi
            success "Self-healing retry succeeded for phase '$phase'"
            continue
        fi
        if [ "$phase_exit" -ne 0 ]; then
            fail "Phase '$phase' failed (exit $phase_exit) — aborting pipeline"
        fi
        success "Phase '$phase' completed"
    done
}
