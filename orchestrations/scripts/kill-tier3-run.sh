#!/usr/bin/env bash
# Kill a running tier3-*-run.sh in ONE command, regardless of how deep its
# descendant tree (run-agent-orchestration.sh, spec-mode-runner.js, ai-run.sh,
# `bash foo | tee` pipelines, phase-retry re-invocations) has grown — and REPORT
# HONESTLY if it could not.
#
# Root cause this fixes (2026-07-07 incident): a plain `kill <top-level-pid>`
# only signals that one process. Pipeline components and re-invoked children
# are not necessarily direct children of the PID you killed, so several
# orchestration-loop and ai-run.sh processes kept running independently (and
# billing the gate model) after the run was believed to be stopped.
#
# Each tier3-*-run.sh re-execs itself under `setsid` and writes its own PID
# (== its process-group ID) to TIER3_PID_FILE. Signalling the NEGATIVE of that
# PID reaches every process in the group at once.
#
# B32 (2026-07-25, live metrolinx kill) — three further defects, all of which
# let this script print "Done." and exit 0 while the pipeline ran on, still
# billing LLM calls:
#
#   1. PID_FILE defaulted to the travel-app pidfile. metrolinx writes
#      /tmp/tier3-metrolinx-run.pid, so the process-group kill — the entire
#      point of this script — was skipped silently for every non-travel-app
#      run. Now EVERY /tmp/tier3-*.pid is collected.
#   2. spec-mode-runner.js was missing from the sweep pattern. It runs in its
#      OWN process group, so the group kill cannot reach it either; it survived
#      and kept spawning agents (observed: fresh glm-5.2, glm-5.1 and kimi-k3
#      calls AFTER the "successful" kill). Every process that can outlive its
#      parent must be listed here.
#   3. The sweep was single-pass and unverified. A parent that spawns a new
#      child after the sweep was simply missed. Now we loop until the process
#      set is empty or stops shrinking, then VERIFY — and exit non-zero, naming
#      the survivors, if anything is still alive.
#
# Exit status is the contract: 0 means verified dead. Non-zero means something
# survived and you must look. A kill you cannot trust forces hand-killing PIDs,
# which is precisely what it exists to prevent.
set -uo pipefail

MAX_ROUNDS="${KILL_TIER3_MAX_ROUNDS:-5}"
did_something=0

# EVERY process that can outlive the process-group kill must appear here.
orphan_pattern='orchestrations/scripts/tier3-travel-app-run\.sh|orchestrations/scripts/tier3-metrolinx-run\.sh|orchestrations/scripts/tier3-skyscanner-app-run\.sh|orchestrations/scripts/tier3-mock-run\.sh|orchestrations/scripts/tier3-paid-run\.sh|orchestrations/scripts/orchestrate\.sh|orchestrations/scripts/run-agent-orchestration\.sh|orchestrations/scripts/spec-mode-runner\.js|orchestrations/scripts/ai-run\.sh|orchestrations/scripts/claude\.sh|orchestrations/scripts/brownfield-repro-test-writer\.sh|orchestrations/scripts/team-lead-review\.sh|orchestrations/scripts/post-impl-tc-writer\.sh|orchestrations/scripts/agent-attempt-analyst\.sh|epam run --provider|epam\.js run --provider'

# Our own process group. Group-killing this would take down whatever invoked us —
# a terminal, a CI step, or the test runner. Found immediately after B32 landed:
# the full vitest suite died with SIGTERM (143) because a matched process shared
# the runner's group, so `kill -- -$pgid` killed vitest itself. When a target
# shares our group we signal the PID alone; the group kill is reserved for the
# run's OWN detached setsid group, which is the case it exists for.
SELF_PGID="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"

# Signal one process: whole group when it is safely foreign, else the PID alone.
signal_target() {
  local _pid="$1" _sig="$2" _pgid
  _pgid="$(ps -o pgid= -p "$_pid" 2>/dev/null | tr -d ' ')"
  if [ -n "$_pgid" ] && [ "$_pgid" != "$SELF_PGID" ]; then
    kill "-$_sig" -- "-$_pgid" 2>/dev/null || kill "-$_sig" "$_pid" 2>/dev/null || true
  else
    kill "-$_sig" "$_pid" 2>/dev/null || true
  fi
}

