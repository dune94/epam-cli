#!/usr/bin/env bash
# prd-integrity.sh — moved verbatim out of run-agent-orchestration.sh by tools/split-main-into-modules.py
# (6 functions). Sourced by run-agent-orchestration.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# Topologically sort a newline-separated list of story IDs by prd.json
# dependencies, preserving declaration order within the same tier.
# Cycles emit a warning and fall back to declaration order.
topo_sort_stories() {
    local story_list="$1"
    [ -z "$story_list" ] && return
    local _py='
import sys, json
from collections import deque
story_ids = [s for s in sys.stdin.read().strip().split("\n") if s.strip()]
if not story_ids:
    sys.exit(0)
prd_file = sys.argv[1]
try:
    with open(prd_file) as f:
        prd = json.load(f)
except Exception:
    print("\n".join(story_ids)); sys.exit(0)
story_map = {s["id"]: s for s in prd.get("stories", [])}
id_set    = set(story_ids)
# When a story depends on a deprecated parent (not in id_set), substitute its
# active split children — identified by specification.createdFrom pointing to
# the parent. This ensures stories depending on a deprecated parent run AFTER
# its replacement children without hardcoding any IDs.
split_children = {}
for s in prd.get("stories", []):
    parent_id = (s.get("specification") or {}).get("createdFrom")
    if parent_id and parent_id not in id_set and s["id"] in id_set:
        split_children.setdefault(parent_id, []).append(s["id"])
in_degree = {s: 0 for s in story_ids}
graph     = {s: [] for s in story_ids}
for sid in story_ids:
    raw_deps = story_map.get(sid, {}).get("dependencies") or []
    deps = []
    for d in raw_deps:
        if d in id_set:
            deps.append(d)
        elif d in split_children:
            deps.extend(split_children[d])
    for dep in deps:
        graph[dep].append(sid)
        in_degree[sid] += 1
queue  = deque(sorted([s for s in story_ids if in_degree[s] == 0], key=story_ids.index))
result = []
while queue:
    node = queue.popleft()
    result.append(node)
    for succ in sorted(graph[node], key=story_ids.index):
        in_degree[succ] -= 1
        if in_degree[succ] == 0:
            queue.append(succ)
if len(result) != len(story_ids):
    sys.stderr.write("WARNING: dependency cycle in story group — using declaration order\n")
    print("\n".join(story_ids))
else:
    print("\n".join(result))
'
    echo "$story_list" | python3 -c "$_py" "$PRD_FILE" 2>/dev/null || echo "$story_list"
}

# capture_story_ids_snapshot <label> — writes the current, sorted set of
# story IDs in prd.stories[] to a snapshot file named after <label>, plus the
# full story objects (used by assert_no_story_ids_lost to self-heal a loss
# instead of only detecting it — see that function's docstring).
capture_story_ids_snapshot() {
    local label="$1"
    jq -r '.stories[].id' "$PRD_FILE" 2>/dev/null | sort > "$STORY_ID_SNAPSHOT_DIR/ids-${label}.txt"
    jq -c '.stories' "$PRD_FILE" 2>/dev/null > "$STORY_ID_SNAPSHOT_DIR/stories-${label}.json"
}

