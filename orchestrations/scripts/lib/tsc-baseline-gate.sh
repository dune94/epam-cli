#!/usr/bin/env bash

# _run_project_verification <project_root>
# The project's declared check (.epam/verification.json) via the verification plugin. The engine
# names no tool, extension, directory or runtime path. Undeclared -> non-zero with a reason.
_run_project_verification() {
    local _root="${1:-$PROJECT_ROOT}"
    # THE SECTION IS THE CALLER'S, NOT AN ASSUMPTION. Without it every baseline ran the manifest's
    # typecheck command -- including the one asked for section="test" -- so the suite baseline was
    # never built, its cache was deleted, and every pre-existing suite failure was charged to the
    # story. Live 2026-09-02 (AMSD-1919). Empty means "the plugin's default", which is typecheck.
    local _section="${2:-}"
    local _auto="${AUTOMATION_DIR:-$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")}"
    local _plugin="${_auto}/plugins/verification-plugin.js"
    local _node="${NODE_CMD:-${NODE_BIN:-node}}"
    if [ ! -f "$_plugin" ]; then echo "verification plugin missing at $_plugin"; return 2; fi
    "$_node" -e '
      const p = require(process.argv[1]);
      const r = p.runVerification(process.argv[2], undefined, process.argv[3] || undefined);
      if (r.status === "unknown") { console.log("verification not declared: " + r.reason); process.exit(2); }
      if (r.output) console.log(r.output);
      process.exit(r.status === "pass" ? 0 : (r.exitCode || 1));
    ' "$_plugin" "$_root" "$_section"
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
# baseline_new_failures <project_root> <node_cmd> <log_dir> [section] [output_file]
#
# With an output_file, the caller has ALREADY run the check and captured it — every live caller
# has, and re-running would double the cost of the most expensive gate in the run. Without one,
# the check is run here.
baseline_new_failures() {
    local project_root="$1"
    local node_cmd="$2"
    local log_dir="$3"
    local section="${4:-typecheck}"
    local output_file="${5:-}"

    local check_output check_exit=0
    if [ -n "$output_file" ] && [ -f "$output_file" ]; then
        check_output="$(cat "$output_file")"
        check_exit=1     # a caller only asks for a delta because the check already failed
    else
        check_output=$(_run_project_verification "$project_root" 2>&1) || check_exit=$?
    fi

    if [ "$check_exit" -eq 0 ]; then
        return 0
    fi

    local _plugin="${AUTOMATION_DIR:-$(dirname "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)")}/plugins/verification-plugin.js"
    local _node="${node_cmd:-${NODE_CMD:-${NODE_BIN:-node}}}"

    local new_errors="$check_output"
    local baseline_sha_file="$log_dir/phase-baseline-sha.txt"
    if [ -f "$baseline_sha_file" ] && [ -f "$_plugin" ]; then
        local baseline_sha
        baseline_sha=$(tr -d '[:space:]' < "$baseline_sha_file")
        if [ -n "$baseline_sha" ]; then
            local baseline_cache="$log_dir/baseline-failures-${section}-${baseline_sha:0:12}.txt"
            if [ ! -f "$baseline_cache" ]; then
                local wt_dir
                wt_dir=$(mktemp -d)
                if git -C "$project_root" worktree add --detach "$wt_dir" "$baseline_sha" >/dev/null 2>&1; then
                    # VENDOR DIRECTORIES ARE GITIGNORED, so `worktree add` — which checks out only
                    # tracked files — leaves them absent. Without them the checker cannot resolve
                    # anything, the baseline comes back empty, and every current error looks NEW:
                    # the exact inverse of what this gate is for. WHICH directories those are is
                    # the project's declaration, not this script's knowledge.
                    # _get_vendor_dirs returns ABSOLUTE paths. Treating them as relative
                    # produced "$project_root/$project_root/node_modules", the symlink never
                    # landed, the checker could not resolve anything at baseline, and its failure
                    # set came back wrong — so every current failure looked new. Basename is the
                    # link name inside the worktree; the source is already absolute.
                    local _vd
                    while IFS= read -r _vd; do
                        [ -n "$_vd" ] && [ -e "$_vd" ] \
                            && ln -s "$_vd" "$wt_dir/$(basename "$_vd")" 2>/dev/null || true
                    done < <(_get_vendor_dirs "$project_root" 2>/dev/null)

                    # THE BASELINE CHECK IS SUPPOSED TO FAIL. That is the whole premise: the
                    # baseline carries pre-existing failures, and capturing them is the point.
                    #
                    # Piping it straight into the parser made `set -o pipefail` propagate that
                    # expected non-zero to the whole pipeline, so the `|| rm -f` deleted the cache
                    # it had just written — every single time. The delta then had nothing to
                    # subtract against and reported every pre-existing failure as new, which is
                    # the exact inverse of this gate. Capture first, parse second.
                    local _base_out
                    _base_out=$(mktemp)
                    _run_project_verification "$wt_dir" "$section" > "$_base_out" 2>&1 || true
                    if "$_node" -e '
                            const fs = require("fs");
                            const p = require(process.argv[1]);
                            const s = fs.readFileSync(process.argv[4], "utf8");
                            const ids = p.parseFailures(process.argv[2], s, process.argv[3]);
                            if (ids === null) process.exit(3);   // undeclared parse — say nothing
                            process.stdout.write(ids.join("\n"));
                          ' "$_plugin" "$wt_dir" "$section" "$_base_out" > "$baseline_cache" 2>/dev/null; then
                        :
                    else
                        rm -f "$baseline_cache"
                    fi
                    rm -f "$_base_out"
                    git -C "$project_root" worktree remove --force "$wt_dir" >/dev/null 2>&1 || true
                fi
                rm -rf "$wt_dir" 2>/dev/null || true
            fi
            if [ -f "$baseline_cache" ]; then
                # SUBTRACT ON IDENTITY, never on counts: "745 passed -> 735 passed" says nothing
                # about WHICH, and a count diff reports "10 before, 10 after, fine" while the
                # failing set has changed completely.
                #
                # An UNDECLARED parse returns null and this block is skipped entirely, so the
                # full output is reported rather than an empty diff. That is the fail-open this
                # replaces: an unparseable checker used to yield an empty set, nothing to
                # subtract, and a PASS.
                new_errors=$(printf '%s' "$check_output" | "$_node" -e '
                    const fs = require("fs");
                    const p = require(process.argv[1]);
                    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
                      const cur = p.parseFailures(process.argv[2], s, process.argv[4]);
                      let base = [];
                      try { base = fs.readFileSync(process.argv[3], "utf8").split("\n").filter(Boolean); }
                      catch { base = []; }
                      const fresh = p.newFailures(cur, base);
                      if (fresh === null) { process.stdout.write(s); return; }
                      if (!fresh.length) return;
                      // Report the OWN lines of the checker for the new identities — an
                      // operator needs the message, not the key.
                      const keep = new Set(fresh);
                      const lines = s.split("\n").filter((l) => {
                        const ids = p.parseFailures(process.argv[2], l, process.argv[4]) || [];
                        return ids.some((i) => keep.has(i));
                      });
                      process.stdout.write(lines.join("\n"));
                    });
                  ' "$_plugin" "$project_root" "$baseline_cache" "$section" 2>/dev/null || echo "$check_output")
            fi
        fi
    fi

    if [ -z "$(echo "$new_errors" | tr -d '[:space:]')" ]; then
        return 0
    fi

    echo "$new_errors"
    return 1
}

# Backwards-compatible name for existing callers.
tsc_baseline_new_errors() { baseline_new_failures "$@"; }
