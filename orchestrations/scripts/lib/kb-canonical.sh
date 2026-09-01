#!/usr/bin/env bash
# The KB starts fresh every run.
#
# POLICY (2026-08-04): self-heal writes the KB DURING a run, engine-side. Agents never
# write it (see src/config/enginePaths.ts — the write perimeter refuses engine paths
# outright, and the "append one entry to KB.md" instruction is gone from both writer
# prompts). Until the pipeline is stable, nothing aggregates or grows the KB ACROSS runs.
#
# Why this file exists: profiles.json has profiles.json.original, and every tier3 launcher
# restores it before each run precisely so a previous run's mutations cannot carry forward.
# The KB had no equivalent. It accumulated indefinitely — 28 entries by 2026-08-04 — and it
# is not inert: KB content is injected into writer prompts, so a wrong entry teaches every
# subsequent agent. One had to be removed by hand (565d10e, "remove a disproven vendor-API
# claim the KB was teaching agents"): a single run's mistaken conclusion had become durable
# guidance for every run after it.
#
# Restoring from a checked-in canonical makes within-run learning ephemeral by design. What
# deserves to persist gets promoted into KB.md.original deliberately, by a human, in a
# commit — not by whatever the last agent happened to conclude.

# kb_restore_canonical <automation_dir>
# Restores <automation_dir>/agents/KB.md from KB.md.original. Never fails the caller.
kb_restore_canonical() {
    local _automation_dir="${1:-${AUTOMATION_DIR:-}}"
    [ -n "$_automation_dir" ] || return 0

    local _kb="$_automation_dir/agents/KB.md"
    local _canonical="$_automation_dir/agents/KB.md.original"

    if [ ! -f "$_canonical" ]; then
        # NEVER silent. A reset that quietly skips is how the KB grew unnoticed for weeks:
        # every run reported a clean start while carrying the previous one's conclusions.
        # The existing KB is deliberately left alone — there is nothing to restore, and
        # deleting it would lose curated content with no way back.
        if command -v warning >/dev/null 2>&1; then
            warning "  KB canonical missing ($_canonical) — KB.md NOT reset; it will carry this run's entries into the next run"
        else
            echo "WARN: KB canonical missing ($_canonical) — KB.md NOT reset" >&2
        fi
        return 0
    fi

    mkdir -p "$_automation_dir/agents" 2>/dev/null || true
    cp "$_canonical" "$_kb" 2>/dev/null || return 0
    if command -v success >/dev/null 2>&1; then
        success "KB.md restored from canonical (within-run entries do not carry across runs)"
    fi

    kb_clear_agent_residue "$_automation_dir"
    return 0
}

# kb_clear_agent_residue <automation_dir>
# KB.md was never the only KB. The failure analyst appends to KB-<codeline>.md and
# KB-<role>.md, and self-heal writes agents/kb/. NONE of it was reset — KB-gotransit.md was
# found carrying entries dated across FOUR SEPARATE DAYS, all injected into later runs'
# prompts as current fact. pre-run-reset.sh had declared this deliberate:
#
#     # NOT cleared: KB-<role>.md. Per-agent knowledge is the one thing meant to persist
#
# Operator, 2026-08-12, overriding it: "agent kb files = remove all after every run - there
# can be no lingering anything to skew runs. That is strictly forbidden."
#
# BY PATTERN, never a list of names. A list is what let the ladder state survive (*.count
# cleared while .model and .iterbump remained) and what let review-feedback survive. A KB
# minted for an agent invented tomorrow is covered by this the day it appears.
kb_clear_agent_residue() {
    local _automation_dir="${1:-${AUTOMATION_DIR:-}}"
    [ -n "$_automation_dir" ] || return 0
    local _agents="$_automation_dir/agents"
    [ -d "$_agents" ] || return 0

    # KB-*.md — per-codeline and per-role prose. Deleted outright: nothing reads one that does
    # not exist, and an empty file still renders an empty KB section into a prompt.
    local _cleared=0
    _cleared=$(find "$_agents" -maxdepth 1 -type f -name 'KB-*.md' 2>/dev/null | wc -l)
    find "$_agents" -maxdepth 1 -type f -name 'KB-*.md' -delete 2>/dev/null || true

    # agents/kb/ — self-heal state. TRUNCATED, not deleted: the run reports and kb-replay.js
    # read these, and a missing file is a different failure from an empty one. Emptied to the
    # empty form of each type so a reader sees "no constraints", never a parse error.
    local _f
    if [ -d "$_agents/kb" ]; then
        while IFS= read -r _f; do
            [ -n "$_f" ] || continue
            case "$_f" in
                *.json)  printf '[]\n' > "$_f" 2>/dev/null || true ;;
                *)       : > "$_f" 2>/dev/null || true ;;
            esac
            _cleared=$((_cleared + 1))
        done <<EOF
