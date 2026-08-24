#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# WHERE A PROJECT'S CONFIG LIVES IS ONE RULE, AND IT IS WRITTEN ONCE.
#
# This is the defect class closed in orchestrate.sh, scanned for across the tree so the
# next copy is caught at test time rather than at launch time.
#
# The failure it prevents is silent, not loud. orchestrate.sh took --project <name>, built
# the path by hand, and never exported EPAM_PROJECT_CONFIG_DIR — so the engine read
# `/llm-settings.json`, found nothing, and export_model_ladders returned 0 on a project it
# had never located. No error anywhere; every seam simply fell through to the run default.
#
# Each hand-assembled copy is one more chance for exactly that: a path built without the
# existence check, without the EPAM_PROJECT_CONFIG_DIR override, and without the export.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    LIB="$SCRIPTS/lib/project-config.sh"
    # The path literal is read from the one file that owns it, never retyped here.
    # No trailing slash: the library emits the root without one and appends the name
    # separately, so a slash-terminated pattern would miss the only real definition and
    # match nothing but the file's own header comment.
    LITERAL="$(grep -oE 'orchestrations/projects' "$LIB" | head -1)"
}

# CODE LINES ONLY. A header that documents the layout is not a second implementation of
# the rule — counting comments would make this test unfixable and train people to ignore it.
code_hits() { grep -n "$LITERAL" "$1" 2>/dev/null | grep -vcE '^[0-9]+:[[:space:]]*#'; }

# Every non-comment line in shell sources that builds the projects path by hand.
handbuilt() {
    grep -rn "$LITERAL" "$SCRIPTS"/*.sh "$SCRIPTS"/lib/*.sh 2>/dev/null \
        | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' \
        | grep -v "^$LIB:"
}

@test "the fixture is real — the library owns the literal exactly once" {
    [ -n "$LITERAL" ]
    [ "$(code_hits "$LIB")" -eq 1 ]
    run bash -c "grep -c '^project_config_dir()' '$LIB'"
    [ "$output" -eq 1 ]
}

@test "the scan is not vacuous — it can see the library's own definition when unfiltered" {
    n=$(grep -rn "$LITERAL" "$SCRIPTS"/lib/*.sh | wc -l)
    [ "$n" -ge 1 ]
}

@test "orchestrate.sh resolves the project dir ONCE and reuses it" {
    # The launcher that carried the original defect must not have grown a second copy.
    [ "$(code_hits "$SCRIPTS/orchestrate.sh")" -eq 0 ]
}

@test "orchestrate.sh exports what the engine reads" {
    grep -qE '^export EPAM_PROJECT_CONFIG_DIR=' "$SCRIPTS/orchestrate.sh"
}

@test "no script builds the project config path by hand" {
    out="$(handbuilt || true)"
    [ -z "$out" ] || {
        echo "the project-dir rule is copied outside lib/project-config.sh:"
        echo "$out"
        echo "each copy skips the existence check, the EPAM_PROJECT_CONFIG_DIR override, or the export."
        false
    }
}

# ── projects_root: the relocation flag, now universal ────────────────────────

@test "EPAM_PROJECTS_DIR relocates the tree, for every caller" {
    # tier3-run.sh documented this flag in its own --help and was the only script that
    # honoured it. Absorbing it into the library is what makes the documentation true.
    W="$(mktemp -d)"; mkdir -p "$W/elsewhere/myproj"
    run bash -c ". '$LIB'; EPAM_PROJECTS_DIR='$W/elsewhere' projects_root /ignored"
    [ "$status" -eq 0 ]
    [ "$output" = "$W/elsewhere" ]
    run bash -c ". '$LIB'; EPAM_PROJECTS_DIR='$W/elsewhere' project_config_dir myproj /ignored"
    [ "$status" -eq 0 ]
    [ "$output" = "$W/elsewhere/myproj" ]
    rm -rf "$W"
}

@test "projects_root refuses rather than returning a bare relative path" {
    run bash -c ". '$LIB'; unset REPO_ROOT EPAM_PROJECTS_DIR; projects_root"
    [ "$status" -ne 0 ]
    [ -z "${output##*no repo root*}" ]
}

@test "every launcher that resolves a project SOURCES the library" {
    bad=""
    for f in "$SCRIPTS"/*.sh; do
        grep -qE '(project_config_dir|projects_root)' "$f" || continue
        # Either form counts. orchestrate.sh guards the source with `[ -f ... ] &&` and then
        # refuses to launch if the function is still undefined, which is stricter than an
        # unguarded source, not weaker — the test must not push it back to the weaker shape.
        grep -E '\..*project-config\.sh' "$f" | grep -qvE '^[[:space:]]*#' \
            || bad="${bad} $(basename "$f")"
    done
    [ -z "$bad" ] || { echo "calls the library without sourcing it:$bad"; false; }
}

@test "EXECUTED: an unknown project is refused by every caller, not defaulted" {
    # A resolver that returned a plausible path to nothing is what started this: the engine
    # read /llm-settings.json, found nothing, and exported no ladder chain without an error.
    run bash -c ". '$LIB'; project_config_dir definitely-not-a-project '$REPO_ROOT'"
    [ "$status" -ne 0 ]
    [ -z "$output" ] || [ -z "${output##*no project*}" ]
}

# ── project_settings_file: one definition of the ladder-settings filename ────

@test "project_settings_file names the settings file relative to the project dir" {
    run bash -c ". '$LIB'; unset EPAM_LLM_SETTINGS_FILE; project_settings_file /some/project"
    [ "$status" -eq 0 ]
    [ "$output" = "/some/project/llm-settings.json" ]
}

@test "an explicit EPAM_LLM_SETTINGS_FILE outranks the project dir, for every caller" {
    # run-agent-orchestration.sh, orchestrate.sh and seven seam scripts each wrote the
    # filename inline; the seam scripts honoured this override and the engine did not, so
    # an operator override applied to some seams of one run and not others.
    run bash -c ". '$LIB'; EPAM_LLM_SETTINGS_FILE=/elsewhere/custom.json project_settings_file /some/project"
    [ "$status" -eq 0 ]
    [ "$output" = "/elsewhere/custom.json" ]
}

@test "project_settings_file refuses rather than naming a file at the filesystem root" {
    # With no directory it used to produce "/llm-settings.json" — a real, readable-looking
    # path to nothing, which is exactly how the engine exported no ladder chain and
    # reported success.
    run bash -c ". '$LIB'; unset EPAM_LLM_SETTINGS_FILE; project_settings_file"
    [ "$status" -ne 0 ]
    [ "$output" != "/llm-settings.json" ]
}
