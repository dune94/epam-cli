#!/usr/bin/env bash
# Run checkpoints — pause after the spec pass, resume at implementation.
#
# WHY. The spec pass is the expensive half of a run: ~12 agent calls, ~50 minutes
# observed. Today a run that reaches implementation and fails has to redo all of it,
# because the spec pass mutates the runtime PRD in place and pre-run-reset.sh clears the
# log tree at the START of every launch. There is nothing durable to resume from.
#
# STANDING RULE this implements: anything generated and not written to disc violates the
# project. So the settled artefacts are persisted the moment they settle, to a location
# teardown cannot reach.
#
# WHERE. <project-config-dir>/runs/<run-id>/checkpoint/. Deliberately NOT under LOG_DIR:
# pre-run-reset.sh empties that tree on the next launch, which is exactly how a successful
# run's evidence was destroyed on 2026-08-03.
#
# Requires from the caller: EPAM_PROJECT_CONFIG_DIR (or PROJECT_CONFIG_DIR), PRD_FILE,
# and optionally AGENT_PROFILES_FILE and ORCH_RUN_ID. Nothing here names a project,
# codeline, client or ticket key — the engine must run on the next unknown project
# unmodified.

# Resolve the durable checkpoint directory for a run id (default: the current run).
checkpoint_dir() {
    local _rid="${1:-${ORCH_RUN_ID:-}}"
    local _base="${EPAM_PROJECT_CONFIG_DIR:-${PROJECT_CONFIG_DIR:-}}"
    if [ -z "$_base" ]; then
        echo "[checkpoint] EPAM_PROJECT_CONFIG_DIR is not set — cannot locate a durable path" >&2
        return 1
    fi
    if [ -z "$_rid" ]; then
        echo "[checkpoint] no run id (ORCH_RUN_ID unset and none passed)" >&2
        return 1
    fi
    printf '%s/runs/%s/checkpoint' "$_base" "$_rid"
}

# save_run_checkpoint <phase>
#
# Persist everything a resume needs. Writes are staged into the final directory and the
# metadata file is written LAST, so a checkpoint that advertises itself as complete
# always has its payload already on disk.
save_run_checkpoint() {
    local _phase="${1:-${PHASE:-main}}"
    local _dir; _dir=$(checkpoint_dir) || return 1
    local _rid="${ORCH_RUN_ID:-}"

    mkdir -p "$_dir" || { echo "[checkpoint] cannot create $_dir" >&2; return 1; }

    if [ -z "${PRD_FILE:-}" ] || [ ! -f "${PRD_FILE}" ]; then
        echo "[checkpoint] PRD_FILE missing (${PRD_FILE:-unset}) — refusing to save a checkpoint with no PRD" >&2
        return 1
    fi
    # The PRD carries the settled stories, the manifest (technicalNotes, including any
    # per-codeline resolution) and the VCs (testCriteria) — the spec pass's whole output.
    cp "$PRD_FILE" "$_dir/prd.json" || return 1

    if [ -n "${AGENT_PROFILES_FILE:-}" ] && [ -f "${AGENT_PROFILES_FILE}" ]; then
        cp "$AGENT_PROFILES_FILE" "$_dir/profiles.json" || return 1
    fi

    # Best-effort extras: useful for forensics, never required for a resume.
    if [ -n "${LOG_DIR:-}" ] && [ -d "${LOG_DIR}" ]; then
        for _extra in story-ids-presplit.txt phase-baseline-sha.txt; do
            [ -f "$LOG_DIR/$_extra" ] && cp "$LOG_DIR/$_extra" "$_dir/$_extra" 2>/dev/null || true
        done
    fi

    local _sha; _sha=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
    local _stories; _stories=$(jq -r '(.stories // []) | length' "$_dir/prd.json" 2>/dev/null || echo 0)

    # Written last — see above.
    jq -n \
        --arg runId "$_rid" \
        --arg phase "$_phase" \
        --arg stage "post-spec" \
        --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg engineSha "$_sha" \
        --argjson storyCount "${_stories:-0}" \
        '{runId:$runId, phase:$phase, stage:$stage, createdAt:$createdAt,
          engineSha:$engineSha, storyCount:$storyCount}' \
        > "$_dir/checkpoint.json" || return 1

    printf '%s\n' "$_dir"
    return 0
}

# restore_run_checkpoint <run-id>
#
# VALIDATE FIRST, THEN WRITE. A rejected checkpoint must leave the runtime PRD untouched:
# resuming onto half-restored state would be worse than not resuming at all.
restore_run_checkpoint() {
    local _rid="${1:-}"
    if [ -z "$_rid" ]; then
        echo "[checkpoint] restore requires a run id" >&2
        return 1
    fi
    local _dir; _dir=$(checkpoint_dir "$_rid") || return 1

    if [ ! -d "$_dir" ]; then
        echo "[checkpoint] no checkpoint found for run '$_rid' (looked in $_dir)" >&2
        return 1
    fi
    if [ ! -f "$_dir/prd.json" ]; then
        echo "[checkpoint] checkpoint for run '$_rid' has no prd.json — refusing a partial resume" >&2
        return 1
    fi
    if ! jq -e . "$_dir/prd.json" >/dev/null 2>&1; then
        echo "[checkpoint] checkpoint PRD for run '$_rid' is not valid JSON — refusing to resume" >&2
        return 1
    fi
    if [ "$(jq -r '(.stories // []) | length' "$_dir/prd.json" 2>/dev/null || echo 0)" = "0" ]; then
        echo "[checkpoint] checkpoint PRD for run '$_rid' has no stories — refusing to resume" >&2
        return 1
    fi
    if [ -z "${PRD_FILE:-}" ]; then
        echo "[checkpoint] PRD_FILE is not set — nowhere to restore to" >&2
        return 1
    fi

    cp "$_dir/prd.json" "$PRD_FILE" || return 1
    if [ -f "$_dir/profiles.json" ] && [ -n "${AGENT_PROFILES_FILE:-}" ]; then
        cp "$_dir/profiles.json" "$AGENT_PROFILES_FILE" || return 1
    fi

    echo "[checkpoint] resumed run '$_rid' — $(jq -r '.storyCount // "?"' "$_dir/checkpoint.json" 2>/dev/null) story(ies), taken at $(jq -r '.createdAt // "?"' "$_dir/checkpoint.json" 2>/dev/null)"
    return 0
}

# Every run id that has a usable checkpoint, oldest first. Silent when there are none.
list_run_checkpoints() {
    local _base="${EPAM_PROJECT_CONFIG_DIR:-${PROJECT_CONFIG_DIR:-}}"
    [ -n "$_base" ] && [ -d "$_base/runs" ] || return 0
    local _d
    for _d in "$_base"/runs/*/checkpoint; do
        [ -f "$_d/prd.json" ] || continue
        basename "$(dirname "$_d")"
    done | sort
    return 0
}
