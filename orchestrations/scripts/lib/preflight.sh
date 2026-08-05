#!/usr/bin/env bash
# preflight.sh — run the pre-launch assessment from any launcher, with no launcher having
# to know the check script's arguments.
#
# preflight-check.sh existed with six sections and was wired into exactly TWO of the eight
# launchers. The two being run daily (metrolinx, mock) were not among them, which is why
# four separate launch failures on 2026-08-05 — a stale dist twice, a dead observability
# stack, a project with no synthesis template — were each discovered by spending a launch
# instead of by the check that exists to prevent exactly that.
#
# The runner name and the project config directory are DERIVED here rather than passed:
# a launcher that had to repeat them is a launcher that can get them wrong, and one already
# did — tier3-skyscanner-app-run.sh passed --runner tier3-travel-app-run.sh, so it
# pre-flighted a different launcher than the one it was about to run.
#
# Usage:  . lib/preflight.sh ; require_preflight   # aborts the launch if anything fails

require_preflight() {
  local script_dir="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  local check="$script_dir/preflight-check.sh"

  if [ ! -f "$check" ]; then
    echo "  ✗ preflight-check.sh not found at $check — refusing to launch unassessed" >&2
    return 1
  fi

  local -a args=()
  # The runner is whichever launcher sourced this file. $0 is that launcher.
  args+=(--runner "$(basename "${0:-unknown}")")
  [ -n "${PRD_FILE:-}" ] && args+=(--prd "$PRD_FILE")
  [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] && args+=(--project-config "$EPAM_PROJECT_CONFIG_DIR")

  echo "── Pre-flight assessment ─────────────────────────────────────────────────────"
  if bash "$check" "${args[@]}"; then
    return 0
  fi

  # Deliberately not skippable by an env var. Every failure this catches cost a launch
  # cycle or credits; an escape hatch here would be used on the run that needed it most.
  echo "" >&2
  echo "  ✗ Pre-flight FAILED — aborting before spending. Fix the items above." >&2
  return 1
}
