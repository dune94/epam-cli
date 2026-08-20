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
# WHICH FILES ARE LINTABLE IS A PROJECT FACT. This was a literal list of ten extensions from
# one ecosystem — the same fact the project already declares as scanFileExtensions in
# .epam/dependency-check.json, and the same class of hardcoding that made the tsc baseline gate
# report PASS on any repo it could not parse. Read, never assumed; a project that declares none
# gets no tree-glob fallback rather than a guessed one.
_eslint_lintable_exts() {
    local _root="${1:-$PROJECT_ROOT}"
    local _cfg="$_root/.epam/dependency-check.json"
    [ -f "$_cfg" ] || _cfg="${EPAM_PROJECT_CONFIG_DIR:-}/dependency-check.json"
    [ -f "$_cfg" ] || return 0
    jq -r '.scanFileExtensions[]? // empty' "$_cfg" 2>/dev/null | sed 's/^\.//' | tr '\n' ' '
}

# Paths the pipeline itself writes into a client repo. Never story output.
_ESLINT_INCIDENTAL_RE='^(\.codegraph/|\.epam/)'

# The root is THREADED, never read from a global. eslint_baseline_gate takes project_root as a
# parameter and $PROJECT_ROOT is not guaranteed to be set in its callers — reading the global
# made the extension list come back empty, nothing was lintable, and the gate passed everything.
# Exactly the fail-open this conversion was meant to remove, reintroduced by a scoping slip.
_eslint_is_lintable() {
    local _f="$1" _root="${2:-${PROJECT_ROOT:-}}" _e
    for _e in $(_eslint_lintable_exts "$_root"); do
        case "$_f" in *."$_e") return 0 ;; esac
    done
    return 1
}

# Whole-tree glob targets, used when there is no scope to narrow to (greenfield).
_eslint_tree_globs() {
    local _root="$1" _ext _mr _prune=()
    # WHERE the source lives and WHICH directories are vendored are both project declarations.
    # This hardcoded src/ and node_modules — a repo whose sources sit elsewhere matched nothing
    # and the gate examined no files while reporting a verdict.
    local _vd
    while IFS= read -r _vd; do
        [ -n "$_vd" ] && _prune+=(-not -path "*/${_vd}/*")
    done < <(_eslint_vendor_dir_names "$_root" 2>/dev/null)

    for _mr in $(_eslint_source_roots "$_root"); do
        [ -d "$_root/$_mr" ] || continue
        for _ext in $(_eslint_lintable_exts "$_root"); do
            if [ -n "$(find "$_root/$_mr" -type f -name "*.${_ext}" \
                        "${_prune[@]}" -print -quit 2>/dev/null)" ]; then
                printf '%s\n' "${_mr}/**/*.${_ext}"
            fi
        done
    done
}

# SELF-CONTAINED ON PURPOSE. _get_vendor_dirs lives in claude.sh, which does not source this
# file — run-agent-orchestration.sh does. Calling it here would silently return nothing: no
# vendor prune, no baseline symlink, and a linter that cannot resolve at baseline reports every
# pre-existing finding as new. Same declaration, read locally.
# THE DECLARED VENDOR DIRECTORY NAMES — regardless of where they sit in the tree.
#
# _eslint_vendor_dirs below emits only vendor directories that exist AT THE ROOT, because its other
# caller symlinks them into a baseline worktree and needs real paths. Pruning is a different
# question: a vendored tree can sit at any depth — src/node_modules/, packages/*/node_modules/ — and
# the find prune matches by basename, so it never needed the directory to exist at the root.
#
# It did need one, and that is the defect: a repo whose only vendored copy is nested had nothing
# pruned, so a .js file belonging to a DEPENDENCY decided that .js was a project source extension,
# and eslint was handed `src/**/*.js` for a TypeScript project.
_eslint_vendor_dir_names() {
    local _root="${1:-$PROJECT_ROOT}"
    local _cfg="$_root/.epam/dependency-check.json"
    [ -f "$_cfg" ] || _cfg="${EPAM_PROJECT_CONFIG_DIR:-}/dependency-check.json"
    [ -f "$_cfg" ] || return 0
    jq -r '.vendorDirs[]? // empty' "$_cfg" 2>/dev/null | while IFS= read -r _d; do
        [ -n "$_d" ] && basename "$_d"
    done
}

_eslint_vendor_dirs() {
    local _root="${1:-$PROJECT_ROOT}"
    local _cfg="$_root/.epam/dependency-check.json"
    [ -f "$_cfg" ] || _cfg="${EPAM_PROJECT_CONFIG_DIR:-}/dependency-check.json"
    [ -f "$_cfg" ] || return 0
    jq -r '.vendorDirs[]? // empty' "$_cfg" 2>/dev/null | while IFS= read -r _d; do
        [ -n "$_d" ] && [ -d "$_root/$_d" ] && echo "$_root/$_d"
    done
}

