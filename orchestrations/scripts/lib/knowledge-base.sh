#!/usr/bin/env bash
# knowledge-base.sh — moved verbatim out of claude.sh by tools/split-main-into-modules.py
# (4 functions). Sourced by claude.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

_kb_file_for_story() {
    local _story_id="$1" _kb_dir="$2"
    local _prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local _cl="${EPAM_CODELINE:-}"
    if [ -z "$_cl" ] && [ -n "$_story_id" ] && [ -f "$_prd_target" ]; then
        _cl=$(jq -r --arg id "$_story_id" \
            '.stories[] | select(.id == $id) | .codeline // ""' "$_prd_target" 2>/dev/null || echo "")
    fi
    # NORMALISED IDENTICALLY TO THE SEED SIDE (lib/agent-roster.js kbFileForCodeline):
    # lowercased, punctuation collapsed to '-'. Without this, "next.gotransit.com" and
    # "next-gotransit-com" address two different stores and one of them is never read. A test
    # executes both implementations and compares them character for character.
    local _slug
    _slug=$(printf '%s' "$_cl" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]\+/-/g; s/^-*//; s/-*$//')
    if [ -n "$_slug" ]; then
        printf '%s/KB-%s.md' "$_kb_dir" "$_slug"
    else
        printf '%s/KB-shared.md' "$_kb_dir"
    fi
}

