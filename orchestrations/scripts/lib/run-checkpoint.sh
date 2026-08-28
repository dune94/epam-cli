#!/usr/bin/env bash

# Modes are declared once, in config/run-modes.json — see lib/run-modes.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-modes.sh"
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
# A PAUSE THE RUN HAS ALREADY BEEN THROUGH MUST NOT FIRE AGAIN.
#
# The settings live in the project's config.env, so they are set for EVERY run of that project --
# including the resume whose whole purpose is to continue PAST the pause the operator just reviewed.
# Read as a bare env check, pause 1 was a trap with no exit: resume, re-pause, resume, re-pause.
#
# It went unnoticed because the pause used `return` where it meant `exit`, so the resume "continued"
# by accident. Fixing the halt turned an accident that behaved correctly into a stall that could not.
#
# Skipping too little wastes the pause; skipping too much silently drops work that was never done --
# so the test is the stage the resumed run actually REACHED, ranked by _stage_rank, against the stage
# this pause guards. An unknown or unreadable stage ranks 0 and so skips NOTHING: a failed lookup
# must never be the reason a human review point is bypassed.
#
# _pause_already_passed <stage-this-pause-guards>
_pause_already_passed() {
    local _guards="${1:-}"
    # The SNAPSHOT, not a fresh reading. EPAM_RESUMED_FROM_STAGE is published by resume_skip_env at
    # startup and inherited by every lane; a fresh run never sets it, so nothing is ever skipped.
    # Re-deriving here is the trap described above: the run would test state it had just written.
    local _reached="${EPAM_RESUMED_FROM_STAGE:-}"
    [ -n "$_reached" ] || return 1
    [ "$(_stage_rank "${_reached}")" -ge "$(_stage_rank "${_guards}")" ]
}

# The stage each pause guards is the SAME string it hands save_run_checkpoint at that point, which is
# what makes the comparison meaningful rather than a second, drifting spelling of the same fact.
should_pause_before_writer() {
    is_truthy "${EPAM_PAUSE_BEFORE_WRITER:-}" && ! _pause_already_passed pre-writer
}

should_pause_after_agent_mint() {
    is_truthy "${EPAM_PAUSE_AFTER_AGENT_MINT:-}" && ! _pause_already_passed post-roster
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

    # THE STAGE NAMES A MODE; THE MODE DECLARES THE SKIPS. Both used to be hand-listed here, and
    # the lists had already drifted: pre-writer omitted the regression guard, so a resume at the
    # writer re-ran the whole existing suite to rebuild a baseline it did not need. One
    # declaration (config/run-modes.json), read by the checkpoint and by EPAM_RUN_MODE alike.
    local _mode=""
    case "$_stage" in
        post-roster) _mode="post-roster" ;;
        post-spec)   _mode="post-spec" ;;
        pre-writer)  _mode="writer-only" ;;
        *)
            echo "[checkpoint] checkpoint for run '${_rid}' records an unrecognised stage '${_stage}' — refusing to guess which steps to skip" >&2
            return 1
            ;;
    esac
    # THE STAGE THIS RESUME STARTED FROM, published once so the pauses can compare against it.
    #
    # It cannot be re-derived later: pause 2 saves the pre-writer checkpoint and then asks whether
    # the run has already passed pre-writer, so a live read answers with the file it wrote three
    # lines earlier and the pause skips itself. Free rehearsal, 2026-08-28 — it went into the writer
    # unattended, which is the one thing that pause exists to prevent.
    #
    # Emitted here because this runs ONCE, in the parent, before any lane exists.
    echo "EPAM_RESUMED_FROM_STAGE=${_stage}"
    run_mode_env "$_mode"
}