# The project's declared module roots, from .epam/dependency-check.json. Absent = no tree-glob
# fallback, which is correct: a gate that cannot find the source must not claim to have linted it.
_eslint_source_roots() {
    local _root="${1:-$PROJECT_ROOT}"
    local _cfg="$_root/.epam/dependency-check.json"
    [ -f "$_cfg" ] || _cfg="${EPAM_PROJECT_CONFIG_DIR:-}/dependency-check.json"
    [ -f "$_cfg" ] || return 0
    jq -r '.moduleRoots[]? // empty' "$_cfg" 2>/dev/null | grep -v '^$' | tr '\n' ' '
}

eslint_baseline_gate() {
    local project_root="$1"
    local eslint_bin="$2"
    local log_dir="$3"
    local lint_log="$4"
    local helper
    helper="$(dirname "${BASH_SOURCE[0]}")/eslint_findings_diff.py"

    local baseline_sha=""
    # WHETHER WE COULD ESTABLISH PROVENANCE AT ALL — not whether the baseline was clean.
    # Those two were the same value (an empty cache) until 2026-08-14; see the block that
    # sets this, and the verdict that now honours it.
    local baseline_unavailable=0
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
            _eslint_is_lintable "$_f" "$project_root" || continue
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
            _eslint_is_lintable "$_f" "$project_root" || continue
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
            # UNDECLARED IS NOT THE SAME AS NOTHING TO LINT, and collapsing them is a fail-open
            # I introduced on 2026-08-11: replacing the hardcoded extension list with the
            # project's declaration meant a project that declares neither scanFileExtensions nor
            # moduleRoots produced zero targets, and this branch returned 0 — the gate reporting
            # PASS having examined nothing. The hardcoded list had always produced targets, so
            # the branch was only ever reached in the genuine case.
            if [ -z "$(_eslint_lintable_exts "$project_root")" ] || [ -z "$(_eslint_source_roots "$project_root")" ]; then
                warning "  [lint] eslint: NOT PERFORMED — this project declares no scanFileExtensions/moduleRoots in .epam/dependency-check.json, so there is nothing to scope the lint to. This is not a pass."
                echo "eslint: NOT PERFORMED — no scanFileExtensions/moduleRoots declared" >> "$lint_log"
                return 0
            fi
            info "  [lint] eslint: SKIP (the declared source roots contain no lintable files)"
            echo "eslint: SKIP — declared source roots contain no lintable files" >> "$lint_log"
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
        # The CHECKOUT must live outside this repo, even though the CACHE lives
        # in log_dir. Live metrolinx 2026-07-26: the worktree was created under
        # orchestrations/logs/ — inside epam-cli — so ESLint walked up from the
        # checkout and found @typescript-eslint twice, once via the client's
        # symlinked node_modules and once via epam-cli's own:
        #   ESLint couldn't determine the plugin "@typescript-eslint" uniquely.
        # It exited 2, wrote nothing, the cache was 0 bytes, and the entire
        # subtraction was silently skipped — every finding attributed to this
        # run, the precise false-blame this function exists to prevent.
        # lib/tsc-baseline-gate.sh has always used mktemp -d for this reason.
        local wt_parent wt_dir
        wt_parent=$(mktemp -d 2>/dev/null) || wt_parent=""
        wt_dir="${wt_parent:+$wt_parent/wt}"
        # -s, not -f: a zero-byte cache is a FAILED computation, not a cached
        # result. Live metrolinx 2026-07-26 — run 2 left an empty cache behind
        # (the duplicate-plugin failure this worktree relocation fixes), and on
        # run 3 `-f` read it as "already computed, skip", so the corrected code
        # never ran and the warning repeated verbatim. The consumption check
        # below already used -s; one function must not hold two notions of
        # "usable cache".
        if [ ! -s "$cache" ] && [ -n "$wt_dir" ]; then
            rm -f "$cache" 2>/dev/null || true
            rm -rf "$wt_dir" 2>/dev/null || true
            if git -C "$project_root" worktree add --detach "$wt_dir" "$baseline_sha" >/dev/null 2>&1; then
                # node_modules is gitignored, so `worktree add` does not check it
                # out. Without it eslint cannot resolve its plugins, produces no
                # findings, and every current finding then reads as new — the
                # exact inverse of this function's purpose. Same trap, and the
                # same fix, as tsc-baseline-gate.sh.
                # The vendored directories the PROJECT declares, symlinked so the linter can
                # resolve at baseline. `worktree add` checks out tracked files only, and this
                # named one ecosystem's directory outright — the last literal in this file.
                local _vd
                while IFS= read -r _vd; do
                    [ -n "$_vd" ] && [ -e "$_vd" ] \
                        && ln -s "$_vd" "$wt_dir/$(basename "$_vd")" 2>/dev/null || true
                done < <(_eslint_vendor_dirs "$project_root" 2>/dev/null)
                local -a baseline_targets=()
                local _f
                for _f in "${targets[@]}"; do
                    [ -f "$wt_dir/$_f" ] && baseline_targets+=("$_f")
                done
                if [ ${#baseline_targets[@]} -gt 0 ]; then
                    ( cd "$wt_dir" && "$eslint_bin" "${baseline_targets[@]}" -f json 2>/dev/null ) > "$cache" || true
                    # ESLint always reports ABSOLUTE filePaths, and this
                    # checkout is a throwaway temp dir. Store repo-relative
                    # paths so the cache stays meaningful on a later CACHE HIT,
                    # when that temp dir no longer exists and a freshly-minted
                    # one would share no prefix with it.
                    python3 - "$cache" "$wt_dir" <<'REBASE_PY' 2>/dev/null || true
import json, sys
cache, wt = sys.argv[1], sys.argv[2].rstrip('/') + '/'
try:
    with open(cache) as f: data = json.load(f)
except Exception: sys.exit(0)
for entry in data if isinstance(data, list) else []:
    p = entry.get('filePath', '')
    if p.startswith(wt): entry['filePath'] = p[len(wt):]
with open(cache, 'w') as f: json.dump(data, f)
REBASE_PY
                else
                    echo '[]' > "$cache"
                fi
                git -C "$project_root" worktree remove --force "$wt_dir" >/dev/null 2>&1 || true
            fi
            rm -rf "$wt_dir" 2>/dev/null || true
        fi
        [ -n "$wt_parent" ] && rm -rf "$wt_parent" 2>/dev/null || true
        if [ -s "$cache" ]; then
            baseline_json="$cache"
            # Paths in the cache are repo-relative (see the rebase above), so the
            # live tree is the right root to interpret them against.
            baseline_root="$project_root"
        else
            # THE CACHE IS EMPTY FOR TWO VERY DIFFERENT REASONS, AND THIS IS THE ONE THAT LIES.
            #
            # The linter runs inside a throwaway worktree with the project's declared vendor
            # directory symlinked in, because it is gitignored and `worktree add` will not check it
            # out. That symlink gives the linter two paths to the same physical plugin directory. A
            # codeline whose vendor tree carries a nested duplicate of a plugin — ordinary package
            # manager behaviour, harmless to the codeline's own lint run, which resolves each plugin
            # by exactly one path — then makes the linter refuse to start, and it writes nothing.
            #
            # Live 2026-08-14 (AMSD-2041): eight violations aged between one and nineteen months
            # were charged to a run that had just been APPROVED at review, two repair attempts could
            # not remove them because they were never its to remove, and the run was killed at 113
            # minutes. The sibling codeline passed the same gate the previous day on a flat vendor
            # tree. Same code, same commit, different topology.
            baseline_unavailable=1
            warning "  [lint] could not compute baseline findings for ${baseline_sha:0:12} — provenance is unknown, so findings cannot be attributed to this run"
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

    # UNATTRIBUTABLE IS NOT UNINVISIBLE, AND IT IS NOT GUILTY EITHER.
    #
    # Without a baseline the diff cannot tell a finding this run introduced from one that has been
    # in the codeline for a year. Failing here charges the run with the latter, and there is no
    # action it can take: removing them means editing code the story never mentioned, in a client
    # repository, which is precisely what the write perimeter exists to prevent. The findings are
    # reported in full so nothing is hidden — they are simply not laid at this run's door.
    #
    # This branch is reachable ONLY when the baseline computation itself failed. A computable
    # baseline with a genuine new finding still fails below, which the guard test holds shut.
    if [ "${baseline_unavailable:-0}" -eq 1 ]; then
        warning "  [lint] eslint: PASS WITH WARNING — the baseline could not be computed, so these"
        warning "  [lint] finding(s) cannot be attributed to this run and are reported, not charged:"
        printf '%s\n' "$new_out" | while IFS= read -r _l; do
            [ -n "$_l" ] && warning "  [lint]   $_l"
        done
        printf 'UNATTRIBUTABLE (baseline unavailable): %s\n' "$new_out" >> "$lint_log"
        return 0
    fi

    error "  [lint] eslint: FAIL — findings introduced by this run:"
    printf '%s\n' "$new_out" | while IFS= read -r _l; do
        [ -n "$_l" ] && error "  [lint]   $_l"
    done
    return 1
}
