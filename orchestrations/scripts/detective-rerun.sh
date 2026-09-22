#!/usr/bin/env bash
# detective-rerun.sh — run the fix-site investigation on its own, outside a full spec pass.
#
# The node step (detective-rerun-step.js) does the work. This exists because that step needs
# the SAME environment the spec pass gives the detective — the project's model ladder, provider
# routing, API keys, brownfield flag and config directory — and assembling that by hand at a
# shell prompt is how a run ends up on the wrong models with no keys.
#
# Nothing is parsed here. The env files are loaded by lib/env-file.sh in the same order
# orchestrate.sh uses (global -> config -> secrets -> config again, so the project always
# wins), because a config file is DATA: on 2026-08-05 executing one instead of reading it sent
# every subsequent path to $HOME. The interpreter comes from lib/node-bin.sh for the same
# reason — a pinned nvm path is valid on one machine until the day it is upgraded.
#
# Usage:
#   detective-rerun.sh --project <name> [--codelines a,b] [--story ID] [--report] [--derive-config-candidates]
#
# --derive-config-candidates is CHEAP and makes NO LLM CALL: it reads requiredPackages off
# the prescription that already stands and appends the project-declared build-config files as
# candidates. Use it instead of a full re-investigation when you only need those candidates —
# a re-investigation is a fresh draw and can come back worse (live 2026-08-11: a re-run
# replaced a correct AMSD-2041/gotransit prescription with changeRequired:false on all five
# sites, and reported success).
#
# --report is read-only: it prints which sites lack changeRequired and exits without calling
# an agent or writing anything. Run it first.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=lib/project-config.sh
. "$SCRIPT_DIR/lib/project-config.sh"

# Config files are DATA: load them without executing them. See lib/env-file.sh.
. "$SCRIPT_DIR/lib/env-file.sh"
. "$SCRIPT_DIR/lib/node-bin.sh"
# The ladders a seam climbs are declared in llm-settings.json. Without this the detective
# resolves its seam, asks for a tier, finds the variable unset, and investigates on whatever
# default happens to apply — observed live 2026-08-13.
. "$SCRIPT_DIR/lib/model-ladders.sh"

PROJECT=""
PASSTHRU=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project|-p) PROJECT="${2:-}"; shift 2 ;;
    *) PASSTHRU+=("$1"); shift ;;
  esac
done

[ -z "$PROJECT" ] && { echo "Usage: detective-rerun.sh --project <name> [--codelines a,b] [--story ID] [--report] [--derive-config-candidates]" >&2; exit 1; }

PROJECT_DIR="$(project_config_dir "$PROJECT" "$REPO_ROOT")" || exit 1
# The project's env is TWO files — the base, and the half the active provider set decides.
# load_project_env asks the registry which they are; naming one here would load only the base
# and silently drop the provider map and fallback model.
[ -d "$PROJECT_DIR" ] || { echo "Project config dir not found: $PROJECT_DIR" >&2; exit 1; }

# Same order as orchestrate.sh: the project config is loaded last so a shared secrets file
# cannot clobber it with another project's connection settings.
load_env_file_safe "$REPO_ROOT/.env"
load_project_env "$PROJECT_DIR" || exit 1
if [ -n "${SECRETS_FILE:-}" ]; then
  case "$SECRETS_FILE" in
    /*) _secrets_abs="$SECRETS_FILE" ;;
     *) _secrets_abs="$REPO_ROOT/$SECRETS_FILE" ;;
  esac
  [ -f "$_secrets_abs" ] && load_env_file_safe "$_secrets_abs"
fi
load_env_file_safe "$CONFIG"

export EPAM_PROJECT_CONFIG_DIR="${EPAM_PROJECT_CONFIG_DIR:-$PROJECT_DIR}"

# SOURCING THE LIB ONLY DEFINES THE FUNCTION — it has to be CALLED, and it needs the settings
# file, which is only known once the project directory is resolved above. Without this the
# detective resolved its seam, asked for the HIGHEST tier, found the variable unset and
# investigated on whatever default applied:
#   [seam-invocation] agent 'code-graph-detective' asks for ladder 'HIGHEST',
#   but EPAM_MODEL_LADDER_HIGHEST is unset in this process
export_model_ladders "$EPAM_PROJECT_CONFIG_DIR/llm-settings.json"

# The detective returns immediately unless this is set — a brownfield investigation has no
# meaning without an existing codebase to investigate. Stated rather than assumed so a project
# whose config omits it fails visibly here instead of returning "no fix sites" and looking
# like a clean answer.
if [ "${EPAM_BROWNFIELD:-0}" != "1" ]; then
  echo "[detective-rerun] EPAM_BROWNFIELD is not 1 for project '$PROJECT' — the detective would" >&2
  echo "[detective-rerun] return no findings, which is indistinguishable from a real empty answer." >&2
  exit 2
fi

PRD_PATH="${PRD_FILE:-$PROJECT_DIR/prd.json}"
[ -f "$PRD_PATH" ] || { echo "[detective-rerun] PRD not found: $PRD_PATH" >&2; exit 2; }

LOG_DIR="${OUTPUT_DIR:-$REPO_ROOT/orchestrations/logs}"

NODE_BIN="${NODE_BIN:-$(resolve_node_bin)}"
export NODE_BIN

echo "[detective-rerun] project=$PROJECT prd=$PRD_PATH" >&2
echo "[detective-rerun] models: high=${SPEC_MODE_OPENSPEC_MODEL_HIGH:-unset} provider=${SPEC_MODE_PROVIDER:-unset}" >&2

exec "$NODE_BIN" "$SCRIPT_DIR/detective-rerun-step.js" \
  --prd "$PRD_PATH" \
  --log-dir "$LOG_DIR" \
  "${PASSTHRU[@]}"