# save_run_checkpoint <phase> [stage]
#
# Persist everything a resume needs. Writes are staged into the final directory and the
# metadata file is written LAST, so a checkpoint that advertises itself as complete
# always has its payload already on disk. Saving again later in the same run overwrites
# the earlier checkpoint and advances its recorded stage — the newest one is the most
# valuable, because it has paid for the most.
# THE FILES THE OPERATOR MAY EDIT AT A PAUSE — declared once, read by everyone who needs them.
#
# Pause 1 prints these under "Inspect and EDIT if needed" and promises the resume will not write
# over the changes. The checkpoint has to keep them for that promise to be checkable: without a copy
# there is no before to compare against and nothing to restore from, so "your edits survived" can be
# asserted but never shown. Found 2026-08-28, on a rehearsal, when an assignments file changed
# across a resume and the change could not be characterised.
#
# One declaration because two hand-kept lists drift -- resume_skip_env, in this same file, carries
# the comment about the last time that happened here.
#
# Emits: <path>\t<what it is>, one per line. Callers filter for existence; a file that a given
# stage has not produced yet is not an error.
#
#   operator_reviewable_inputs [prd-path]
operator_reviewable_inputs() {
    local _cfg="${EPAM_PROJECT_CONFIG_DIR:-${EPAM_AGENTS_DIR:-}}"
    local _prd="${1:-${PRD_FILE:-}}"
    [ -n "${EPAM_AGENTS_DIR:-}" ] && printf '%s\t%s\n' \
        "${EPAM_AGENTS_DIR}/profiles.json" "each role's brief"
    if [ -n "$_cfg" ]; then
        printf '%s\t%s\n' "${_cfg}/project-roles.json" "implementers — may author code"
        printf '%s\t%s\n' "${_cfg}/project-investigators.json" "investigators — read-only"
    fi
    [ -n "$_prd" ] && printf '%s\t%s\n' "$_prd" "each story's agentRole"
    return 0
}

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

    # THE REVIEWABLE FILES, KEPT VERBATIM. Required, not forensic: this is the copy that makes an
    # operator's edit at the pause recoverable if a later stage writes over it.
    mkdir -p "$_dir/reviewed" || return 1
    local _rp _rd
    while IFS=$'\t' read -r _rp _rd; do
        [ -n "$_rp" ] && [ -f "$_rp" ] || continue
        cp "$_rp" "$_dir/reviewed/$(basename "$_rp")" || return 1
    done < <(operator_reviewable_inputs)

    # Best-effort extras: useful for forensics, never required for a resume.
    # role-assignments.json is here because the resume REWRITES it in place (annotating each entry
    # "pre-assigned (validated, not regenerated)"), and without the before there is no way to show
    # the validation preserved what the operator set.
    if [ -n "${LOG_DIR:-}" ] && [ -d "${LOG_DIR}" ]; then
        [ -f "$LOG_DIR/role-assignments.json" ] \
            && cp "$LOG_DIR/role-assignments.json" "$_dir/reviewed/role-assignments.json" 2>/dev/null || true
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
# The merge and count programs live in files: a multi-line jq literal inside this function broke
# the parser, and a one-line version would be unreadable.
_CKPT_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_CKPT_MERGE_JQ="$_CKPT_LIB_DIR/jq/checkpoint-merge.jq"
_CKPT_SPEC_JQ="$_CKPT_LIB_DIR/jq/checkpoint-spec-count.jq"

# _operator_edited <live-file> <copy-handed-to-the-operator>
#
# True when the live file differs from the bytes the pause presented -- that is, a human changed it
# at the review point. A byte comparison, not a heuristic: reviewed/ holds exactly what was shown.
#
# Everything the pause offers for editing is offered because changing it is the POINT of stopping,
# so a difference here outranks a copy the run took before the human had looked at it.
_operator_edited() {
    local _live="${1:-}" _shown="${2:-}"
    [ -n "$_live" ] && [ -f "$_live" ] || return 1
    [ -n "$_shown" ] && [ -f "$_shown" ] || return 1   # nothing was shown: nothing to have edited
    ! cmp -s "$_live" "$_shown"
}