# assert_no_story_ids_lost <label> <step_name> — re-reads the current story
# ID set and diffs it against the named snapshot. A GROWING set (new split
# children) is expected and not an error.
#
# Self-healing (added 2026-07-11, after this fired a SECOND time live —
# first found 2026-07-09 — on Step 0.5 wiping SKY-002/003/004 from a
# DIFFERENT phase's implementationOrder entirely): this is an intermittent
# LLM tool-use defect (the agent has raw Bash/jq PRD write access and its own
# prompt already forbids exactly this), not something a prompt tweak reliably
# prevents. Rather than hard-abort the whole pipeline every time it recurs,
# restore the exact vanished story object(s) from the full-object snapshot
# captured alongside the ID snapshot and continue. Only hard-fails (exit 1)
# if a story is missing AND wasn't in the snapshot either (nothing to
# restore from) — that shape is not self-healable and still needs a human.
assert_no_story_ids_lost() {
    local label="$1"
    local step_name="$2"
    local snapshot_file="$STORY_ID_SNAPSHOT_DIR/ids-${label}.txt"
    [ -f "$snapshot_file" ] || return 0  # no snapshot captured yet — nothing to compare
    local current_ids missing_ids
    current_ids=$(jq -r '.stories[].id' "$PRD_FILE" 2>/dev/null | sort)
    missing_ids=$(comm -23 "$snapshot_file" <(echo "$current_ids"))
    if [ -n "$missing_ids" ]; then
        local stories_snapshot="$STORY_ID_SNAPSHOT_DIR/stories-${label}.json"
        if [ -s "$stories_snapshot" ]; then
            warning "STORY-ID-LOSS after ${step_name}: restoring vanished stor(y/ies) from the pre-step snapshot instead of aborting:"
            local missing_json tmp_prd
            missing_json=$(echo "$missing_ids" | jq -R -s 'split("\n") | map(select(length > 0))')
            tmp_prd=$(mktemp)
            chmod 644 "$tmp_prd" 2>/dev/null
            if jq --argjson missing "$missing_json" --slurpfile snap "$stories_snapshot" \
                '.stories += ($snap[0] | map(select(.id as $i | $missing | index($i) != null)))' \
                "$PRD_FILE" > "$tmp_prd" 2>/dev/null && jq empty "$tmp_prd" 2>/dev/null; then
                mv "$tmp_prd" "$PRD_FILE"
                while IFS= read -r _mid; do
                    [ -n "$_mid" ] && warning "    - restored: $_mid"
                done <<< "$missing_ids"
                current_ids=$(jq -r '.stories[].id' "$PRD_FILE" 2>/dev/null | sort)
                missing_ids=$(comm -23 "$snapshot_file" <(echo "$current_ids"))
            else
                rm -f "$tmp_prd"
            fi
        fi
    fi
    if [ -n "$missing_ids" ]; then
        error "STORY-ID-LOSS INVARIANT VIOLATED after ${step_name}: the following stor(y/ies) vanished entirely from prd.stories[] and could not be restored:"
        while IFS= read -r _mid; do
            [ -n "$_mid" ] && error "    - $_mid"
        done <<< "$missing_ids"
        error "  This step has full tool-write access to the PRD but is only permitted to ADD"
        error "  to profiles.json or change agentRole/model/aiProvider/reasoningEffort fields."
        error "  Check the agent's own transcript for this step's assessment/coordinator log."
        exit 1
    fi
}

# assert_no_story_ids_gained <label> <step_name> — companion to
# assert_no_story_ids_lost, for steps that must NEVER add a brand-new
# top-level story (unlike Step 0/spec-pass, whose whole job is to grow the
# story set via legitimate splits — that step is what the "presplit"
# snapshot is taken AFTER, precisely so growth from spec-pass itself is
# never flagged here).
#
# Root cause this guards against (found live, 2026-07-10, tier3-travel-app
# run): 6 entirely fabricated stories (SKY-005 through SKY-010 — an HTML
# dashboard story, three "comprehensive test suite" stories, a code-review/
# security-audit story, a mutation-testing story) appeared in prd.stories[]
# between the Step 0.1 CPA pre-pass snapshot and the end of Step 0.5 —  the
# ONLY two steps that ran in that window. Step 0.5's own prompt explicitly
# says "NEVER rewrite the PRD file with a different story structure. You may
# only update agentRole fields and append to profiles.json" — its own text
# summary that run claimed exactly that (agentRole updates + profile
# enhancements only) — but the actual PRD content contradicts its own
# summary. One of the fabricated stories even carried a `specification`
# block mimicking real spec-pass output (same shape, same shared run ID),
# making the forgery look legitimate at a glance; spec-pass's own
# authoritative summary.json for that exact run ID shows it only ever
# touched SKY-001. No deterministic guardrail existed to catch an agent
# adding stories nobody asked for — this closes that gap the same way
# assert_no_story_ids_lost closes the shrinkage gap.
assert_no_story_ids_gained() {
    local label="$1"
    local step_name="$2"
    local snapshot_file="$STORY_ID_SNAPSHOT_DIR/ids-${label}.txt"
    [ -f "$snapshot_file" ] || return 0  # no snapshot captured yet — nothing to compare
    local current_ids gained_ids
    current_ids=$(jq -r '.stories[].id' "$PRD_FILE" 2>/dev/null | sort)
    gained_ids=$(comm -13 "$snapshot_file" <(echo "$current_ids"))
    if [ -n "$gained_ids" ]; then
        error "UNAUTHORIZED STORY CREATION after ${step_name}: the following NEW stor(y/ies) appeared in prd.stories[] that were not there before this step ran:"
        while IFS= read -r _gid; do
            [ -n "$_gid" ] && error "    - $_gid"
        done <<< "$gained_ids"
        error "  This step has full tool-write access to the PRD but is only permitted to ADD"
        error "  to profiles.json or change agentRole/model/aiProvider/reasoningEffort fields —"
        error "  never to author brand-new top-level stories."
        error "  Check the agent's own transcript for this step's assessment/coordinator log."
        exit 1
    fi
}

