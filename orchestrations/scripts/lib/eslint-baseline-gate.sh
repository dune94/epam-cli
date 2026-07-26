#!/usr/bin/env bash
# eslint-baseline-gate.sh — the Step 20 lint verdict, scoped to what this run
# actually produced and charged only for what it actually introduced.
#
# Sibling of lib/tsc-baseline-gate.sh, which already solved this shape for tsc:
# a brownfield repo can carry pre-existing findings in files no story touches,
# and failing on those blocks every story identically regardless of what it
# changed. Step 20's eslint half had none of that logic. It ran
# `eslint src/ --max-warnings 0` over the whole tree and hard-failed on any
# finding — and, because a bare directory argument is expanded using --ext
# (default .js, removed outright in ESLint 9), on a TypeScript codeline it
# matched no files at all and failed with exit 2 having examined nothing.
# Live metrolinx 2026-07-25: story implemented, tested and committed, phase
# aborted by a gate that was never reporting on the code.
#
# Three rules follow from that, and they are the whole of this file:
#
#   SCOPE   The gate judges the writers' outputs. The story loop records them
#           (record_story_outputs in claude.sh); this reads that manifest.
#           Falling back to a baseline diff is allowed, but never silently.
#
#   BLAME   Only findings ABSENT at the phase baseline count. A writer that
#           edits an already-dirty file does not inherit its debt: the only way
#           to satisfy that would be reformatting code the ticket never
#           mentioned, which the team-lead reviewer separately vetoes as
#           over-engineering. The pipeline must not fight itself.
#
#   COST    Step 20 runs after the story is committed, and its remediation path
#           exits 2, which tier3-*-run.sh answers by re-running the entire
#           phase with --reset. Auto-fixable findings are fixed here,
#           deterministically, instead of buying a story rebuild to correct
#           whitespace. Only findings needing judgement reach the loop.
#
# Greenfield is unchanged in spirit: with no baseline, every finding is new —
# suppressing there would disable the gate on exactly the code the pipeline
# wrote from scratch.
#
# eslint_baseline_gate <project_root> <eslint_bin> <log_dir> <lint_log>
#   0 = pass (nothing new)   1 = new findings   2 = could not run

# Extensions ESLint can parse. A property of the linter, not of any one
# project's stack — deriving targets from what is present is what keeps a
# JS-shaped assumption out of the engine.
_ESLINT_LINTABLE_EXTS="js jsx mjs cjs ts tsx mts cts vue svelte"

# Paths the pipeline itself writes into a client repo. Never story output.
_ESLINT_INCIDENTAL_RE='^(\.codegraph/|\.epam/)'

_eslint_is_lintable() {
    local _f="$1" _e
    for _e in $_ESLINT_LINTABLE_EXTS; do
        case "$_f" in *."$_e") return 0 ;; esac
    done
    return 1
}

# Whole-tree glob targets, used when there is no scope to narrow to (greenfield).
_eslint_tree_globs() {
    local _root="$1" _ext
    for _ext in $_ESLINT_LINTABLE_EXTS; do
        if [ -n "$(find "$_root/src" -type f -name "*.${_ext}" \
                    -not -path '*/node_modules/*' -print -quit 2>/dev/null)" ]; then
            printf '%s\n' "src/**/*.${_ext}"
        fi
    done
}

