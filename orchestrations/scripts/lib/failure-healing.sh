#!/usr/bin/env bash
# failure-healing.sh — moved verbatim out of claude.sh by tools/split-main-into-modules.py
# (14 functions). Sourced by claude.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# run_dynamic_tools_in_unlocked_window <project_root> <output_file>
# Deterministically executes every dynamic tool the self-healing loop has
# written for this project, in the SANCTIONED unlocked window (right after
# _vendor_unlock, before the test command runs) — not left to the agent to
# invoke via Bash sometime during its own turn.
#
# Root cause this fixes (found live, 2026-07-09, tier3-travel-app run):
# _vendor_lock() chmods vendor dirs (e.g. node_modules) read-only for the
# WHOLE story turn, before the agent runs. When the failure-analyst diagnoses
# a missing dependency and writes a dynamic tool that runs `npm install X`,
# the agent's own invocation of that tool happens DURING the same locked
# turn — the install either fails outright (permission denied, surfacing as
# the exact same "X not found" diagnosis on every retry) or partially writes
# just enough to trip run_vendor_integrity_check's tamper detector, hard-
# failing the story before the fix ever had a chance to land. A dependency-
# installing dynamic tool could NEVER succeed under the old lock ordering —
# confirmed live: SKY-002-test/SKY-002-test-1 each burned all 8 retries on
# "vitest not found" without the repeatedly-rewritten install-vitest.sh tool
# ever actually installing vitest.
#
# Tools are already required to be idempotent (enforced by the tool_creation
# reviewer's own rules), so running them here — unconditionally, every retry,
# in a genuinely unlocked window — is safe even if the agent ALSO tries to
# invoke the same tool itself during its turn.
#
# Safety floor: each tool is syntax-checked (bash -n) before being trusted to
# execute. The orchestrator (not just the agent) now runs these
# unconditionally every retry, so a tool that's merely syntactically broken
# must not be blindly executed — skip and log rather than let a malformed
# script corrupt state or hang the pipeline.
run_dynamic_tools_in_unlocked_window() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local tools_dir="$project_root/.epam/dynamic-tools"
    [ -d "$tools_dir" ] || return 0
    [ -n "$(find "$tools_dir" -maxdepth 1 -name '*.sh' 2>/dev/null)" ] || return 0

    local _tool_file _tool_base
    for _tool_file in "$tools_dir"/*.sh; do
        [ -f "$_tool_file" ] || continue
        _tool_base="${_tool_file##*/}"
        # Only reviewed tools are ever used by downstream agents or the
        # orchestrator itself — an explicit, checkable marker, not an
        # assumption that the directory only ever contains reviewed scripts.
        if [ ! -f "${_tool_file}.reviewed" ]; then
            warning "  [dynamic-tools] Skipping ${_tool_base} — no .reviewed marker (not approved by the reviewer gate)"
            continue
        fi
        if ! bash -n "$_tool_file" 2>>"$output_file"; then
            warning "  [dynamic-tools] Skipping ${_tool_base} — fails bash syntax check"
            continue
        fi
        log "  [dynamic-tools] Running ${_tool_base} in sanctioned unlocked window..."
        if ! (cd "$project_root" && bash "$_tool_file") >> "$output_file" 2>&1; then
            warning "  [dynamic-tools] ${_tool_base} exited non-zero (continuing)"
        fi
    done
}

# _attempt_change_summary <story_id> [baseline_ref]
#
# WHAT THE LAST ATTEMPT ACTUALLY DID — the one piece of evidence neither the writer nor the
# failure analyst has ever been given.
#
# The writer is told what is WRONG (reviewer blockers, verification failures, prior-run lessons)
# and never what it DID, so it cannot tell "I tried this and it was rejected" from "I have not
# tried anything", and re-derives an approach it has already been told is wrong. The analyst is
# asked why an implementation failed while being shown no implementation — live 2026-08-12 it
# answered "Target=none — Transient import slip", a fair reading of the text it had and useless
# as guidance, and its answer escalates the model.
#
# COMPUTED, NOT ASKED FOR. Plain git against the story's own baseline. No agent, no judgement,
# no summarisation: a model between a machine fact and the agent acting on it destroys
# provenance, and this reviewer has already approved a change while misstating the diff.
#
# ONE SOURCE, TWO CONSUMERS — the writer's retry prompt and the analyst's evidence read the same
# text. Two pipelines is how they drifted into being fed differently in the first place.
# ── THE ANALYST'S WIDER VIEW (2026-09-20) ─────────────────────────────────────────────────────
#
# regintel 20260919T224649Z: 30 healing events, 21 prescriptions, 0 patches applied, 4 of 5
# stories unhealed. Every diagnosis was correct for the one story it read and wrong for the
# run — 005b was told "never async", 005a "always async", 007a "accept both" — because each
# analyst saw only its story's tests, prescribed rewrites of a file its writer was forbidden to
# touch, and re-derived attempt 1's diagnosis on attempt 4 from the same evidence. Self-heal was
# stateless, story-local and writer-directed; the failures were cross-story, cross-attempt and
# out-of-scope. These three inputs, the three targets (escalate / spec / environment) and the
# per-story summary give the seam what that shape could not express. Facts from the PRD and the
# run's ledgers; the words are the template's; the analyst judges.