# assert_no_illegitimate_deprecation <label> <step_name> — companion to
# assert_no_story_ids_lost/assert_no_story_ids_gained, closing a gap those two
# don't cover: a story whose ID survives (so ID-loss doesn't fire) but whose
# `status` field gets silently flipped to "deprecated" by one of the
# unrestricted-tool-write steps (Step 0.5, Step 0.9).
#
# Root cause this guards against (found live, 2026-07-12, tier3-travel-app
# run): SKY-001 was legitimately split into SKY-001-impl/SKY-001-test by
# Step 0 (spec-pass) — both created with status="pending", the correct,
# executable state captured in the "presplit" snapshot. By the time Step 1
# reached them, both had status="deprecated" (plus completed=true and
# removed from implementationOrder) — the exact signature applySpecChanges
# writes onto a PARENT story once ITS split succeeds (spec-mode-runner.js:
# 1865-1866/2392-2397), even though neither of these two stories was ever a
# parent of a further split (no grandchild story IDs exist anywhere in the
# PRD). Nothing between the presplit snapshot and Step 1 legitimately
# deprecates a scaffold-phase story — only Step 0 itself and the
# mid-execution split-gate may do that, and the split-gate explicitly logged
# "No unvalidated mid-execution splits" for this phase. The only steps that
# ran in that window with the unrestricted PRD write access needed to cause
# this are Step 0.5 and Step 0.9 (both explicitly instructed, in their own
# prompts, to touch only agentRole/model/aiProvider/reasoningEffort fields or
# profiles.json — same class of prompt-vs-actual-write mismatch already
# documented for assert_no_story_ids_gained). Net effect: the two stories
# that were actually supposed to write package.json/tsconfig.json/etc. were
# silently skipped all run, and the phase "completed" having done zero real
# scaffolding work.
#
# Scope deliberately narrow: only stories present in BOTH the snapshot and
# the current PRD (a story ID appearing/vanishing is assert_no_story_ids_lost/
# gained's job), and only a flip INTO "deprecated" from something else (a
# story that was already deprecated at snapshot time — e.g. a delegated
# parent — legitimately stays deprecated; that's not a regression).
assert_no_illegitimate_deprecation() {
    local label="$1"
    local step_name="$2"
    local snapshot_file="$STORY_ID_SNAPSHOT_DIR/stories-${label}.json"
    [ -s "$snapshot_file" ] || return 0  # no snapshot captured yet — nothing to compare

    local flipped_ids
    flipped_ids=$(jq -r --slurpfile snap "$snapshot_file" '
        ($snap[0] | map({(.id): (.status // "pending")}) | add) as $before |
        [.stories[] | select(
            ($before[.id] // null) != null and
            ($before[.id]) != "deprecated" and
            (.status // "pending") == "deprecated"
        ) | .id] | .[]
    ' "$PRD_FILE" 2>/dev/null || true)
    [ -z "$flipped_ids" ] && return 0

    warning "STATUS-CORRUPTION after ${step_name}: the following stor(y/ies) were flipped to \"deprecated\" with no legitimate split/delegation event — restoring from the pre-step snapshot:"
    local flipped_json tmp_prd
    flipped_json=$(echo "$flipped_ids" | jq -R -s 'split("\n") | map(select(length > 0))')
    tmp_prd=$(mktemp)
    chmod 644 "$tmp_prd" 2>/dev/null
    if jq --argjson flipped "$flipped_json" --slurpfile snap "$snapshot_file" \
        '.stories = (.stories | map(
            . as $cur |
            ($snap[0][] | select(.id == $cur.id and ($flipped | index($cur.id) != null))) // $cur
        ))' \
        "$PRD_FILE" > "$tmp_prd" 2>/dev/null && jq empty "$tmp_prd" 2>/dev/null; then
        mv "$tmp_prd" "$PRD_FILE"
        while IFS= read -r _fid; do
            [ -n "$_fid" ] && warning "    - restored: $_fid"
        done <<< "$flipped_ids"
    else
        rm -f "$tmp_prd"
        error "STATUS-CORRUPTION after ${step_name}: could not restore — check $PRD_FILE manually"
        exit 1
    fi
}

# ── Post-assessment AC invariant check ────────────────────────────────────────
# No story in implementationOrder may have >24 ACs before execution begins.
# Catches spec-pass overflow or Step 0.5 agent writes that bypassed capSplitACs.
check_ac_invariant() {
    local _phase_id="$1"
    local _violations
    _violations=$(jq -r \
        --arg phase "$_phase_id" \
        --argjson max 24 \
        '(.implementationOrder[$phase] // []) as $order |
         .stories[] |
         select(
           (.id as $id | $order | index($id) != null) and
           ((.acceptanceCriteria // []) | length > $max)
         ) | "\(.id): \((.acceptanceCriteria // []) | length) ACs"' \
        "$PRD_FILE" 2>/dev/null)

    if [ -n "$_violations" ]; then
        warning "  [ac-invariant] Stories exceeding 24-AC limit (may cause spec-validator failures):"
        while IFS= read -r _v; do warning "    $_v"; done <<< "$_violations"
    else
        log "  [ac-invariant] All stories within 24-AC limit for phase '$_phase_id'"
    fi
}