$(find "$_agents/kb" -maxdepth 1 -type f 2>/dev/null)
EOF
    fi

    # A reset that could not clean must say so. Announcing a clean start while carrying the
    # previous run's conclusions is the exact failure this whole file exists to prevent.
    local _left
    _left=$(find "$_agents" -maxdepth 1 -type f -name 'KB-*.md' 2>/dev/null | wc -l)
    if [ "$_left" -gt 0 ]; then
        if command -v fail_contamination >/dev/null 2>&1; then
            fail_contamination "$_left agent KB file(s) could NOT be cleared in $_agents — a run started now would inherit a previous run's conclusions as fact"
        else
            echo "ERROR: $_left agent KB file(s) could NOT be cleared in $_agents" >&2
            return 1
        fi
    fi

    if [ "$_cleared" -gt 0 ] && command -v success >/dev/null 2>&1; then
        success "Cleared $_cleared agent KB file(s) — no prior run's conclusions reach this one"
    fi
    return 0
}

# kb_delete_project_kb [project-config-dir] — THE LAUNCHING PROJECT'S KB, DELETED.
#
# The KB is per-run scratch: written freely DURING a run, never surviving one. Only half of that
# was enforced — kb_restore_canonical resets the ENGINE KB and truncates the engine store, and
# nothing at all touched the project's own. So projects/metrolinx/KB.md (16 Aug) and
# projects/metrolinx/kb/*.jsonl (30 Aug) reached the 2026-09-01 run for AMSD-1919 carrying August's
# conclusions about AMSD-2041 — a different, closed ticket. kb-store.js reads exactly this path.
#
# DELETED, not truncated: kb-store.js recreates its directory on first write, so nothing needs an
# empty file left behind. Residue is an ERROR — announcing a clean start while carrying the last
# run's conclusions is the failure this file exists to prevent.
kb_delete_project_kb() {
    local _proj="${1:-${EPAM_PROJECT_CONFIG_DIR:-}}"
    if [ -z "$_proj" ] || [ ! -d "$_proj" ]; then
        if command -v info >/dev/null 2>&1; then
            info "No project selected — no project KB to delete"
        else
            echo "INFO: no project selected — nothing to delete" >&2
        fi
        return 0
    fi

    local _removed=0
    if [ -f "$_proj/KB.md" ]; then
        rm -f "$_proj/KB.md" 2>/dev/null || true
        _removed=$((_removed + 1))
    fi
    if [ -d "$_proj/kb" ]; then
        local _f
        while IFS= read -r _f; do
            [ -n "$_f" ] || continue
            rm -f "$_f" 2>/dev/null || true
            _removed=$((_removed + 1))
        done <<EOF
$(find "$_proj/kb" -maxdepth 1 -type f 2>/dev/null)
EOF
    fi

    # WHAT IS STILL THERE DECIDES THE VERDICT, not what was attempted.
    local _left=0
    [ -f "$_proj/KB.md" ] && _left=$((_left + 1))
    if [ -d "$_proj/kb" ]; then
        _left=$((_left + $(find "$_proj/kb" -maxdepth 1 -type f 2>/dev/null | wc -l)))
    fi
    if [ "$_left" -gt 0 ]; then
        if command -v fail_contamination >/dev/null 2>&1; then
            fail_contamination "$_left project KB file(s) could NOT be deleted in $_proj — this run would inherit the previous run's conclusions"
        else
            echo "ERROR: $_left project KB file(s) could NOT be deleted in $_proj" >&2
        fi
        return 1
    fi

    if command -v success >/dev/null 2>&1; then
        success "Deleted $_removed project KB file(s) in $_proj — this run starts with no KB at all"
    fi
    return 0
}
