#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# jq-vals.sh — build a prompt values file without passing content through argv.
#
# WHY THIS EXISTS. MAX_ARG_STRLEN caps a SINGLE argv entry at 128KB. That is not
# ARG_MAX (2MB), which is the whole vector, and it is not configurable. So:
#
#     jq -n --arg prompt "$prompt" '{"__PROMPT__":$prompt}' > "$_vals"
#
# dies with `jq: Argument list too long` and exit 126 the moment the prompt
# crosses 128KB — which a writer prompt carrying a story, its criteria, the file
# contents and an execution plan does routinely.
#
# Live metrolinx AMSD-2041, 2026-08-19: this killed 'coordinator-amendment' and
# 'writer-plan-section'. Both callers assign through bare command substitution,
# so the dead render became an EMPTY STRING rather than a refusal — the retry
# amendment carried nothing (0 rendered, 2 failed across the whole run) and the
# writer prompt itself went out empty. Every gate verdict was correct; not one
# reached the agent. The run climbed the ladder to its top rung against a wall
# no model had been shown.
#
# THE SAME CLASS WAS FIXED ONCE BEFORE AT ONE SITE (2e2e8b1,
# contextualize-stories.sh). Fixing the site left 80 others, so this is a drop-in
# with the SAME calling syntax as `jq -n`: convert a site by replacing `jq -n`
# with `jq_vals` and changing nothing else. A test scans for site 81.
#
#   jq_vals [--arg NAME VALUE]... [--argjson NAME JSON]... FILTER
#
# Values reach jq through files (`--rawfile`), never argv. The values themselves
# are written with printf, a shell BUILTIN — no exec, so no cap applies to them.
# ─────────────────────────────────────────────────────────────────────────────

# shellcheck disable=SC2148

jq_vals() {
    local _args=() _files=() _prelude="" _name _value _tmp _rc

    while [ $# -gt 0 ]; do
        case "$1" in
            --arg)
                [ $# -ge 3 ] || { echo "[jq_vals] --arg needs NAME and VALUE" >&2; return 2; }
                _name="$2"; _value="$3"; shift 3
                _tmp=$(mktemp "${TMPDIR:-/tmp}/jqvals-XXXXXX") || return 2
                _files+=("$_tmp")
                # printf is a builtin: the value never becomes an argv entry of an
                # exec'd process, which is the entire point of this function.
                printf '%s' "$_value" > "$_tmp"
                _args+=(--rawfile "$_name" "$_tmp")
                ;;
            --argjson)
                [ $# -ge 3 ] || { echo "[jq_vals] --argjson needs NAME and JSON" >&2; return 2; }
                _name="$2"; _value="$3"; shift 3
                _tmp=$(mktemp "${TMPDIR:-/tmp}/jqvals-XXXXXX") || return 2
                _files+=("$_tmp")
                printf '%s' "$_value" > "$_tmp"
                # --rawfile hands jq a STRING, so the JSON is parsed inside the filter
                # and bound to the name the caller asked for. The caller's filter is
                # never rewritten — it is prefixed, so `$name` means what it always
                # meant and a filter containing the literal text `$name` in a string
                # is untouched.
                _args+=(--rawfile "_jqv_${_name}" "$_tmp")
                _prelude="${_prelude}(\$_jqv_${_name}|fromjson) as \$${_name} | "
                ;;
            *)
                break
                ;;
        esac
    done

    if [ $# -lt 1 ]; then
        echo "[jq_vals] no filter given" >&2
        rm -f "${_files[@]}" 2>/dev/null
        return 2
    fi

    # The filter is the first remaining argument; anything after it is passed on
    # untouched (jq takes no positional input here, but a caller may add flags).
    local _filter="$1"; shift

    jq -n "${_args[@]}" "${_prelude}${_filter}" "$@"
    _rc=$?

    # Cleaned up on every path. One render leaks one file per value otherwise, and
    # a story that retries twelve times renders many times.
    rm -f "${_files[@]}" 2>/dev/null
    return "$_rc"
}
