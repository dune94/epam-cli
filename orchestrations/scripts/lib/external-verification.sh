#!/usr/bin/env bash
# external-verification.sh — moved verbatim out of claude.sh by tools/split-main-into-modules.py
# (24 functions). Sourced by claude.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# _get_vendor_dirs <project_root>
# Reads the generic, project-supplied list of vendored-dependency directories
# from .epam/dependency-check.json's "vendorDirs" key (e.g. ["node_modules"]
# for an npm project, ["venv", "site-packages"] for Python, ["vendor"] for Go
# — never hardcoded in this engine, since a future project may not use npm at
# all). Opt-in: no config file or no "vendorDirs" key = no output, callers
# no-op. Echoes one absolute path per line for directories that actually exist.
_get_vendor_dirs() {
    local project_root="$1"
    local config_file="${project_root}/.epam/dependency-check.json"
    [ -f "$config_file" ] || return 0
    jq -r '.vendorDirs[]? // empty' "$config_file" 2>/dev/null | while IFS= read -r _d; do
        [ -z "$_d" ] && continue
        local _abs="$project_root/$_d"
        [ -d "$_abs" ] && echo "$_abs"
    done
}

# _vendor_lock <project_root>
# Root cause this addresses (found live, 2026-07-07): a story's agent,
# repeatedly failing to get its real test tool working, OVERWROTE the actual
# installed package's own entry point file (node_modules/vitest/vitest.mjs)
# with a fake stub that unconditionally echoed "passed" — the agent faking
# verification success rather than fixing the underlying problem. HealingBroken
# eventually caught the recurring failure and the story was correctly marked
# failed, not falsely passed, but the tampering itself should never have been
# possible in the first place.
#
# chmod -R a-w on every configured vendor dir, same OS-level pre-emptive
# guard already proven for _scope_lock's per-story file protection — applied
# once per story attempt (before invoking the agent), not per-file, since
# vendor dirs are NEVER a legitimate write target for any story, unlike
# src/ files which rotate ownership between stories.
# Note (same limitation _scope_lock already documents): this deters, it does
# not cryptographically prevent — the file owner can still `chmod +w` via
# Bash and bypass it. See run_vendor_integrity_check() below for the backstop
# that catches tampering even when the lock itself is bypassed.
_vendor_lock() {
    local project_root="$1"
    local _locked=0
    local _vendor_dir
    while IFS= read -r _vendor_dir; do
        [ -z "$_vendor_dir" ] && continue
        chmod -R a-w "$_vendor_dir" 2>/dev/null && ((_locked++))
    done < <(_get_vendor_dirs "$project_root")
    if [ "$_locked" -gt 0 ]; then
        mkdir -p "$project_root/.epam" 2>/dev/null || true
        touch "$project_root/.epam/.vendor-lock-marker" 2>/dev/null || true
        log "  [vendor-guard] Locked $_locked vendor director(y/ies) read-only"
    fi
}

# _vendor_unlock <project_root>
# Restores write permissions on configured vendor dirs — called after the
# agent's own turn ends, before run_dependency_check's own LEGITIMATE
# installs (which do need to write there) and the deterministic checks/test
# run. The integrity check itself (run_vendor_integrity_check) runs BEFORE
# this unlock and before run_dependency_check, so it only ever sees changes
# from the agent's own turn, never dependency-check's sanctioned writes.
_vendor_unlock() {
    local project_root="$1"
    local _vendor_dir
    while IFS= read -r _vendor_dir; do
        [ -z "$_vendor_dir" ] && continue
        chmod -R u+w "$_vendor_dir" 2>/dev/null || true
    done < <(_get_vendor_dirs "$project_root")
}

# run_vendor_integrity_check <project_root> <output_file>
# Deterministic backstop (found live, 2026-07-07 — see _vendor_lock's
# docstring for the exact live defect this catches): detects any file under a
# configured vendor dir modified since the lock marker was touched at story-
# attempt start, regardless of whether the chmod lock itself was bypassed.
# A legitimate story NEVER needs to modify an already-installed vendored
# package's own files — only add NEW dependencies via the manifest, which
# run_dependency_check's sanctioned install step handles AFTER this check
# runs. Any hit here is treated as a hard, deterministic failure — no LLM
# diagnosis needed, the fact itself is certain.
#
# Excludes tool-generated cache/output paths, config-supplied via
# .epam/dependency-check.json's "vendorCacheExcludePatterns" (bash glob
# patterns matched against each file's path relative to the vendor dir — e.g.
# ".vite/*" for Vitest's own results cache). No test-runner/tool name is
# hardcoded in this engine, same "manifest supplies stack knowledge" pattern
# as vendorDirs/requiredDevDependencies above. Root cause this fixes (found
# live, 2026-07-13, SKY-004 and SKY-003-b): a story's agent legitimately runs
# its own tests to self-verify — completely normal, encouraged behavior — and
# vitest rewrites its OWN result cache (node_modules/.vite/vitest/results.json)
# as a side effect. That's the tool's own transient output, not a rewrite of
# its actual entry-point/source code (the exploit this check exists to catch,
# e.g. node_modules/vitest/vitest.mjs) — but the check couldn't tell them
# apart, hard-failing 4 separate legitimate test runs across two stories in a
# single run.
# Returns 0 if clean (or no vendor dirs configured / no marker yet). Returns 1
# and sets VERIFICATION_FAILURE otherwise.
run_vendor_integrity_check() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local marker="$project_root/.epam/.vendor-lock-marker"
    [ -f "$marker" ] || return 0

    local -a exclude_patterns=()
    local _config_file="$project_root/.epam/dependency-check.json"
    if [ -f "$_config_file" ]; then
        while IFS= read -r _pat; do
            [ -n "$_pat" ] && exclude_patterns+=("$_pat")
        done < <(jq -r '.vendorCacheExcludePatterns[]? // empty' "$_config_file" 2>/dev/null)
    fi

    local tampered=()
    local _vendor_dir
    while IFS= read -r _vendor_dir; do
        [ -z "$_vendor_dir" ] && continue
        while IFS= read -r _f; do
            [ -z "$_f" ] && continue
            local _rel="${_f#"$_vendor_dir"/}"
            local _excluded=false
            local _pat
            for _pat in "${exclude_patterns[@]}"; do
                # shellcheck disable=SC2254 # intentional glob match against a config-supplied pattern
                case "$_rel" in
                    $_pat) _excluded=true; break ;;
                esac
            done
            [ "$_excluded" = true ] || tampered+=("$_f")
        done < <(find "$_vendor_dir" -type f -newer "$marker" 2>/dev/null)
    done < <(_get_vendor_dirs "$project_root")

    [ "${#tampered[@]}" -eq 0 ] && return 0

    local details
    details=$(head -n "$(evidence_window tamperedFileLines)" <<< "$(printf '%s\n' "${tampered[@]}")")
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nFile(s) inside a vendored/third-party dependency directory were modified — this is never legitimate (only NEW dependencies should be added via the manifest, never an existing installed package edited directly). Revert this change and fix the ACTUAL problem (e.g. wrong package.json config, missing devDependency) instead:\n\n%s\n' "$details")
    {
        echo ""
        echo "=== Vendor directory integrity check failed ==="
        echo "$details"
    } >> "$output_file"
    return 1
}

