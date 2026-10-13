#!/usr/bin/env bash
# run-artifacts.sh — the evidence and the reports a run owes, on EVERY outcome.
#
#   archive_run_artifacts <project> <outcome> <launch-log>
#
# Writes <project config>/runs/<ORCH_RUN_ID>/: the archived artefacts (archive-run-artifacts.sh), run.log,
# outcome.txt, and the reports generate-run-report.py builds from them (narrative, qa-summary, flow, code).
#
# One definition for every launcher. It lived only in tier3-metrolinx-run.sh, so runs started from
# orchestrate.sh — every AMSD-2974 run — ended "Pipeline complete" with no outcome.txt and no report
# (run 9 iteration 2, 2026-10-13).
#
# Never allowed to change the run's outcome: every step is `|| true`.
# Needs: SCRIPT_DIR, REPO_ROOT, project_config_dir (lib/project-config.sh).

archive_run_artifacts() {
  local project="$1" outcome="$2" launch_log="$3"
  # Assigned separately: `local dir="$(...)"` makes the exit status local's, always 0,
  # which would swallow the resolver's refusal.
  local _cfg dir logs
  _cfg="$(project_config_dir "$project" "$REPO_ROOT")" || return 1
  dir="$_cfg/runs/${ORCH_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
  logs="$REPO_ROOT/orchestrations/logs"
  mkdir -p "$dir" 2>/dev/null || return 0
  AUTOMATION_DIR="$REPO_ROOT/orchestrations" \
  LOG_DIR="$logs" \
  RUN_ARTIFACT_DIR="$dir" \
    bash "$SCRIPT_DIR/archive-run-artifacts.sh" >/dev/null 2>&1 || true
  [ -f "$launch_log" ] && cp "$launch_log" "$dir/run.log" 2>/dev/null || true
  printf '%s\n' "$outcome" > "$dir/outcome.txt" 2>/dev/null || true

  python3 "$SCRIPT_DIR/generate-run-report.py" \
    --launch-log "$launch_log" \
    --logs-dir "$logs" \
    --codeline "$(sed 's/\x1b\[[0-9;]*m//g' "$launch_log" 2>/dev/null | grep -oE "Codeline '[^']+' → \S+" | head -1 | awk '{print $NF}')" \
    --baseline "$(cat "$logs/phase-baseline-sha.txt" 2>/dev/null | tr -d '[:space:]')" \
    --prd "$dir/working-prd.json" \
    --out "$dir" >/dev/null 2>&1 || true
  echo "Run artefacts + reports: $dir"
}
