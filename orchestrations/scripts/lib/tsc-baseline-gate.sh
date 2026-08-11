#!/usr/bin/env bash

# _run_project_verification <project_root>
# The project's declared check (.epam/verification.json) via the verification plugin. The engine
# names no tool, extension, directory or runtime path. Undeclared -> non-zero with a reason.
_run_project_verification() {
    local _root="${1:-$PROJECT_ROOT}"
    local _auto="${AUTOMATION_DIR:-$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")}"
    local _plugin="${_auto}/plugins/verification-tools.js"
    local _node="${NODE_CMD:-${NODE_BIN:-node}}"
    if [ ! -f "$_plugin" ]; then echo "verification plugin missing at $_plugin"; return 2; fi
    "$_node" -e '
      const p = require(process.argv[1]);
      const r = p.runVerification(process.argv[2]);
      if (r.status === "unknown") { console.log("verification not declared: " + r.reason); process.exit(2); }
      if (r.output) console.log(r.output);
      process.exit(r.status === "pass" ? 0 : (r.exitCode || 1));
    ' "$_plugin" "$_root"
}

# tsc-baseline-gate.sh — shared "new errors only" tsc filtering, used by
# BOTH claude.sh's per-story tsc-verify/tsc-gate AND run-agent-orchestration.sh's
# Step 19 pre-review gate.
#
# Root cause this fixes (2026-07-23): claude.sh's per-story gate already had
# this baseline-tolerance logic (a brownfield repo can have pre-existing tsc
# errors in files no story touches — failing on those blocks every story
# identically regardless of what it actually changed). Step 19 duplicated
# NONE of it — it ran raw `tsc --noEmit` and hard-failed on ANY error,
# including ones the per-story gate had ALREADY classified as pre-existing
# and not this story's fault. That inconsistency meant a story could pass
# review (team-lead APPROVED) and still have the whole phase abort at Step 19
# over an error nobody introduced. Extracted into one shared function so both
# gates can never diverge again.
#
# tsc_baseline_new_errors <project_root> <node_cmd> <log_dir>
# Prints the tsc --noEmit errors that are NEW relative to JIRA_BASELINE_BRANCH
# (empty output + exit 0 if tsc passed, or if every error is pre-existing).
# Exit code: 0 = no new errors (pass), 1 = new errors present (fail).
tsc_baseline_new_errors() {
    local project_root="$1"
    local node_cmd="$2"
    local log_dir="$3"

    local tsc_output tsc_exit=0
    tsc_output=$(_run_project_verification "$project_root" 2>&1) || tsc_exit=$?

    if [ "$tsc_exit" -eq 0 ]; then
        return 0
    fi

    local new_errors="$tsc_output"
    local baseline_sha_file="$log_dir/phase-baseline-sha.txt"
    if [ -f "$baseline_sha_file" ]; then
        local baseline_sha
        baseline_sha=$(tr -d '[:space:]' < "$baseline_sha_file")
        if [ -n "$baseline_sha" ]; then
            local baseline_cache="$log_dir/tsc-baseline-errors-${baseline_sha:0:12}.txt"
            if [ ! -f "$baseline_cache" ]; then
                local wt_dir
                wt_dir=$(mktemp -d)
                if git -C "$project_root" worktree add --detach "$wt_dir" "$baseline_sha" >/dev/null 2>&1; then
                    # node_modules is gitignored — `worktree add` only checks out
                    # tracked files, so it's absent in the new worktree. Without
                    # it, tsc silently fails to run (module not found) and the
                    # baseline cache ends up empty, making every current-state
                    # error look "new" — the exact opposite of this fix's intent.
                    ln -s "$project_root/node_modules" "$wt_dir/node_modules" 2>/dev/null || true
                    ( _run_project_verification "$wt_dir" 2>&1 \
                        | grep -oE '^[^(]+\([0-9]+,[0-9]+\): error [A-Z0-9]+' ) > "$baseline_cache" 2>/dev/null || true
                    git -C "$project_root" worktree remove --force "$wt_dir" >/dev/null 2>&1 || true
                fi
                rm -rf "$wt_dir" 2>/dev/null || true
            fi
            if [ -f "$baseline_cache" ]; then
                # Extract the same "<file>(<line>,<col>): error <CODE>" key from
                # the current output, then keep only lines whose key is absent
                # from the baseline set — genuinely new errors this story introduced.
                new_errors=$(echo "$tsc_output" | grep -oE '^[^(]+\([0-9]+,[0-9]+\): error [A-Z0-9]+.*$' \
                    | grep -vFf "$baseline_cache" || true)
            fi
        fi
    fi

    if [ -z "$(echo "$new_errors" | tr -d '[:space:]')" ]; then
        return 0
    fi

    echo "$new_errors"
    return 1
}