restore_run_checkpoint() {
    local _rid="${1:-}"
    if [ -z "$_rid" ]; then
        echo "[checkpoint] restore requires a run id" >&2
        return 1
    fi
    local _dir; _dir=$(checkpoint_dir "$_rid") || return 1

    # THE ONLY CHECKPOINT MOST RUNS SAVE IS A LANE ONE.
    #
    # Of the two save sites, post-roster is guarded by should_pause_after_agent_mint, and post-spec
    # — the one whose comment says "buys a resumable run" — executes INSIDE the lane, so it writes
    # to runs/<id>/lanes/<lane>/checkpoint. A project that does not pause produces lane checkpoints
    # and nothing else, while this restore looked only at runs/<id>/checkpoint and refused.
    #
    # Live 2026-08-18: run 20260818T101809Z had both lanes checkpointed pre-writer, with the spec
    # pass's whole output on disk, and had to be repeated from zero — about 50 minutes of mint and
    # spec — to retry the writer. So the parent reads the lane checkpoints rather than demanding a
    # file the design does not produce at that stage. Everything below is unchanged: the same
    # validity checks, and the same rule that a restore never moves the PRD backwards.
    local _base_runs; _base_runs=$(dirname "$_dir")
    if [ ! -d "$_dir" ]; then
        # EVERY LANE, MERGED. A lane checkpoints only ITS OWN story, so taking the richest
        # single lane would hand the other lane a PRD with nothing in it. Merged by story id,
        # each story keeping the copy that carries the most spec output.
        local _lanes_glob _lane_dir _merged _lane_count=0 _tmp _meta=""
        _lanes_glob="${_base_runs}/lanes"
        _merged=$(mktemp "${TMPDIR:-/tmp}/ckpt-merge-XXXXXX.json")
        for _lane_dir in "$_lanes_glob"/*/checkpoint; do
            [ -f "$_lane_dir/prd.json" ] || continue
            jq -e . "$_lane_dir/prd.json" >/dev/null 2>&1 || continue
            _lane_count=$((_lane_count + 1))
            [ -z "$_meta" ] && [ -f "$_lane_dir/checkpoint.json" ] && _meta="$_lane_dir/checkpoint.json"
            if [ "$_lane_count" -eq 1 ]; then
                cp "$_lane_dir/prd.json" "$_merged"
                continue
            fi
            _tmp=$(mktemp "${TMPDIR:-/tmp}/ckpt-merge-XXXXXX.json")
            if jq -s -f "$_CKPT_MERGE_JQ" "$_merged" "$_lane_dir/prd.json" > "$_tmp" 2>/dev/null && [ -s "$_tmp" ]; then
                mv "$_tmp" "$_merged"
            else
                rm -f "$_tmp" "$_merged"
                echo "[checkpoint] could not merge the lane checkpoint at $_lane_dir — refusing a partial resume" >&2
                return 1
            fi
        done
        if [ "$_lane_count" -gt 0 ]; then
            local _n_stories _n_spec
            _n_stories=$(jq '(.stories // []) | length' "$_merged" 2>/dev/null || echo 0)
            _n_spec=$(jq -f "$_CKPT_SPEC_JQ" "$_merged" 2>/dev/null || echo 0)
            echo "[checkpoint] no parent checkpoint for run '$_rid' — resuming from $_lane_count lane checkpoint(s): $_n_stories story(ies), $_n_spec spec item(s). Lane checkpoints are what a run that does not pause saves." >&2
            _dir=$(mktemp -d "${TMPDIR:-/tmp}/ckpt-lane-XXXXXX")
            mv "$_merged" "$_dir/prd.json"
            [ -n "$_meta" ] && cp "$_meta" "$_dir/checkpoint.json" || true
        else
            rm -f "$_merged"
            echo "[checkpoint] no checkpoint found for run '$_rid' — no parent checkpoint at $_dir and no usable lane checkpoint under $_lanes_glob" >&2
            return 1
        fi
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
    # AND A RESTORE NEVER UNDOES THE OPERATOR.
    #
    # Spec items cannot see a role reassignment: an edited PRD carries exactly as many as the
    # checkpoint, so the rule above says "not backwards -- copy" and the edit is silently gone.
    # Measured 2026-08-28 on a rehearsal: a story reassigned at pause 1 was back to its old role
    # after the resume, while the banner promised "it does not re-assign over your changes".
    local _rev="$_dir/reviewed"
    [ -d "$_rev" ] || _rev="${EPAM_PROJECT_CONFIG_DIR:-${PROJECT_CONFIG_DIR:-}}/runs/$_rid/checkpoint/reviewed"

    # AN EDIT IS A CHANGE, NOT A LOSS.
    #
    # "Different from what the operator was shown" also describes a PRD that was emptied or damaged
    # after the pause — which is the exact failure this restore exists to repair, and keeping it
    # would reintroduce that failure while fixing its opposite. An operator retunes an assignment;
    # they do not delete the story list. So an edit is honoured only while the stories survive it.
    local _live_stories=0 _kept_stories=0
    _live_stories=$(jq '(.stories // []) | length' "$PRD_FILE" 2>/dev/null || echo 0)
    _kept_stories=$(jq '(.stories // []) | length' "$_dir/prd.json" 2>/dev/null || echo 0)
    if _operator_edited "$PRD_FILE" "$_rev/prd.json" \
       && [ "${_live_stories:-0}" -ge "${_kept_stories:-0}" ]; then
        echo "[checkpoint] KEEPING the PRD on disk: it was EDITED at the pause, after this checkpoint was taken." >&2
    elif [ "${_live_spec:-0}" -gt "${_ckpt_spec:-0}" ]; then
        echo "[checkpoint] KEEPING the PRD on disk: it carries ${_live_spec} spec item(s) and the checkpoint carries ${_ckpt_spec} — restoring would discard the spec pass this resume is meant to skip past" >&2
    else
        cp "$_dir/prd.json" "$PRD_FILE" || return 1
    fi
    if [ -f "$_dir/profiles.json" ] && [ -n "${AGENT_PROFILES_FILE:-}" ]; then
        if _operator_edited "$AGENT_PROFILES_FILE" "$_rev/profiles.json"; then
            echo "[checkpoint] KEEPING the roster on disk: it was EDITED at the pause." >&2
        else
            cp "$_dir/profiles.json" "$AGENT_PROFILES_FILE" || return 1
        fi
    fi

    # COUNTED FROM THE PRD BEING RESTORED, not from the metadata. A merged lane restore carries
    # every lane's stories while any single lane's checkpoint.json records only its own, so the
    # metadata count would under-report exactly what the merge exists to fix.
    echo "[checkpoint] resumed run '$_rid' — $(jq -r '(.stories // []) | length' "$_dir/prd.json" 2>/dev/null) story(ies), taken at $(jq -r '.createdAt // "?"' "$_dir/checkpoint.json" 2>/dev/null)"
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