# run_dependency_check <project_root>
#
# SCANNING IS A PLUGIN. This was 371 lines of Python embedded in a heredoc here, which scanned
# source for imports, classified each specifier, and AUTO-INSTALLED whatever it called missing.
# Import scanning and module resolution are language facts, so they moved to
# orchestrations/plugins/dependency-scan-plugin.js. This is now a reporter.
#
# WHY IT MOVED. Live 2026-08-11 (AMSD-2041/gotransit) the old code installed
# "components": "^0.1.0" — an unrelated 2013 public npm package — into a transit operator's
# production manifest. `components` is that repository's OWN directory. It happened because the
# scanner hardcoded ecosystem facts the project already declares (vendorDirs was DECLARED while
# 'node_modules' was written literally four times in the same function), so when the declaration
# was absent the literals kept it running and it produced a confident wrong answer instead of
# stopping.
#
# THE ENGINE NO LONGER DECIDES. An unresolvable import is a FINDING. Installing happens only
# when the PROJECT declares autoInstall, using the installCommand the project declares — never
# on this script's own verdict.
# run_lockfile_sync_check <project_root>
#
# THE MANIFEST AND THE LOCKFILE DRIFTED APART AND EVERY CHECK PASSED ANYWAY.
#
# Live metrolinx AMSD-2041, approved commit af1d6b99. package.json gained
# "@contentstack/live-preview-utils" and package-lock.json -- tracked, not ignored, clean in the
# worktree -- was never touched; the package is absent from it entirely. tsc, ESLint and the build
# passed and the reviewer APPROVED, because node_modules already held the package from a run five
# days earlier that survived the codeline reset. `npm install` appears zero times in the run log.
# `npm ci` on that branch fails outright.
#
# run_dependency_check answers the neighbouring question -- does the manifest declare what the code
# imports -- and cannot see this one, because the manifest DID declare it. Only the lockfile
# records what a clean checkout installs.
#
# IT DOES NOT BLOCK ON DRIFT THE STORY DID NOT CAUSE. That is 665f1a5's lesson: pre-existing desync
# is repository debt, and hard-stopping on debt no writer output can repair burns the story budget
# in a loop with no exit. The discriminator is EPAM_STORY_INTRODUCED_DEPS, the same manifest-delta
# the SAST gate uses.
run_lockfile_sync_check() {
    local project_root="$1"
    local _handler="${SCRIPT_DIR}/lib/handlers/lockfile-sync.js"
    local _node="${NODE_CMD:-node}"

    [ -n "$project_root" ] && [ -d "$project_root" ] || return 0
    [ -f "$_handler" ] || { warning "  [lockfile-sync] handler missing — cannot prove the lockfile is in sync"; return 0; }

    local _out
    _out=$("$_node" "$_handler" "$project_root" 2>/dev/null) || {
        warning "  [lockfile-sync] check did not run — cannot prove the lockfile is in sync"
        return 0
    }

    local _unprovable
    _unprovable=$(printf '%s\n' "$_out" | awk -F'\t' '$1=="unprovable"{print $2}')
    if [ -n "$_unprovable" ]; then
        # NOT a pass. Said out loud, because a check reporting success from absent evidence is the
        # class of defect this gate exists to remove.
        info "  [lockfile-sync] cannot prove: ${_unprovable}"
        return 0
    fi

    local _missing=()
    while IFS= read -r _line; do
        [ -n "$_line" ] || continue
        case "$_line" in missing*) ;; *) continue ;; esac
        _missing+=("$_line")
    done <<< "$_out"
    [ ${#_missing[@]} -gt 0 ] || return 0

    # Which of them did THIS story introduce? Everything else is pre-existing debt.
    #
    # The producer may have exported the answer already (the SAST gate needs the same one). An
    # EMPTY export is a real answer -- "this story added nothing" -- so only an UNSET variable
    # sends us to compute it.
    local _intro_list="${EPAM_STORY_INTRODUCED_DEPS-}"
    if [ -z "${EPAM_STORY_INTRODUCED_DEPS+x}" ] && command -v story_introduced_deps >/dev/null 2>&1; then
        _intro_list="$(story_introduced_deps "$project_root")"
    fi
    local _introduced=",${_intro_list},"
    local _blocking=() _preexisting=() _pkg _lock
    for _line in "${_missing[@]}"; do
        _pkg=$(printf '%s' "$_line" | cut -f2)
        _lock=$(printf '%s' "$_line" | cut -f3)
        case "$_introduced" in
            *",${_pkg},"*) _blocking+=("$_pkg") ;;
            *) _preexisting+=("$_pkg") ;;
        esac
    done

    if [ ${#_preexisting[@]} -gt 0 ]; then
        warning "  [lockfile-sync] ${#_preexisting[@]} pre-existing dependency(ies) absent from ${_lock} — advisory, not introduced by this story: $(printf '%s ' "${_preexisting[@]}")"
    fi

    [ ${#_blocking[@]} -gt 0 ] || return 0

    local _specs
    _specs=$(printf '  - %s\n' "${_blocking[@]}")
    DETERMINISTIC_CHECK_FAILURE=1
    export DETERMINISTIC_CHECK_FAILURE
    STORY_REJECTION_KEY="lockfile:${_blocking[0]}"
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nYour change added dependency(ies) to the manifest that %s does not resolve:\n\n%s\nA lockfile is the only record of what a clean checkout installs. They resolve here because a vendor directory happens to already contain them, so the type check, the tests and the build all pass on this machine and the branch is BROKEN for anyone installing from the lockfile.\n\nInstall each one with this project'"'"'s package manager so the manifest and %s are written together. Do not hand-edit %s, and do not remove the dependency.\n' \
        "$_lock" "$_specs" "$_lock" "$_lock")
    error "  [lockfile-sync] ${#_blocking[@]} dependency(ies) this story added are absent from ${_lock} — the change cannot be installed from a clean checkout"
    return 1
}

run_dependency_check() {
    local project_root="$1"
    local _plugin="${AUTOMATION_DIR}/plugins/dependency-scan-plugin.js"
    local _node="${NODE_CMD:-${NODE_BIN:-node}}"
    [ -f "$_plugin" ] || { warning "  [dependency-scan] plugin missing at $_plugin — no scan performed"; return 0; }

    # PRE-SCAN HOOK — the project's own reconciliation, before anything is inspected.
    #
    # Some estates need a full package-manager reconciliation before an agent touches code: e.g.
    # stripping a private-registry dependency, running a full install, restoring the manifest.
    # Live 2026-07-21: a codeline with a GitHub-Packages dependency 401'd on every per-package
    # install, and copy workarounds left truncated files. A single project-declared full install
    # fixed it. Non-fatal by design — a hook that fails must not stop the agent working.
    local _hook _hook_timeout
    _hook=$(_project_dep_config_value "$project_root" preInstallHook)
    if [ -n "$_hook" ]; then
        info "  [dependency-check] Running preInstallHook..."
        _hook_timeout="${EPAM_DEP_HOOK_TIMEOUT_SECS:-300}"
        if ( cd "$project_root" && timeout "$_hook_timeout" bash -c "$_hook" ); then
            info "  [dependency-check] preInstallHook complete"
        else
            _hook_rc=$?
            if [ "$_hook_rc" -eq 124 ]; then
                info "  [dependency-check] preInstallHook TIMED OUT after ${_hook_timeout}s (non-fatal — continuing)"
            else
                info "  [dependency-check] preInstallHook exited ${_hook_rc} (non-fatal — continuing)"
            fi
        fi
    fi

    # WHAT THIS STORY TOUCHED — the signal that separates a new problem from estate condition.
    #
    # A package present in a vendor directory but absent from the manifest builds locally and
    # breaks for anyone installing from the manifest. It is also the steady state of many
    # brownfield repos: reporting every instance on every run buries the one that matters. So it
    # is reported only when the importing file is one this story changed.
    #
    # Derived from the repo's own status, not from a story manifest: an agent can import from a
    # file it never declared, and that is exactly the case worth catching.
    local _changed
    _changed=$(git -C "$project_root" status --porcelain 2>/dev/null \
        | sed 's/^...//' | sed 's/^.* -> //' | tr '\n' '\036')

    # THE LINES THIS CHANGE ADDED — raw, never parsed here.
    #
    # An undeclared import is the story's only when the change INTRODUCED it; a file merely touched
    # may have carried one since before the run. The plugin decides which specifiers those lines
    # contain, using the importPattern the project declares — a second copy of that pattern here
    # would be a project fact living outside config or a plugin, and the two would drift.
    #
    # Untracked files count whole: every line of a file this change created is an added line.
    local _added
    _added=$( { git -C "$project_root" diff --unified=0 2>/dev/null
                git -C "$project_root" diff --cached --unified=0 2>/dev/null; } \
              | grep '^+' | grep -v '^+++' | sed 's/^+//'
              git -C "$project_root" ls-files --others --exclude-standard 2>/dev/null \
              | while IFS= read -r _uf; do [ -f "$project_root/$_uf" ] && cat "$project_root/$_uf" 2>/dev/null; done )

    local _out
    _out=$(EPAM_SCAN_CHANGED_FILES="$_changed" EPAM_SCAN_ADDED_LINES="$_added" "$_node" -e '
      const p = require(process.argv[1]);
      const changed = String(process.env.EPAM_SCAN_CHANGED_FILES || "")
        .split("").map((s) => s.trim()).filter(Boolean);
      const r = p.scanImports(process.argv[2], process.env, { changedFiles: changed, introducedLines: String(process.env.EPAM_SCAN_ADDED_LINES || "").split("\n") });
      if (r.status === "unknown") { console.log("UNKNOWN\t" + r.reason); process.exit(0); }
      for (const f of r.findings) console.log(f.verdict + "\t" + f.specifier + "\t" + f.file);
      // Only when it could have changed the answer. A clean scan stays silent — a note on every
      // run is noise, and noise is what stops anyone reading the line that matters.
      if (r.findings.length && !r.moduleRootsDeclared) console.log("NOTE\tmodule roots were discovered, not declared — an unresolvable import may be internal");
    ' "$_plugin" "$project_root" 2>&1) || true

    [ -z "$_out" ] && return 0

    local _line _kind _rest
    local _undeclared=()
    while IFS= read -r _line; do
        [ -z "$_line" ] && continue
        _kind="${_line%%	*}"; _rest="${_line#*	}"
        case "$_kind" in
            UNKNOWN)
                # Absent declaration is not "no problems found". Said out loud so a project that
                # has not declared how it scans is visibly unscanned rather than silently clean.
                warning "  [dependency-scan] not performed: ${_rest}"
                ;;
            malformed)
                warning "  [dependency-scan] malformed import capture (NOT a package): ${_rest}"
                ;;
            unknown_external)
                _undeclared+=("${_rest}")
                warning "  [dependency-scan] undeclared import: ${_rest}"
                ;;
            installed_undeclared)
                _undeclared+=("${_rest}")
                # Present in a vendor directory, absent from the manifest, and imported by a file
                # THIS story changed. It builds here and breaks from a clean checkout — live
                # 2026-08-09 the first story ever committed to a client codeline was undeliverable
                # for exactly this reason, and every gate passed because tsc validates against
                # node_modules, never against what the manifest can reproduce.
                warning "  [dependency-scan] imported but NOT DECLARED (present in a vendor dir only): ${_rest}"
                ;;
            NOTE)
                info "  [dependency-scan] ${_rest}"
                ;;
        esac
    done <<< "$_out"

    # Only when the PROJECT asks for it, and only with the command the PROJECT declares.
    local _auto _install_tpl
    _auto=$(_project_dep_config_value "$project_root" autoInstall)

    # AN IMPORT THE MANIFEST CANNOT REPRODUCE FAILS THE ATTEMPT, AND THE WRITER IS TOLD.
    #
    # This scan warned and returned 0. Live metrolinx AMSD-2041, 2026-08-18: the writer imported
    # @contentstack/live-preview-utils in src/pages/_app.tsx without declaring it. The package sat
    # in node_modules from an earlier run, so the import RESOLVED -- tsc passed, every gate passed,
    # and the branch would have been broken for anyone running a clean install. The scan caught it
    # on all six attempts and package.json was never touched, because the finding went to the
    # terminal and nowhere else: no VERIFICATION_FAILURE for the retry prompt, and no
    # STORY_REJECTION_KEY for the ladder's repeat detector. Same defect as repo-lint, and as the
    # 2026-08-09 incident this file already documents.
    #
    # Deterministic by definition -- the specifier is either in the manifest or it is not.
    #
    # Only when autoInstall will NOT resolve it: a project that installs the package itself is
    # already fixing the problem, and failing it would reject work that is about to become correct.
    if [ ${#_undeclared[@]} -gt 0 ] && [ "$_auto" != "true" ]; then
        local _manifest _specs _first
        _manifest=$(_project_dep_config_value "$project_root" manifestFile)
        [ -n "$_manifest" ] || _manifest="the project manifest"
        _specs=$(printf '  - %s\n' "${_undeclared[@]}")
        _first="${_undeclared[0]%%	*}"
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        STORY_REJECTION_KEY="dependency:${_first}"
        VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nYour change imports package(s) that %s does not declare. They resolve here only because a vendor directory happens to contain them, so this builds on this machine and is BROKEN from a clean checkout -- and every type check and test passes either way, which is why nothing else will catch it.\n\n%s\nAdd each one to %s with a version, in the same section its siblings use. Do not remove the import and do not work around it.\n' \
            "$_manifest" "$_specs" "$_manifest")
        error "  [dependency-scan] ${#_undeclared[@]} import(s) not declared in ${_manifest} — the change cannot be reproduced from a clean checkout"
        return 1
    fi

    [ "$_auto" = "true" ] || return 0
    _install_tpl=$(_project_install_command "$project_root")
    [ -n "$_install_tpl" ] || { warning "  [dependency-scan] autoInstall declared but no installCommand — nothing installed"; return 0; }

    local _spec _pkg _cmd _timeout="${EPAM_DEPENDENCY_INSTALL_TIMEOUT_SECS:-120}"
    while IFS= read -r _line; do
        case "$_line" in unknown_external*|installed_undeclared*) ;; *) continue ;; esac
        _rest="${_line#*	}"; _spec="${_rest%%	*}"
        _pkg=$("$_node" -e '
          const s = process.argv[1];
          const parts = s.split("/");
          console.log(s.startsWith("@") ? parts.slice(0,2).join("/") : parts[0]);
        ' "$_spec" 2>/dev/null)
        [ -n "$_pkg" ] || continue
        _cmd="${_install_tpl//\{package\}/$_pkg}"
        info "  [dependency-scan] autoInstall declared — installing ${_pkg} (from '${_spec}')"
        # The installer's OWN output is surfaced, not swallowed. Redirecting it to /dev/null
        # hides a failing install behind a one-line summary — the same "a green tick is the only
        # visible outcome" shape this conversion exists to remove.
        #
        # A TIMEOUT IS NOT A FAILURE, and must not read as one. Live: an install against an
        # unreachable registry hung with no timeout at all and consumed a whole story budget.
        # `timeout` reports 124; collapsing that into a generic failure loses the one detail that
        # tells an operator the registry is unreachable rather than the package wrong.
        local _install_rc=0
        ( cd "$project_root" && timeout "$_timeout" bash -c "$_cmd" 2>&1 ) || _install_rc=$?
        if [ "$_install_rc" -eq 124 ]; then
            warning "  [dependency-scan] install of '${_pkg}' TIMED OUT after ${_timeout}s"
        elif [ "$_install_rc" -ne 0 ]; then
            warning "  [dependency-scan] install of '${_pkg}' failed (exit ${_install_rc})"
        fi
    done <<< "$_out"
}

