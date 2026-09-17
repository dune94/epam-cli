#!/usr/bin/env bash
# seam-harness.sh — the project's environment exactly as tier3-run.sh establishes it, then ONE seam.
#   EPAM_PROVIDER_SET=claude bash orchestrations/scripts/tools/seam-harness.sh --project skyscanner --seam project-roster-review --run <runId>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
project=""; install="$REPO_ROOT"
for ((i=1;i<=$#;i++)); do
  [ "${!i}" = "--project" ] && { j=$((i+1)); project="${!j}"; }
  [ "${!i}" = "--install" ] && { j=$((i+1)); install="$(cd "${!j}" && pwd)"; }
done
[ -n "$project" ] || { echo "usage: --project <name> --seam <name> --run <runId> [--install <dir>]" >&2; exit 2; }
# The INSTALL's project env (its PRD, its codeline root), the ENGINE's code. See seam-harness.js.
PROJECT_DIR="$install/orchestrations/projects/$project"
cd "$install"
. "$SCRIPT_DIR/lib/env-file.sh"
for _env in "$install/.env" "$PROJECT_DIR/.env"; do [ -f "$_env" ] && load_env_file_safe "$_env" preserve; done
load_project_env "$PROJECT_DIR" preserve
export EPAM_PROJECT_CONFIG_DIR="$PROJECT_DIR"
exec "${NODE_BIN:-node}" "$SCRIPT_DIR/tools/seam-harness.js" "$@"
