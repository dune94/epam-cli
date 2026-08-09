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
    # THE PARENT IS NOT A LANE, AND MUST NOT BE MISTAKEN FOR ONE.
    #
    # The fallback below matches project.outputDir against outputDirs[] — and the synthesizer
    # sets project.outputDir = outputDirs[0].path, so the PARENT resolved to codeline[0]. The
    # post-roster checkpoint (saved by the parent, before any lane exists) was written to
    # runs/<id>/lanes/<first-codeline>/checkpoint, and the parent's resume then looked in
    # runs/<id>/checkpoint, found nothing, and refused to continue. Live 2026-08-08.
    #
    # Identical to the control-plane port defect fixed the same day: any function that infers
    # "which lane am I" from the PRD resolves the parent to codeline[0]. The role is derived in
    # exactly one place, so ask that, and only fall through to inference inside a lane.
    if declare -F is_parent >/dev/null 2>&1 && is_parent; then
        printf ''
        return 0
    fi
    local _l="${CODELINE_NAME:-${EPAM_CODELINE:-}}"
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
CHECKPOINT_STAGES="post-roster post-spec pre-writer"

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

# The TWO pause settings.
#
# EPAM_PAUSE_BEFORE_WRITER stops the run after the spec pass, CPA pre-pass, skill
# assessment and detective have all completed, and before any story is written:
# everything the writer consumes is settled and inspectable, and no code exists yet.
#
# EPAM_PAUSE_AFTER_AGENT_MINT stops earlier still — after the project's agent roster has
# been minted and every story assigned a role, and BEFORE the spec phase runs. This exists
# because the roster is now derived per project rather than inherited: which roles were
# minted, how they were briefed, and which story each one owns are decisions that shape
# every later stage, and they are cheap to correct here and expensive to correct after the
# spec pass has built on them. Operator direction, 2026-08-07: assess the agents and look
# for gaps before proceeding into spec.
#
# This file previously stated there was deliberately no second pause point, on the grounds
# that an earlier checkpoint holds none of what the writer consumes. That reasoning still
# holds for the WRITER — and the roster pause is not about the writer. It is about the
# agents themselves, which did not used to be generated at all.
should_pause_before_writer() {
    is_truthy "${EPAM_PAUSE_BEFORE_WRITER:-}"
}

should_pause_after_agent_mint() {
    is_truthy "${EPAM_PAUSE_AFTER_AGENT_MINT:-}"
}

# resume_skip_env <run-id> — emit the env assignments a resume must apply, derived from
# the stage the checkpoint was actually taken at. Skipping too little wastes the pause;
# skipping too much silently drops work that was never done.
# _stage_rank <stage> — how far a stage is through the run. Higher is further.
_stage_rank() {
    case "${1:-}" in
        post-roster) echo 1 ;;
        post-spec)   echo 2 ;;
        pre-writer)  echo 3 ;;
        *)           echo 0 ;;
    esac
}