# run_mock_completeness_check <project_root> <output_file>
# Deterministic pre-test gate for the recurring "incomplete vi.mock() factory"
# failure class (live-diagnosed repeatedly for SKY-004: "vi.mock factory for
# SkyscannerClient omits `search` method", "vi.mock factory is incomplete;
# unmocked methods are undefined, handlers throw"). The corresponding
# [Self-Heal] skill note ("mock ALL exported methods or spread real ones via
# vi.importActual") was already present in the system prompt from attempt 1
# and was still violated — prompt-based compliance for this rule is
# effectively zero. This check makes the fact deterministic instead: for
# every `vi.mock('<path>', () => ({ ClassName: vi.fn().mockImplementation(()
# => ({ ...methods... })) }))` factory found in a test file, resolve <path>
# to its real source file, parse the REAL class's public method names (same
# regex as generate_story_contract), and fail fast — before the slow test
# run — if any real method is missing from the mock's method list.
# Returns 0 if every mock factory found is complete (or none found). Returns
# 1 and sets VERIFICATION_FAILURE naming the missing method(s) otherwise.
run_mock_completeness_check() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local config_file="${project_root}/.epam/contract-generation.json"
    [ -f "$config_file" ] || return 0

    local result
    result=$(python3 "$SCRIPT_DIR/lib/handlers/mock-completeness-check.py" "$project_root" "$config_file"
)

    if [ "$(echo "$result" | head -1)" = "OK" ]; then
        return 0
    fi

    local details
    details=$(echo "$result" | tail -n +2)
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nA vi.mock() factory is missing method(s) that the real class exports — any test calling a missing method will throw "X is not a function". Add the missing method(s) to the mock before anything else:\n\n%s\n' "$details")
    {
        echo ""
        echo "=== Mock completeness check failed ==="
        echo "$details"
    } >> "$output_file"
    return 1
}

# run_relative_import_check <project_root> <output_file> [story_id]
# Option D — deterministic detection of a relative import that does not
# resolve to a real file. Root cause this targets: an agent guessing the
# wrong path for a sibling module it can't directly see (recurring live
# failure: './skyscanner-client' guessed, real file at
# './skyscanner/client') — previously only discoverable after a full,
# often multi-minute test run, then re-diagnosed from scratch by the
# failure analyst every single retry. This runs in milliseconds, for free,
# right after the agent's files are written, and suggests the likely
# correct path via filename-token overlap — fully generic, no project- or
# language-specific knowledge (works for .ts/.js relative imports; the
# token-matching heuristic makes no npm/TypeScript-specific assumption).
#
# Auto-apply (added 2026-07-07, opt-in via EPAM_AUTO_FIX_RELATIVE_IMPORTS=true,
# default OFF — preserves the original "detection, not silent rewrite" design
# below unless explicitly enabled): originally this check only ever suggested
# a fix in the retry prompt, on the stated reasoning that auto-rewriting
# "risks breaking a valid but unusual import." That reasoning holds for LOW-
# confidence matches, but a live run showed the SAME violation surviving
# THREE full ladder escalations (base model through the strongest configured
# model) because it's a mechanical habit (appending a redundant .js extension
# in a CommonJS project), not a reasoning-capability gap — no amount of model
# escalation fixes a training-data habit. When enabled, auto-apply is scoped
# conservatively to address the original safety concern: (1) only fires on
# HIGH-confidence matches (token-overlap score >= 2, stricter than the >0
# threshold used for merely suggesting), (2) only rewrites files the CURRENT
# story actually owns (technicalNotes.files, the same boundary scope-guard
# already enforces) — never a file outside this attempt's own scope, (3) only
# replaces the exact broken specifier text, preserving original quote style.
# run_anti_pattern_check <project_root> <output_file> [story_id]
# ─────────────────────────────────────────────────────────────────────────────
# Deterministic, PROJECT-CONFIGURED check for a writer regressing to a
# documented-wrong pattern — no pattern is ever hardcoded here. Rules come
# from ${EPAM_PROJECT_CONFIG_DIR:-}/anti-patterns.json, a JSON array of
# {id, matchPattern, message} objects (matchPattern: a Python regex, DOTALL
# not needed since a negated character class already spans newlines). Absent
# file = silent no-op — most projects configure nothing.
#
# Built 2026-08-02 after a live Writer Retest run, to catch a KNOWN wrong
# pattern deterministically on attempt 1 rather than paying for a downstream
# LLM review to notice it (same shape as run_relative_import_check above).
#
# WHAT THAT ORIGINAL RULE GOT WRONG, recorded so it is not rebuilt: it encoded
# a VENDOR API FACT asserted from memory — that one SDK config key was correct
# and another wrong. Discovery against the INSTALLED package (the
# dependency_contract plugin) later contradicted it: the "wrong" key is the one
# the runtime actually reads, and the "prescribed" key appears nowhere in the
# package, so a writer obeying the rule would have shipped a key that silently
# does nothing. The rule would have blocked the correct implementation on every
# run. See test/unit/orchestration/no-hand-authored-vendor-rules.test.ts.
#
# So: this mechanism is for rules that could have been written BEFORE any
# failure was observed, from the project's standing setup. A claim about what a
# third-party package consumes is DETERMINABLE — discover it, never transcribe
# it here or into a project's anti-patterns.json.
#
# Scoped to the story's OWN declared files (technicalNotes.files) only — same
# scoping lesson as run_relative_import_check's fix, 2026-08-02: a pattern
# that pre-exists in a file this story doesn't own is not this story's to fix
# and must never block it.
#
# Returns 0 if no configured rule matches (or no rules are configured).
# Returns 1 and sets VERIFICATION_FAILURE naming the exact rule violated.
run_anti_pattern_check() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local story_id="${3:-}"
    local rules_file="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/anti-patterns.json}"
    [ -f "$rules_file" ] || return 0

    local owned_files_json="[]"
    if [ -n "$story_id" ]; then
        owned_files_json=$(jq -c --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .technicalNotes.files // []' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "[]")
        owned_files_json="${owned_files_json:-[]}"
    fi

    local result
    result=$(python3 "$SCRIPT_DIR/lib/handlers/anti-pattern-check.py" "$project_root" "$rules_file" "$owned_files_json"
)

    if [ "$(echo "$result" | head -1)" = "OK" ]; then
        return 0
    fi

    local details
    details=$(echo "$result" | tail -n +2)
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nA known, previously-diagnosed wrong pattern was detected — fix this before anything else:\n\n%s\n' "$details")
    {
        echo ""
        echo "=== Anti-pattern check failed ==="
        echo "$details"
    } >> "$output_file"
    return 1
}