# Optional scope. Unset in production => every matching process, as before.
# Tests set it to their sandbox root so exercising this script cannot reap
# unrelated processes: the sweep pattern legitimately includes pipeline agents
# (agent-attempt-analyst.sh et al), so an unscoped kill inside a PARALLEL test
# suite kills other tests' children — observed as a self-heal test failing with
# a killed child (execFileSync status null) roughly 1 run in 3.
MATCH_ROOT="${KILL_TIER3_MATCH_ROOT:-}"

# Never count this script, its shell, or the pgrep itself as a survivor.
list_survivors() {
  local _lines
  _lines="$(pgrep -af "$orphan_pattern" 2>/dev/null || true)"
  [ -z "$_lines" ] && return 0
  if [ -n "$MATCH_ROOT" ]; then
    _lines="$(printf '%s\n' "$_lines" | grep -F -- "$MATCH_ROOT" || true)"
    [ -z "$_lines" ] && return 0
  fi
  printf '%s\n' "$_lines" | awk '{print $1}' | grep -vx "$$" | grep -vx "${PPID:-0}" || true
}

# ── Process-group kill for every known runner pidfile ────────────────────────
# Explicit TIER3_PID_FILE first (honoured for back-compat), then every
# /tmp/tier3-*.pid — one per runner, so a metrolinx/skyscanner/mock kill works
# without the caller having to know which variable to export.
pid_files=()
if [ -z "$MATCH_ROOT" ]; then
  [ -n "${TIER3_PID_FILE:-}" ] && pid_files+=("$TIER3_PID_FILE")
  for f in /tmp/tier3-*.pid; do [ -f "$f" ] && pid_files+=("$f"); done
fi

for PID_FILE in "${pid_files[@]:-}"; do
  [ -n "$PID_FILE" ] && [ -f "$PID_FILE" ] || continue
  pgid="$(cat "$PID_FILE" 2>/dev/null || echo "")"
  if [ -n "$pgid" ] && kill -0 "$pgid" 2>/dev/null; then
    if [ "$pgid" = "$SELF_PGID" ]; then
      echo "[kill-tier3] Refusing to group-kill our OWN process group ($pgid) — signalling the PID only."
      kill -TERM "$pgid" 2>/dev/null || true; sleep 2; kill -KILL "$pgid" 2>/dev/null || true
    else
      echo "[kill-tier3] Killing process group $pgid (from $PID_FILE)..."
      kill -TERM -- "-$pgid" 2>/dev/null || true
      sleep 2
      kill -KILL -- "-$pgid" 2>/dev/null || true
    fi
    did_something=1
  fi
  rm -f "$PID_FILE"
done

# ── Sweep, repeatedly, until the set stops shrinking ─────────────────────────
# Single-pass was the bug: a surviving parent respawns children the moment the
# sweep finishes. Kill whole process groups, re-check, repeat.
echo "[kill-tier3] Sweeping for orphaned orchestration processes..."
prev_count=-1
for round in $(seq 1 "$MAX_ROUNDS"); do
  survivors="$(list_survivors)"
  [ -z "$survivors" ] && break
  count="$(printf '%s\n' "$survivors" | wc -l | tr -d ' ')"
  [ "$round" -gt 1 ] && echo "[kill-tier3]   round $round: $count still alive"

  # Kill whole process groups where we can — a bare TERM to a parent leaves its
  # children orphaned and running, which is how the last incident spread.
  for p in $survivors; do signal_target "$p" TERM; done
  sleep 1
  for p in $survivors; do signal_target "$p" KILL; done
  did_something=1
  sleep 1

  # Stop early if we are making no progress — better to report than spin.
  [ "$count" = "$prev_count" ] && break
  prev_count="$count"
done

# ── Verify. This is the part that was missing. ───────────────────────────────
sleep 1
remaining="$(list_survivors)"
if [ -n "$remaining" ]; then
  echo "[kill-tier3] ✗ FAILED — these processes SURVIVED the kill and may still be billing:" >&2
  # shellcheck disable=SC2086
  ps -o pid,pgid,etime,args -p $(echo "$remaining" | tr '\n' ' ') 2>/dev/null >&2 || echo "$remaining" >&2
  echo "[kill-tier3] The run is NOT stopped. Investigate before launching anything else." >&2
  exit 1
fi

if [ "$did_something" -eq 1 ]; then
  echo "[kill-tier3] ✓ Done — verified no orchestration processes remain."
else
  echo "[kill-tier3] Nothing was running."
fi
