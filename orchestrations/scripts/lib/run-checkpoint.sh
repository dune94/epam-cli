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

# WHICH LANE AM I? A story may SPAN codelines and every lane of a run shares one
# ORCH_RUN_ID, so a checkpoint keyed on the run id alone is shared by all of them. The
# orchestrator does not export the lane name (it is a local in the lane loop); the only
# per-lane signal written is project.outputDir, recovered by matching it back against
# project.outputDirs[] — the same derivation claude.sh's _current_lane() uses.
_checkpoint_lane() {
    local _l="${CODELINE_NAME:-}"
    if [ -z "$_l" ] && [ -n "${PRD_FILE:-}" ] && [ -f "${PRD_FILE}" ]; then
        _l=$(jq -r '.project as $p | (($p.outputDirs // []) | map(select(.path == $p.outputDir)) | .[0].codeline) // empty' \
            "$PRD_FILE" 2>/dev/null)
    fi
    printf '%s' "$_l"
}

# Resolve the durable checkpoint directory for a run id (default: the current run).
#
# PER LANE. Live 2026-08-04, run 20260804T003327Z: this returned
# runs/<run-id>/checkpoint with no codeline in it, so all three metrolinx lanes wrote to
# one directory and overwrote each other. Two lanes reached pre-writer and a third lane's
# earlier post-spec save clobbered both, leaving one lane's stage marker on another lane's
# PRD. Resuming that would have restored a single codeline's artefacts into every lane.
#
# Single-codeline runs resolve no lane and keep the original flat path, unchanged.
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
    local _lane; _lane=$(_checkpoint_lane)
    if [ -n "$_lane" ]; then
        printf '%s/runs/%s/lanes/%s/checkpoint' "$_base" "$_rid" "$_lane"
    else
        printf '%s/runs/%s/checkpoint' "$_base" "$_rid"
    fi
}

# ── Pause stages ─────────────────────────────────────────────────────────────
# Pause points are NAMED, not a growing pile of boolean flags. Each stage records how much
# of the pipeline has already been paid for, which is what a resume needs in order to skip
# exactly that much and no more.
#
#   post-spec   — after the specification pass. Cheapest place to stop.
#   pre-writer  — after the CPA pre-pass, skill assessment and detective, before ANY story
#                 is written. Everything the writer consumes is settled here, so this is
#                 the point at which its inputs can be inspected before code is generated.
#
# Keep this list and the case in resume_skip_env in step.
CHECKPOINT_STAGES="post-spec pre-writer"

# The ENGINE's commit — resolved against this library's own location, never against the
# current working directory.
#
# This used to be a bare `git rev-parse --short HEAD`, which resolves wherever the caller
# happens to be standing. A worktree lane saves its checkpoint with cwd inside the CLIENT
# codeline, so live run 20260804T152722Z recorded next.upexpress.com's HEAD (1f79748) and
# next.metrolinx.com's HEAD (42b81c44) as the "engine" version on two of three lanes —
# valid-looking short SHAs from entirely different repositories. Only the lane that
# happened to save from the engine's own cwd was right, and only by luck.
#
# engineSha exists so a resume can tell whether the engine moved underneath a checkpoint.
# A value from another repository makes that judgement impossible while looking correct.
#
# BASH_SOURCE[0] is this file, wherever it was sourced from, so the answer is the same for
# every lane and does not depend on cwd being a git repository at all.
_engine_sha() {
    local _here
    _here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)" || {
        echo "unknown"; return 0; }
    git -C "$_here" rev-parse --short HEAD 2>/dev/null || echo "unknown"
}

_is_known_stage() {
    case " $CHECKPOINT_STAGES " in *" ${1:-} "*) return 0 ;; *) return 1 ;; esac
}

# should_pause_before_writer — the ONE pause setting.
#
# EPAM_PAUSE_BEFORE_WRITER stops the run after the spec pass, CPA pre-pass, skill
# assessment and detective have all completed, and before any story is written. That is
# the only point worth stopping at: everything the writer consumes is settled and
# inspectable, and no code has been generated yet.
#
# There is deliberately no second pause point. An earlier stop (after the spec pass) has
# a checkpoint holding none of what the writer actually consumes, and two settings meant
# a run could halt somewhere the operator did not intend.
should_pause_before_writer() {
    is_truthy "${EPAM_PAUSE_BEFORE_WRITER:-}"
}

# resume_skip_env <run-id> — emit the env assignments a resume must apply, derived from
# the stage the checkpoint was actually taken at. Skipping too little wastes the pause;
# skipping too much silently drops work that was never done.
resume_skip_env() {
    local _rid="${1:-}"
    local _dir; _dir=$(checkpoint_dir "$_rid") || return 1
    [ -f "$_dir/checkpoint.json" ] || {
        echo "[checkpoint] no checkpoint for run '${_rid}'" >&2; return 1; }

    local _stage; _stage=$(jq -r '.stage // empty' "$_dir/checkpoint.json" 2>/dev/null)
    case "$_stage" in
        post-spec)
            echo "EPAM_SPEC_MODE=0"
            ;;
        pre-writer)
            echo "EPAM_SPEC_MODE=0"
            echo "SKIP_CPA=1"
            echo "SKIP_SKILL_ASSESSMENT=1"
            ;;
        *)
            echo "[checkpoint] checkpoint for run '${_rid}' records an unrecognised stage '${_stage}' — refusing to guess which steps to skip" >&2
            return 1
            ;;
    esac
    return 0
}

# save_run_checkpoint <phase> [stage]
#
# Persist everything a resume needs. Writes are staged into the final directory and the
# metadata file is written LAST, so a checkpoint that advertises itself as complete
# always has its payload already on disk. Saving again later in the same run overwrites
# the earlier checkpoint and advances its recorded stage — the newest one is the most
# valuable, because it has paid for the most.
save_run_checkpoint() {
    local _phase="${1:-${PHASE:-main}}"
    local _stage="${2:-post-spec}"
    if ! _is_known_stage "$_stage"; then
        echo "[checkpoint] refusing to save an unknown stage '${_stage}'" >&2
        return 1
    fi
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

    local _sha; _sha=$(_engine_sha)
    local _stories; _stories=$(jq -r '(.stories // []) | length' "$_dir/prd.json" 2>/dev/null || echo 0)

    # Written last — see above.
    jq -n \
        --arg runId "$_rid" \
        --arg phase "$_phase" \
        --arg stage "$_stage" \
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
    # Flat (single-codeline) and per-lane layouts both count. A multi-lane run is ONE run
    # to the operator, so the id is reported once however many lanes it has.
    for _d in "$_base"/runs/*/checkpoint "$_base"/runs/*/lanes/*/checkpoint; do
        [ -f "$_d/prd.json" ] || continue
        case "$_d" in
            */lanes/*/checkpoint) basename "$(dirname "$(dirname "$(dirname "$_d")")")" ;;
            *)                    basename "$(dirname "$_d")" ;;
        esac
    done | sort -u
    return 0
}