# Return the next sequential KB entry ID (KB-001, KB-002, ...) by reading orchestrations/agents/KB.md
get_next_kb_id() {
    local kb_file="$AUTOMATION_DIR/agents/KB.md"
    if [ ! -f "$kb_file" ]; then
        echo "KB-001"
        return
    fi
    local last_num
    last_num=$(grep -oP '(?<=^## KB-)\d+' "$kb_file" | sort -n | tail -1)
    if [ -z "$last_num" ]; then
        echo "KB-001"
    else
        printf "KB-%03d" $(( 10#${last_num} + 1 ))
    fi
}

# Return KB entries relevant to a story's agent role.
# Reads from KB-{agentProfile}.md (role-specific) and KB-shared.md.
# Returns at most 10 entries total to bound context injection size.
get_relevant_kb_entries() {
    local story_id=$1
    local kb_dir="$AUTOMATION_DIR/agents"

    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    local agent_profile
    agent_profile=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .agentRole // ""' "$prd_target" 2>/dev/null || echo "")
    [ -z "$agent_profile" ] && return

    # Collect last 10 lines from role-specific KB + shared KB (shared is a fallback)
    local role_kb; role_kb=$(_kb_file_for_story "$story_id" "$kb_dir")
    local shared_kb="${kb_dir}/KB-shared.md"
    local combined=""
    [ -f "$role_kb"   ] && combined="${combined}$(cat "$role_kb" 2>/dev/null)"$'\n'
    [ -f "$shared_kb" ] && combined="${combined}$(cat "$shared_kb" 2>/dev/null)"$'\n'

    # Strip blank lines and return at most 10 bullet entries
    printf '%s' "$combined" | grep -v '^[[:space:]]*$' | tail -n 10
}

# Build the KB section appended to every implementation prompt
# ── The run's own guidance ledger ───────────────────────────────────────────
# What the failure analyst prescribed for a story's NEXT attempt, in THIS run. Per story, under
# LOG_DIR — pre-run-reset clears LOG_DIR ledgers on a fresh launch and keeps them on a resume, so
# nothing lingers across runs (operator, 2026-08-12) and nothing is lost within one. This is the
# in-run channel the analyst's comments described and never had; without it target=skill and
# target=kb wrote nowhere the retry prompt reads.
_run_guidance_file() {
    printf '%s/run-guidance.jsonl' "${LOG_DIR:?LOG_DIR is required for the run guidance ledger}"
}

# record_run_guidance <story_id> <note> <target>
record_run_guidance() {
    local _sid="${1:?story id}" _note="${2:-}" _target="${3:-skill}"
    [ -n "$_note" ] || return 0
    local _f; _f=$(_run_guidance_file) || return 1
    jq -cn --arg s "$_sid" --arg n "$_note" --arg t "$_target" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{storyId:$s, note:$n, target:$t, ts:$ts}' >> "$_f"
}

# run_guidance_for_story <story_id> — the notes recorded for this story, newest last, unique.
run_guidance_for_story() {
    local _sid="${1:?story id}" _f
    _f=$(_run_guidance_file 2>/dev/null) || return 0
    [ -f "$_f" ] || return 0
    jq -r --arg s "$_sid" 'select(.storyId == $s) | .note' "$_f" 2>/dev/null | awk '!seen[$0]++'
}

build_kb_prompt_section() {
    local story_id=$1
    local retry_count=${2:-0}
    local next_kb_id=${3:-KB-001}

    local kb_entries
    kb_entries=$(get_relevant_kb_entries "$story_id")

    local retry_note=""
    # These are forwarded to the child process invoked below. shellcheck cannot see the consumer,
    # so it reports them unused; removing them would take the values away from the child.
    # shellcheck disable=SC2034
    [ "$retry_count" -gt 0 ] && \
        retry_note="**This is retry attempt ${retry_count}** — a previous attempt failed. You MUST write a KB entry documenting what went wrong and what you changed."

    # Inject external test failure context when available
    if [ -n "${VERIFICATION_FAILURE:-}" ]; then
        printf '%s\n' "$VERIFICATION_FAILURE"
    fi

    local _guidance; _guidance=$(run_guidance_for_story "$story_id")
    if [ -n "$_guidance" ]; then
        printf '\n## Guidance From This Story'"'"'s Previous Attempt\n'
        printf 'The failure analyst diagnosed the previous attempt of this story and prescribed the following. It names a checkable fact the previous attempt got wrong; apply it before writing.\n'
        printf '%s\n' "$_guidance" | sed 's/^/- /'
    fi

    printf '\n## Relevant Knowledge Base Entries\n'
    if [ -n "$kb_entries" ]; then
        printf 'The following was learned from previous story implementations and is relevant to your agent role. Apply this knowledge before writing any code:\n\n'
        printf '%s\n' "$kb_entries"
    else
        printf 'No prior KB entries match your agent role yet.\n'
    fi

    # The anti-read protection SURVIVES the removal below. Issue 2b: M3 burned every
    # iteration reading KB.md instead of writing code. The relevant entries are injected
    # above, so there is never a reason to open the file.
    printf 'Do NOT read orchestrations/agents/KB.md before writing implementation files. The relevant KB entries are already injected above.\n\n'

    # KB CONTRIBUTION REMOVED (2026-08-04). The agent was told to "append one entry to
    # `orchestrations/agents/KB.md`" — a RELATIVE path — while its cwd is the CLIENT
    # codeline, so it created the engine's KB inside the customer's repository. Live
    # metrolinx 20260804T225443Z: that file entered the upexpress lane's writer-output
    # manifest as though the writer had produced it, and Step 9's bare `git add -A`
    # staged it for commit.
    #
    # Agents do not write the KB. Self-heal does, engine-side, against an absolute path.
    # WriteFileTool now refuses engine paths outright (src/config/enginePaths.ts), so this
    # instruction could only ask the agent to do something it will be blocked from doing.

    # Surface any dynamic tools the self-heal loop has written for this project.
    # These are small shell scripts synthesized by the failure analyst (target=tool)
    # to automate a mechanical step that kept getting skipped by hand (e.g. adding a
    # package to package.json before importing it). Invoke them via the bash tool.
    local tools_dir="$PROJECT_ROOT/.epam/dynamic-tools"
    if [ -d "$tools_dir" ] && [ -n "$(find "$tools_dir" -maxdepth 1 -name '*.sh' 2>/dev/null)" ]; then
        printf '\n## Available Dynamic Tools\n'
        printf 'This project has the following helper scripts, written by prior self-healing runs. Use them via the bash tool instead of repeating the equivalent steps by hand:\n\n'
        local _tool_file _tool_purpose_line
        for _tool_file in "$tools_dir"/*.sh; do
            [ -f "$_tool_file" ] || continue
            # Only reviewed tools are ever surfaced to an agent — same
            # explicit .reviewed marker check as
            # run_dynamic_tools_in_unlocked_window(), so an unreviewed or
            # stale script (however it got there) is never offered as if
            # trusted.
            [ -f "${_tool_file}.reviewed" ] || continue
            _tool_purpose_line=$(sed -n '2p' "$_tool_file" | sed 's/^# //')
            printf -- '- `bash %s <args>` — %s\n' "$_tool_file" "$_tool_purpose_line"
        done
    fi
}
