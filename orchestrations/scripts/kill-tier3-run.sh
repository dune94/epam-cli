#!/usr/bin/env bash
# Kill a running tier3-travel-app-run.sh in ONE command, regardless of how
# deep its descendant tree (run-agent-orchestration.sh, ai-run.sh, `bash foo |
# tee` pipelines, phase-retry re-invocations) has grown.
#
# Root cause this fixes (2026-07-07 incident): a plain `kill <top-level-pid>`
# only signals that one process. Pipeline components and re-invoked children
# are not necessarily direct children of the PID you killed, so several
# orchestration-loop and ai-run.sh processes kept running independently (and
# billing the gate model) after the run was believed to be stopped — required
# manually hunting down orphans across several `pgrep`/`kill` rounds.
#
# tier3-travel-app-run.sh now re-execs itself under `setsid` and writes its
# own PID (== its process-group ID) to TIER3_PID_FILE. Sending the signal to
# the NEGATIVE of that PID reaches every process in the group at once. This
# script also sweeps for orphaned processes matching the known script names,
# to catch stragglers from runs started before this fix existed (no pidfile),
# or a stale/missing pidfile.
set -uo pipefail

PID_FILE="${TIER3_PID_FILE:-/tmp/tier3-travel-app-run.pid}"
did_something=0

if [ -f "$PID_FILE" ]; then
  pgid="$(cat "$PID_FILE" 2>/dev/null || echo "")"
  if [ -n "$pgid" ] && kill -0 "$pgid" 2>/dev/null; then
    echo "[kill-tier3] Killing process group $pgid (from $PID_FILE)..."
    kill -TERM -- "-$pgid" 2>/dev/null || true
    sleep 2
    kill -KILL -- "-$pgid" 2>/dev/null || true
    did_something=1
  fi
  rm -f "$PID_FILE"
fi

echo "[kill-tier3] Sweeping for orphaned orchestration processes (pre-fix runs, stragglers)..."
# Found live 2026-07-12: claude.sh (the per-story implementation loop) and its
# `epam run` subprocess are NOT direct descendants reached by the process-
# group kill above when the run was launched without going through whatever
# triggers tier3-travel-app-run.sh's own setsid/pidfile write (e.g. a plain
# `nohup ... &` launch) — no pidfile exists, so only this sweep runs, and it
# used to miss these two, leaving them running (and billing) after the "kill"
# reported success.
orphan_pattern='orchestrations/scripts/tier3-travel-app-run\.sh|orchestrations/scripts/run-agent-orchestration\.sh|orchestrations/scripts/ai-run\.sh|orchestrations/scripts/claude\.sh|epam run --provider'
orphans="$(pgrep -f "$orphan_pattern" 2>/dev/null || true)"
if [ -n "$orphans" ]; then
  echo "$orphans" | xargs -r kill -TERM 2>/dev/null || true
  sleep 2
  orphans="$(pgrep -f "$orphan_pattern" 2>/dev/null || true)"
  if [ -n "$orphans" ]; then
    echo "$orphans" | xargs -r kill -KILL 2>/dev/null || true
  fi
  did_something=1
fi

if [ "$did_something" -eq 1 ]; then
  echo "[kill-tier3] Done."
else
  echo "[kill-tier3] Nothing was running."
fi