# _analyst_write_scope <story_id> — what this story's writer may touch, and who owns the rest.
_analyst_write_scope() {
    local _id="${1:-}" _prd="${MAIN_PRD_FILE:-${PRD_FILE:-}}"
    [ -n "$_id" ] && [ -f "$_prd" ] || return 0
    jq -r --arg id "$_id" '
      (.stories[] | select(.id == $id) | .technicalNotes.files // []) as $mine
      | "Files this story may write (its declared scope):\n" + ($mine | map("  - " + .) | join("\n"))
      + "\nFiles OTHER stories declare — a fix there is theirs, escalate it, never prescribe it to this writer:\n"
      + ([.stories[] | select(.id != $id and .status != "deprecated") | . as $s | (.technicalNotes.files // [])[] | "  - " + . + " (" + $s.id + ")"] | unique | join("\n"))' \
      "$_prd" 2>/dev/null
}

# _analyst_shared_criteria <story_id> — the criteria OTHER stories hold on this story's source
# files: testCriteria facts (greenfield / TC-bearing stories) and verificationCriteria
# (brownfield) alike. The contract in force; a fix that contradicts it is a spec conflict.
_analyst_shared_criteria() {
    local _id="${1:-}" _prd="${MAIN_PRD_FILE:-${PRD_FILE:-}}"
    [ -n "$_id" ] && [ -f "$_prd" ] || return 0
    jq -r --arg id "$_id" '
      def norm: ltrimstr("./");
      def same($a; $b): ($a | norm) == ($b | norm) or (($a | norm) | endswith("/" + ($b | norm))) or (($b | norm) | endswith("/" + ($a | norm)));
      (.stories[] | select(.id == $id)) as $me
      | ([($me.technicalNotes.files // [])[], ($me.testCriteria.sourceFiles // [])[]] | unique) as $files
      | [ .stories[] | select(.id != $id and .status != "deprecated") | . as $s
          | ([($s.technicalNotes.files // [])[], ($s.testCriteria.sourceFiles // [])[]] | unique) as $theirs
          | ($files[] | . as $f | select(any($theirs[]; same(.; $f))) | $f) as $f
          | (($s.testCriteria.facts // []) + ($s.verificationCriteria // [] | map(if type == "object" then (.criterion // tostring) else . end))) as $crit
          | select(($crit | length) > 0)
          | "- " + $s.id + " on " + $f + ":\n" + ($crit | map("    * " + .) | join("\n")) ]
      | unique | join("\n")' "$_prd" 2>/dev/null
}

# _analyst_healing_history <story_id> — this story's prior diagnoses and prescriptions, in order,
# from the run's own ledgers; and the fact that none of them resolved the failure (this attempt
# failed too). Empty when there is no history.
_analyst_healing_history() {
    local _id="${1:-}" _ev="${LOG_DIR:-}/healing-events.jsonl" _gl="${LOG_DIR:-}/run-guidance.jsonl"
    [ -n "$_id" ] && [ -s "$_ev" ] || return 0
    local _events
    _events=$(jq -c --arg id "$_id" 'select(.story_id == $id and (.event // "") != "HEALING_BROKEN")' "$_ev" 2>/dev/null)
    [ -n "$_events" ] || return 0
    local _notes="[]"
    [ -s "$_gl" ] && _notes=$(jq -c -s --arg id "$_id" '[.[] | select(.storyId == $id) | .note // empty]' "$_gl" 2>/dev/null || echo "[]")
    printf '%s\n' "$_events" | jq -r -s --argjson notes "$_notes" '
      to_entries | map(
        "attempt " + ((.key + 1) | tostring) + " (rung " + ((.value.rung // 0) | tostring) + "): diagnosed \"" + (.value.diagnosis // "") + "\" — target " + (.value.target // "none")
        + (if (.value.note // ($notes[.key] // "")) != "" then "; prescribed: \"" + (.value.note // $notes[.key]) + "\"" else "" end)
        + (if (.value.evidence // "") != "" then "; evidence: " + .value.evidence else "" end)
        + (if (.value.expected_outcome // "") != "" then "; expected: " + .value.expected_outcome else "" end)
      ) | join("\n")
      + "\nNone of the " + (length | tostring) + " prescription(s) above resolved the failure — this attempt is still failing. A diagnosis that repeats one of them is not new information; say what is DIFFERENT about the cause, or name where the fix actually belongs (escalate / spec / environment)."'
}

# _apply_analyst_escalation <story_id> <analyst-json> — target=escalate: file the escalation
# record resolve_escalation reads (the same record the writer's escalate_defect_to_sibling_story
# tool writes). Refuses a target inside the story's own scope: that is a skill note, not an
# escalation (exit 1). Exit 2 when the answer names no target file.
_apply_analyst_escalation() {
    local _id="${1:-}" _json="${2:-}" _prd="${MAIN_PRD_FILE:-${PRD_FILE:-}}"
    local _tf _fix _diag _owner
    _tf=$(printf '%s' "$_json" | jq -r '.escalation.targetFile // .targetFile // ""' 2>/dev/null)
    _fix=$(printf '%s' "$_json" | jq -r '.escalation.requiredFix // .skill_note // ""' 2>/dev/null)
    _diag=$(printf '%s' "$_json" | jq -r '.diagnosis // ""' 2>/dev/null)
    _owner=$(printf '%s' "$_json" | jq -r '.escalation.ownerStoryId // ""' 2>/dev/null)
    if [ -z "$_tf" ]; then
        warning "  [FailureAnalyst] target=escalate but no escalation.targetFile — injecting diagnosis only"
        return 2
    fi
    if [ -f "$_prd" ] && jq -e --arg id "$_id" --arg f "$_tf" '.stories[] | select(.id == $id) | (.technicalNotes.files // []) | map(. == $f or endswith("/" + $f) or ($f | endswith("/" + .))) | any' "$_prd" >/dev/null 2>&1; then
        warning "  [FailureAnalyst] target=escalate names $_tf, which is inside $_id's own scope — the fix is this writer's; treating the prescription as a skill note"
        return 1
    fi
    mkdir -p "${PROJECT_ROOT}/.epam/escalations"
    jq -n --arg from "$_id" --arg tf "$_tf" --arg diag "$_diag" --arg fix "$_fix" --arg owner "$_owner" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{fromStoryId: $from, targetFile: $tf, diagnosis: $diag, requiredFix: $fix, filedBy: "failure-analyst", createdAt: $ts} + (if $owner != "" then {ownerStoryId: $owner} else {} end)' \
        > "${PROJECT_ROOT}/.epam/escalations/${_id}.json"
    log "  [FailureAnalyst] target=escalate — filed a defect in $_tf${_owner:+ (owner $_owner)} for the resolver: $_fix"
    return 0
}

# _apply_reviewed_tc_patches <escalating-story> <tc_patches-json> — each patch names the story
# whose testCriteria fact it changes (storyId; this story when absent). Applied per story, judged
# by the prd-change-reviewer per story, reverted on rejection. Echoes the count applied.
_apply_reviewed_tc_patches() {
    local _id="${1:-}" _patches="${2:-[]}" _prd="${MAIN_PRD_FILE:-${PRD_FILE:-}}"
    local _applied=0 _sid
    for _sid in $(printf '%s' "$_patches" | jq -r --arg me "$_id" '[.[] | (.storyId // $me)] | unique | .[]' 2>/dev/null); do
        local _before _after _mine _verdict
        _mine=$(printf '%s' "$_patches" | jq -c --arg me "$_id" --arg sid "$_sid" '[.[] | select((.storyId // $me) == $sid)]')
        _before=$(jq -c --arg id "$_sid" '.stories[] | select(.id == $id) | .testCriteria.facts // []' "$_prd" 2>/dev/null || echo "[]")
        ( flock -w 10 200 || exit 1
          python3 - "$_prd" "$_sid" "$_mine" <<'PYEOF'
import json, sys, os
prd_path, sid, patches = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == sid:
        facts = s.setdefault('testCriteria', {}).setdefault('facts', [])
        for p in patches:
            i = p.get('index'); t = p.get('new_text')
            if isinstance(i, int) and 0 <= i < len(facts) and t:
                facts[i] = t
        break
tmp = prd_path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(tmp, prd_path)
PYEOF
        ) 200>"${_prd}.lock"
        _after=$(jq -c --arg id "$_sid" '.stories[] | select(.id == $id) | .testCriteria.facts // []' "$_prd" 2>/dev/null || echo "[]")
        [ "$_before" = "$_after" ] && continue
        _verdict=$(run_prd_change_reviewer "$_sid" "tc_patch" "$_before" "$_after")
        if [ "$_verdict" = "fail" ]; then
            warning "  [FailureAnalyst] TC patch on $_sid rejected by the reviewer — reverting"
            ( flock -w 10 200 || exit 1
              python3 - "$_prd" "$_sid" "$_before" <<'PYEOF'
import json, sys, os
prd_path, sid, facts = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == sid:
        s.setdefault('testCriteria', {})['facts'] = facts
        break
tmp = prd_path + '.tmp'
with open(tmp, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(tmp, prd_path)
PYEOF
            ) 200>"${_prd}.lock"
        else
            _applied=$((_applied + $(printf '%s' "$_mine" | jq 'length')))
            log "  [FailureAnalyst] TC patch on $_sid: reviewer said '$_verdict' — applied"
        fi
    done
    echo "$_applied"
}

# write_healing_summary <story_id> <completed|failed> — the story's self-heal record, rendered
# once when the story ends: diagnosed → prescribed → outcome, per attempt. The operator's summary
# and the next run's evidence; one line to the log.
write_healing_summary() {
    local _id="${1:-}" _outcome="${2:-unknown}" _ev="${LOG_DIR:-}/healing-events.jsonl" _gl="${LOG_DIR:-}/run-guidance.jsonl"
    [ -n "$_id" ] && [ -n "${LOG_DIR:-}" ] || return 0
    local _events="" _n=0
    [ -s "$_ev" ] && _events=$(jq -c --arg id "$_id" 'select(.story_id == $id and (.event // "") != "HEALING_BROKEN")' "$_ev" 2>/dev/null)
    [ -n "$_events" ] && _n=$(printf '%s\n' "$_events" | grep -c .)
    [ "$_n" -gt 0 ] || return 0
    local _notes="[]"
    [ -s "$_gl" ] && _notes=$(jq -c -s --arg id "$_id" '[.[] | select(.storyId == $id) | .note // empty]' "$_gl" 2>/dev/null || echo "[]")
    mkdir -p "${LOG_DIR}/healing-summary"
    {
        printf '# Self-heal summary — %s (%s)\n\n' "$_id" "$_outcome"
        printf 'attempts: %s (each with a diagnosis) · outcome: %s\n\n' "$_n" "$_outcome"
        printf '%s\n' "$_events" | jq -r -s --argjson notes "$_notes" '
          to_entries[] | "## attempt " + ((.key + 1) | tostring) + " (rung " + ((.value.rung // 0) | tostring) + ", target " + (.value.target // "none") + ")\n"
            + "- diagnosed: " + (.value.diagnosis // "") + "\n"
            + (if (.value.note // ($notes[.key] // "")) != "" then "- prescribed: " + (.value.note // $notes[.key]) + "\n" else "" end)
            + (if (.value.evidence // "") != "" then "- evidence: " + .value.evidence + "\n" else "" end)
            + (if (.value.expected_outcome // "") != "" then "- expected: " + .value.expected_outcome + "\n" else "" end)
            + "- patches applied: " + ((.value.patches_applied // 0) | tostring) + "\n"'
    } > "${LOG_DIR}/healing-summary/${_id}.md"
    local _targets
    _targets=$(printf '%s\n' "$_events" | jq -r -s 'map(.target // "none") | group_by(.) | map(.[0] + "×" + (length | tostring)) | join(", ")')
    log "  [SelfHeal] $_id $_outcome after $_n diagnosed attempt(s) — targets: $_targets — summary: healing-summary/${_id}.md"
}

# _attempt_start_snapshot
#
# THE TREE AS IT STOOD WHEN THIS ATTEMPT STARTED — tracked and untracked alike — as a git
# tree object, without touching the real index or the working tree. Taken by implement_story
# right before every invocation; _attempt_change_summary diffs against it.
#
# Found live 2026-09-20 (regintel 20260919T224649Z resume 7): the summary diffed against the
# STORY's baseline, which already carried the story's earlier completed work, so a scoped-fix
# attempt that made 18 reads, 4 bash calls and ZERO writes was reported to the analyst as having
# changed the files it never touched. It diagnosed code instead of the absence of an attempt.
# Echoes nothing when there is no repository; the summary then falls back to the baseline.
_attempt_start_snapshot() {
    [ -e "$PROJECT_ROOT/.git" ] || return 0
    local _tmp_index
    _tmp_index=$(mktemp "${TMPDIR:-/tmp}/attempt-index-XXXXXX") || return 0
    cp "$PROJECT_ROOT/.git/index" "$_tmp_index" 2>/dev/null || : > "$_tmp_index"
    local _tree
    _tree=$( cd "$PROJECT_ROOT" && GIT_INDEX_FILE="$_tmp_index" git add -A . >/dev/null 2>&1 && GIT_INDEX_FILE="$_tmp_index" git write-tree 2>/dev/null )
    rm -f "$_tmp_index"
    [ -n "$_tree" ] && printf '%s' "$_tree"
    return 0
}

# _restore_tree_snapshot <tree>
#
# THE TREE AS IT WAS — tracked, staged and untracked alike — from a snapshot taken by
# _attempt_start_snapshot. Files added since are removed, edits are undone, the index matches.
# Used to withdraw a scoped fix that did not converge (see resolve_escalation), so a half-done
# edit of another story's file never reaches the escalating story's commit under its name
# (regintel 20260919T224649Z: 007a's "story complete" carried 005a's half-rewritten
# classifier.py). Says so and does nothing when there is no repository or no snapshot.
_restore_tree_snapshot() {
    local _tree="${1:-}"
    [ -n "$_tree" ] && [ -e "$PROJECT_ROOT/.git" ] || return 0
    git -C "$PROJECT_ROOT" cat-file -e "${_tree}^{tree}" 2>/dev/null || return 0
    local _now
    _now=$(_attempt_start_snapshot)
    [ -n "$_now" ] && [ "$_now" = "$_tree" ] && return 0
    # Files that exist now and did not in the snapshot: delete them (git restore cannot).
    if [ -n "$_now" ]; then
        git -C "$PROJECT_ROOT" diff --name-only --diff-filter=A "$_tree" "$_now" 2>/dev/null | while IFS= read -r _f; do
            [ -n "$_f" ] && rm -f "$PROJECT_ROOT/$_f"
        done
    fi
    git -C "$PROJECT_ROOT" restore --source="$_tree" --worktree --staged -- . 2>/dev/null \
        || git -C "$PROJECT_ROOT" checkout "$_tree" -- . 2>/dev/null || return 1
    return 0
}

# _attempt_tool_record <raw-output-file>
#
# WHAT THE AGENT DID WITH ITS TURN, counted from the runner's own raw record — per tool name,
# whichever runner wrote it: the epam runner's iteration record (.iterations[].toolCalls[].name),
# claude's stream-json (tool_use blocks), codex's item stream (item.completed → item.type).
# A machine fact for the analyst to judge: "18 read_file, 4 bash, no write_file" is the evidence
# that separates "wrote the wrong thing" from "wrote nothing". Says so when there is no record.
_attempt_tool_record() {
    local _raw="${1:-}"
    [ -n "$_raw" ] && [ -s "$_raw" ] || { printf '(no tool record available for this attempt)\n'; return 0; }
    local _names
    _names=$( { jq -r '.iterations[]?.toolCalls[]?.name // empty' "$_raw" 2>/dev/null
               jq -r 'select(type=="object") | (.message.content[]? | select(.type=="tool_use") | .name), (select(.type=="item.completed") | .item.type // empty)' "$_raw" 2>/dev/null; } \
             | grep -v '^$' | sort | uniq -c | sort -rn | awk '{printf "  %s × %s\n", $2, $1}' )
    if [ -z "$_names" ]; then printf '(no tool record available for this attempt)\n'; return 0; fi
    printf 'Tool calls this attempt (from the runner'"'"'s record):\n%s\n' "$_names"
    if ! printf '%s' "$_names" | grep -qiE 'write|edit|file_change|patch'; then
        printf '  no write/edit tool was called — the attempt produced no file changes of its own\n'
    fi
    return 0
}

_attempt_change_summary() {
    local _story_id="${1:-}"
    # THIS attempt's start when a snapshot was taken (ATTEMPT_START_REF, see
    # _attempt_start_snapshot); the story's baseline otherwise.
    local _ref="${2:-${ATTEMPT_START_REF:-$(_resolved_baseline_ref)}}"
    local _stat=""

    if [ -e "$PROJECT_ROOT/.git" ] && git -C "$PROJECT_ROOT" rev-parse --verify "$_ref" >/dev/null 2>&1; then
        # TREE AGAINST TREE. The tree as it stands now — tracked, staged, untracked alike — is
        # snapshotted the same way the attempt's start was, and the two are compared. A working-
        # tree diff would read an untracked file that pre-dates the attempt as "deleted" (it is
        # in the snapshot, not in the index) and would miss a brand-new file altogether — and a
        # brand-new file is the most common shape of "what the attempt did".
        local _now
        _now=$(_attempt_start_snapshot)
        if [ -n "$_now" ]; then
            _stat=$( git -C "$PROJECT_ROOT" diff --stat "$_ref" "$_now" 2>/dev/null | grep -vE '^[[:space:]]*$' | head -n "$(evidence_window changedFileLines)" )
        else
            _stat=$( git -C "$PROJECT_ROOT" diff --stat "$_ref" 2>/dev/null | grep -vE '^[[:space:]]*$' | head -n "$(evidence_window changedFileLines)" )
        fi
    fi

    local _record=""
    [ -n "${ATTEMPT_RAW_FILE:-}" ] && _record=$(_attempt_tool_record "$ATTEMPT_RAW_FILE")

    if [ -z "$(printf '%s' "$_stat" | tr -d '[:space:]')" ]; then
        # THE MOST IMPORTANT CASE. An empty summary reads as "no information", and the next
        # attempt then behaves as though it were the first. Say it plainly instead.
        printf 'The previous attempt changed NO files — nothing was written. Treat this as an attempt that produced nothing, not as a fresh start.\n'
        [ -n "$_record" ] && printf '\n%s\n' "$_record"
        return 0
    fi

    printf 'The previous attempt changed these files (diffstat against %s):\n\n%s\n' "$_ref" "$_stat"
    [ -n "$_record" ] && printf '\n%s\n' "$_record"
    return 0
}

# classify_invocation_refusal <attempt-output-file> <exit-code>
#
# TRUE when the CLI refused its own command line -- an argument it will refuse identically forever.
#
# 2026-08-28: every writer attempt died in milliseconds on
#   error: option '--autocompact <auto|tokens>' argument '80000' is invalid.
# The coordinator called all twelve "unknown", escalated haiku -> sonnet-5 and reset the worktree
# between each, because no raw output file existed and absent was read as "no evidence". The
# evidence was in the attempt's own output log the whole time, identical every time.
#
# Retrying is for conditions that might differ next time. This is not one of them: report the
# offending option and stop, so the operator fixes the flag instead of paying for eleven repeats.
# require_profile <persona-key> <profiles-file>
#
# THE BRIEF, OR NOTHING — never prose written here.
#
# Three call sites carried `[ -z "$x" ] && x="You are a ..."`, so a missing roster entry silently
# substituted a persona that no prompt file holds, no review ever saw, and no project can
# specialise. All three keys exist in both roster sources, which means the fallback could only fire
# when the roster was BROKEN — exactly when running anyway is worst, and the resulting verdict is
# one nobody can audit or reproduce.
#
# The pipeline already knows the right answer: runtime-boundary refuses "with no instructions", and
# team-lead-review refuses rather than review on an empty brief. A gate that declines is
# recoverable. A gate that invents its own instructions is not.
require_profile() {
    local _key="${1:-}" _file="${2:-}"
    local _brief=""
    [ -n "$_key" ] || { error "  [profile] no persona key given — refusing to invent one"; return 1; }
    if [ -n "$_file" ] && [ -f "$_file" ]; then
        _brief=$(jq -r --arg k "$_key" '.[$k] // ""' "$_file" 2>/dev/null || echo "")
    fi
    if [ -z "$_brief" ] || [ "$_brief" = "null" ]; then
        error "  [profile] '${_key}' has no brief in ${_file:-<no profiles file>} — refusing to run it on"
        error "  [profile] prose written in this script. Mint the roster, or restore profiles.json."
        return 1
    fi
    printf '%s' "$_brief"
}

# THE RETRY AFTER AN OUTPUT-CAP HIT GETS ROOM. When classify_failure_class reads the runner's
# truncation message, the next attempt's output budget becomes the widest tier's — an identical cap
# would truncate identically (regintel 140717Z: 8 attempts on REGI-004-A, all at 6144, all empty).
raise_output_budget_after_cap_hit() {
    [ "${COORDINATOR_FAILURE_CLASS:-}" = "output_cap" ] || return 0
    local _widest="${EPAM_EFFORT_MAX_MAX_OUTPUT_TOKENS:-0}"
    if [ "${_widest:-0}" -gt "${STORY_MAX_OUTPUT_TOKENS:-0}" ] 2>/dev/null; then
        log "  Coordinator[L1]: output budget ${STORY_MAX_OUTPUT_TOKENS:-?} → ${_widest} for the retry (the last attempt was truncated at its cap)"
        STORY_MAX_OUTPUT_TOKENS="$_widest"
        export STORY_MAX_OUTPUT_TOKENS
    fi
    return 0
}

classify_failure_class() {
    local raw_file="${1:-}"
    local result_json="${2:-}"
    local exit_code="${3:-1}"
    local story_id="${4:-}"
    local output_log="${5:-}"

    COORDINATOR_FAILURE_CLASS="unknown"
    COORDINATOR_ESCALATE="yes"

    # TWO FAILURES THAT LOOK LIKE "0 BYTES, EXIT 1" AND ARE NOT ENVIRONMENT FAILURES (regintel
    # 140717Z, 2026-09-21). The runner names an output-cap hit on stderr — "Response truncated at
    # max_tokens" (src/agent/AgentRunner.ts) — and the attempt log is where that stderr lands; an
    # identical retry truncates identically, so the class is output_cap and the retry gets room.
    # And an account with no credit fails every call the same way while the API key stays valid;
    # the balance probe the pre-flight already uses answers that in one call — class credit, halt.
    if [ "$exit_code" -ne 0 ] && [ -n "$output_log" ] && [ -f "$output_log" ] \
       && grep -q "truncated at max_tokens" "$output_log" 2>/dev/null; then
        COORDINATOR_FAILURE_CLASS="output_cap"
        COORDINATOR_ESCALATE="yes"
        warning "  Coordinator[L1]: the attempt was truncated at its output cap (${STORY_MAX_OUTPUT_TOKENS:-?} tokens) — class output_cap; the retry is given the widest budget"
        return 0
    fi
    if [ "$exit_code" -ne 0 ]; then
        local _bal; _bal="$(balance_probe_read 2>/dev/null || true)"
        if [ -n "$_bal" ] && awk -v b="$_bal" 'BEGIN{exit !(b+0 <= 0.05)}'; then
            COORDINATOR_FAILURE_CLASS="credit"
            COORDINATOR_ESCALATE="no"
            error "  Coordinator[L1]: the provider account has no credit (balance \$${_bal}) — every attempt will fail the same way; halting this story instead of climbing its ladder"
            return 0
        fi
    fi

    # Class A: environment crash — raw output is EMPTY and exit code != 0.
    #
    # ABSENT IS NOT EMPTY. This measured emptiness as `raw_size=0` with a default of 0, so a file
    # that was never written — or an empty path, which is exactly what the caller passes when its
    # fallbacks miss — scored identically to a file the CLI wrote nothing into. On 2026-08-18 no
    # _result_raw.json existed for either story, so ten attempts were diagnosed "environment
    # crash", the coordinator confirmed a healthy binary and key, and the real cause (a provider
    # that did not follow its escalated model) was never considered. A conclusion drawn from
    # absent evidence is worse than no conclusion: it sends the next step somewhere confident and
    # wrong. Missing stays UNKNOWN, and says so.
    if [ "$exit_code" -ne 0 ] && { [ -z "$raw_file" ] || [ ! -f "$raw_file" ]; }; then
        COORDINATOR_FAILURE_CLASS="unknown"
        COORDINATOR_ESCALATE="yes"
        warning "  Coordinator[L1]: no raw output file to read (${raw_file:-<no path>}) — the attempt's output was never written, so the failure class is UNKNOWN, not diagnosed"
        return 0
    fi
    local raw_size=0
    [ -f "$raw_file" ] && raw_size=$(wc -c < "$raw_file" 2>/dev/null || echo 0)
    if [ "$raw_size" -eq 0 ] && [ "$exit_code" -ne 0 ]; then
        COORDINATOR_FAILURE_CLASS="env"
        COORDINATOR_ESCALATE="no"
        warning "  Coordinator[L1]: environment failure detected (raw=0 bytes, exit=$exit_code) — diagnosing before escalation decision"
        # Active crash diagnosis: check API key and binary health
        local _diag_ok=true
        # 1. Check epam binary is executable
        if ! command -v "${EPAM_CLI:-epam}" >/dev/null 2>&1; then
            warning "  Coordinator[Diag]: epam binary not found on PATH — check EPAM_CLI or PATH"
            _diag_ok=false
        fi
        # 2. Check the stack's credential, IF this stack has one to check.
        #
        # This curled a vendor auth endpoint unconditionally and, finding no key for that
        # vendor, declared "provider will fail on any API call" — on a codemie or mockserver
        # run, where that vendor is not used at all. A diagnostic that reports a healthy run as
        # broken is worse than none. The set declares whether it has a checkable credential
        # endpoint (provider-sets.json spendProbe); a set declaring none is skipped, not failed.
        local _or_key=""
        if [ -n "$(spend_probe_read)" ]; then
            _or_key="${OPENROUTER_API_KEY:-${EPAM_API_KEY_OPENROUTER:-}}"
        else
            log "  Coordinator[Diag]: this provider set declares no credential endpoint — skipping the vendor key check"
        fi
        if [ -n "$_or_key" ]; then
            local _key_status
            _key_status=$(curl -s --max-time 5 \
                "https://openrouter.ai/api/v1/auth/key" \
                -H "Authorization: Bearer $_or_key" 2>/dev/null \
                | jq -r '.data.label // "invalid"' 2>/dev/null || echo "unreachable")
            if [ "$_key_status" = "invalid" ] || [ "$_key_status" = "unreachable" ]; then
                warning "  Coordinator[Diag]: OPENROUTER_API_KEY check returned '$_key_status' — key may be expired or network is down"
                _diag_ok=false
            else
                log "  Coordinator[Diag]: OpenRouter key OK (label=$_key_status)"
            fi
        else
            warning "  Coordinator[Diag]: OPENROUTER_API_KEY is empty — provider will fail on any API call"
            _diag_ok=false
        fi
        if [ "$_diag_ok" = true ]; then
            log "  Coordinator[Diag]: binary and key are healthy — model/timeout issue; allowing escalation to retryModel"
            COORDINATOR_ESCALATE="yes"
        fi
        return
    fi

    # Class B: capability failure — "reached maximum iterations" in result
    local result_text=""
    [ -f "$result_json" ] && result_text=$(jq -r '.result // ""' "$result_json" 2>/dev/null || echo "")
    if echo "$result_text" | grep -qi "maximum iterations\|max.*iter"; then
        COORDINATOR_FAILURE_CLASS="capability"
        COORDINATOR_ESCALATE="yes"
        # Inject a directive so the escalated model doesn't repeat the same
        # exhaustion pattern. This is a SEPARATE occurrence of the same
        # write-first-vs-read-first distinction fixed in
        # build_implementation_prompt() (found live 2026-07-23, AMSD-1820) —
        # missed here because it's a different code path (the max-iterations
        # failure classifier, not the initial prompt builder). Without this
        # brownfield branch, a story that hits this classifier gets the OLD
        # "do NOT investigate" text re-injected via ## Coordinator Guidance,
        # silently contradicting and undoing the "READ BEFORE YOU WRITE"
        # directive already shown earlier in the SAME prompt.
        if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/coordinator-amendment-vals-XXXXXX.json")
            jq -n \
                  '{}' > "$_cp_vals"
            _render_out="$(render_or_keep coordinator-amendment "$_cp_vals" turns_exhausted_files_exist)" && COORDINATOR_PROMPT_AMENDMENT="$_render_out"
            rm -f "$_cp_vals"
        else
            _cp_vals=$(mktemp "${TMPDIR:-/tmp}/coordinator-amendment-vals-XXXXXX.json")
            jq -n \
                  '{}' > "$_cp_vals"
            _render_out="$(render_or_keep coordinator-amendment "$_cp_vals" turns_exhausted_nothing_written)" && COORDINATOR_PROMPT_AMENDMENT="$_render_out"
            rm -f "$_cp_vals"
        fi
        log "  Coordinator[L1]: capability failure (max iterations) — escalation approved, write-first amendment injected"
        if [ -n "$story_id" ] && [ -n "${LOG_DIR:-}" ]; then
            (
                flock -w 5 200 || true
                jq -cn --arg id "$story_id" --arg ts "$(date -Iseconds)" \
                    '{story_id:$id, timestamp:$ts}' >> "${LOG_DIR}/iteration-exhaustion.jsonl"
            ) 200>"${LOG_DIR}/iteration-exhaustion.jsonl.lock"
        fi
        return
    fi

    # Class B variant: ran with tokens but no deliverables
    local tokens_out=0
    [ -f "$result_json" ] && tokens_out=$(jq -r '.usage.outputTokens // .usage.output_tokens // 0' "$result_json" 2>/dev/null || echo 0)
    if [ "${tokens_out:-0}" -gt 100 ] && [ -z "$result_text" ]; then
        COORDINATOR_FAILURE_CLASS="capability"
        COORDINATOR_ESCALATE="yes"
        log "  Coordinator[L1]: capability failure (tokens consumed, no result) — escalation approved"
        return
    fi

    # Class C: quality failure — result exists, deliverables may exist, but tests failed
    # This is identified by the caller (verify_story_deliverables or run_external_verification failing)
    # If we reach here with non-empty result, it's likely quality
    if [ -n "$result_text" ]; then
        COORDINATOR_FAILURE_CLASS="quality"
        COORDINATOR_ESCALATE="yes"
        log "  Coordinator[L1]: quality failure (agent ran, result produced) — escalation tentatively approved"
        return
    fi

    # Unknown: default to escalate (safe fallback)
    COORDINATOR_FAILURE_CLASS="unknown"
    COORDINATOR_ESCALATE="yes"
    log "  Coordinator[L1]: unknown failure class — escalation approved (safe default)"

    # Cross-run memory check: read story-failures.jsonl for repeated patterns.
    # After 2+ consecutive env failures on the same story, suppress escalation and
    # flag it as a persistent environment problem requiring operator intervention.
    local _failures_file="${LOG_DIR}/story-failures.jsonl"
    if [ -f "$_failures_file" ]; then
        local _prior_env_count
        _prior_env_count=$(jq -r --arg sid "${story_id:-}" \
            'select(.storyId == $sid and .failureClass == "env") | .storyId' \
            "$_failures_file" 2>/dev/null | wc -l | tr -d ' ')
        if [ "${_prior_env_count:-0}" -ge 2 ]; then
            COORDINATOR_FAILURE_CLASS="env"
            COORDINATOR_ESCALATE="no"
            warning "  Coordinator[L1]: story $story_id has ${_prior_env_count} prior env failures across runs — suppressing escalation, flagging for operator review"
        fi
        local _prior_cap_count
        _prior_cap_count=$(jq -r --arg sid "${story_id:-}" \
            'select(.storyId == $sid and .failureClass == "capability") | .storyId' \
            "$_failures_file" 2>/dev/null | wc -l | tr -d ' ')
        if [ "${_prior_cap_count:-0}" -ge 3 ]; then
            log "  Coordinator[L1]: story $story_id has ${_prior_cap_count} prior capability failures — story may need decomposition (too many ACs for any single invocation)"
            # Cross-run KB synthesis: emit a pattern entry after 3+ capability failures
            # so future runs benefit from the accumulated failure pattern.
            #
            # OFF BY DEFAULT (2026-08-04). This is cross-run GROWTH by design, and the KB
            # is injected into writer prompts — so an entry written here teaches every
            # later agent. Until the pipeline is stable the KB starts fresh every run
            # (lib/kb-canonical.sh restores it from KB.md.original), which would discard
            # this entry anyway; writing it while claiming "future runs benefit" would be
            # a false claim in the log. Re-enable deliberately with
            # EPAM_KB_CROSS_RUN_SYNTHESIS=1 once cross-run learning is wanted again.
            if [ "${EPAM_KB_CROSS_RUN_SYNTHESIS:-0}" = "1" ]; then
            local _kb_file="$AUTOMATION_DIR/agents/KB.md"
            local _today; _today=$(date +'%Y-%m-%d')
            local _kb_entry_marker="KB-PERSIST-${story_id}"
            if [ -f "$_kb_file" ] && ! grep -q "$_kb_entry_marker" "$_kb_file" 2>/dev/null; then
                local _ac_count
                _ac_count=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | (.acceptanceCriteria // []) | length' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "unknown")
                {
                    printf '\n## %s -- %s\n\n' "$_kb_entry_marker" "$_today"
                    printf '**Category:** orchestration\n'
                    printf '**AgentRole:** any\n'
                    printf '**Tags:** inference-ladder, story-decomposition, capability-failure\n'
                    printf '**Trigger:** cross-run-synthesis\n'
                    printf '**StoryRef:** %s\n\n' "$story_id"
                    printf 'Story %s has failed %s times with capability class (max iterations / empty output). ' "$story_id" "$_prior_cap_count"
                    printf 'It has %s ACs. Model escalation alone has not resolved this — the story likely needs to be ' "$_ac_count"
                    printf 'decomposed into smaller children (≤8 ACs each) before the next run. '
                    printf 'OpenSpec/SpecKit should split this story at Step 0 in the next pipeline run.\n'
                } > /dev/null
                # NOT PERSISTED. This wrote a "cross-run" KB entry that nothing ever cleared, so
                # a conclusion drawn about one run's code was injected as current fact into every
                # later run. Operator 2026-08-12: no lingering anything may skew a run.
                log "  Coordinator[L1]: capability pattern noted for $story_id (${_prior_cap_count} failures) — this run only, not persisted"
            fi
            else
                log "  Coordinator[L1]: cross-run KB synthesis disabled (EPAM_KB_CROSS_RUN_SYNTHESIS=0) — $story_id has ${_prior_cap_count} capability failures, not persisted to the KB"
            fi
        fi
    fi
}

# _tool_recipe_reinvokes_test_cmd <recipe> <test_cmd>
# Deterministic pre-check for a dynamic-tool recipe re-running the project's
# OWN configured test command (e.g. "npm test") as part of its own recipe.
#
# Root cause this closes (found live, 2026-07-11/12, tier3-travel-app run,
# SKY-004-test): a dynamic tool (build-before-test.sh) whose stated purpose
# was "ensure the build runs before tests" wrote a recipe of
# `npm run build && npx vitest run` — independently re-invoking the FULL test
# suite a second time, outside the orchestrator's own dedicated, captured
# `run_external_verification()` test run. That duplicate, uncaptured
# invocation is a real risk: any stray output it produces (or any process it
# leaves running) is NOT isolated from the orchestrator's own subsequent
# capture of $test_output, which is fed directly into the failure-analyst's
# next diagnosis as trusted ground truth. A tool's job is the ONE mechanical
# step it was written for (installing a dependency, running a build) — never
# a second, uncoordinated run of the test suite itself.
#
# Generic/config-driven, not hardcoded to any test runner: compares the
# recipe against THIS project's own resolved test command (passed in from
# run_external_verification's LAST_TEST_CMD), not a fixed "vitest"/"jest"
# pattern list.
_tool_recipe_reinvokes_test_cmd() {
    local recipe="$1"
    local test_cmd="${2:-}"
    [ -z "$test_cmd" ] && return 1
    echo "$recipe" | grep -qF -- "$test_cmd" && return 0
    return 1
}

# run_diagnosis_groundedness_check <story_id> <diagnosis>
# Advisory-only (2026-07-12): scores the FailureAnalyst's own diagnosis
# against the real failure log (VERIFICATION_FAILURE) using DeepEval's
# GEval metric as an LLM judge over OpenRouter -- see
# orchestrations/scripts/tools/diagnosis-groundedness-check.py for the full
# rationale (a live incident already on record for this pipeline: the
# analyst confidently asserted a root cause that was flatly wrong, and every
# retry then "fixed" the wrong thing because the diagnosis guiding it was
# false). Logs to orchestrations/logs/failure-diagnosis-groundedness.jsonl
# so a future decision to make this blocking is backed by measurement, not
# guesswork -- it NEVER alters target/patch handling, and the call site
# deliberately does not capture this function's return value.
# Silently no-ops (no warning spam) if the venv/script/API key isn't
# available, so this optional tooling can never break the retry loop.
run_diagnosis_groundedness_check() {
    local story_id="$1"
    local diagnosis="$2"
    is_truthy "${SKIP_DIAGNOSIS_GROUNDEDNESS_CHECK:-}" && return 0

    local _dgc_script="${SCRIPT_DIR}/tools/diagnosis-groundedness-check.py"
    local _dgc_venv_python="${SCRIPT_DIR}/tools/.venv-deepeval/bin/python"
    [ -x "$_dgc_venv_python" ] || return 0
    [ -f "$_dgc_script" ] || return 0

    local _dgc_input
    # --rawfile, not --arg: VERIFICATION_FAILURE carries a whole suite dump since the input
    # caps were removed, and argv tops out at ARG_MAX. With --arg, jq exited 126 and the
    # empty result was read as "nothing to diagnose" one line below — a gate that fails OPEN
    # precisely when the evidence is largest.
    local _dgc_dir; _dgc_dir=$(mktemp -d "${TMPDIR:-/tmp}/dgc-XXXXXX")
    printf '%s' "${VERIFICATION_FAILURE:-}" > "$_dgc_dir/log"
    local _dgc_err="$_dgc_dir/err"
    if ! _dgc_input=$(jq -n --arg diag "$diagnosis" --rawfile log "$_dgc_dir/log" \
        '{diagnosis: $diag, log_excerpt: $log}' 2>"$_dgc_err"); then
        warning "  [DiagnosisGate] could not build input (jq failed): $(cat "$_dgc_err" 2>/dev/null)"
        rm -rf "$_dgc_dir"
        return 0
    fi
    rm -rf "$_dgc_dir"
    [ -z "$_dgc_input" ] && return 0

    local _dgc_result
    _dgc_result=$(echo "$_dgc_input" | timeout 30 "$_dgc_venv_python" "$_dgc_script" 2>/dev/null)
    [ -z "$_dgc_result" ] && return 0
    echo "$_dgc_result" | jq empty 2>/dev/null || return 0

    # NOTE: `.skipped // true` would be wrong here -- jq's `//` alternative
    # operator treats a literal `false` value as falsy too (not just null/
    # absent), so it would silently collapse a genuine {"skipped": false}
    # result into "true" and this check would NEVER accept a real
    # evaluation. `has("skipped")` distinguishes "field present and false"
    # from "field absent" correctly.
    local _dgc_skipped
    _dgc_skipped=$(echo "$_dgc_result" | jq -r 'if has("skipped") then .skipped else true end' 2>/dev/null)
    [ "$_dgc_skipped" = "true" ] && return 0

    local _dgc_verdict _dgc_score
    _dgc_verdict=$(echo "$_dgc_result" | jq -r '.verdict // "unknown"' 2>/dev/null)
    _dgc_score=$(echo "$_dgc_result" | jq -r '.score // 0' 2>/dev/null)
    if [ "$_dgc_verdict" = "ungrounded" ]; then
        warning "  [DiagnosisGroundedness] $story_id: diagnosis may be ungrounded (score=$_dgc_score) — advisory only, not blocking"
    else
        log "  [DiagnosisGroundedness] $story_id: diagnosis grounded (score=$_dgc_score)"
    fi

    mkdir -p "${LOG_DIR}" 2>/dev/null
    # -c (compact) is required here, not cosmetic: without it jq pretty-
    # prints each object across multiple lines, breaking the "one JSON
    # object per line" contract every JSONL consumer (line-based tailing,
    # wc -l counting, streaming parsers) depends on -- found live 2026-07-12
    # while building a report script against this exact file.
    jq -nc --arg story "$story_id" --arg diag "$diagnosis" --argjson result "$_dgc_result" --arg ts "$(date -Iseconds)" \
        '{storyId: $story, diagnosis: $diag, timestamp: $ts} + $result' \
        >> "${LOG_DIR}/failure-diagnosis-groundedness.jsonl" 2>/dev/null || true
    return 0
}

# run_failure_analyst <story_id> <output_file> <retry_num>
# Layer 3 (self-heal): AI reads the test failure, diagnoses root cause, then patches
# PRD ACs (for ambiguous specs) or injects skill guidance into the coordinator
# amendment (for bad coding patterns) — before the next retry.
# Only meaningful when VERIFICATION_FAILURE is set (external test suite failed).
# Uses ORCH_GATE_PROVIDER/ORCH_GATE_MODEL (same gate as assess_model_escalation).
# _gate_call_failure_detail <stderr_file>
#
# WHY THE GATE CALL FAILED, IN THE RUN LOG, WHERE THE OPERATOR IS LOOKING.
#
# The analyst's stderr is appended to the story's output file under logs/claude_outputs/ — a path
# nothing points the operator at. So a failed gate call reported "no response to parse" and nothing
# else, while the provider's own explanation sat on disk.
#
# Live 2026-09-11 (openrouter run 20260910T222155Z): three analyst calls failed across two models
# and the run log gave no cause. The real one was
#
#   OpenRouter API error: 404 {"error":{"message":"No endpoints found for z-ai/glm-5.3.",
#    "metadata":{"routing_funnel":[... {"step":"Filter by Fallback","endpoint_count":0}]}}}
#
# — our own provider pin eliminating every surviving endpoint. Reading only the run log, that was
# diagnosed twice, wrongly and confidently, before the funnel was found. A message that hides the
# cause does not merely cost time; it manufactures wrong answers.
#
# Prefers the most specific line available, and NEVER invents one: a call that produced no error
# text says exactly that. Bounded, because a gate's stderr can be megabytes and the run log is read
# by a human.
_gate_call_failure_detail() {
    local _err_file="${1:-}" _line=""
    if [ -n "$_err_file" ] && [ -s "$_err_file" ]; then
        # The provider's own error first; then any error line; then the last non-empty line.
        _line=$(grep -aoE '[A-Za-z/]*API error: [0-9]{3}.*' "$_err_file" 2>/dev/null | tail -1)
        [ -z "$_line" ] && _line=$(grep -aiE 'error|refus|exhausted|denied|unauthor' "$_err_file" 2>/dev/null | tail -1)
        [ -z "$_line" ] && _line=$(grep -av '^[[:space:]]*$' "$_err_file" 2>/dev/null | tail -1)
    fi
    if [ -z "$_line" ]; then
        printf 'the call produced no error output at all (0 bytes) — nothing to report but the failure itself'
        return 0
    fi
    # One line, bounded. tr first so a multi-line JSON payload cannot break the log line.
    printf '%s' "$_line" | tr -d '\r' | tr '\n' ' ' | cut -c1-400
}

run_failure_analyst() {
    local story_id="$1"
    local output_file="${2:-/dev/null}"
    local retry_num="${3:-0}"

    # WHICH SEAM THIS IS — declared ONCE, and it must match a key in the profiles registry or the
    # ladder resolves no tier and the agent silently never escalates.
    #
    # Live defect, same day it was written: two call sites in this function passed
    # "failure-analyst", which the registry does not contain. _agent_ladder_tier returned empty,
    # agent_ladder_model handed back the current model unchanged, and the analyst's ladder — the
    # whole point of the change — did nothing. The harness that "verified" it passed the real
    # archetype name, so it never saw what production actually sent.
    local _ANALYST_SEAM="impl-failure-analyst"

    # Only analyze test-suite failures; missing-deliverable failures lack useful output
    [ -z "${VERIFICATION_FAILURE:-}" ] && return 0

    local gate_provider="${ORCH_GATE_PROVIDER:-}"
    # Failure analyst uses ESCALATION_MODEL (z-ai/glm-5.2) when set — never openrouter chat models;
    # falls back to ORCH_GATE_MODEL only when no escalation model is configured.
    # THE SEAM'S LADDER, not a run-wide pin. ORCH_GATE_MODEL reached every seam that could
    # not resolve one itself; .env set it to z-ai/glm-5.2, so a mockserver run asked for an
    # OpenRouter model. An unresolvable seam yields empty and the caller refuses, as before.
    local gate_model="${ESCALATION_MODEL:-$(seam_model_or_fail "agent-failure-analyst" 2>/dev/null || true)}"
    if [ -z "$gate_provider" ]; then
        log "  [FailureAnalyst] No gate provider configured — skipping self-heal analysis"
        return 0
    fi

    log "  [FailureAnalyst] Analyzing test failure for $story_id (gate=$gate_model)..."
    "$SCRIPT_DIR/update-monitor.sh" story_start "failure-analyst" "main" "failure-analyst" "Failure Analyst: $story_id" \
        "${STORY_PROVIDER:-}" "${STORY_MODEL:-}" 2>/dev/null || true
    "$SCRIPT_DIR/update-monitor.sh" event "self_heal_start" \
        "Self-heal started for $story_id (attempt $retry_num, gate=$gate_model)" \
        "$story_id" "main" "failure-analyst" "$gate_model" "$gate_provider" 2>/dev/null || true

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"

    # Build spec context: prefer testCriteria.facts (ground truth from TC writer) over ACs
    local story_acs story_role skill_addendum profiles_file
    local tc_facts_raw
    tc_facts_raw=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .testCriteria.facts // [] | to_entries | map("TC\(.key+1): \(.value)") | join("\n")' \
        "$prd_target" 2>/dev/null || echo "")
    # A BLOCK OR NOTHING. The heading travels with the criteria (lib/story-acs-block.sh): TC facts
    # when the story has them, else its acceptance criteria (greenfield), else nothing — a
    # brownfield story gets no empty "criteria" heading (ea920ee7), and never a "(no ACs found)".
    if [ -n "$tc_facts_raw" ]; then
        story_acs="$(printf 'CURRENT TEST CRITERIA (TC facts):\n%s\n\n' "$tc_facts_raw")"
    else
        story_acs=$(story_acs_block "$prd_target" "$story_id" "CURRENT TEST CRITERIA (acceptance criteria):")
    fi
    story_role=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' \
        "$prd_target" 2>/dev/null || echo "")
    profiles_file="$(dirname "$SCRIPT_DIR")/agents/profiles.json"
    skill_addendum=""
    if [ -f "$profiles_file" ]; then
        # profiles.json is flat {role: "prompt string"} — extract [Self-Heal] lines only
        skill_addendum=$(jq -r --arg role "$story_role" '.[$role] // ""' "$profiles_file" 2>/dev/null | \
            grep '\[Self-Heal\]' || echo "")
    fi

    # Load failure-analyst profile from profiles.json (role-level instructions)
    local analyst_profile=""
    if [ -f "$profiles_file" ]; then
        analyst_profile=$(require_profile "failure-analyst" "$profiles_file" || true)
    fi

    # Dependency contract injection (added 2026-07-07): same ground-truth
    # mechanism already proven for build_implementation_prompt() — the
    # failure-analyst was previously diagnosing failures with NO visibility
    # into a dependency's REAL exports/signatures, and got it wrong on a live
    # run: it called a casing-typo'd import ("SkyScannerClient" vs the real
    # "SkyscannerClient") a "default vs named export mismatch," which is
    # simply false — the class IS correctly a named export, just mis-cased.
    # Every retry (including the strongest configured model) then "fixed" the
    # wrong thing because the diagnosis GUIDING it was wrong. A stronger model
    # can't out-reason a false premise it's been handed as ground truth.
    local dependency_contracts=""
    local _fa_dep_ids_json
    _fa_dep_ids_json=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | [(.dependencies // .technicalNotes.dependsOn // [])[]? // empty]' \
        "$prd_target" 2>/dev/null || echo "[]")
    local _fa_dep_id
    while IFS= read -r _fa_dep_id; do
        [ -z "$_fa_dep_id" ] && continue
        local _fa_contract_file="$PROJECT_ROOT/.contracts/${_fa_dep_id}.md"
        if [ -f "$_fa_contract_file" ]; then
            dependency_contracts="${dependency_contracts}
### Contract: ${_fa_dep_id}
$(cat "$_fa_contract_file")
"
        fi
    done < <(echo "$_fa_dep_ids_json" | jq -r '.[]?' 2>/dev/null)

    # Third-party package grounding — the SAME defect this call exists to catch
    # was itself caused by an ungrounded diagnosis: the analyst classified
    # "Config object doesn't match the SDK's Config type" as target=none
    # ("transient — retry with a stronger model") three times running, because
    # it had no more ability to see the SDK's real shape than the implementer
    # did. Ground it here too, from the same declared files, using the same
    # discovery this function's caller (build_implementation_prompt) already
    # runs — reuses .epam/dependency-check.json + .epam/contract-generation.json,
    # no manifest = no-op.
    local _fa_vendor_files_json _fa_vendor_file _fa_vendor_pkg
    _fa_vendor_files_json=$(jq -c --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.files // []' \
        "$prd_target" 2>/dev/null || echo "[]")
    if [ -n "${WORKTREE_MODE:-}" ] && [ -n "${MAIN_PROJECT_ROOT:-}" ]; then
        _fa_vendor_files_json="${_fa_vendor_files_json//${MAIN_PROJECT_ROOT}/${PROJECT_ROOT}}"
    fi
    while IFS= read -r _fa_vendor_file; do
        [ -z "$_fa_vendor_file" ] && continue
        local _fa_vendor_abs
        [[ "$_fa_vendor_file" = /* ]] && _fa_vendor_abs="$_fa_vendor_file" || _fa_vendor_abs="$PROJECT_ROOT/$_fa_vendor_file"
        _fa_vendor_abs="$(_resolve_deliverable_path "$_fa_vendor_abs" 2>/dev/null || echo "$_fa_vendor_abs")"
        [ -f "$_fa_vendor_abs" ] || continue
        while IFS= read -r _fa_vendor_pkg; do
            [ -z "$_fa_vendor_pkg" ] && continue
            local _fa_vendor_contract="$PROJECT_ROOT/.contracts/vendor-${_fa_vendor_pkg}.md"
            [ -f "$_fa_vendor_contract" ] || _generate_vendor_contract "$PROJECT_ROOT" "$_fa_vendor_pkg" 2>/dev/null
            if [ -f "$_fa_vendor_contract" ]; then
                dependency_contracts="${dependency_contracts}
### Vendor package: ${_fa_vendor_pkg}
$(cat "$_fa_vendor_contract")
"
            fi
        done < <(_discover_vendor_packages "$_fa_vendor_abs" 2>/dev/null)
    done < <(echo "$_fa_vendor_files_json" | jq -r '.[]?' 2>/dev/null)

    [ -z "$dependency_contracts" ] && dependency_contracts="(no dependency contracts available)"

    local analyst_prompt
    # THE ANALYST PROMPT IS A PROJECT-AUTHORITY FILE, never a heredoc in this engine.
    # orchestrations/prompts/templates/failure-analyst.json is the immutable generic source
    # it was minted from and is NEVER executed. A missing project prompt is a HARD FAILURE:
    # there is deliberately nothing to fall back to, because a silent degrade to a generic
    # template is how an engine-embedded prompt runs for a whole campaign unnoticed.
    #
    # Values go via a JSON file, not argv: they routinely carry newlines, quotes and
    # megabytes of test output. The renderer substitutes with a replacer FUNCTION, so a \$&
    # or \$1 inside a diff or a log is inserted literally instead of being read as a
    # replacement pattern.
    local _analyst_values _analyst_values_err
    _analyst_values=$(mktemp "${TMPDIR:-/tmp}/analyst-values-XXXXXX.json")
    _analyst_values_err="${_analyst_values}.err"

    # VIA --rawfile, NEVER argv.
    #
    # These values used to be passed with `jq --arg`, which puts every byte on the command
    # line. ARG_MAX is 2 MiB; a real suite failure dump exceeds it, so jq exited 126
    # ("Argument list too long"), the redirect wrote a 0-byte file, and `2>/dev/null` threw
    # the reason away. prompt-library then reported only "Unexpected end of JSON input" and
    # the analyst died — live, run 20260815T195931Z, on every retry of AMSD-2041.
    #
    # The caps that used to hide this (VERIFICATION_FAILURE:0:1000 and friends) were removed
    # deliberately: no agent input is cut mid-meaning. So the transport has to carry the
    # whole thing. --rawfile reads each value from a file and never touches argv.
    local _av_dir; _av_dir=$(mktemp -d "${TMPDIR:-/tmp}/analyst-args-XXXXXX")
    printf '%s' "${analyst_profile:-}"                  > "$_av_dir/profile"
    printf '%s' "${story_acs:-}"                        > "$_av_dir/acs"
    printf '%s' "${skill_addendum:-}"                   > "$_av_dir/addendum"
    printf '%s' "${dependency_contracts:-}"             > "$_av_dir/contracts"
    printf '%s' "${VERIFICATION_FAILURE:-}"             > "$_av_dir/vf"
    _attempt_change_summary "$story_id"                 > "$_av_dir/changes" 2>/dev/null || : > "$_av_dir/changes"
    _analyst_write_scope "$story_id"                    > "$_av_dir/scope"   2>/dev/null || : > "$_av_dir/scope"
    _analyst_shared_criteria "$story_id"                > "$_av_dir/shared"  2>/dev/null || : > "$_av_dir/shared"
    _analyst_healing_history "$story_id"                > "$_av_dir/history" 2>/dev/null || : > "$_av_dir/history"

    # THE TEMPLATE DECLARES __MANIFEST_FILE__ AND NOTHING SUPPLIED IT.
    #
    # Live 2026-08-18: the analyst could not build its prompt on any of the twelve writer attempts
    # — "missing values for: __MANIFEST_FILE__" — so the one component whose job is to diagnose a
    # failing writer was blind for the whole story, on both lanes, in the run where it was needed
    # most. The value is the codeline's manifest name, read from the project's own dependency
    # declaration rather than named here, so a project on another stack answers for itself.
    local _analyst_manifest_file=""
    if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] && [ -f "${EPAM_PROJECT_CONFIG_DIR}/dependency-check.json" ]; then
        _analyst_manifest_file=$(jq -r '.manifestFile // ""' "${EPAM_PROJECT_CONFIG_DIR}/dependency-check.json" 2>/dev/null || echo "")
    fi
    [ -n "$_analyst_manifest_file" ] || _analyst_manifest_file="the codeline's dependency manifest"

    # The same declaration the checker enforces (config/self-heal.json), so the analyst writes
    # within the limit rather than discovering it as a rejection.
    local _analyst_skill_note_max; _analyst_skill_note_max=$(_skill_note_max_chars) || return 1

    if ! jq -n \
        --rawfile profile "$_av_dir/profile" \
        --arg story_id "$story_id" \
        --arg story_role "$story_role" \
        --rawfile story_acs "$_av_dir/acs" \
        --rawfile skill_addendum "$_av_dir/addendum" \
        --rawfile dependency_contracts "$_av_dir/contracts" \
        --rawfile verification_failure "$_av_dir/vf" \
        --rawfile attempt_changes "$_av_dir/changes" \
        --rawfile write_scope "$_av_dir/scope" \
        --rawfile shared_criteria "$_av_dir/shared" \
        --rawfile healing_history "$_av_dir/history" \
        --arg manifest_file "$_analyst_manifest_file" \
        --arg skill_note_max "$_analyst_skill_note_max" \
        '{"__ANALYST_PROFILE__":$profile,
          "__MANIFEST_FILE__":$manifest_file,
          "__SKILL_NOTE_MAX__":$skill_note_max,
          "__STORY_ID__":$story_id,
          "__STORY_ROLE__":$story_role,
          "__STORY_ACS__":$story_acs,
          "__SKILL_ADDENDUM__":$skill_addendum,
          "__DEPENDENCY_CONTRACTS__":$dependency_contracts,
          "__VERIFICATION_FAILURE__":$verification_failure,
          "__ATTEMPT_CHANGES__":$attempt_changes,
          "__WRITE_SCOPE__":$write_scope,
          "__SHARED_CRITERIA__":$shared_criteria,
          "__HEALING_HISTORY__":$healing_history}' > "$_analyst_values" 2>"$_analyst_values_err"; then
        # NOT SILENT. An unbuildable values file is a defect to report, not an empty file to
        # hand downstream so it can fail with a parse error that names nothing.
        error "  [FailureAnalyst] cannot BUILD values file (jq failed): $(cat "$_analyst_values_err" 2>/dev/null)"
        rm -rf "$_av_dir"; rm -f "$_analyst_values" "$_analyst_values_err"
        return 1
    fi
    rm -rf "$_av_dir"

    if ! analyst_prompt=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/prompt-library.js" \
            render failure-analyst "${EPAM_PROJECT_CONFIG_DIR:-}" "$_analyst_values" 2>"$_analyst_values_err"); then
        error "  [FailureAnalyst] cannot build prompt: $(cat "$_analyst_values_err" 2>/dev/null | head -c 500)"
        rm -f "$_analyst_values" "$_analyst_values_err"
        return 1
    fi
    rm -f "$_analyst_values" "$_analyst_values_err"

    local analyst_raw="" analyst_json="" _analyst_call_ok="false"
    # Which attempt the unusable-answer branch already recorded a rung for, so the call-failure
    # branch below does not record a second one for the same failure.
    local _analyst_stepped_attempt=""
    local _analyst_max_attempts=3 _analyst_attempt=1
    local _analyst_json_result
    _analyst_json_result=$(mktemp /tmp/analyst-result-XXXXXX.json)
    while [ "$_analyst_attempt" -le "$_analyst_max_attempts" ]; do
        # Tool access (found live, 2026-07-31): the analyst was the ONLY gate
        # agent in this file with no way to verify a claim against reality —
        # AI_GATE_ALLOW_TOOLS=1 is set at exactly two OTHER call sites
        # (run_plan_mode, run_pre_phase_assessment); this one hand-rolled its
        # own invocation and never got it. It diagnosed a fully-installed,
        # correctly-imported internal package (@metrolinx/cx-shared) as "not
        # installed" three times, HEALING_BROKEN fired — a guess stated with
        # full confidence from three pre-injected text blocks and nothing
        # else. Reuses ORCH_GATE_ALLOWED_TOOLS VERBATIM — the same shared,
        # config-driven, read-only-by-default allowlist (bash,read_file,
        # list_files,search; no write_file) every other gate agent already
        # draws from. No analyst-specific tool list.
        #
        # Bounded like the post-phase assessment (same night, same reasoning):
        # this runs on the critical path of EVERY retry, so an unbounded grant
        # repeats the 184k-token-review mistake at a worse multiplier. 6
        # mirrors that fix's own measured number — enough to check one
        # file/directory, not enough to re-explore the codebase.
        if analyst_raw=$(echo "$analyst_prompt" | \
                EPAM_AGENT_NAME="${_ANALYST_SEAM}" EPAM_STORY_ID="${story_id}" \
                AI_PROVIDER="$gate_provider" \
                AI_MODEL="$gate_model" \
                EPAM_CLI="$EPAM_CLI" \
                ORCH_JSON_RESULT="$_analyst_json_result" \
                EPAM_REASONING_EFFORT="high" \
                EPAM_TEMPERATURE="0.7" \
                AI_GATE_ALLOW_TOOLS=1 \
                EPAM_ALLOWED_TOOLS="$ORCH_GATE_ALLOWED_TOOLS" \
                EPAM_MAX_TOOL_CALLS="${FAILURE_ANALYST_MAX_TOOL_CALLS:-24}" \
                bash "$SCRIPT_DIR/ai-run.sh" --provider "$gate_provider" \
                ${gate_model:+--model "$gate_model"} \
                2>>"$output_file"); then
            _analyst_call_ok="true"

            # Extract first valid JSON object (handles nested structures via Python)
            analyst_json=$(echo "$analyst_raw" | python3 "$SCRIPT_DIR/lib/handlers/failure-analyst-json.py" 2>/dev/null || echo "")

            if [ -n "$analyst_json" ] && echo "$analyst_json" | jq empty 2>/dev/null; then
                break
            fi
            analyst_json=""
            # AN EMPTY RESPONSE IS NOT A MALFORMED ONE, AND BOTH USED TO SAY "could not parse".
            #
            # Live 2026-08-12: the analyst failed on roughly half its first calls and the
            # result files on disk were 0 BYTES — the model returned nothing at all. From the
            # log that was indistinguishable from prose or a truncated object, so diagnosing it
            # meant going to /tmp and measuring file sizes. The parser is not at fault: it tries
            # a whole-text parse and then brace-matches for the first balanced object, so if it
            # finds nothing there was nothing to find. Name which of the two happened, and show
            # what came back when there was something.
            local _analyst_snippet
            _analyst_snippet=$(printf '%s' "${analyst_raw:-}" | tr -d '\r' | tr '\n' ' ')
            if [ "$_analyst_attempt" -lt "$_analyst_max_attempts" ]; then
                # AN ANSWER THIS UNUSABLE IS EVIDENCE ABOUT THE MODEL. Re-asking the same one buys
                # a copy of the same non-answer — the reasoning the story ladder already applies,
                # which gate agents had no way to reach. The analyst now climbs the ladder its own
                # archetype declares; lib/agent-ladder.sh explains why nothing here names a model.
                agent_ladder_record_failure "$_ANALYST_SEAM" "$story_id"
                # ONE RUNG PER FAILED ATTEMPT. The call-failure block further down escalates on
                # exactly the condition this branch guarantees -- analyst_json is set to "" three
                # lines above -- so both fired on every unusable answer and the analyst climbed
                # two rungs for one failure, exhausting its ladder in half the attempts it was
                # given. Saying which attempt already stepped is what keeps them exclusive; the
                # other block is still needed on its own path, where the CALL failed and this
                # branch never runs.
                _analyst_stepped_attempt="$_analyst_attempt"
                local _analyst_next
                _analyst_next=$(agent_ladder_model "$_ANALYST_SEAM" "$story_id" "${gate_model:-}")
                if [ -n "$_analyst_next" ] && [ "$_analyst_next" != "${gate_model:-}" ]; then
                    warning "  [FailureAnalyst] escalating the ANALYST: ${gate_model:-unknown} → ${_analyst_next} (its answer was unusable, so the next attempt asks a different model)"
                    gate_model="$_analyst_next"
                elif agent_ladder_exhausted "$_ANALYST_SEAM" "$story_id" "${gate_model:-}"; then
                    warning "  [FailureAnalyst] the analyst is at the top of its declared ladder (${gate_model:-unknown}) — retrying the same model, which is the last one available to it"
                fi
                if [ -z "$(printf '%s' "${analyst_raw:-}" | tr -d '[:space:]')" ]; then
                    warning "  [FailureAnalyst] Analyst returned an EMPTY response (0 bytes) from ${gate_model:-unknown} — retrying gate call (attempt $((_analyst_attempt + 1))/${_analyst_max_attempts})"
                else
                    warning "  [FailureAnalyst] Analyst response contained no JSON object — retrying gate call (attempt $((_analyst_attempt + 1))/${_analyst_max_attempts}). It began: ${_analyst_snippet:0:200}"
                fi
            fi
        else
            # NEVER SILENT. This branch set _analyst_call_ok=false and logged nothing, so an
            # unreachable or erroring gate model left NO trace in the run log — the operator
            # saw a story retry with no guidance and no reason given.
            _analyst_call_ok="false"
            warning "  [FailureAnalyst] Gate invocation FAILED for ${gate_model:-unknown} (attempt ${_analyst_attempt}/${_analyst_max_attempts}) — $(_gate_call_failure_detail "${output_file:-}")"
        fi

        # RETRYING A MODEL THAT SAID NOTHING IS NOT A RECOVERY STRATEGY.
        #
        # gate_model was chosen once and never reconsidered, so a model returning 0 bytes got
        # called three times and the story then retried with NO diagnosis. Live 2026-08-12:
        # z-ai/glm-5.2 returned empty on roughly half its first calls and burned one whole
        # analyst cycle that way. Three identical calls to a silent endpoint is exactly the
        # gamble the ladder exists to avoid.
        #
        # Nothing new is built: get_model_ladder_step already resolves the next rung from
        # EPAM_MODEL_LADDER_<TIER>, this file's own loader exports those from llm-settings.json,
        # and the high ladder already carries z-ai/glm-5.2 -> moonshotai/kimi-k3. The tier comes
        # from THIS SEAM'S declared profile, not from a literal here.
        #
        # The ANALYST's model moves; the writer's does not. The writer is not what failed, and
        # spending the story's escalation budget on a diagnostic problem is the category error
        # that HealingBroken already makes.
        # THE SHARED HANDLER, ONCE. This block used to re-implement the escalation that
        # lib/agent-ladder.sh already performs a few lines above — reading the tier itself with the
        # agent's name and a literal tier as the fallback, both spelled out twice. Two copies of an
        # escalation is one defect waiting: they drift, and the one that runs is whichever the
        # control flow reaches first.
        #
        # agent_ladder_model resolves the tier from the agent's ARCHETYPE through the seam, so no
        # agent name and no tier name is needed here at all.
        if [ -z "$analyst_json" ] && [ "$_analyst_attempt" -lt "$_analyst_max_attempts" ] \
           && [ "${_analyst_stepped_attempt:-}" != "$_analyst_attempt" ]; then
            local _next_gate_model
            agent_ladder_record_failure "$_ANALYST_SEAM" "$story_id"
            _next_gate_model=$(agent_ladder_model "$_ANALYST_SEAM" "$story_id" "${gate_model:-}")
            if [ -n "$_next_gate_model" ] && [ "$_next_gate_model" != "${gate_model:-}" ]; then
                warning "  [FailureAnalyst] escalating analyst model '${gate_model}' → '${_next_gate_model}' — the previous rung produced nothing usable"
                gate_model="$_next_gate_model"
            else
                warning "  [FailureAnalyst] analyst ladder exhausted at '${gate_model}' — retrying the same rung"
            fi
        fi
        _analyst_attempt=$((_analyst_attempt + 1))
    done

    if [ "$_analyst_call_ok" = "true" ]; then
        if [ -n "$analyst_json" ] && echo "$analyst_json" | jq empty 2>/dev/null; then
            local diagnosis target skill_note reason patch_count _profile_updated
            diagnosis=$(echo "$analyst_json" | jq -r '.diagnosis // "unknown"' 2>/dev/null || echo "unknown")
            target=$(echo "$analyst_json" | jq -r '.target // "none"' 2>/dev/null || echo "none")
            skill_note=$(echo "$analyst_json" | jq -r '.skill_note // ""' 2>/dev/null || echo "")
            [ -n "$skill_note" ] && skill_note=$(_ensure_imperative_opener "$skill_note")
            reason=$(echo "$analyst_json" | jq -r '.reason // ""' 2>/dev/null || echo "")
            local analyst_evidence analyst_expected
            analyst_evidence=$(echo "$analyst_json" | jq -r '.evidence // ""' 2>/dev/null || echo "")
            analyst_expected=$(echo "$analyst_json" | jq -r '.expected_outcome // ""' 2>/dev/null || echo "")
            local tool_name tool_purpose tool_recipe
            tool_name=$(echo "$analyst_json" | jq -r '.tool_spec.name // ""' 2>/dev/null || echo "")
            tool_purpose=$(echo "$analyst_json" | jq -r '.tool_spec.purpose // ""' 2>/dev/null || echo "")
            tool_recipe=$(echo "$analyst_json" | jq -r '.tool_spec.recipe // ""' 2>/dev/null || echo "")
            patch_count=0
            _profile_updated="false"

            log "  [FailureAnalyst] Diagnosis: $diagnosis"
            log "  [FailureAnalyst] Target=$target — $reason"

            run_diagnosis_groundedness_check "$story_id" "$diagnosis"

            case "$target" in
                prd)
                    local patches_json
                    patches_json=$(echo "$analyst_json" | jq -c '.ac_patches // []' 2>/dev/null || echo "[]")
                    if [ "$patches_json" != "[]" ]; then
                        log "  [FailureAnalyst] Patching PRD ACs for $story_id..."
                        # Snapshot ACs before patching so reviewer can compare and we can revert
                        local _ac_before _ac_after
                        _ac_before=$(jq -c --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .acceptanceCriteria' \
                            "$prd_target" 2>/dev/null || echo "[]")
                        while IFS= read -r patch; do
                            [ -z "$patch" ] && continue
                            local idx new_text
                            idx=$(echo "$patch" | jq -r '.index // ""' 2>/dev/null || echo "")
                            new_text=$(echo "$patch" | jq -r '.new_text // ""' 2>/dev/null || echo "")
                            if [ -n "$idx" ] && [ -n "$new_text" ]; then
                                ( flock -w 10 200 || { error "  [FailureAnalyst] Could not acquire lock on $prd_target"; return 1; }
                                python3 - "$new_text" << PYEOF 2>&1 | while IFS= read -r line; do log "  [FailureAnalyst] $line"; done
import json, sys, os
prd_path = '$prd_target'
story_id = '$story_id'
idx = $idx
new_text = sys.argv[1]
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == story_id:
        acs = s.get('acceptanceCriteria', [])
        if 0 <= idx < len(acs):
            old = acs[idx]
            acs[idx] = new_text
            print(f'AC{idx+1} patched: {repr(old[:50])} → {repr(new_text[:50])}')
        else:
            print(f'AC index {idx} out of range (story has {len(acs)} ACs)', file=sys.stderr)
        break
_tmp_prd_path = prd_path + '.tmp'
with open(_tmp_prd_path, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(_tmp_prd_path, prd_path)
PYEOF
                                ) 200>"${prd_target}.lock"
                                patch_count=$((patch_count + 1))
                            fi
                        done < <(echo "$patches_json" | jq -c '.[]' 2>/dev/null)
                        _ac_after=$(jq -c --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .acceptanceCriteria' \
                            "$prd_target" 2>/dev/null || echo "[]")
                        # Reviewer gate — revert on fail to prevent corrupt ACs reaching agent
                        local _review_verdict
                        _review_verdict=$(run_prd_change_reviewer "$story_id" "ac_patch" "$_ac_before" "$_ac_after")
                        if [ "$_review_verdict" = "fail" ]; then
                            warning "  [FailureAnalyst] AC patch rejected by reviewer — reverting to original ACs"
                            ( flock -w 10 200 || { error "  [FailureAnalyst] Could not acquire lock on $prd_target"; return 1; }
                            python3 - "$_ac_before" << PYEOF 2>/dev/null || true
import json, sys, os
prd_path = '$prd_target'
story_id = '$story_id'
acs = json.loads(sys.argv[1])
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == story_id:
        s['acceptanceCriteria'] = acs
        break
_tmp_prd_path = prd_path + '.tmp'
with open(_tmp_prd_path, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(_tmp_prd_path, prd_path)
PYEOF
                            ) 200>"${prd_target}.lock"
                            patch_count=0
                        else
                            log "  [FailureAnalyst] Applied $patch_count AC patch(es) — retry will use updated spec"
                        fi
                    else
                        log "  [FailureAnalyst] target=prd but no ac_patches provided — no change made"
                    fi
                    ;;
                tc)
                    local tc_patches_json
                    tc_patches_json=$(echo "$analyst_json" | jq -c '.tc_patches // []' 2>/dev/null || echo "[]")
                    if [ "$tc_patches_json" != "[]" ]; then
                        log "  [FailureAnalyst] Patching testCriteria facts for $story_id..."
                        # Snapshot TC facts before patching for reviewer and revert
                        local _tc_before _tc_after
                        _tc_before=$(jq -c --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .testCriteria.facts // []' \
                            "$prd_target" 2>/dev/null || echo "[]")
                        while IFS= read -r patch; do
                            [ -z "$patch" ] && continue
                            local tc_idx tc_new_text
                            tc_idx=$(echo "$patch" | jq -r '.index // ""' 2>/dev/null || echo "")
                            tc_new_text=$(echo "$patch" | jq -r '.new_text // ""' 2>/dev/null || echo "")
                            if [ -n "$tc_idx" ] && [ -n "$tc_new_text" ]; then
                                ( flock -w 10 200 || { error "  [FailureAnalyst] Could not acquire lock on $prd_target"; return 1; }
                                python3 - "$tc_new_text" << PYEOF 2>&1 | while IFS= read -r line; do log "  [FailureAnalyst] $line"; done
import json, sys, os
prd_path = '$prd_target'
story_id = '$story_id'
idx = $tc_idx
new_text = sys.argv[1]
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == story_id:
        tc = s.setdefault('testCriteria', {})
        facts = tc.setdefault('facts', [])
        if 0 <= idx < len(facts):
            old = facts[idx]
            facts[idx] = new_text
            print(f'TC fact {idx+1} patched: {repr(old[:50])} → {repr(new_text[:50])}')
        else:
            print(f'TC index {idx} out of range (story has {len(facts)} facts)', file=sys.stderr)
        break
_tmp_prd_path = prd_path + '.tmp'
with open(_tmp_prd_path, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(_tmp_prd_path, prd_path)
PYEOF
                                ) 200>"${prd_target}.lock"
                                patch_count=$((patch_count + 1))
                            fi
                        done < <(echo "$tc_patches_json" | jq -c '.[]' 2>/dev/null)
                        _tc_after=$(jq -c --arg id "$story_id" \
                            '.stories[] | select(.id == $id) | .testCriteria.facts // []' \
                            "$prd_target" 2>/dev/null || echo "[]")
                        # Reviewer gate — revert on fail to prevent bad TCs reaching test agent
                        local _tc_review_verdict
                        _tc_review_verdict=$(run_prd_change_reviewer "$story_id" "tc_patch" "$_tc_before" "$_tc_after")
                        if [ "$_tc_review_verdict" = "fail" ]; then
                            warning "  [FailureAnalyst] TC patch rejected by reviewer — reverting to original facts"
                            ( flock -w 10 200 || { error "  [FailureAnalyst] Could not acquire lock on $prd_target"; return 1; }
                            python3 - "$_tc_before" << PYEOF 2>/dev/null || true
import json, sys, os
prd_path = '$prd_target'
story_id = '$story_id'
facts = json.loads(sys.argv[1])
with open(prd_path) as f:
    prd = json.load(f)
for s in prd.get('stories', []):
    if s.get('id') == story_id:
        s.setdefault('testCriteria', {})['facts'] = facts
        break
_tmp_prd_path = prd_path + '.tmp'
with open(_tmp_prd_path, 'w') as f:
    json.dump(prd, f, indent=2)
os.replace(_tmp_prd_path, prd_path)
PYEOF
                            ) 200>"${prd_target}.lock"
                            patch_count=0
                        else
                            log "  [FailureAnalyst] Applied $patch_count TC patch(es) — retry will use updated testCriteria"
                        fi
                    else
                        log "  [FailureAnalyst] target=tc but no tc_patches provided — TC writer will regenerate on next deliverable pass"
                    fi
                    ;;
                skill)
                    if [ -n "$skill_note" ]; then
                        # Persist skill note to the codeline KB so later runs inherit this learning
                        if [ -f "$profiles_file" ]; then
                            # Deterministic anti-pattern gate (found live, 2026-08-02): a skill
                            # note can be a 100%-correct reading of a WRONG ground truth (e.g. a
                            # stale SDK .d.ts file) — FailureAnalyst has no way to know that, and
                            # neither does the LLM reviewer just below, since the same blind spot
                            # applies to both. This project's own anti-patterns.json already
                            # encodes the known-correct answer from a real prior review; a note
                            # that contradicts it is refused here, before either LLM ever sees it,
                            # so the same wrong belief can never be re-argued back into the
                            # profile no matter how many times a model re-derives it.
                            local _skill_anti_pattern_msg
                            _skill_anti_pattern_msg=$(_text_violates_anti_pattern "$skill_note")
                            if [ -n "$_skill_anti_pattern_msg" ]; then
                                warning "  [FailureAnalyst] Skill note contradicts a known anti-pattern — refusing to persist: $_skill_anti_pattern_msg"
                            else
                            # DEDUP SOURCE CORRECTED 2026-08-07 (ARCH-5). This read the role's
                            # text out of profiles.json, which was where skill notes used to be
                            # persisted. They are now appended to the codeline KB, and
                            # profiles.json is wiped by pre-run-reset at the start of every run.
                            # Left pointing at profiles.json, both uses below silently degraded:
                            # the exact-duplicate check could never match (so every duplicate
                            # paid for a reviewer call before being caught by the KB check
                            # further down), and the reviewer was handed empty dedup context, so
                            # its near-duplicate judgment had nothing to compare against. Both
                            # must read the file the note actually lands in.
                            local _existing_notes _dedup_kb_dir _dedup_kb_file
                            _dedup_kb_dir="$(dirname "$SCRIPT_DIR")/agents"
                            _dedup_kb_file=$(_kb_file_for_story "$story_id" "$_dedup_kb_dir")
                            _existing_notes=$([ -f "$_dedup_kb_file" ] && cat "$_dedup_kb_file" 2>/dev/null || echo "")
                            # Duplicate guard (fixed 2026-07-11, after a live run persisted an
                            # exact duplicate note): the reviewer call below already correctly
                            # rejects an exact-duplicate skill note as a "fail" verdict (same
                            # dedup mechanism the 2026-07-10 fix restored) -- but the
                            # unreviewed-fallback path just below was designed to rescue a
                            # genuinely NEW lesson that failed 3 review rounds on WORDING
                            # alone, and didn't distinguish that from "rejected because it's a
                            # verbatim duplicate." It persisted the duplicate anyway,
                            # defeating the entire dedup mechanism it sits next to. Check for
                            # an exact duplicate FIRST and skip the whole reviewer+persist
                            # flow when found -- there is nothing to review or fall back to.
                            if echo "$_existing_notes" | grep -qF -- "$skill_note"; then
                                log "  [FailureAnalyst] Skill note is an exact duplicate of an existing note in $(basename "$_dedup_kb_file") — discarding, not persisting again"
                            else
                            # Reviewer validates skill note before persisting. Rejections
                            # get up to 3 summarize-and-resubmit rounds (same mechanism as
                            # kb_entry) before being discarded.
                            local _skill_review_verdict
                            # Root cause fix (found live, 2026-07-10, tier3-travel-app run):
                            # this used to `head -c 500` the existing profile text before
                            # handing it to the duplicate check inside
                            # run_change_with_reviewer_retry/_skill_note_format_ok. New notes
                            # are appended to the END of the profile string, so once a
                            # profile grows past 500 chars (typescript-engineer reached
                            # 12K+), the dedup check was structurally blind to every note
                            # already there — guaranteeing duplicates for any profile past
                            # that length. Observed: the same self-contradictory "don't use
                            # 'as'... use 'value as Type'" note persisted twice verbatim in
                            # one story's retry loop. Pass the FULL profile text so the
                            # exact-duplicate check (grep -qF) can actually see prior notes.
                            _skill_review_verdict=$(run_change_with_reviewer_retry "$story_id" "skill_note" \
                                "$_existing_notes" \
                                "$skill_note" 3)
                            # run_change_with_reviewer_retry ran inside the $(...) above, so its
                            # REVIEWER_RETRY_TEXT assignment was scoped to that subshell — read
                            # the file-based side channel it left behind instead.
                            REVIEWER_RETRY_TEXT=$(cat "${TMPDIR:-/tmp}/.reviewer-retry-text-$$" 2>/dev/null || echo "$skill_note")
                            local _skill_note_to_persist="$REVIEWER_RETRY_TEXT"
                            if [ "$_skill_review_verdict" = "fail" ]; then
                                # Same fallback as kb_entry above (2026-07-06): don't discard a
                                # genuinely useful lesson just because its WORDING failed review
                                # 3 times — persist a length-safe, tagged-unreviewed fallback
                                # instead of losing the knowledge outright.
                                warning "  [FailureAnalyst] Skill note rejected by reviewer after 3 attempts — persisting raw fallback (unreviewed) instead of discarding"
                                # Persist the note WHOLE. An unreviewed-but-complete rule is
                                # usable; an unreviewed-and-severed one is worse than none.
                                _skill_note_to_persist="[unreviewed-fallback] ${skill_note}"
                            fi
                            REVIEWER_RETRY_TEXT="$_skill_note_to_persist"
                            # THE ROSTER IS SET AFTER THE MINT. Nothing writes it afterwards.
                            #
                            # This appended the note into profiles.json, claiming in its own
                            # comment that "future runs inherit this learning". They could not:
                            # pre-run-reset restores profiles.json from its original at the
                            # start of every run, so the note lived exactly as long as the run
                            # that produced it. Meanwhile the roster became mutable while three
                            # lanes read it in parallel, and drifted from its original, which
                            # broke the same invariant test repeatedly.
                            #
                            # The note goes where knowledge actually survives — the codeline KB,
                            # the same store the kb target uses and that every implementation
                            # prompt already reads. Duplicate suppression comes free: the file
                            # is checked before appending.
                            # NO CROSS-RUN WRITE. A skill note used to be APPENDED to
                            # agents/KB-<codeline>.md and logged as "survives into later runs".
                            # Nothing cleared it, so guidance derived from one run's code was
                            # injected into every later run's prompts as current fact. Operator,
                            # 2026-08-12: "there can be no lingering anything to skew runs. That
                            # is strictly forbidden."
                            #
                            # THE IN-RUN CHANNEL. When cross-run persistence was removed the
                            # comment above said the note "still reaches THIS run's retry through
                            # the in-run amendment" — no such amendment existed. Nothing wrote the
                            # note anywhere the retry prompt reads, so target=skill was a no-op
                            # behind a log line claiming an injection (regintel REGI-004-B and
                            # REGI-001-tests, 2026-09-18/19: identical failure on every retry,
                            # "self-healing is NOT working"). It now lands in the run's own
                            # guidance ledger under LOG_DIR — per story, cleared by pre-run-reset
                            # on a fresh launch, kept on a resume — which build_kb_prompt_section
                            # renders into that story's next attempt. Nothing lingers across runs.
                            record_run_guidance "$story_id" "$REVIEWER_RETRY_TEXT" "skill"
                            log "  [FailureAnalyst] Skill note recorded for ${story_id}'s next attempt (${#REVIEWER_RETRY_TEXT} chars) — this run only, not persisted across runs"
                            _profile_updated="true"
                            fi
                            fi
                        fi
                    else
                        log "  [FailureAnalyst] target=skill but skill_note empty — falling back to diagnosis only"
                    fi
                    ;;
                kb)
                    if [ -n "$skill_note" ]; then
                        # Agent-specific KB: KB-{agentRole}.md — keeps context injection small.
                        # Shared rules go to KB-shared.md; agent-specific rules go to role file.
                        local kb_dir
                        kb_dir="$(dirname "$SCRIPT_DIR")/agents"
                        local kb_file; kb_file=$(_kb_file_for_story "$story_id" "$kb_dir")
                        # NO TRUNCATION — entries are single actionable rules, and a rule
                        # carrying a regex, path or command is destroyed by a character cut.
                        # Length is a REJECTION criterion upstream (the note goes back for
                        # rewrite), never a mutilation silently applied here.
                        local short_note="${skill_note}"
                        # Exact-duplicate check against the FULL kb_file BEFORE ever calling
                        # the reviewer (found live, 2026-07-12): unlike the skill_note case
                        # above (which does exactly this grep against the full profile text),
                        # this path only ever fed the reviewer the LAST 6 LINES of the KB file
                        # as dedup context, relying entirely on the LLM's subjective judgment
                        # for everything older than that. Live evidence:
                        # KB-typescript-engineer.md accumulated 4 reworded variants of the
                        # exact same "verify test-file imports are in package.json
                        # devDependencies before writing tests" rule, all appended within one
                        # 5-minute window — the LLM reviewer approved each as "not a duplicate"
                        # since the wording differed each time. This catches the EXACT-repeat
                        # case deterministically; genuine near-duplicate rewording is still the
                        # reviewer's call, same scope boundary the skill_note fix drew.
                        if [ -f "$kb_file" ] && grep -qF -- "$short_note" "$kb_file"; then
                            log "  [FailureAnalyst] KB note is an exact duplicate of an existing entry in $(basename "$kb_file") — discarding, not persisting again"
                        else
                        # Read last 3 existing KB entries to give reviewer dedup context
                        local _kb_last3=""
                        _kb_last3=$(tail -6 "$kb_file" 2>/dev/null || echo "")
                        # Full agent audit, 2026-07-31: kb-change-reviewer's own rule
                        # ("Entry contradicts the agentRole's profile in profiles.json")
                        # was unenforceable — unlike the skill_note call site (whose
                        # "before" IS the target profile text, since notes are appended
                        # to it directly), this call only ever passed KB-file tail
                        # lines, never the target role's actual profile.json text. Fetch
                        # it the same way the skill_note branch does, so the reviewer
                        # can actually check the rule instead of guessing or ignoring it.
                        local _kb_target_role_profile=""
                        if [ -f "$profiles_file" ]; then
                            _kb_target_role_profile=$(jq -c --arg role "$story_role" '.[$role] // ""' "$profiles_file" 2>/dev/null)
                        fi
                        local _kb_review_before="KB entries so far:
${_kb_last3}

Target agentRole (${story_role}) profile, for the 'contradicts the agentRole's profile' rule:
${_kb_target_role_profile}"
                        # KB reviewer gate — permanent entries must pass strict validation.
                        # Rejections get up to 3 summarize-and-resubmit rounds before being
                        # discarded (see run_change_with_reviewer_retry).
                        local _kb_review_verdict
                        _kb_review_verdict=$(run_change_with_reviewer_retry \
                            "$story_id" "kb_entry" \
                            "$_kb_review_before" \
                            "$short_note" 3)
                        # See the skill_note call site above for why this file read is needed.
                        REVIEWER_RETRY_TEXT=$(cat "${TMPDIR:-/tmp}/.reviewer-retry-text-$$" 2>/dev/null || echo "$short_note")
                        if [ "$_kb_review_verdict" = "fail" ]; then
                            # Root cause this replaces (found live, 2026-07-06):
                            # a genuinely correct, useful rule ("must export
                            # main(argv)") got REJECTED 3 times purely for
                            # WORDING issues (over the char limit, wrong verb,
                            # "not generalizable") and then silently dropped —
                            # the actual lesson was lost forever, not just its
                            # phrasing. $short_note is already a mechanically
                            # safe, length-compliant truncation of the raw
                            # content computed BEFORE the reviewer ever ran, so
                            # persist THAT as a last-resort fallback (tagged as
                            # unreviewed) instead of discarding the knowledge
                            # outright. A future reviewer/human pass can still
                            # clean up the wording; nothing is lost meanwhile.
                            warning "  [FailureAnalyst] KB entry rejected by reviewer after 3 attempts — persisting raw fallback (unreviewed) for this run instead of discarding"
                            record_run_guidance "$story_id" "[unreviewed-fallback] ${short_note}" "kb"
                            _profile_updated="true"
                        else
                            # Same in-run channel as the skill note — see there. The cross-run
                            # write stays removed.
                            record_run_guidance "$story_id" "$REVIEWER_RETRY_TEXT" "kb"
                            log "  [FailureAnalyst] KB entry recorded for ${story_id}'s next attempt (${#REVIEWER_RETRY_TEXT} chars) — this run only, not persisted"
                            _profile_updated="true"
                        fi
                        fi
                    else
                        log "  [FailureAnalyst] target=kb but skill_note empty — no KB entry written"
                    fi
                    ;;
                tool)
                    if [ -n "$tool_name" ] && [ -n "$tool_recipe" ] && \
                       _tool_recipe_reinvokes_test_cmd "$tool_recipe" "${LAST_TEST_CMD:-}"; then
                        warning "  [FailureAnalyst] Dynamic tool '${tool_name}' recipe re-invokes this project's own test command ('${LAST_TEST_CMD}') — a tool's job is the ONE mechanical step it automates, never a second independent test run; NOT written"
                    elif [ -n "$tool_name" ] && [ -n "$tool_recipe" ]; then
                        local tools_dir="$PROJECT_ROOT/.epam/dynamic-tools"
                        mkdir -p "$tools_dir" 2>/dev/null
                        local tool_path="${tools_dir}/${tool_name}.sh"
                        local _tool_before=""
                        [ -f "$tool_path" ] && _tool_before=$(cat "$tool_path")

                        # Build the candidate script: header comment (purpose, used for
                        # prompt injection) + the recipe as the executable body.
                        local _tool_candidate
                        _tool_candidate=$(printf '#!/usr/bin/env bash\n# %s\nset -e\n%s\n' "$tool_purpose" "$tool_recipe")

                        # Reviewer gate — validates the script before it's trusted for
                        # future runs. Same snapshot/revert pattern as every other
                        # self-heal write. Rejections get up to 3 summarize-and-resubmit
                        # rounds (same mechanism as kb_entry/skill_note) before being
                        # discarded — a rejected tool used to be a dead end even when the
                        # rejection was a fixable bash bug (e.g. subshell variable scoping).
                        local _tool_review_verdict
                        _tool_review_verdict=$(run_change_with_reviewer_retry "$story_id" "tool_creation" \
                            "$_tool_before" "$_tool_candidate" 3)
                        REVIEWER_RETRY_TEXT=$(cat "${TMPDIR:-/tmp}/.reviewer-retry-text-$$" 2>/dev/null || echo "$_tool_candidate")
                        if [ "$_tool_review_verdict" = "fail" ]; then
                            warning "  [FailureAnalyst] Dynamic tool '${tool_name}' rejected by reviewer after 3 attempts — NOT written"
                        else
                            printf '%s' "$REVIEWER_RETRY_TEXT" > "$tool_path"
                            chmod +x "$tool_path" 2>/dev/null
                            # Explicit, auditable "this exact tool was reviewed and
                            # approved" marker — a sidecar file, not a marker embedded
                            # in the script itself, so it never collides with the
                            # `sed -n '2p'` purpose-line extraction used elsewhere.
                            # Both run_dynamic_tools_in_unlocked_window() (the
                            # orchestrator's own deterministic execution) and the
                            # agent-prompt tool listing check for this marker before
                            # trusting/surfacing a tool — today's only write path
                            # already requires review, but this makes "only reviewed
                            # tools are ever used" an explicit, checkable invariant
                            # rather than an implicit assumption about there being no
                            # other writer.
                            printf 'reviewed_at=%s\nstory_id=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$story_id" > "${tool_path}.reviewed"
                            log "  [FailureAnalyst] Dynamic tool written: .epam/dynamic-tools/${tool_name}.sh — ${tool_purpose}"
                            _profile_updated="true"
                        fi
                    else
                        log "  [FailureAnalyst] target=tool but tool_spec incomplete — falling back to diagnosis only"
                    fi
                    ;;
                escalate)
                    # THE FIX IS IN ANOTHER STORY'S FILE. Filed as the escalation record the
                    # resolver reads on this same retry loop (resolve_escalation runs right after
                    # the analyst); the owner's ladder does the work, this writer gets a free retry.
                    if _apply_analyst_escalation "$story_id" "$analyst_json"; then
                        :
                    elif [ $? -eq 1 ] && [ -z "$skill_note" ]; then
                        skill_note=$(echo "$analyst_json" | jq -r '.escalation.requiredFix // ""' 2>/dev/null)
                        [ -n "$skill_note" ] && skill_note=$(_ensure_imperative_opener "$skill_note")
                    fi
                    ;;
                spec)
                    # ANOTHER STORY'S CRITERION IS THE DEFECT. Patched through the change reviewer,
                    # per story; a rejection reverts. tc_patches carry storyId.
                    local _spec_patches
                    _spec_patches=$(echo "$analyst_json" | jq -c '.tc_patches // []' 2>/dev/null || echo "[]")
                    if [ "$_spec_patches" != "[]" ]; then
                        patch_count=$(_apply_reviewed_tc_patches "$story_id" "$_spec_patches" | tail -1)
                        [ "${patch_count:-0}" -gt 0 ] && log "  [FailureAnalyst] target=spec — $patch_count reviewed criterion patch(es) applied across stories"
                    else
                        log "  [FailureAnalyst] target=spec but no tc_patches provided — injecting diagnosis only"
                    fi
                    ;;
                environment)
                    # NOT THE WRITER'S FAULT. No ladder is spent on a stronger model for a broken
                    # environment; the coordinator's environment class handles the retry.
                    COORDINATOR_FAILURE_CLASS="environment"
                    COORDINATOR_ESCALATE="no"
                    export COORDINATOR_FAILURE_CLASS COORDINATOR_ESCALATE
                    log "  [FailureAnalyst] target=environment — the failure is environmental, not the writer's; no rung is spent on it"
                    ;;
                none)
                    log "  [FailureAnalyst] No structural fix needed — model escalation ladder handles retry"
                    ;;
                *)
                    log "  [FailureAnalyst] Unknown target '$target' — injecting diagnosis only"
                    ;;
            esac
            # Record the healing event for observability and post-run audit
            run_healing_recorder "$story_id" "$retry_num" "$target" "$diagnosis" "$patch_count" "$_profile_updated" "$skill_note" "$analyst_evidence" "$analyst_expected"
            # Emit self_heal_result so agent-activity dashboard shows target, diagnosis, and outcome
            "$SCRIPT_DIR/update-monitor.sh" event "self_heal_result" \
                "Self-heal result for $story_id: target=$target patches=$patch_count profile=$_profile_updated — $diagnosis" \
                "$story_id" "main" "failure-analyst" "$gate_model" "$gate_provider" 2>/dev/null || true
            # A pure syntax error escalates immediately (see check_syntax_class_error's
            # docstring) — check this BEFORE the repeat-based check below, which would
            # otherwise wait for the same syntax error to recur once more first.
            check_syntax_class_error "$story_id" "$diagnosis"
            # Detect repeat failures — same diagnosis 2+ times means healing is broken
            check_healing_effectiveness "$story_id" "$diagnosis" "$retry_num"
            # Detect diverse failures — a DIFFERENT diagnosis each attempt while still
            # on the base model means the model can't converge on this story at all
            check_failure_diversity "$story_id" "$retry_num" "$diagnosis"
            # Always inject the failure summary into the coordinator amendment so the
            # downstream retry agent knows EXACTLY what went wrong and how to avoid it.
            local _analyst_guidance="Root cause: ${diagnosis}"
            [ -n "$skill_note" ] && _analyst_guidance="${_analyst_guidance}
Fix: ${skill_note}"
            [ "$target" = "prd" ] && _analyst_guidance="${_analyst_guidance}
The acceptance criteria for this story have been updated — re-read them carefully before writing code."
            [ "$target" = "tc" ] && _analyst_guidance="${_analyst_guidance}
The testCriteria facts for this story have been updated — re-read the Test Criteria section carefully before writing tests."
            [ "$target" = "none" ] && _analyst_guidance="${_analyst_guidance}
The spec is correct — the model made a code-level mistake. Write correct code this time."
            local _existing="${COORDINATOR_PROMPT_AMENDMENT:-}"
            COORDINATOR_PROMPT_AMENDMENT="${_existing}
## Self-Heal: Failure Analyst Summary
${_analyst_guidance}"
        else
            warning "  [FailureAnalyst] Could not parse JSON from analyst response after ${_analyst_max_attempts} attempts — proceeding with retry as-is"
        fi
    else
        warning "  [FailureAnalyst] Gate model call failed — proceeding with retry as-is"
    fi
    # Emit cost_snapshot for failure-analyst (accumulated across its retry loop)
    if [ -f "$_analyst_json_result" ] && [ -s "$_analyst_json_result" ]; then
        local _fa_cost _fa_tin _fa_tout _fa_turns _fa_phase
        _fa_cost=$(jq -r '.total_cost_usd // .cost_usd // 0'                       "$_analyst_json_result" 2>/dev/null || echo 0)
        _fa_tin=$(jq -r '.usage.input_tokens // .usage.inputTokens // 0'            "$_analyst_json_result" 2>/dev/null || echo 0)
        _fa_tout=$(jq -r '.usage.output_tokens // .usage.outputTokens // 0'         "$_analyst_json_result" 2>/dev/null || echo 0)
        _fa_turns=$(jq -r '.num_turns // .turns // .iterations // 1'                "$_analyst_json_result" 2>/dev/null || echo 1)
        _fa_phase="${CURRENT_PHASE:-}"
        jq -cn \
            --arg ts "$(date -Iseconds)" \
            --arg story "$story_id" \
            --arg phase "${_fa_phase:-}" \
            --arg model "${gate_model:-}" \
            --arg provider "${gate_provider:-}" \
            --argjson cost "${_fa_cost:-0}" \
            --argjson tin "${_fa_tin:-0}" \
            --argjson tout "${_fa_tout:-0}" \
            --argjson turns "${_fa_turns:-1}" \
            '{
              event_id: ("evt-cost-" + ($ts | gsub("[^0-9]";""))),
              timestamp: $ts,
              agent: "failure-analyst",
              story_id: (if $story == "" then null else $story end),
              phase: (if $phase == "" then null else $phase end),
              type: "cost_snapshot",
              model: (if $model == "" then null else $model end),
              provider: (if $provider == "" then null else $provider end),
              detail: {costUsd: $cost, tokensIn: $tin, tokensOut: $tout, turns: $turns, source: "run_failure_analyst"}
            }' >> "${ACTIVITY_FILE:-$LOG_DIR/agent-activity.jsonl}" 2>/dev/null || true
        rm -f "$_analyst_json_result"
    fi
    "$SCRIPT_DIR/update-monitor.sh" story_complete "failure-analyst" "main" "Analysis complete: $story_id" 2>/dev/null || true
}

# run_healing_recorder <story_id> <retry_num> <target> <diagnosis> <patches_applied> <profile_updated>
# Appends a JSONL record to $OUTPUT_DIR/healing-events.jsonl after each analyst cycle.
# Each record is independently parseable so the log survives partial runs.
run_healing_recorder() {
    local story_id="$1"
    local retry_num="${2:-0}"
    local target="${3:-none}"
    local diagnosis="${4:-unknown}"
    local patches_applied="${5:-0}"
    local profile_updated="${6:-false}"
    # The prescription, its evidence and its expected outcome travel with the event, so the next
    # analyst (and the story's summary) can read what was tried and what was promised.
    local note="${7:-}" evidence="${8:-}" expected_outcome="${9:-}"
    local rung
    rung=$(( retry_num / 2 ))
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
    # Always write to LOG_DIR (orchestrations/logs) — healing-events is pipeline
    # monitoring data, not project output. Writing to OUTPUT_DIR breaks the dashboard
    # which reads from logs/healing-events.jsonl via nginx /logs-dir mount.
    local heal_log="${LOG_DIR}/healing-events.jsonl"
    mkdir -p "$(dirname "$heal_log")"
    # Safe JSON serialisation — escape quotes and backslashes in diagnosis
    local safe_diagnosis
    safe_diagnosis=$(printf '%s' "$diagnosis" | sed 's/\\/\\\\/g; s/"/\\"/g')
    jq -nc --arg ts "$ts" --arg id "$story_id" --argjson retry "${retry_num:-0}" --argjson rung "$rung" --arg target "$target" \
        --arg diag "$diagnosis" --argjson patches "${patches_applied:-0}" --argjson profile "$( [ "$profile_updated" = "true" ] && echo true || echo false )" \
        --arg note "$note" --arg evidence "$evidence" --arg expected "$expected_outcome" \
        '{ts:$ts, story_id:$id, retry:$retry, rung:$rung, target:$target, diagnosis:$diag, patches_applied:$patches, profile_updated:$profile}
         + (if $note != "" then {note:$note} else {} end) + (if $evidence != "" then {evidence:$evidence} else {} end) + (if $expected != "" then {expected_outcome:$expected} else {} end)' \
        >> "$heal_log" 2>/dev/null \
    || printf '{"ts":"%s","story_id":"%s","retry":%s,"rung":%s,"target":"%s","diagnosis":"%s","patches_applied":%s,"profile_updated":%s}\n' \
        "$ts" "$story_id" "$retry_num" "$rung" "$target" "$safe_diagnosis" \
        "$patches_applied" "$profile_updated" \
        >> "$heal_log"
    log "  [HealingRecorder] Event written (story=$story_id retry=$retry_num rung=$rung target=$target)"

    # ── Self-heal KB (pillar 1: episodic tier) ───────────────────────────────
    # Additive and flag-guarded. The legacy line above still feeds the dashboard;
    # this second write is keyed by a signature derived from the TOOL OUTPUT
    # ($VERIFICATION_FAILURE), never from the diagnosis prose above — a replay of
    # 118 real episodes found only 4 diagnoses carried a compiler code, so prose
    # cannot serve as a stable lookup key. Never fails the run: losing an episode
    # must not lose a story.
    if true; then   # self-heal always on (switch removed 2026-07-25)
        local _kb_apply_lib="${SCRIPT_DIR:-$(dirname "${BASH_SOURCE[0]}")}/lib/kb-apply.sh"
        if [ -f "$_kb_apply_lib" ]; then
            # shellcheck disable=SC1090
            . "$_kb_apply_lib"
            # Here-string, NOT a pipe: a pipeline runs kb_record_episode in a
            # subshell and KB_LAST_SIGNATURE — the key kb_maybe_synthesize needs —
            # is lost when it exits, leaving synthesis unable to build anything.
            # THE ROLE IS THE STORY'S OWN AGENT. STORY_ROLE is set by no caller of this script,
            # so every writer-path episode was recorded under a null role and synthesis — keyed on
            # (role, signature) — could never fire; the KB never learned from a writer failure
            # (£0 greenfield harness, 2026-09-14). The story's agentRole, as the analyst reads it.
            # The class is the coordinator's classification of this attempt; "unknown" is not a
            # class, and an episode with no derivable signature stays unkeyed, honestly.
            local _kb_role _kb_class
            _kb_role="${STORY_ROLE:-$(jq -r --arg id "$story_id" '.stories[] | select(.id == $id) | .agentRole // ""' "${PRD_FILE:-}" 2>/dev/null || echo "")}"
            _kb_class="${COORDINATOR_FAILURE_CLASS:-}"; [ "$_kb_class" = "unknown" ] && _kb_class=""
            kb_record_episode "$story_id" "$_kb_role" "$diagnosis" "$_kb_class" \
                <<< "${VERIFICATION_FAILURE:-}" || true
            # Close the loop: episodes alone build nothing. Synthesis turns a
            # REPEATED signature into one arbitrated, schema-valid constraint that
            # the next attempt gets as enforcement — never as prompt prose.
            kb_maybe_synthesize "$_kb_role" || true
        fi
    fi
}

# apply_known_fix <project_root> <diagnosis>
# Deterministic second-line safety net for recurring self-heal failures.
#
# Root cause this fixes (found live, 2026-07-06): the FailureAnalyst's fix-routing
# has exactly 5 targets (prd, tc, tool, skill, kb), and NONE of them means "directly
# patch the content of a file the agent already wrote." For a known, mechanical,
# single-line config gap (e.g. vitest.config.ts missing `passWithNoTests: true`,
# so `vitest run` exits 1 with zero test files even though the AC explicitly
# allows that), the analyst correctly diagnosed the exact fix needed at TWO
# different model tiers, but both times picked the nearest-available-but-wrong
# target (`tool` = writes an unrelated helper script; `tc` = patches documentation
# text) — neither can touch the actual file content, so the diagnosis recurred
# and the story exhausted its entire retry ladder on a fix that was correctly
# identified but could never be mechanically applied.
#
# Deliberately NOT a 6th LLM-facing target: growing the analyst's enum gives it
# one more way to be wrong, not a better chance of being right — the gap isn't
# "not enough categories," it's "no category exists that means what's needed."
# Instead, this is a separate, deterministic, non-LLM layer that only engages
# AFTER check_healing_effectiveness has already detected 2+ repeats of the same
# diagnosis — the LLM stays the fast first responder for everything else, and
# this is a safety net for the narrow class of "correctly diagnosed, wrongly
# routed" mechanical fixes. All stack-specific knowledge (which file, which
# snippet, which symptom pattern) lives in the project's own
# .epam/known-fixes.json — same "config supplies stack knowledge, engine has
# none" convention as .epam/dependency-check.json and .epam/contract-generation.json.
#
# Returns 0 (and logs) if a fix was found and applied; returns 1 otherwise —
# callers must treat 1 as "no known fix, fall through to existing behavior."
apply_known_fix() {
    local project_root="$1"
    local diagnosis="$2"
    local config_file="${project_root}/.epam/known-fixes.json"
    [ -f "$config_file" ] || return 1

    local applied_id
    applied_id=$(python3 - "$project_root" "$config_file" "$diagnosis" << 'PYEOF' 2>/dev/null
import json, re, sys, os

project_root, config_file, diagnosis = sys.argv[1], sys.argv[2], sys.argv[3]

with open(config_file) as f:
    fixes = json.load(f)

for fix in fixes:
    try:
        if not re.search(fix['symptomPattern'], diagnosis, re.IGNORECASE):
            continue
        target_path = os.path.join(project_root, fix['targetFile'])
        if not os.path.exists(target_path):
            continue
        with open(target_path) as tf:
            content = tf.read()
        # Already present — this symptom must have a different cause; don't
        # falsely claim success, let the caller fall through to normal handling.
        if fix['checkPattern'] in content:
            continue
        m = re.search(fix['insertAfterPattern'], content)
        if not m:
            continue
        new_content = content[:m.end()] + fix['insertText'] + content[m.end():]
        with open(target_path, 'w') as tf:
            tf.write(new_content)
        print(fix['id'])
        sys.exit(0)
    except (KeyError, re.error):
        continue

sys.exit(1)
PYEOF
)
    local rc=$?
    if [ "$rc" -eq 0 ] && [ -n "$applied_id" ]; then
        log "  [KnownFix] Applied deterministic fix '${applied_id}' for recurring diagnosis (see .epam/known-fixes.json)"
        return 0
    fi
    return 1
}

# check_syntax_class_error <story_id> <current_diagnosis>
# A pure syntax error (unbalanced brace, missing semicolon, unterminated string,
# invalid type assertion, TS10xx/TS11xx parser diagnostics) is never a subtle
# logic mistake that benefits from a same-tier retry with a text hint — the
# model either can/can't produce syntactically valid TypeScript, and repeating
# the SAME model tier just burns attempts waiting for check_healing_effectiveness's
# 2-repeat threshold to fire. Escalate to the next rung on the FIRST occurrence
# instead of waiting for a repeat.
#
# Root cause this fixes (observed live, 2026-07-10, tier3-travel-app run):
# SKY-003-impl hit "Missing closing brace in cli.ts at line 375" and retried at
# the SAME model tier twice before HealingBroken's repeat-of-2 threshold finally
# forced an escalation to z-ai/glm-5.2, which then converged immediately. The
# same class of syntax error (unterminated strings, invalid 'as' syntax, missing
# semicolons) recurred across multiple DIFFERENT stories this session, always
# eventually fixed only after burning 2+ same-tier attempts first.
#
# Second root cause fixed 2026-07-14 (SKY-003-b, tier3-travel-app run): the
# pattern list above never matched "malformed template literal"/"malformed
# array or bracket"/"invalid computed property" -- diagnosis phrasings that
# ARE syntax errors but don't use this list's exact vocabulary -- so this
# function silently never fired for 6 straight retries on the same corrupted
# line, leaving check_healing_effectiveness's slower repeat-of-2 path to do
# all the work instead of the immediate escalation this function exists for.
# Added "malformed" as a fourth generic keyword rather than enumerating every
# specific phrasing (unbounded and language-agnostic, same idiom as the
# existing alternation).
#
# Also root-caused WHY 6 retries never converged even after escalating:
# reading the actual corrupted file (cli.test.ts:260) showed a dropped
# array-closing token merging the tail of one test into the `it(...)` header
# of the next -- a full-file-regeneration boundary glitch. Every retry
# rewrote the ENTIRE file from scratch, so the model kept re-hitting the same
# failure MODE (a long-file generation boundary slip) even as the exact
# corrupted bytes shifted attempt to attempt, which is also why
# failure-analyst's own diagnosis text kept changing without ever
# converging. Persist a generic, role-scoped, permanent skill note the first
# time this fires for a story so this run (or the very next test-writing
# story) tries a different strategy: patch the broken region, don't
# regenerate the whole file. Reuses the same reviewer-gated persist pattern
# already used for failure-analyst's target=skill/kb notes -- deterministic
# exact-duplicate guard, format validated by _skill_note_format_ok, so this
# is written exactly once per role, not once per retry.
check_syntax_class_error() {
    local story_id="$1"
    local diagnosis="$2"
    [ "${HEALING_BROKEN:-0}" = "1" ] && return 0
    if echo "$diagnosis" | grep -qiE \
        'missing (closing|opening) (brace|paren(thesis)?|bracket)|unterminated (string|template)|missing semicolon|invalid type assertion|unexpected token|malformed|\bTS1[01][0-9]{2}\b|syntax error'; then
        log "  [SyntaxClassEscalation] '$diagnosis' matches a syntax-error pattern — escalating immediately instead of waiting for a repeat"
        HEALING_BROKEN=1
        export HEALING_BROKEN

        local _syntax_story_role
        _syntax_story_role=$(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .agentRole // ""' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "")
        if [ -n "$_syntax_story_role" ] && [ -f "$AGENT_PROFILES_FILE" ]; then
            # Kept under 200 chars deliberately: _skill_note_format_ok's
            # length check (mirrors prd-change-reviewer's own skill_note
            # rule) then short-circuits run_change_with_reviewer_retry
            # straight to "pass" via its deterministic fast path -- no live
            # LLM gate-model call needed for a note this mechanical, and no
            # dependency on ORCH_GATE_PROVIDER being configured at all.
            local _syntax_note="Always patch only the broken line range on a repeated syntax-error retry -- never regenerate the whole file, since a full rewrite tends to reproduce the same corruption elsewhere."
            # DEDUP SOURCE CORRECTED 2026-08-07 (ARCH-5): same defect as the skill branch in
            # run_failure_analyst. The note is appended to the codeline KB below, so reading
            # prior notes out of profiles.json meant the "already learned this" check could
            # never fire and the reviewer got empty dedup context — this note would be
            # re-proposed and re-reviewed on every syntax escalation of every run.
            local _syntax_role_profile _syntax_dedup_dir _syntax_dedup_file
            _syntax_dedup_dir="$(dirname "$SCRIPT_DIR")/agents"
            _syntax_dedup_file=$(_kb_file_for_story "$story_id" "$_syntax_dedup_dir")
            _syntax_role_profile=$([ -f "$_syntax_dedup_file" ] && cat "$_syntax_dedup_file" 2>/dev/null || echo "")
            if ! echo "$_syntax_role_profile" | grep -qF -- "$_syntax_note"; then
                local _syntax_verdict
                _syntax_verdict=$(run_change_with_reviewer_retry "$story_id" "skill_note" \
                    "$_syntax_role_profile" "$_syntax_note" 3)
                # Fail-closed: only persist on an actual "pass" verdict --
                # a rejected note must never be written, matching every
                # other reviewer-gated write site in this file.
                if [ "$_syntax_verdict" = "pass" ]; then
                    local _syntax_note_final
                    _syntax_note_final=$(cat "${TMPDIR:-/tmp}/.reviewer-retry-text-$$" 2>/dev/null || echo "$_syntax_note")
                    # Same store as every other durable lesson. This was an UNLOCKED
                    # read-modify-write on profiles.json — jq to a temp file, then mv — while
                    # the neighbouring skill-note path was properly flocked. Two writers to one
                    # mutable file, one of them unguarded, makes the other one's guarantee void
                    # the moment they interleave, and three lanes run in parallel.
                    #
                    # Retired rather than locked: the roster is set after the mint, and this
                    # note belongs where it survives the per-run restore.
                    # CROSS-RUN WRITE REMOVED (2026-08-12). This was the FIFTH and last one,
                    # and it survived the first sweep because that sweep grepped for the two
                    # variable names already known ($kb_file, $_skill_kb_file) instead of the
                    # pattern. Scoped check, general claim — the same mistake the KB itself
                    # kept teaching agents.
                    #
                    # Operator: "agent kb files = remove all after every run - there can be no
                    # lingering anything to skew runs. That is strictly forbidden."
                    #
                    # The note still reaches THIS run's agents through the profile skill notes.
                    # Nothing carries it into the next one.
                    log "  [SyntaxClassEscalation] Skill note applied to this run only — not persisted across runs"
                else
                    log "  [SyntaxClassEscalation] Skill note rejected by reviewer — not persisting"
                fi
            fi
        fi
    fi
}

# check_healing_effectiveness <story_id> <current_diagnosis> [retry_num]
# Reads healing-events.jsonl and checks if the same diagnosis has appeared 2+ times
# for this story without a different diagnosis in between. If so, self-healing is
# not working — log a CRITICAL alert and set HEALING_BROKEN=1 to abort retries.
check_healing_effectiveness() {
    local story_id="$1"
    local current_diagnosis="$2"
    local retry_num="${3:-0}"
    local heal_log="${LOG_DIR}/healing-events.jsonl"
    [ -f "$heal_log" ] || return 0
    # Count consecutive same-root-cause events for this story (most recent N events).
    # A naive 20-char exact-prefix match was live-confirmed to miss real repeats: the
    # gate model rarely phrases the same root cause identically twice (e.g. "Code uses
    # '../public/index.html'..." vs "Agent referenced src/public/index.html but didn't
    # create the file..." — same bug, zero shared 20-char prefix). Token-overlap
    # matching catches paraphrased repeats: extract significant words (len>=4, minus
    # stopwords) from each diagnosis and compare against the current one; treat as the
    # same root cause when at least 3 significant words overlap AND that overlap is a
    # sizeable share (>=40%) of the smaller diagnosis's vocabulary. Both thresholds are
    # needed together — overlap-count alone lets short diagnoses false-positive on one
    # shared word; ratio alone lets two long, mostly-unrelated diagnoses match on a
    # handful of incidental shared words (e.g. both mentioning "file" and "server").
    local repeat_count
    repeat_count=$(python3 - "$heal_log" "$story_id" "$current_diagnosis" 2>/dev/null << 'PYEOF' || echo 0
import json, re, sys

heal_log, story, current = sys.argv[1], sys.argv[2], sys.argv[3]

STOPWORDS = {
    'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
    'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'not', 'it',
    'its', 'this', 'that', 'which', 'so', 'than', 'then', 'because', 'due', 'into',
    'used', 'use', 'uses', 'using', 'causes', 'cause', 'caused', 'agent', 'code',
}

def tokens(text):
    words = re.findall(r"[a-zA-Z']{4,}", text.lower())
    return set(w for w in words if w not in STOPWORDS)

def same_root_cause(a, b):
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return a[:20] == b[:20]
    overlap = ta & tb
    ratio = len(overlap) / min(len(ta), len(tb))
    # min(3, ...) scales the absolute-overlap floor down for short diagnoses — a
    # diagnosis with only 2 significant words (e.g. "exact repeats") could never
    # reach a flat floor of 3 even when identical to itself.
    min_overlap = min(3, len(ta), len(tb))
    return len(overlap) >= min_overlap and ratio >= 0.4

events = []
with open(heal_log) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if obj.get('story_id') == story and obj.get('event') != 'HEALING_BROKEN':
                events.append(obj.get('diagnosis', ''))
        except Exception:
            pass

count = 0
for d in reversed(events):
    if same_root_cause(d, current):
        count += 1
    else:
        break
print(count)
PYEOF
)
    if [ "${repeat_count:-0}" -ge 2 ]; then
        # Deterministic safety net before giving up: a known, mechanical fix may
        # exist for this exact recurring symptom even though the LLM analyst
        # couldn't apply it through its 5-target routing. If found and applied,
        # skip the HEALING_BROKEN escalation entirely and let the next retry use
        # the now-patched file.
        if apply_known_fix "${PROJECT_ROOT:-}" "$current_diagnosis"; then
            log "  [HealingBroken] Deterministic known-fix applied — not counting this as a broken-healing cycle"
            return 0
        fi
        error "  [HealingBroken] CRITICAL: '${current_diagnosis}' has recurred ${repeat_count}+ times for $story_id without a different fix — self-healing is NOT working."
        error "  [HealingBroken] Check: (1) gate model is reachable (2) failure analyst is diagnosing correctly (3) patches are being applied"
        # Write a HEALING_BROKEN sentinel record so the run summary captures this.
        # Include all standard healing-events fields so the dashboard renders it
        # correctly (retry, rung, target, diagnosis must be non-null).
        local ts
        ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "unknown")
        local safe_diag
        safe_diag=$(printf '%s' "$current_diagnosis" | sed 's/\\/\\\\/g; s/"/\\"/g')
        local _broken_rung
        _broken_rung=$(( retry_num / 2 ))
        printf '{"ts":"%s","story_id":"%s","retry":%s,"rung":%s,"target":"none","diagnosis":"%s","patches_applied":0,"profile_updated":false,"event":"HEALING_BROKEN","repeated_diagnosis":"%s","count":%s}\n' \
            "$ts" "$story_id" "$retry_num" "$_broken_rung" "$safe_diag" "$safe_diag" "$repeat_count" >> "$heal_log"
        HEALING_BROKEN=1
        export HEALING_BROKEN
    fi
}

# check_failure_diversity <story_id> <retry_num> <current_diagnosis>
# Mirror of check_healing_effectiveness, inverted: that function detects the SAME
# diagnosis repeating (healing is broken, skip ahead). This detects consecutive
# DIFFERENT diagnoses while still on the un-escalated base model (Rung 0-1,
# retries 0-3) — evidence of a genuine capability gap, not a transient mistake
# "one more attempt" will fix. Root cause addressed: SKY-004 spent 4 of 8
# attempts (half its budget) on MiniMax-M3 despite 4 DIFFERENT failures
# surfacing in that window (wrong import path -> incomplete mock factory ->
# missing test import/mock export -> ...), only reaching model escalation at
# attempt 5. Sets EARLY_ESCALATION_NEEDED=1 so the retry loop can jump straight
# to Rung 2 instead of exhausting the rest of the base-model budget on a model
# that's visibly not converging. No-op once the model has already escalated
# (rung >= 2) — this signal only matters before that point.
check_failure_diversity() {
    local story_id="$1"
    local retry_num="$2"
    local current_diagnosis="$3"

    local _rung=$(( retry_num / 2 ))
    [ "$_rung" -ge 2 ] && return 0

    local heal_log="${LOG_DIR}/healing-events.jsonl"
    [ -f "$heal_log" ] || return 0

    local is_different
    is_different=$(python3 - "$heal_log" "$story_id" "$current_diagnosis" 2>/dev/null << 'PYEOF' || echo "false"
import json, re, sys

heal_log, story, current = sys.argv[1], sys.argv[2], sys.argv[3]

STOPWORDS = {
    'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
    'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'not', 'it',
    'its', 'this', 'that', 'which', 'so', 'than', 'then', 'because', 'due', 'into',
    'used', 'use', 'uses', 'using', 'causes', 'cause', 'caused', 'agent', 'code',
}

def tokens(text):
    words = re.findall(r"[a-zA-Z']{4,}", text.lower())
    return set(w for w in words if w not in STOPWORDS)

def same_root_cause(a, b):
    ta, tb = tokens(a), tokens(b)
    if not ta or not tb:
        return a[:20] == b[:20]
    overlap = ta & tb
    ratio = len(overlap) / min(len(ta), len(tb))
    min_overlap = min(3, len(ta), len(tb))
    return len(overlap) >= min_overlap and ratio >= 0.4

events = []
with open(heal_log) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if obj.get('story_id') == story and obj.get('event') != 'HEALING_BROKEN':
                events.append(obj.get('diagnosis', ''))
        except Exception:
            pass

# events[-1] is the diagnosis just written for THIS attempt (run_healing_recorder
# runs before this check, same ordering as check_healing_effectiveness). Compare
# it against the immediately preceding attempt's diagnosis.
if len(events) < 2:
    print("false")
else:
    prev, cur = events[-2], events[-1]
    print("false" if same_root_cause(prev, cur) else "true")
PYEOF
)

    if [ "$is_different" = "true" ]; then
        warning "  [FailureDiversity] Different failure class than the previous attempt while still on the base model — likely a capability gap, not a transient mistake"
        EARLY_ESCALATION_NEEDED=1
        export EARLY_ESCALATION_NEEDED
    fi
}

# same_root_cause_diagnoses <diagnosis_a> <diagnosis_b>
# Standalone version of the token-overlap comparison embedded in
# check_healing_effectiveness/check_failure_diversity — extracted here because a
# THIRD caller needs it (deterministic-check repeat detection, added live during
# run #15) that already has both text strings in hand and has no reason to read
# or write healing-events.jsonl for this comparison. Echoes "true" or "false".
same_root_cause_diagnoses() {
    local a="$1"
    local b="$2"
    python3 - "$a" "$b" 2>/dev/null << 'PYEOF' || echo "false"
import re, sys

a, b = sys.argv[1], sys.argv[2]

STOPWORDS = {
    'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
    'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'as', 'not', 'it',
    'its', 'this', 'that', 'which', 'so', 'than', 'then', 'because', 'due', 'into',
    'used', 'use', 'uses', 'using', 'causes', 'cause', 'caused', 'agent', 'code',
}

def tokens(text):
    words = re.findall(r"[a-zA-Z']{4,}", text.lower())
    return set(w for w in words if w not in STOPWORDS)

ta, tb = tokens(a), tokens(b)
if not ta or not tb:
    print("true" if a[:20] == b[:20] else "false")
else:
    overlap = ta & tb
    ratio = len(overlap) / min(len(ta), len(tb))
    min_overlap = min(3, len(ta), len(tb))
    print("true" if len(overlap) >= min_overlap and ratio >= 0.4 else "false")
PYEOF
}