# Returns 0 if all relative imports resolve (or all were auto-fixed). Returns
# 1 and sets VERIFICATION_FAILURE with a suggestion for any that remain broken.
run_relative_import_check() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local story_id="${3:-}"
    local auto_fix="${EPAM_AUTO_FIX_RELATIVE_IMPORTS:-false}"

    # owned_files/has_story_context now resolved UNCONDITIONALLY when a story_id
    # is given (previously gated behind auto_fix=true, so it was only ever
    # computed for auto-fix ELIGIBILITY, never for scoping which findings BLOCK
    # the current story) — same fix already applied to run_named_import_check
    # below, ported here 2026-08-02 after a live Writer Retest run: this check
    # walks the ENTIRE project tree with no scope boundary, so a pre-existing,
    # totally unrelated broken import (src/context/uniformContext.ts importing
    # a nonexistent uniformManifest.json — nothing to do with the story being
    # implemented) blocked AMSD-2041 for 3 straight attempts on a genuinely
    # correct fix (verified: 19/19 tests passing, zero type errors) that this
    # story was structurally incapable of ever "fixing", since it doesn't own
    # that file. The sibling-escalation path below still fires when an owning
    # story can be found, but previously STILL fell through to `return 1`
    # regardless — out-of-scope findings must never block THIS story's turn.
    local owned_files_json="[]"
    local has_story_context="false"
    if [ -n "$story_id" ]; then
        has_story_context="true"
        owned_files_json=$(jq -c --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .technicalNotes.files // []' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "[]")
        # jq exits 0 with EMPTY output (not "[]") when story_id matches no
        # story in the PRD — the `||` above only fires on a non-zero exit, so
        # that case fell straight through as an empty string, which crashes
        # Python's json.loads() downstream. Found live 2026-08-02 testing the
        # relative-import-check port of this same pattern.
        owned_files_json="${owned_files_json:-[]}"
    fi

    local result
    result=$(python3 "$SCRIPT_DIR/lib/handlers/relative-import-check.py" "$project_root" "$auto_fix" "$owned_files_json" "$has_story_context"
)

    local autofixed_lines
    autofixed_lines=$(echo "$result" | grep "^AUTOFIXED:" || true)
    if [ -n "$autofixed_lines" ]; then
        while IFS= read -r _fix_line; do
            [ -z "$_fix_line" ] && continue
            log "  [relative-import-check] Auto-corrected ${_fix_line#AUTOFIXED:}"
        done <<< "$autofixed_lines"
    fi
    result=$(echo "$result" | grep -v "^AUTOFIXED:" || true)

    # Findings in files this story doesn't own are surfaced (visibility) but
    # never block this story's own turn — same pattern as run_named_import_check.
    # A sibling-owning story, if one exists, still gets a REAL escalation file
    # written (resolve_escalation() already knows how to consume it) — that
    # part of the original design has real value — but writing it no longer
    # gates whether THIS story's turn blocks. Previously, EVEN a successfully
    # registered escalation still fell through to `return 1` below regardless,
    # so out-of-scope breakage blocked the current story either way. Root
    # cause this fixes (found live, 2026-08-02, Writer Retest run): a
    # single-story PRD has no sibling to attribute an out-of-scope broken
    # import to, so a totally unrelated, pre-existing broken import
    # (uniformContext.ts -> a nonexistent uniformManifest.json) blocked a
    # genuinely correct AMSD-2041 fix for 3 straight attempts — the ladder was
    # burned on a bug the story could never have fixed, exactly the SAME
    # failure shape the original sibling-escalation code was meant to solve
    # but didn't, because it still blocked regardless of outcome.
    local out_of_scope_lines
    out_of_scope_lines=$(echo "$result" | grep "^OUT_OF_SCOPE:" || true)
    if [ -n "$out_of_scope_lines" ]; then
        while IFS= read -r _oos_line; do
            [ -z "$_oos_line" ] && continue
            warning "  [relative-import-check] Broken import outside this story's scope (not blocking): ${_oos_line#OUT_OF_SCOPE:}"
        done <<< "$out_of_scope_lines"

        if [ -n "$story_id" ]; then
            local _first_oos_file
            _first_oos_file=$(head -1 <<< "$out_of_scope_lines" | sed -E 's/^OUT_OF_SCOPE:([^:]+):.*/\1/')
            if [ -n "$_first_oos_file" ]; then
                # BUG B FIX (found live, 2026-07-12, tier3-travel-app run): this
                # lookup used to scan ALL stories with no deprecated-status
                # filter and take the FIRST array match — a split PARENT marked
                # deprecated (but still carrying its ORIGINAL pre-split combined
                # technicalNotes.files, e.g. SKY-003 listing both cli.ts AND
                # cli.test.ts) commonly appears BEFORE its active child
                # (SKY-003-impl) in the stories array, so the escalation got
                # misattributed to the dead parent instead of the real,
                # already-completed active owner. Exclude deprecated stories,
                # and prefer a same-split sibling (same specification.createdFrom
                # as the current story) over any other match — mirroring the
                # SAME two-tier preference resolve_escalation() already uses
                # when it later consumes this escalation.
                local _self_parent
                _self_parent=$(jq -r --arg id "$story_id" \
                    '.stories[] | select(.id == $id) | .specification.createdFrom // empty' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null)
                local _owner_id
                _owner_id=$(jq -r --arg self "$story_id" --arg f "$_first_oos_file" --arg parent "$_self_parent" \
                    '[.stories[] | select(.id != $self) | select(.status != "deprecated") | select((.technicalNotes.files // []) | map(. == $f or endswith("/" + $f)) | any) | select(($parent != "") and .specification.createdFrom == $parent)][0].id
                     // [.stories[] | select(.id != $self) | select(.status != "deprecated") | select((.technicalNotes.files // []) | map(. == $f or endswith("/" + $f)) | any)][0].id
                     // empty' \
                    "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null)
                if [ -n "$_owner_id" ]; then
                    local _first_oos_detail
                    _first_oos_detail=$(head -1 <<< "$out_of_scope_lines" | sed 's/^OUT_OF_SCOPE://')
                    mkdir -p "${PROJECT_ROOT}/.epam/escalations"
                    jq -n --arg tf "$_first_oos_file" \
                        --arg diag "Relative import in ${_first_oos_file} does not resolve to a real file (detected by deterministic check while implementing ${story_id})." \
                        --arg fix "$_first_oos_detail" \
                        '{targetFile: $tf, diagnosis: $diag, requiredFix: $fix}' \
                        > "${PROJECT_ROOT}/.epam/escalations/${story_id}.json"
                    log "  [relative-import-check] Broken import lives in ${_first_oos_file}, owned by ${_owner_id} (not ${story_id}) — registered sibling escalation (informational; this story's turn is not blocked by it)"
                fi
            fi
        fi
    fi
    result=$(echo "$result" | grep -v "^OUT_OF_SCOPE:" || true)

    if [ "$(echo "$result" | head -1)" = "OK" ]; then
        return 0
    fi

    local details
    details=$(echo "$result" | tail -n +2)

    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nA relative import does not resolve to a real file — this will fail immediately when the test suite runs. Fix the import path before anything else:\n\n%s\n' "$details")
    {
        echo ""
        echo "=== Relative import check failed ==="
        echo "$details"
    } >> "$output_file"
    return 1
}

# run_named_import_check <project_root> <output_file> [story_id]
# Deterministic detection (same shape as run_relative_import_check above) of a
# named import whose identifier doesn't actually exist among the target
# file's exports — even though the FILE PATH itself resolves correctly.
#
# Root cause this targets: a live run burned a story's ENTIRE ladder
# escalation (8 attempts, ending on the strongest configured model, $0.25)
# on `import { SkyScannerClient } from './client'` when the real export is
# `SkyscannerClient` (one-character casing difference) — and never converged
# because the failure-analyst MISDIAGNOSED it as a default-vs-named export
# mismatch (it wasn't; the class is correctly a named export, just spelled
# differently). Every retry, including the strongest model, "fixed" the
# wrong thing because the diagnosis guiding it was wrong. A deterministic
# check that names the exact real export (case-insensitive match) removes
# the misdiagnosis risk entirely — no model judgment involved.
#
# Fully generic — no hardcoded class/identifier names, no project-specific
# knowledge. Parses exports via regex (export class/function/const/let/var/
# interface/type/enum Name, and export { A, B as C } lists) and named imports
# via the same import-statement regex as run_relative_import_check, then
# checks each imported identifier is actually in the target's export set.
# Suggests the closest case-insensitive match when one exists (the exact bug
# shape found live), consistent with relative-import-check's "Did you mean
# X?" pattern.
#
# Auto-apply (opt-in via EPAM_AUTO_FIX_NAMED_IMPORTS=true, default OFF, same
# conservative design as relative-import-check's auto-fix): only fires when
# there is EXACTLY ONE case-insensitive match among the target's real
# exports (unambiguous), and only rewrites files the current story owns.
#
# Returns 0 if all named imports resolve to a real export (or none found).
# Returns 1 and sets VERIFICATION_FAILURE with a suggestion otherwise.
run_named_import_check() {
    local project_root="$1"
    local output_file="${2:-/dev/null}"
    local story_id="${3:-}"
    local auto_fix="${EPAM_AUTO_FIX_NAMED_IMPORTS:-false}"

    # owned_files is now always resolved when a story_id is given (previously
    # gated behind auto_fix=true, so it was only ever computed for auto-fix
    # ELIGIBILITY, never for scoping which findings BLOCK the current story).
    # Root cause this fixes (found live, 2026-07-09/10, tier3-travel-app run):
    # this check walks the ENTIRE project tree, so a pre-existing broken
    # import in a file the CURRENT story doesn't own (e.g. SKY-003-impl's
    # cli.ts importing a type SKY-002-impl's client.ts never exported)
    # permanently blocked an unrelated story (SKY-002-test, which owns only
    # client.test.ts and is scope-guarded from ever touching cli.ts) —
    # exhausting all 8 retries on a bug it was structurally incapable of
    # fixing. has_story_context distinguishes "we know what this story owns,
    # scope blocking to that" from "no story_id given, preserve old global
    # behavior" (e.g. a caller with no per-story context at all).
    local owned_files_json="[]"
    local has_story_context="false"
    if [ -n "$story_id" ]; then
        has_story_context="true"
        owned_files_json=$(jq -c --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .technicalNotes.files // []' \
            "${MAIN_PRD_FILE:-$PRD_FILE}" 2>/dev/null || echo "[]")
        # jq exits 0 with EMPTY output (not "[]") when story_id matches no
        # story in the PRD — the `||` above only fires on a non-zero exit, so
        # that case fell straight through as an empty string, which crashes
        # Python's json.loads() downstream. Found live 2026-08-02 testing the
        # relative-import-check port of this same pattern.
        owned_files_json="${owned_files_json:-[]}"
    fi

    local result
    result=$(python3 "$SCRIPT_DIR/lib/handlers/named-import-check.py" "$project_root" "$auto_fix" "$owned_files_json" "$has_story_context"
)

    local autofixed_lines
    autofixed_lines=$(echo "$result" | grep "^AUTOFIXED:" || true)
    if [ -n "$autofixed_lines" ]; then
        while IFS= read -r _fix_line; do
            [ -z "$_fix_line" ] && continue
            log "  [named-import-check] Auto-corrected ${_fix_line#AUTOFIXED:}"
        done <<< "$autofixed_lines"
    fi
    result=$(echo "$result" | grep -v "^AUTOFIXED:" || true)

    # Findings in files this story doesn't own are surfaced (visibility) but
    # never block this story's own turn — see the Python block's own comment
    # for the live defect this fixes (an unrelated story permanently blocked
    # by a bug it was structurally incapable of fixing).
    local out_of_scope_lines
    out_of_scope_lines=$(echo "$result" | grep "^OUT_OF_SCOPE:" || true)
    if [ -n "$out_of_scope_lines" ]; then
        while IFS= read -r _oos_line; do
            [ -z "$_oos_line" ] && continue
            warning "  [named-import-check] Broken import outside this story's scope (not blocking): ${_oos_line#OUT_OF_SCOPE:}"
        done <<< "$out_of_scope_lines"
    fi
    result=$(echo "$result" | grep -v "^OUT_OF_SCOPE:" || true)

    if [ "$(echo "$result" | head -1)" = "OK" ]; then
        return 0
    fi

    local details
    details=$(echo "$result" | tail -n +2)
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nA named import does not exist as an export in its target file — this will fail immediately when the test suite runs (the model likely misspelled/mis-cased an identifier, not a default-vs-named export issue). Fix the identifier name before anything else:\n\n%s\n' "$details")
    {
        echo ""
        echo "=== Named import check failed ==="
        echo "$details"
    } >> "$output_file"
    return 1
}

run_external_verification() {
    local story_id="$1"
    local output_file="${2:-/dev/null}"
    local prd_target="${MAIN_PRD_FILE:-$PRD_FILE}"
    VERIFICATION_FAILURE=""
    DETERMINISTIC_CHECK_FAILURE=0

    # Vendor-dir integrity check runs FIRST, before anything else in this
    # function (including run_dependency_check's own sanctioned writes to the
    # same directories) — so it only ever attributes a change to THIS story's
    # own agent turn, never to a later legitimate install. Runs regardless of
    # whether a test command is configured (tampering here could poison a
    # LATER story sharing the same vendor dirs even if this story has no
    # tests of its own). No-op when no vendorDirs are configured.
    #
    # BUG (caught before ever shipping live, 2026-07-07 — found by re-reading
    # the code under scrutiny, not by a live run): the original version
    # returned 1 on tampering BEFORE calling _vendor_unlock, meaning the vendor
    # dirs would stay chmod -R a-w'd (read-only) PERMANENTLY the very first
    # time tampering was ever caught — breaking every subsequent retry's own
    # legitimate run_dependency_check installs, and every later story in the
    # whole run, since nothing else ever unlocks it. Fixed: unlock ALWAYS runs
    # regardless of the check's result; only the return code differs.
    local _vendor_check_rc=0
    if [ "${EPAM_VENDOR_GUARD_ENABLED:-0}" = "1" ]; then
        run_vendor_integrity_check "$PROJECT_ROOT" "$output_file" || _vendor_check_rc=1
    fi
    _vendor_unlock "$PROJECT_ROOT"
    if [ "$_vendor_check_rc" -ne 0 ]; then
        warning "  [vendor-guard] Vendor directory tampering detected — skipping test run"
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        return 1
    fi

    # Run any reviewed dynamic tools now, in this genuinely unlocked window —
    # see run_dynamic_tools_in_unlocked_window()'s own docstring for the
    # live defect this fixes (a dependency-installing dynamic tool could
    # never succeed while the agent's own turn held vendor dirs locked).
    run_dynamic_tools_in_unlocked_window "$PROJECT_ROOT" "$output_file"

    # Read optional testCommand from PRD story.technicalNotes
    local test_cmd
    test_cmd=$(jq -r --arg id "$story_id" \
        '.stories[] | select(.id == $id) | .technicalNotes.testCommand // ""' \
        "$prd_target" 2>/dev/null || echo "")

    # THE PROJECT DECLARES HOW IT RUNS ITS SUITE. The engine asks; it does not know.
    #
    # This block used to hardcode four ecosystem facts — a manifest filename, a key inside it,
    # a command, and a test-file naming convention — in engine code, where hardcoding is not
    # permitted. They now live in the project's own .epam/verification.json `test` section and
    # are read by orchestrations/plugins/verification-plugin.js.
    #
    # THE GUARD THAT USED TO LIVE HERE ASKED THE WRONG QUESTION. It required the STORY to own a
    # test file. It was added 2026-07-08 for SKY-001A, a scaffold story whose only job was
    # writing a manifest: running the suite then failed because no test files existed ANYWHERE
    # yet, the analyst misdiagnosed "missing test files", tried to create one, and the
    # scope-guard blocked the write — a guaranteed infinite loop. That state is real and is
    # still skipped, via repoHasTests.
    #
    # But a BROWNFIELD story modifying existing code declares source files, never test files,
    # so `_owns_test_file` was 0 by definition. Live 2026-08-11 (AMSD-2041/gotransit): the
    # command stayed empty, the function returned 0 = PASS, and the writer was told its change
    # passed the tests. Nothing had run. It had added an import of a package shipping
    # untranspiled sources, and ten previously-green suites failed at import time — invisible to
    # all 8 retry attempts. "This repo has no tests" and "this story declares no test file" are
    # different states; only the first justifies skipping.
    if [ -z "$test_cmd" ]; then
        local _repo_has_tests
        _repo_has_tests=$(_project_repo_has_tests "$PROJECT_ROOT")
        # unknown (no declared convention) is NOT "no tests" — it must not silently skip.
        if [ "$_repo_has_tests" = "false" ]; then
            info "  [test-gate] the project declares a suite but this repo contains no test files — skipping"
            return 0
        fi
        if [ "$_repo_has_tests" = "unknown" ]; then
            warning "  [test-gate] this project declares no test-file convention in .epam/verification.json — the suite cannot be scoped or skipped safely"
        fi
        local _declared_test_cmd
        _declared_test_cmd=$(_project_test_command "$PROJECT_ROOT")
        if [ -n "$_declared_test_cmd" ]; then
            test_cmd="$_declared_test_cmd"
        fi
    fi
    # SCOPE THE RUN TO THIS STORY'S OWN TEST FILES, when the project says how.
    #
    # A broken test file belonging to ANOTHER story used to fail this story's verification (live:
    # a broken cli.test.ts failed the server story while server.test.ts passed 15/15). Running
    # only the files this story owns removes that contamination.
    #
    # Both halves are project declarations now: which paths ARE test files (test.testFilePattern)
    # and how this runner accepts a file list (test.scopedCommand, e.g. "npm test -- {files}").
    # A project that declares neither runs its whole suite, which is correct and never silent.
    if [ -n "$test_cmd" ]; then
        local _owned_test_files
        _owned_test_files=$(_project_owned_test_files "$PROJECT_ROOT" "$story_id" "$prd_target")
        if [ -n "$_owned_test_files" ]; then
            local _scoped
            _scoped=$(_project_scoped_test_command "$PROJECT_ROOT" "$_owned_test_files")
            [ -n "$_scoped" ] && test_cmd="$_scoped"
        fi
    fi

    [ -z "$test_cmd" ] && return 0  # no test command configured — skip

    # Exposed for run_failure_analyst's tool_creation gate (added 2026-07-12):
    # a dynamic tool that independently re-invokes this SAME test command is a
    # duplicate-verification risk, not a mechanical fixup — see that check for
    # the live incident this closes.
    LAST_TEST_CMD="$test_cmd"
    export LAST_TEST_CMD

    # Sanitize the child-process environment for npm install/test (added
    # 2026-07-11, after a live test failure no amount of model escalation
    # could ever fix): claude.sh inherits the orchestrator's OWN .env
    # (Anthropic/OpenRouter/MiniMax keys, etc — sourced by
    # run-agent-orchestration.sh) all the way down to whatever test command
    # runs INSIDE the generated app. Root cause found live: epam-cli's own
    # .env happens to define RAPIDAPI_KEY (a real credential) — the exact
    # env var name a generated SkyscannerClient story checked as a
    # constructor fallback. Every retry of its "should throw when no API key
    # provided" test failed identically because the constructor legitimately
    # found a REAL key in the inherited environment and didn't throw — the
    # generated app's code was correct the entire time; the test's
    # environment was contaminated by a secret that belongs to the
    # ORCHESTRATOR, not the app under test. No model escalation or skill
    # guidance can ever fix a test that's structurally unwinnable this way.
    # Strip every var name defined in the orchestrator's own .env from the
    # install/test subprocess environment so the generated app is tested in
    # real isolation.
    #
    # Deliberately uses bash's own `unset` builtin, NOT `env -u` — this
    # environment's PATH shadows the real GNU coreutils `env` with an
    # unrelated PATH-setup shell shim at ~/.local/bin/env that doesn't
    # implement `-u` (confirmed live: `env -u FOO bash -c '...'` silently
    # produced none of the command's effects). A prefixed `unset` string has
    # no dependency on any external binary and can't be shadowed this way.
    local _orch_env_file
    _orch_env_file="$(dirname "$AUTOMATION_DIR")/.env"
    local _orch_env_unset_prefix=""
    if [ -f "$_orch_env_file" ]; then
        while IFS='=' read -r _envkey _envval; do
            [[ "$_envkey" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
            _orch_env_unset_prefix="${_orch_env_unset_prefix}unset ${_envkey}; "
        done < <(grep -v '^[[:space:]]*#' "$_orch_env_file" | grep -v '^[[:space:]]*$')
    fi

    # Scope guard: restore .ts files outside this story's declared scope from
    # the pre-run snapshot. Agents frequently use Bash (not WriteFile) to write
    # files, bypassing tool-level guards. This restores them before npm test so
    # a story's verification only reflects the files it actually owns.
    local _sg_backup="${SCOPE_GUARD_BACKUP_DIR:-}"
    if [ -n "$_sg_backup" ] && [ -d "$_sg_backup" ]; then
        # Build declared set (absolute paths)
        local -A _sg_decl
        while IFS= read -r _f; do
            [ -n "$_f" ] && _sg_decl["$_f"]=1
        done < <(jq -r --arg id "$story_id" \
            '.stories[] | select(.id == $id) | .technicalNotes.files[]? // empty' \
            "$prd_target" 2>/dev/null)

        if [ ${#_sg_decl[@]} -gt 0 ]; then
            local _sg_restored=0
            while IFS= read -r _rel; do
                local _abs="$PROJECT_ROOT/$_rel"
                # Skip if this file is in the story's declared scope
                [ -n "${_sg_decl[$_abs]+x}" ] && continue
                local _bak="$_sg_backup/$_rel"
                if [ -f "$_bak" ]; then
                    cp "$_bak" "$_abs" 2>/dev/null && ((_sg_restored++))
                fi
            done < <(find "$_sg_backup" -type f | sed "s|^$_sg_backup/||")
            if [ "$_sg_restored" -gt 0 ]; then
                warning "  [scope-guard] Restored $_sg_restored out-of-scope .ts file(s) before verification (agent wrote outside ${story_id}'s declared scope)"
            fi
        fi
    fi

    # Ensure node_modules exist in the worktree — git worktrees don't inherit gitignored dirs.
    # Without this, npm test fails with exit 127 (vitest binary not found).
    # Bounded timeout (added 2026-07-06): a live run's story-level 600s
    # watchdog killed the entire claude.sh subprocess with the LAST log line
    # being "Installing dependencies..." — the actual agent call had already
    # finished in 11s (confirmed via the per-story result.json timestamp),
    # but this npm install (registry/network dependent, no timeout) silently
    # consumed the rest of the 600s budget with zero further signal. Same
    # class of bug as the npm test / git-operation hangs fixed earlier this
    # session — this was the third unbounded external command, missed then.
    # WHICH manifest, WHICH vendor directory, and WHICH provisioning command are PROJECT facts,
    # read from the codeline's .epam/dependency-check.json — the plug-in's declaration, assembled
    # by lib/handlers/codeline-manifests.js. The engine executes them verbatim and knows no stack.
    # Until 2026-09-16 it read the ADD command and ran it with `{package}` deleted: a rule true of
    # one package manager and false of the rest, so a Python worktree got a bare `pip install`,
    # no interpreter, and every test exited 2 (run 20260915T101555Z, REGI-001-B). A codeline that
    # declares no provisionCommand is reported and left as it is — never guessed at.
    # The vendor directory is the manifest's FIRST declared vendorDir (the one provisioning
    # populates), read as declared — _get_vendor_dirs lists only directories that EXIST, so the
    # old test `[ ! -d "$PROJECT_ROOT/<absolute path>" ]` was true whenever the directory existed
    # and the whole branch was skipped whenever it did not: provisioning ran exactly when it was
    # not needed.
    local _dep_manifest _dep_vendor _dep_provision _dep_env_prefix
    _dep_manifest=$(_project_manifest_file "$PROJECT_ROOT")
    _dep_vendor=""
    [ -f "$PROJECT_ROOT/.epam/dependency-check.json" ] && _dep_vendor=$(jq -r '.vendorDirs[0]? // empty' "$PROJECT_ROOT/.epam/dependency-check.json" 2>/dev/null || true)
    _dep_provision=$(_project_provision_command "$PROJECT_ROOT")
    _dep_env_prefix=$(_project_run_env_prefix "$PROJECT_ROOT")
    if [ -n "$_dep_manifest" ] && [ -f "$PROJECT_ROOT/$_dep_manifest" ] \
       && { [ -z "$_dep_vendor" ] || [ ! -d "$PROJECT_ROOT/$_dep_vendor" ]; }; then
        if [ -z "$_dep_provision" ]; then
            warning "  [provision] $story_id: the codeline declares no provisionCommand in .epam/dependency-check.json — environment NOT provisioned; the test command runs as declared"
        else
        log "  Provisioning the environment (${_dep_vendor:-no vendor dir} absent in worktree): $_dep_provision"
        local _install_timeout="${EPAM_INSTALL_TIMEOUT_SECS:-180}"
        # Capture $? directly from the command substitution — NOT via
        # `if ! (cmd); then`, which collapses any non-zero exit code (124
        # included) into a plain boolean 1 through the `!` negation, making
        # exit 124 indistinguishable from a normal failure (this exact bug
        # shipped in the first version of this fix and was caught by its own
        # test suite: the TIMED OUT branch never fired).
        local _install_output
        _install_output=$(cd "$PROJECT_ROOT" && timeout "$_install_timeout" bash -c "${_orch_env_unset_prefix}${_dep_env_prefix}${_dep_provision}" 2>&1)
        local _install_rc=$?
        if [ "$_install_rc" -eq 124 ]; then
            warning "  provisioning TIMED OUT after ${_install_timeout}s — test may still fail"
        elif [ "$_install_rc" -ne 0 ]; then
            warning "  provisioning failed (exit $_install_rc) — test may still fail: $(printf '%s' "$_install_output" | tail -3 | tr '\n' ' ')"
        fi
        fi
    fi

    # THE VERDICT IS READ. Both of these were called bare until 2026-08-19, so their `return 1`
    # was discarded: they set VERIFICATION_FAILURE and DETERMINISTIC_CHECK_FAILURE (which is why
    # their findings still reached the retry prompt) and then verification carried on to the test
    # suite and could return 0. Live AMSD-2041: lockfile-sync blocked FOUR times and the story
    # completed anyway, with a manifest the lockfile does not resolve. The four sibling checks
    # below have always been guarded; these two were the exception.
    #
    # Each check sets the failure text and the flag itself, so the caller only reads the verdict.
    if ! run_dependency_check "$PROJECT_ROOT"; then
        return 1
    fi
    if ! run_lockfile_sync_check "$PROJECT_ROOT"; then
        return 1
    fi

    # Fail fast on a broken relative import BEFORE running the (often
    # multi-minute) test command — this recurring failure class was
    # previously only discoverable by waiting for a full test run, then
    # having the failure analyst re-diagnose the same "wrong import path"
    # pattern from scratch every retry (validated live: baseline model call
    # guessed './skyscanner-client' when the real file was
    # './skyscanner/client'). Skip test execution entirely if found.
    if ! run_relative_import_check "$PROJECT_ROOT" "$output_file" "$story_id"; then
        warning "  [relative-import-check] Broken import detected — skipping test run"
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        return 1
    fi

    # Fail fast on a named import whose identifier doesn't exist in its
    # target's exports — same rationale as relative-import-check above, but
    # for a different failure shape (file path resolves fine, the imported
    # NAME is wrong/mis-cased). Root cause: a live run burned a story's
    # entire ladder escalation on this exact bug because the failure-analyst
    # misdiagnosed it as a default-vs-named export mismatch.
    if ! run_named_import_check "$PROJECT_ROOT" "$output_file" "$story_id"; then
        warning "  [named-import-check] Non-existent named import detected — skipping test run"
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        return 1
    fi

    # Fail fast on a project-configured anti-pattern (e.g. a documented-wrong
    # value a prior review already caught) — see run_anti_pattern_check's own
    # docstring. Silent no-op for any project with no anti-patterns.json.
    if ! run_anti_pattern_check "$PROJECT_ROOT" "$output_file" "$story_id"; then
        warning "  [anti-pattern-check] Known wrong pattern detected — skipping test run"
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        return 1
    fi

    # Fail fast on an incomplete vi.mock() factory BEFORE running the test
    # command — same rationale as relative-import-check above, targeting the
    # other recurring live failure class (mock factory missing a real method,
    # e.g. SKY-004's SkyscannerClient mock omitting `search`).
    if ! run_mock_completeness_check "$PROJECT_ROOT" "$output_file"; then
        warning "  [mock-completeness-check] Incomplete vi.mock() factory detected — skipping test run"
        DETERMINISTIC_CHECK_FAILURE=1
        export DETERMINISTIC_CHECK_FAILURE
        return 1
    fi

    log "  Running external verification: $test_cmd"
    local test_output
    local test_exit=0
    # Bounded timeout (added 2026-07-06): a live run's story-level 600s
    # watchdog killed the ENTIRE claude.sh subprocess with zero diagnostic
    # output after this exact command hung — the story's own implementation
    # had already succeeded; `npm test` (vitest) itself never returned. The
    # classic cause for a server story: a test calls app.listen() without a
    # matching server.close() in afterAll, so Node's event loop never drains
    # and the test process hangs forever. Without a bound here, that failure
    # mode silently consumes the entire watchdog budget with no signal at all
    # about which command was actually stuck. EPAM_TEST_TIMEOUT_SECS default
    # (300s) is comfortably under the lowest story-level watchdog ceiling
    # (600s for low-effort stories) so this always fires first and gives a
    # clear, actionable diagnosis instead of a generic outer timeout.
    local _test_timeout="${EPAM_TEST_TIMEOUT_SECS:-300}"
    # BOUNDED, both dimensions — see _bounded_test_command. Unbounded, this suite starves the host.
    local _bounded_cmd; _bounded_cmd="$(_bounded_test_command "$test_cmd")"
    # The declared command runs INSIDE the codeline's declared environment (runEnvironment in
    # .epam/dependency-check.json): the environment's own runner answers, not the host's.
    local _test_env_prefix; _test_env_prefix=$(_project_run_env_prefix "$PROJECT_ROOT")
    test_output=$(cd "$PROJECT_ROOT" && timeout "$_test_timeout" bash -c "${_orch_env_unset_prefix}${_test_env_prefix}${_bounded_cmd}" 2>&1) || test_exit=$?

    if [ "$test_exit" -eq 124 ]; then
        warning "External verification TIMED OUT for $story_id after ${_test_timeout}s (test command: $test_cmd)"
        VERIFICATION_FAILURE=$(printf '\n## Verification Failure — TIMEOUT\n\nThe orchestrator ran `%s` after your files were written and it did NOT complete within %ds — it hung. The most common cause for a server story: a test calls app.listen() (or an equivalent server-start call) without closing it (server.close()) in an afterAll/afterEach hook, so the test process never exits. Check every test that starts a server or opens a long-lived resource (timers, sockets, watchers) and ensure it is torn down.\n\n```\n%s\n```\n' \
            "$test_cmd" "$_test_timeout" "$test_output")
        {
            echo ""
            echo "=== External verification TIMED OUT after ${_test_timeout}s ==="
            echo "$test_output" | head -n "$(evidence_window testOutputLines)"
        } >> "$output_file"
        return 1
    fi

    if [ "$test_exit" -ne 0 ]; then
        warning "External verification failed for $story_id (exit $test_exit)"

        # A BROWNFIELD STORY CANNOT BE FAILED FOR TESTS IT DID NOT BREAK.
        #
        # Operator policy: "For brownfield we can inherit existing test failures, but we
        # cannot be expected to fix them." The type-check path has implemented that for a
        # while — run the check, run it again at the baseline SHA, subtract by IDENTITY, pass
        # when everything left is pre-existing. This path did not: a raw non-zero exit failed
        # the story, so ONE pre-existing failing test failed it on every attempt, forever,
        # while the message below told the writer to "fix the code so the tests pass".
        # An unwinnable gate, the same shape as the changeRequired one that cost three runs.
        #
        # Live 2026-08-12, the analyst diagnosed it in plain text and the story failed anyway:
        # "Failing tests are pre-existing — schedules.spec.tsx fails identically with and
        # without agent changes."
        #
        # The already-captured output is handed in rather than re-run: this executes per
        # ATTEMPT, up to 8 times a story, and the suite is the most expensive gate in the run.
        local _new_test_failures="$test_output"
        if command -v baseline_new_failures >/dev/null 2>&1; then
            local _test_out_file _tdelta_rc=0 _tdelta_out
            _test_out_file=$(mktemp)
            printf '%s' "$test_output" > "$_test_out_file"
            _tdelta_out=$(baseline_new_failures "$PROJECT_ROOT" "${NODE_CMD:-${NODE_BIN:-node}}" \
                "$LOG_DIR" test "$_test_out_file") || _tdelta_rc=$?
            rm -f "$_test_out_file"
            [ "$_tdelta_rc" -eq 0 ] && _new_test_failures="" || _new_test_failures="$_tdelta_out"
        fi

        # EVERY FAILURE WAS PRE-EXISTING — the story passes. That is the whole purpose of the
        # baseline diff, and the policy it implements: inherit what the codeline already had,
        # never add to it. The tsc path lost precisely this guard once and an empty delta fell
        # through to the failure branch, reporting errors with an EMPTY error list.
        if [ -z "$(echo "$_new_test_failures" | tr -d '[:space:]')" ]; then
            success "External verification for $story_id: only pre-existing baseline test failures — none introduced by this story"
            return 0
        fi

        # Include both the head AND tail of test output so errors that appear at
        # the end (e.g. "Unhandled Rejection" summaries emitted after per-test
        # results) reach the failure analyst — a head-only truncation causes
        # misdiagnosis when the real root cause is in the final lines
        # (found live: analyst diagnosed "missing env var" from truncated head
        # while the real cause — async main() rejection — was in the tail).
        # The writer is shown the NEW failures, not the whole suite. Handing it every
        # pre-existing failure as if it were its own is how an attempt gets sent chasing
        # breakage it did not cause — and the instruction below now says so explicitly.
        # WHOLE, never head+tail. The middle of a failure dump is where the first
        # error usually is; cutting it out and printing "[... output truncated ...]"
        # told the writer something was missing without telling it what.
        # BOUND WHAT THE ANALYST IS HANDED, ON ENTRY BOUNDARIES.
        #
        # This text is embedded whole into the FailureAnalyst prompt. It is the new-failure delta,
        # which is small when the baseline builds — and the ENTIRE suite output when it does not.
        # Live 2026-09-02 (AMSD-1919) it reached ~1,092,054 tokens against a 1,000,000 limit, so
        # every analyst call failed on SIZE and the ladder escalated claude-sonnet-5 ->
        # claude-opus-4-8 -> claude-opus-5 against an input no model could accept.
        #
        # The window is declared (config/evidence-windows.json: failureExcerptLines) and entries are
        # dropped WHOLE, per the project's own failurePattern. A half-failure tells the analyst
        # something is wrong without telling it what.
        local _test_head
        _test_head=$(printf '%s' "$_new_test_failures" \
            | "${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/bound-failures.js" "$PROJECT_ROOT" test 2>/dev/null) \
            || _test_head="$_new_test_failures"
        [ -n "$_test_head" ] || _test_head="$_new_test_failures"
        local _test_tail=""
        VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nThe orchestrator ran `%s` after your files were written and it failed (exit code %d). The failures below are the ones YOUR CHANGES INTRODUCED — failures the codeline already had have been subtracted and are not your responsibility. Fix these.\n\n```\n%s%s\n```\n' \
            "$test_cmd" "$test_exit" "$_test_head" "$_test_tail")
        {
            echo ""
            echo "=== External verification failed (exit $test_exit) ==="
            echo "$test_output" | head -n "$(evidence_window testOutputLines)"
        } >> "$output_file"
        return 1
    fi

    success "External verification passed for $story_id"
    return 0
}

# run_repo_lint_verification <story_id> <output_file>
#
# THE REPO'S OWN LINT, RUN BEFORE THE COMMIT INSTEAD OF AFTER IT.
#
# Live 2026-08-09, AMSD-2041 on gotransit: the writer produced correct code, the project type check passed,
# and then the commit fired the repo's husky pre-commit hook. eslint reported ONE unused constant.
# lint-staged reverts the working tree when a task fails, so that single violation destroyed the
# whole attempt; the loop reset the worktree to origin/develop ("no validated state to preserve")
# and started over, and would have hit the identical wall on all 8 attempts because nothing ever
# told the writer the rule existed.
#
# We already run eslint — at Step 20, AFTER the per-story commit at Step 8/9. So it only ever
# examines work that committed successfully, and never runs for the story that cannot commit.
# Here the failure is feedback the retry loop can act on rather than a destructive commit failure.
#
# SCOPE IS THE CHANGED FILES. That is exactly what lint-staged lints, so this reproduces the
# hook's verdict. Linting the whole tree would fail every story in any brownfield repo carrying
# pre-existing violations in files no story touched — the trap run_tsc_verification had to escape
# with baseline diffing.
#
# Runs only where the repo ENFORCES lint at commit time. A repo with no pre-commit hook is held
# to its own standard, not ours.
# THE DECLARED-LINT PATH -- for a codeline whose linter is not eslint.
#
# Separate from run_repo_lint_verification on purpose: the eslint path below it resolves its files
# through lint-staged routing and an eslint --print-config probe, both of which are questions only
# eslint can answer. This one asks the codeline which of its changed files are source, runs the
# command the codeline declares, and reads the exit status.
#
# 127 -- the declared command cannot be run here -- is a FAILURE of a project that lints, never the
# same thing as a project that does not lint. The old probe could not express that difference.
_run_declared_lint_gate() {
    local story_id="$1" output_file="${2:-/dev/null}" _cmd="$3"
    local _dl_changed _dl_testable="" _dl_files=() _dl_f

    _dl_changed=$( { git -C "$PROJECT_ROOT" diff --name-only --diff-filter=d 2>/dev/null
                     git -C "$PROJECT_ROOT" diff --cached --name-only --diff-filter=d 2>/dev/null
                     git -C "$PROJECT_ROOT" ls-files --others --exclude-standard 2>/dev/null; } \
                   | sort -u | engine_paths_filter)
    if [ -n "$_dl_changed" ]; then
        # shellcheck disable=SC2086
        _dl_testable=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/testable-source.js" \
            "$PROJECT_ROOT" $_dl_changed 2>/dev/null || echo "")
    fi
    while IFS= read -r _dl_f; do
        [ -n "$_dl_f" ] || continue
        [ -f "$PROJECT_ROOT/$_dl_f" ] || continue
        _dl_files+=("$_dl_f")
    done <<< "$_dl_testable"

    if [ ${#_dl_files[@]} -eq 0 ]; then
        log "  [repo-lint] $story_id: no changed files that this codeline declares as source — nothing to lint"
        return 0
    fi

    local _dl_out _dl_rc=0
    # The project DECLARES its command as a string, so running it means eval. The file list after it
    # is a quoted array, which is the part that must not be re-split.
    # shellcheck disable=SC2294
    _dl_out=$(cd "$PROJECT_ROOT" && eval "$_cmd" "${_dl_files[@]}" 2>&1) || _dl_rc=$?

    if [ "$_dl_rc" -eq 127 ]; then
        error "  [repo-lint] $story_id: this codeline declares [$_cmd] and it could not be run — lint NOT PERFORMED"
        printf '%s\n' "$_dl_out" | head -10 >&2
        return 1
    fi
    if [ "$_dl_rc" -eq 0 ]; then
        success "  [repo-lint] $story_id: the repository lint [$_cmd] accepts ${#_dl_files[@]} changed file(s)"
        return 0
    fi

    error "  [repo-lint] $story_id: the repository lint [$_cmd] rejects ${#_dl_files[@]} changed file(s) —"
    error "  [repo-lint]   the pre-commit hook will refuse this commit and may REVERT the work."
    printf '%s\n' "$_dl_out" | head -40 >&2

    DETERMINISTIC_CHECK_FAILURE=1
    export DETERMINISTIC_CHECK_FAILURE
    # KEYED ON THE FAILURES, so an identical rejection twice escalates the ladder instead of
    # looking novel on every attempt. The identities are the ones the codeline DECLARES for its
    # lint (verification.json lint.failurePattern/failureIdentity, via the plugin); a codeline that
    # declares none is keyed on the distinct diagnostic lines themselves. Neither names a tool.
    local _dl_ids
    _dl_ids=$(_verification_plugin_call parseFailures "$PROJECT_ROOT" "$_dl_out" lint 2>/dev/null | jq -r 'if type=="array" then sort | join(",") else empty end' 2>/dev/null)
    [ -n "$_dl_ids" ] || _dl_ids=$(printf '%s\n' "$_dl_out" | grep -v '^\s*$' | sort -u | md5sum | cut -c1-12)
    STORY_REJECTION_KEY="lint:${_dl_ids}"
    VERIFICATION_FAILURE=$(printf '\n## Verification Failure\n\nThe repository lints with `%s` and it rejects your change:\n\n```\n%s\n```\n\nFix these before the change can be committed: the pre-commit hook will refuse this commit and may revert the work.\n' \
        "$_cmd" "$(printf '%s' "$_dl_out" | head -n "$(evidence_window lintOutputLines)")")
    export VERIFICATION_FAILURE
    printf '%s\n' "$_dl_out" >> "$output_file" 2>/dev/null || true
    return 1
}

run_repo_lint_verification() {
    local story_id="$1"
    local output_file="${2:-/dev/null}"
    is_truthy "${SKIP_STORY_LINT_GATE:-}" && return 0
    [ -d "$PROJECT_ROOT/.git" ] || return 0

    # Does this repo check anything at commit time? Honour core.hooksPath (husky v9 sets it),
    # then the husky default, then the stock hook location.
    local _hook="" _hooks_path
    _hooks_path=$(git -C "$PROJECT_ROOT" config --get core.hooksPath 2>/dev/null)
    for _candidate in \
        ${_hooks_path:+"$PROJECT_ROOT/$_hooks_path/pre-commit"} \
        "$PROJECT_ROOT/.husky/pre-commit" \
        "$PROJECT_ROOT/.git/hooks/pre-commit"; do
        [ -f "$_candidate" ] && { _hook="$_candidate"; break; }
    done
    # AN ABSENT CHECK IS NOT A PASS. These three exits used to be silent `return 0`s, so
    # "lint could not run" was indistinguishable from "lint found nothing" — the same fail-open
    # shape as every other defect in this pipeline. The story is not failed for them (the writer
    # cannot install a hook or a linter), but the run says so out loud.
    if [ -z "$_hook" ]; then
        warning "  [repo-lint] $story_id: no pre-commit hook in $PROJECT_ROOT — lint was NOT run; nothing here proves the change is clean"
        return 0
    fi

    # WHAT THIS CODELINE LINTS WITH, ASKED OF THE CODELINE FIRST.
    #
    # This probed for eslint and nothing else. On a codeline that lints with biome, oxlint, ruff or
    # a Makefile target it found none, said in its own words that nothing proved the change clean,
    # and returned 0 -- the only one of this engine's seventeen delivery-contract gates that was
    # coupled to a stack.
    #
    # .epam/verification.json already declares typecheck and test; lint is the third of the same
    # shape, detected by the plugin that owns detection. Nothing below it names a tool.
    local _declared_lint=""
    _declared_lint=$("${NODE_BIN:-node}" -e '
      const fs = require("fs"), path = require("path");
      let cmd = "";
      try {
        const j = JSON.parse(fs.readFileSync(path.join(process.argv[2], ".epam", "verification.json"), "utf8"));
        cmd = ((j.lint || {}).command) || "";
      } catch (e) { /* not declared on disk */ }
      if (!cmd) {
        try {
          const p = require(process.argv[1]);
          cmd = (((p.detectLint(process.argv[2]) || {}).lint) || {}).command || "";
        } catch (e) { cmd = ""; }
      }
      process.stdout.write(cmd);
    ' "${AUTOMATION_DIR:-$(dirname "$SCRIPT_DIR")}/plugins/verification-plugin.js" "$PROJECT_ROOT" 2>/dev/null || echo "")

    # THE CODELINE'S DECLARED LINT, OR NONE. The engine names no linter: it does not look for a
    # binary, route files through a particular tool's staging, or probe a particular tool's config.
    # Every one of those was a question only one linter could answer, written into the engine
    # (removed 2026-09-16). A codeline that declares no lint is told so, out loud, and not failed.
    if [ -n "$_declared_lint" ]; then
        _run_declared_lint_gate "$story_id" "$output_file" "$_declared_lint"
        return $?
    fi
    warning "  [repo-lint] $story_id: the codeline declares no lint command — lint was NOT run; nothing here proves the change is clean"
    return 0
}

_verification_plugin_call() {
    # $1 = exported function name, $2.. = JSON-encodable string args
    local _fn="$1"; shift
    local _plugin="${AUTOMATION_DIR}/plugins/verification-plugin.js"
    local _node="${NODE_CMD:-${NODE_BIN:-node}}"
    [ -f "$_plugin" ] || { printf ''; return 1; }
    "$_node" -e '
      const p = require(process.argv[1]);
      const fn = p[process.argv[2]];
      if (typeof fn !== "function") { process.exit(3); }
      const out = fn.apply(null, process.argv.slice(3));
      if (out === null || out === undefined) { console.log("unknown"); }
      else if (typeof out === "object") { console.log(JSON.stringify(out)); }
      else { console.log(String(out)); }
    ' "$_plugin" "$_fn" "$@" 2>/dev/null
}

# The project's declared manifest filename / install command, from .epam/dependency-check.json —
# the same file _get_vendor_dirs() reads. Empty when undeclared, so a caller provisions nothing
# rather than having an ecosystem guessed for it.
_project_dep_config_value() {
    local _root="${1:-$PROJECT_ROOT}" _key="$2"
    local _cfg="$_root/.epam/dependency-check.json"
    [ -f "$_cfg" ] || _cfg="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/dependency-check.json}"
    [ -f "$_cfg" ] || return 0
    jq -r --arg k "$_key" '.[$k] // empty' "$_cfg" 2>/dev/null
}

_project_manifest_file()  { _project_dep_config_value "${1:-$PROJECT_ROOT}" manifestFile; }

_project_install_command() { _project_dep_config_value "${1:-$PROJECT_ROOT}" installCommand; }

# HOW THE CODELINE'S ENVIRONMENT IS PROVISIONED — the manifest's provisionCommand, verbatim.
# Until 2026-09-16 the engine had no such reading: it deleted `{package}` from the ADD command and
# ran the remainder, which provisions under exactly one package manager and under no other.
_project_provision_command() { _project_dep_config_value "${1:-$PROJECT_ROOT}" provisionCommand; }

# complete_codeline_manifests <codeline-root>
#
# THE CODELINE'S MANIFEST IS COMPLETED FROM ITS ECOSYSTEM BEFORE IT IS READ. A greenfield codeline
# starts with the PROJECT's declared .epam/dependency-check.json (greenfield_seed_codeline) and the
# only completion from the ecosystem provider ran in the orchestrator's codeline loop — the
# brownfield/multi-codeline path — so a greenfield main-branch story was verified against a manifest
# that never learned provisionCommand, runEnvironment or emptyDeliverables after the scaffold story
# wrote requirements.txt (regintel 20260916T200108Z, 2026-09-17: "declares no provisionCommand",
# pytest without the venv, an empty __init__.py judged missing). Keys the manifest already holds
# are kept (the project's word wins); absent keys are added from the provider; a codeline whose
# ecosystem no provider declares is left as it is. One node call; idempotent.
complete_codeline_manifests() {
    local _root="${1:-$PROJECT_ROOT}"
    [ -n "$_root" ] && [ -d "$_root" ] || return 0
    local _cfg="$_root/.epam/dependency-check.json"
    [ -f "$_cfg" ] || return 0
    command -v jq >/dev/null 2>&1 || return 0
    local _derived _rc=0
    _derived=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/codeline-manifests.js" "$_root" 2>/dev/null) || _rc=$?
    [ "$_rc" -eq 0 ] && [ -n "$_derived" ] || return 0
    local _added
    _added=$(jq -n --argjson have "$(cat "$_cfg")" --argjson derive "$(printf '%s' "$_derived" | jq '."dependency-check.json" // {}')" \
        '[($derive | keys[]) as $k | select(($have | has($k)) | not) | $k]' 2>/dev/null || echo '[]')
    [ "$(printf '%s' "$_added" | jq 'length' 2>/dev/null || echo 0)" -gt 0 ] || return 0
    local _tmp; _tmp=$(mktemp)
    if jq -s '.[1] * .[0]' "$_cfg" <(printf '%s' "$_derived" | jq '."dependency-check.json"') > "$_tmp" 2>/dev/null; then
        mv "$_tmp" "$_cfg"
        log "  [manifest] completed .epam/dependency-check.json in ${_root} with $(printf '%s' "$_added" | jq -r 'join(", ")') from its ecosystem provider"
    else
        rm -f "$_tmp"
    fi
}

# WHERE COMMANDS RUN — the manifest's runEnvironment rendered as `export` statements for a
# `bash -c` prefix: PATH entries are codeline-relative directories put in front of PATH, every
# other key is exported verbatim (relative values resolved against the codeline). Empty when the
# manifest declares none, so a command runs exactly as it would have before.
_project_run_env_prefix() {
    local _root="${1:-$PROJECT_ROOT}"
    local _cfg="$_root/.epam/dependency-check.json"
    [ -f "$_cfg" ] || _cfg="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/dependency-check.json}"
    [ -f "$_cfg" ] || return 0
    jq -r --arg root "$_root" '
      def abs: if startswith("/") then . else ($root + "/" + .) end;
      (.runEnvironment // {}) | to_entries[] |
        if .key == "PATH" then "export PATH=\"" + (([.value[]?] | map(abs) | join(":")) + ":$PATH") + "\"; "
        else "export " + .key + "=\"" + (.value | tostring | abs) + "\"; " end
    ' "$_cfg" 2>/dev/null | tr -d '\n'
}

# "true" | "false" | "unknown" — unknown when the project declared no test-file convention.
_project_repo_has_tests() {
    local _out
    _out=$(_verification_plugin_call repoHasTests "${1:-$PROJECT_ROOT}")
    case "$_out" in true|false) printf '%s' "$_out" ;; *) printf 'unknown' ;; esac
}

# The declared suite command, or empty when the project declared none.
# testCommandFor RETURNS THE DECLARED COMMAND, pinned to the clock the project declares when it
# declares one. A project that declares no clock gets exactly what readTestManifest returned
# before, byte-identical — which is every project passing today.
#
# WHY PIN AT ALL: a suite must answer the same way whenever it runs. AMSD-1919 burned 12 writer
# retries on 2026-09-07 because the client suite hides service updates for the first two hours of
# the day and its jest config pins TZ=UTC, so two tests fail between 00:00 and 02:00 UTC. The fix
# was already correct; the run simply started at 00:29.
#
# The fallback keeps an older plugin working: no testCommandFor, no pin, same command as before.
# _bounded_test_command <cmd> — the project's test command, bounded in BOTH dimensions.
#
# This suite is the heaviest thing the pipeline runs and it ran with no bound at all: jest takes
# cores-1 workers by default (15 on a 16-core box) against thousands of jsdom tests, on EVERY
# writer attempt, up to twelve. It took the host down twice on 2026-09-07 and cost a WSL restart.
# The same suite is bounded at every one of run-agent-orchestration.sh's six call sites, which say
# why: "an unbounded suite starves the host". Only the writer's copy was left out.
#
# TWO DIMENSIONS, NEITHER SUBSTITUTING FOR THE OTHER:
#   CPU     run_test_bounded uses taskset — it caps CORES.
#   MEMORY  taskset does not cap heap. Only an explicit ceiling does, and for a node runner that is
#           NODE_OPTIONS=--max-old-space-size. Operator, repeatedly: "all processes have to have
#           memory bounded". A worker limit is not a memory limit.
#
# DECLARED, NOT HARDCODED. How much heap a project's suite may use is that project's fact, so it
# declares `maxOldSpaceMb` in .epam/verification.json beside its command. A project that declares
# none gets no invented ceiling — inventing one would break a suite that legitimately needs more —
# but it still gets the CPU bound, because that one is safe for everybody.
_bounded_test_command() {
    local _cmd="${1:-}" _mb=""
    [ -n "$_cmd" ] || return 0

    if command -v jq >/dev/null 2>&1; then
        local _vf="${PROJECT_ROOT:-}/.epam/verification.json"
        [ -f "$_vf" ] && _mb=$(jq -r '.test.maxOldSpaceMb // empty' "$_vf" 2>/dev/null)
    fi
    case "$_mb" in ''|*[!0-9]*) _mb="" ;; esac        # a malformed ceiling is no ceiling

    [ -n "$_mb" ] && _cmd="NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--max-old-space-size=${_mb}\" ${_cmd}"

    # The CPU half, through the same helper the orchestration script uses. If the lib is not
    # loadable or affinity is unavailable it degrades to today's behaviour rather than failing the
    # verification — a bound that cannot be applied must never fail a run.
    local _bx="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/lib/bounded-exec.sh"
    if [ -f "$_bx" ]; then
        # shellcheck source=/dev/null
        . "$_bx" 2>/dev/null || true
    fi
    # EMIT SOMETHING A FRESH SHELL CAN RUN. The caller executes this through `bash -c`, which is a
    # NEW shell: a run_test_bounded call would be "command not found" (exit 127) and would fail
    # every story. Caught live before release — the function exists only in the sourcing shell, so
    # the bound has to be an actual binary invocation with the worker count already resolved.
    local _w=""
    command -v resolve_test_workers >/dev/null 2>&1 && _w="$(resolve_test_workers 2>/dev/null)"
    case "$_w" in ''|*[!0-9]*) _w="" ;; esac
    if [ -n "$_w" ] && [ "$_w" -ge 1 ] 2>/dev/null && command -v taskset >/dev/null 2>&1 \
       && taskset -c 0 true >/dev/null 2>&1; then
        printf 'taskset -c 0-%d sh -c %s' "$(( _w - 1 ))" "$(printf '%q' "$_cmd")"
    else
        # No affinity available: today's behaviour, and the memory ceiling above still applies.
        printf '%s' "$_cmd"
    fi
}

_project_test_command() {
    local _root="${1:-$PROJECT_ROOT}"
    local _plugin="${AUTOMATION_DIR}/plugins/verification-plugin.js"
    local _node="${NODE_CMD:-${NODE_BIN:-node}}"
    [ -f "$_plugin" ] || return 0
    "$_node" -e '
      const p = require(process.argv[1]);
      const cmd = typeof p.testCommandFor === "function"
        ? p.testCommandFor(process.argv[2])
        : ((m) => (m && m.ok ? m.command : ""))(p.readTestManifest(process.argv[2]));
      if (cmd) console.log(cmd);
    ' "$_plugin" "$_root" 2>/dev/null
}

# This story's declared files that the PROJECT recognises as test files, space separated.
_project_owned_test_files() {
    # THE PLUGIN ANSWERS THIS. Both of these used to be node programs written inside bash
    # single-quoted strings — unrunnable on their own, untestable, with stderr sent to /dev/null.
    # The first one destructured its arguments one position too far, so it read the STORY ID as the
    # repo root and got undefined for the PRD; readFileSync(undefined) threw, the catch exited 0,
    # and it printed nothing for every story of every project since it was written. Nothing failed
    # visibly: claude.sh scopes verification only when this returns files, so external verification
    # always ran the whole suite (live 2026-09-02: 746 suites / 3,385 tests and 10,731MB to validate
    # one line).
    #
    # _verification_plugin_call is the ONE generic invoker. Adding a capability is a function in the
    # plugin and a call here — never another program embedded in a string.
    local _out
    _out=$(_verification_plugin_call ownedTestFiles "$1" "$2" "$3") || return 0
    [ "$_out" = "unknown" ] && return 0      # no declared convention: cannot answer, so scope nothing
    printf '%s' "$_out"
}

_project_scoped_test_command() {
    # The template is the project's own declaration (.epam/verification.json test.scopedCommand);
    # the plugin substitutes the file list. Empty when undeclared, so the caller runs the full
    # suite — correct, and never silent.
    local _out
    _out=$(_verification_plugin_call scopedTestCommand "$1" "$2") || return 0
    [ "$_out" = "unknown" ] && return 0
    printf '%s' "$_out"
}