eslint_baseline_gate() {
    local project_root="$1"
    local eslint_bin="$2"
    local log_dir="$3"
    local lint_log="$4"
    local helper
    helper="$(dirname "${BASH_SOURCE[0]}")/eslint_findings_diff.py"

    local baseline_sha=""
    local baseline_file="$log_dir/phase-baseline-sha.txt"
    if [ -f "$baseline_file" ]; then
        baseline_sha=$(tr -d '[:space:]' < "$baseline_file" 2>/dev/null)
    fi

    # ── SCOPE ────────────────────────────────────────────────────────────────
    local manifest="$log_dir/story-outputs-${PHASE:-core}.txt"
    local scope_files=() scope_source=""
    if [ -s "$manifest" ]; then
        scope_source="writer output manifest"
        while IFS= read -r _f; do
            [ -n "$_f" ] || continue
            printf '%s' "$_f" | grep -qE "$_ESLINT_INCIDENTAL_RE" && continue
            _eslint_is_lintable "$_f" || continue
            [ -f "$project_root/$_f" ] || continue
            scope_files+=("$_f")
        done < "$manifest"
    elif [ -n "$baseline_sha" ] && [ -d "$project_root/.git" ]; then
        # Loud on purpose: a gate that quietly changes how it computes its own
        # scope is indistinguishable from one that is broken.
        warning "  [lint] no writer-output manifest at $manifest — falling back to the baseline diff for lint scope"
        scope_source="baseline diff fallback"
        while IFS= read -r _f; do
            [ -n "$_f" ] || continue
            printf '%s' "$_f" | grep -qE "$_ESLINT_INCIDENTAL_RE" && continue
            _eslint_is_lintable "$_f" || continue
            [ -f "$project_root/$_f" ] || continue
            scope_files+=("$_f")
        done < <(git -C "$project_root" diff --name-only "$baseline_sha" 2>/dev/null || true)
    fi

    local -a targets=()
    local greenfield=0
    if [ -n "$scope_source" ]; then
        if [ ${#scope_files[@]} -eq 0 ]; then
            info "  [lint] eslint: SKIP — this run produced no lintable source files ($scope_source)"
            echo "eslint: SKIP — no lintable writer output ($scope_source)" >> "$lint_log"
            return 0
        fi
        targets=("${scope_files[@]}")
        info "  [lint] scope: ${#scope_files[@]} file(s) from $scope_source"
    else
        # No manifest AND no baseline: a scaffolded project. Everything is ours.
        greenfield=1
        while IFS= read -r _g; do [ -n "$_g" ] && targets+=("$_g"); done < <(_eslint_tree_globs "$project_root")
        if [ ${#targets[@]} -eq 0 ]; then
            info "  [lint] eslint: SKIP (no lintable source files under src/)"
            echo "eslint: SKIP — no lintable source files under src/" >> "$lint_log"
            return 0
        fi
        info "  [lint] scope: whole tree (greenfield — no phase baseline to compare against)"
    fi

    # ── BASELINE FINDINGS ────────────────────────────────────────────────────
    # Computed in a detached worktree at the phase baseline, cached per SHA
    # exactly as tsc-baseline-gate.sh does. `-` means "no baseline", which the
    # helper reads as "every finding is new".
    local baseline_json="-" baseline_root="$project_root"
    if [ "$greenfield" -eq 0 ] && [ -n "$baseline_sha" ]; then
        local cache="$log_dir/eslint-baseline-${baseline_sha:0:12}.json"
        local wt_dir="$log_dir/.eslint-baseline-wt-${baseline_sha:0:12}"
        if [ ! -f "$cache" ]; then
            rm -rf "$wt_dir" 2>/dev/null || true
            if git -C "$project_root" worktree add --detach "$wt_dir" "$baseline_sha" >/dev/null 2>&1; then
                # node_modules is gitignored, so `worktree add` does not check it
                # out. Without it eslint cannot resolve its plugins, produces no
                # findings, and every current finding then reads as new — the
                # exact inverse of this function's purpose. Same trap, and the
                # same fix, as tsc-baseline-gate.sh.
                ln -s "$project_root/node_modules" "$wt_dir/node_modules" 2>/dev/null || true
                local -a baseline_targets=()
                local _f
                for _f in "${targets[@]}"; do
                    [ -f "$wt_dir/$_f" ] && baseline_targets+=("$_f")
                done
                if [ ${#baseline_targets[@]} -gt 0 ]; then
                    ( cd "$wt_dir" && "$eslint_bin" "${baseline_targets[@]}" -f json 2>/dev/null ) > "$cache" || true
                else
                    echo '[]' > "$cache"
                fi
                git -C "$project_root" worktree remove --force "$wt_dir" >/dev/null 2>&1 || true
            fi
            rm -rf "$wt_dir" 2>/dev/null || true
        fi
        if [ -s "$cache" ]; then
            baseline_json="$cache"
            baseline_root="$wt_dir"
        else
            warning "  [lint] could not compute baseline findings for ${baseline_sha:0:12} — every finding will be attributed to this run"
        fi
    fi

    # ── AUTO-FIX ─────────────────────────────────────────────────────────────
    # Only files that were CLEAN at the baseline. `eslint --fix` cannot be
    # limited to our lines, so running it on a file with inherited violations
    # would reformat code the ticket never mentioned and balloon the client diff.
    local -a dirty=() fixable=()
    if [ "$baseline_json" != "-" ]; then
        while IFS= read -r _f; do [ -n "$_f" ] && dirty+=("$_f"); done < \
            <(python3 "$helper" dirty-files "$baseline_json" "$baseline_root" 2>/dev/null || true)
    fi
    local _t _d _is_dirty
    for _t in "${targets[@]}"; do
        _is_dirty=0
        for _d in ${dirty[@]+"${dirty[@]}"}; do
            [ "$_t" = "$_d" ] && { _is_dirty=1; break; }
        done
        [ "$_is_dirty" -eq 0 ] && fixable+=("$_t")
    done
    if [ ${#fixable[@]} -gt 0 ]; then
        info "  [lint] auto-fixing ${#fixable[@]} file(s) clean at baseline (${#dirty[@]} skipped: pre-existing findings, not ours to reformat)"
        ( cd "$project_root" && "$eslint_bin" "${fixable[@]}" --fix >/dev/null 2>&1 ) || true
    fi

    # ── VERDICT ──────────────────────────────────────────────────────────────
    local current_json="$log_dir/eslint-current-${PHASE:-core}.json"
    local run_exit=0
    ( cd "$project_root" && "$eslint_bin" "${targets[@]}" -f json 2>/dev/null ) > "$current_json" || run_exit=$?
    if [ ! -s "$current_json" ]; then
        error "  [lint] eslint: COULD NOT RUN (exit $run_exit) — examined no files; lint targets or config are wrong, not the code"
        error "  [lint] targets: ${targets[*]}"
        echo "eslint: exit $run_exit — examined no files (target/config error, not a code finding)" >> "$lint_log"
        return 2
    fi

    local new_out new_rc=0
    new_out=$(python3 "$helper" diff "$baseline_json" "$current_json" "$project_root" 2>&1) || new_rc=$?
    printf '%s\n' "$new_out" >> "$lint_log"

    if [ "$new_rc" -eq 0 ]; then
        success "  [lint] eslint: PASS (no findings introduced by this run)"
        printf '%s\n' "$new_out" | grep -E 'pre-existing' | while IFS= read -r _l; do info "  [lint] $_l"; done
        return 0
    fi

    error "  [lint] eslint: FAIL — findings introduced by this run:"
    printf '%s\n' "$new_out" | while IFS= read -r _l; do
        [ -n "$_l" ] && error "  [lint]   $_l"
    done
    return 1
}
