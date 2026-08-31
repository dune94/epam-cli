#!/usr/bin/env bash
# ai-run.sh — RETIRED NAME. Forwards to llm-handler.sh.
#
# The name said nothing about what the script does, and it had become one of EIGHT
# independent paths to a vendor API. The pipeline now has ONE central handler —
# llm-handler.sh — which resolves the provider from the active provider set and
# dispatches to a vendor handler.
#
# This shim exists ONLY so the migration does not have to rewrite 536 call sites in
# one change. It carries no logic: any behaviour here would be a second hub, which is
# the exact defect the consolidation removes. Delete it once call sites name the hub.

# THE PIPELINE DOES NOT RUN CODE NOBODY HAS TESTED. This stage asks how much of the code it is
# about to execute has a test behind it, and halts when the project says it must.
_scg_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/stage-coverage-gate.sh"
# shellcheck source=/dev/null
[ -f "$_scg_lib" ] && . "$_scg_lib" && require_stage_coverage writer || exit 1

exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/llm-handler.sh" "$@"
