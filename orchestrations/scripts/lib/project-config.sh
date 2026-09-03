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

# resolve_run_project <prd-path> [declared-name] — WHICH PROJECT IS THIS RUN?
#
# A PRD names its project, and when there IS a PRD that is the answer. A Jira-driven run has none at
# launch: ingest synthesizes it at the very path handed to --prd, so reading that file at startup
# finds nothing and refuses the run before it can create what was being read. Two mock launchers hit
# exactly that. The paid metrolinx launcher escaped only by shape — it points at the project's
# canonical prd.json, which pre-exists because pre-run-reset restores it.
#
# So the caller declares the project when there is no PRD to read, exactly as orchestrate.sh has
# always taken --project <name>.
#
# BOTH ABSENT IS REFUSED. This file's rule is NO DEFAULT: a launcher that cannot say which project
# it is running must stop, because these run against client repositories.
#
# A DISAGREEMENT IS REFUSED TOO. Silently preferring the PRD or the flag is the same defect wearing
# a different hat — a run configured from a project nobody chose, announced in one line nobody reads
# twice.
resolve_run_project() {
    local _prd="${1:-}" _declared="${2:-}" _named=""
    if [ -n "$_prd" ] && [ -f "$_prd" ]; then
        _named="$("${NODE_BIN:-node}" -e '
          try {
            const prd = require(process.argv[1]);
            const n = prd && prd.project && prd.project.name;
            process.stdout.write(typeof n === "string" ? n.trim() : "");
          } catch (e) { process.stdout.write(""); }
        ' "$_prd" 2>/dev/null || printf '')"
    fi

    if [ -n "$_named" ] && [ -n "$_declared" ] && [ "$_named" != "$_declared" ]; then
        echo "[project-config] the PRD at $_prd names project '$_named' but '$_declared' was declared — refusing to choose between them" >&2
        return 1
    fi
    [ -n "$_named" ] && { printf '%s' "$_named"; return 0; }
    [ -n "$_declared" ] && { printf '%s' "$_declared"; return 0; }

    echo "[project-config] no project for this run: the PRD at ${_prd:-(none)} names none — it may not be written yet, as a Jira run synthesizes it during ingest — and none was declared with --project" >&2
    return 1
}
