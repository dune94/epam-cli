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
    return 0
}