# run_stage <run-id> — how far the RUN got, derived from its lanes.
#
# THE STAGE IS RECORDED PER LANE AND READ BY THE PARENT. checkpoint_dir() resolves per lane
# (2026-08-03, after three codelines overwrote one another), so `save_run_checkpoint pre-writer`
# — which runs inside a lane — writes to runs/<id>/lanes/<codeline>/checkpoint, while the
# parent's post-roster save goes to runs/<id>/checkpoint. resume_skip_env runs in the PARENT and
# only ever read the parent's file, so a multi-codeline run resumed at post-roster and replayed
# the whole spec pass. Live 2026-08-09: ~50 minutes per resume, and it REGENERATED the specs the
# operator had just approved at pause 2 — the writer would have built against artefacts nobody
# reviewed.
#
# The run is as far along as its LEAST advanced lane, the same way a spanning story is complete
# only when no lane is outstanding. That is what makes skipping safe: a lane that never ran its
# spec pass can never be skipped past it. The parent's own stage is a floor, never lowered by a
# stale lane.
run_stage() {
    local _rid="${1:-}"
    local _base="${EPAM_PROJECT_CONFIG_DIR:-${PROJECT_CONFIG_DIR:-}}"
    [ -n "$_base" ] && [ -n "$_rid" ] || return 1

    local _parent="$_base/runs/$_rid/checkpoint/checkpoint.json"
    local _stage="" _rank=0
    if [ -f "$_parent" ]; then
        _stage=$(jq -r '.stage // empty' "$_parent" 2>/dev/null)
        _rank=$(_stage_rank "$_stage")
    fi

    # Lanes, if this run has any. The minimum across them is the run's progress.
    local _lane_min="" _lane_min_rank=99 _seen=0 _f _ls _lr
    for _f in "$_base/runs/$_rid"/lanes/*/checkpoint/checkpoint.json; do
        [ -f "$_f" ] || continue
        _seen=1
        _ls=$(jq -r '.stage // empty' "$_f" 2>/dev/null)
        _lr=$(_stage_rank "$_ls")
        if [ "$_lr" -lt "$_lane_min_rank" ]; then _lane_min_rank=$_lr; _lane_min="$_ls"; fi
    done

    if [ "$_seen" = "1" ] && [ "$_lane_min_rank" -gt "$_rank" ]; then
        _stage="$_lane_min"
    fi
    [ -n "$_stage" ] || return 1
    printf '%s' "$_stage"
}

resume_skip_env() {
    local _rid="${1:-}"
    local _dir; _dir=$(checkpoint_dir "$_rid") || return 1
    # PARENT ONLY. Inside a lane the lane's OWN stage governs: a lane at post-spec must not be
    # told to skip the CPA it never ran because a sibling reached pre-writer. Deriving from all
    # lanes answers the parent's question — "how far did the RUN get" — and only the parent asks
    # it, before any lane exists.
    local _stage=""
    if declare -F is_parent >/dev/null 2>&1 && is_parent; then
        _stage=$(run_stage "$_rid" 2>/dev/null) || _stage=""
    fi
    if [ -z "$_stage" ]; then
        [ -f "$_dir/checkpoint.json" ] || {
            echo "[checkpoint] no checkpoint for run '${_rid}'" >&2; return 1; }
        _stage=$(jq -r '.stage // empty' "$_dir/checkpoint.json" 2>/dev/null)
    fi
    case "$_stage" in
        post-roster)
            # The roster and the assignments are on disk and the mint is not repeated —
            # re-minting would propose against an already-minted roster and the merge is
            # additive, so a resume would accumulate near-duplicate roles.
            echo "EPAM_SKIP_AGENT_MINT=1"
            echo "EPAM_SKIP_JIRA_INGEST=1"
            ;;
        post-spec)
            echo "EPAM_SPEC_MODE=0"
            echo "EPAM_SKIP_AGENT_MINT=1"
            echo "EPAM_SKIP_JIRA_INGEST=1"
            ;;
        pre-writer)
            echo "EPAM_SPEC_MODE=0"
            echo "EPAM_SKIP_AGENT_MINT=1"
            echo "SKIP_CPA=1"
            echo "SKIP_SKILL_ASSESSMENT=1"
            echo "EPAM_SKIP_JIRA_INGEST=1"
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

    # A RESTORE NEVER MOVES THE PRD BACKWARDS.
    #
    # The parent's checkpoint PRD is frozen at post-roster — saved before the spec pass, because
    # `save_run_checkpoint pre-writer` only ever runs inside a lane. Copying it over PRD_FILE on
    # every resume destroys exactly what the resume exists to preserve. Live 2026-08-09 it turned
    # the merged three-lane canonical (13 verification criteria, 14 fix sites) into 0 and 0, and
    # blanked a lane's work-dir PRD as well.
    #
    # Before the skip was fixed the loss was masked: the spec pass re-ran and refilled what
    # restore had emptied, at the cost of ~50 minutes and artefacts nobody had reviewed. With the
    # skip correct, restoring backwards hands the writer an empty plan instead.
    #
    # Measured from the artefacts, not from stage bookkeeping, so it holds even when the stages
    # are wrong — which is how this got here.
    local _live_spec=0 _ckpt_spec=0
    if [ -f "$PRD_FILE" ]; then
        _live_spec=$(jq '[.stories[]? | ((.verificationCriteria // []) | length) + ((.fixSiteAnalysis // []) | length)] | add // 0' "$PRD_FILE" 2>/dev/null || echo 0)
    fi
    _ckpt_spec=$(jq '[.stories[]? | ((.verificationCriteria // []) | length) + ((.fixSiteAnalysis // []) | length)] | add // 0' "$_dir/prd.json" 2>/dev/null || echo 0)
    if [ "${_live_spec:-0}" -gt "${_ckpt_spec:-0}" ]; then
        echo "[checkpoint] KEEPING the PRD on disk: it carries ${_live_spec} spec item(s) and the checkpoint carries ${_ckpt_spec} — restoring would discard the spec pass this resume is meant to skip past" >&2
    else
        cp "$_dir/prd.json" "$PRD_FILE" || return 1
    fi
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
