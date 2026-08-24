#!/usr/bin/env bash
# THE PROJECT'S CONFIG DIRECTORY — RESOLVED ONCE.
#
# Four launchers needed this and three had their own answer:
#
#   tier3-run.sh            validated, two ways in, fails when neither is given
#   tier3-mock-run.sh       ${EPAM_PROJECT_CONFIG_DIR:-$REPO_ROOT/orchestrations/projects/mock3}
#   tier3-metrolinx-run.sh  "$SCRIPT_DIR/../projects/metrolinx", unvalidated
#   orchestrate.sh          NOTHING — and it takes --project <name>
#
# The fourth is why this file exists. run-agent-orchestration.sh:279 reads
# "${EPAM_PROJECT_CONFIG_DIR:-}/llm-settings.json" to export the model ladders, so on the
# orchestrate.sh path it read "/llm-settings.json", found no file, exported no chain, and every
# seam in the run fell back or declined. The ingest run died at discovery-vocabulary-agent with
# nothing in the log but "failed".
#
# Adding a fourth copy to orchestrate.sh would have fixed that run and left the same trap set for
# the fifth launcher. The resolution is here, and the launchers ask.
#
# NO DEFAULT. A launcher that cannot say which project it is running must stop: defaulting picks a
# codeline nobody asked for, and these run against client repositories.

# projects_root [repo-root] — the directory that CONTAINS every project's config dir.
#
# Exists because the layout has a second, legitimate reader: preflight-static.sh globs across
# ALL projects to find the newest PRD. That is not a per-project resolution, so it cannot call
# project_config_dir — and left to itself it wrote the layout out by hand, which is one more
# copy to miss when the layout moves. One literal, two shapes of question.
# EPAM_PROJECTS_DIR relocates the whole tree. Only tier3-run.sh honoured it, and it
# documented the option in its own --help — so the same flag worked for one launcher and
# was silently ignored by the other twelve. Absorbed here, it works everywhere or nowhere.
projects_root() {
    if [ -n "${EPAM_PROJECTS_DIR:-}" ]; then
        printf '%s' "$EPAM_PROJECTS_DIR"
        return 0
    fi
    local _root="${1:-${REPO_ROOT:-}}"
    [ -n "$_root" ] || {
        echo "[project-config] cannot locate the projects directory: no repo root given" >&2
        return 1
    }
    printf '%s' "$_root/orchestrations/projects"
}

# project_config_dir <project-name> [repo-root] — the directory, absolute, on stdout.
#
# An explicit EPAM_PROJECT_CONFIG_DIR outranks the name: an operator pointing a run at a config
# directory of their own is a deliberate override, and a name resolved over the top of it would
# turn that into an invisible no-op.
#
# Non-zero, with the reason on stderr, when the project cannot be resolved. The caller decides
# whether that is fatal; what it must never receive is a plausible path to nothing.
project_config_dir() {
    local _name="${1:-}"
    local _root="${2:-${REPO_ROOT:-}}"
    local _dir=""

    if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ]; then
        _dir="$EPAM_PROJECT_CONFIG_DIR"
        [ -d "$_dir" ] || {
            echo "[project-config] EPAM_PROJECT_CONFIG_DIR does not exist: $_dir" >&2
            return 1
        }
    elif [ -n "$_name" ]; then
        [ -n "$_root" ] || {
            echo "[project-config] cannot resolve project '$_name': no repo root given" >&2
            return 1
        }
        _dir="$(projects_root "$_root")/$_name"
        [ -d "$_dir" ] || {
            echo "[project-config] no project '$_name' — looked in $(projects_root "$_root")" >&2
            return 1
        }
    else
        echo "[project-config] no project named. Pass a project name, or export EPAM_PROJECT_CONFIG_DIR." >&2
        return 1
    fi

    ( cd "$_dir" && pwd ) || return 1
}

# project_settings_file <project-config-dir> — the llm-settings.json the ladders come from.
#
# One definition of the filename. run-agent-orchestration.sh, orchestrate.sh and seven seam
# scripts each wrote "${...}/llm-settings.json" inline; the seam scripts additionally honour
# EPAM_LLM_SETTINGS_FILE and the engine did not, so an operator override worked for some seams of
# one run and not others.
project_settings_file() {
    local _dir="${1:-}"
    if [ -n "${EPAM_LLM_SETTINGS_FILE:-}" ]; then
        printf '%s' "$EPAM_LLM_SETTINGS_FILE"
        return 0
    fi
    [ -n "$_dir" ] || return 1
    printf '%s' "$_dir/llm-settings.json"
}
