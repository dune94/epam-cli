#!/usr/bin/env bash
# demo-mode.sh — Point dashboards at the canned demo log snapshot.
# Usage: bash scripts/demo-mode.sh [on|off]
#
# "on"  — symlinks orchestrations/logs → demo/logs (dashboards render without a live run)
# "off" — restores the real orchestrations/logs directory
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
LOGS_DIR="$ROOT/orchestrations/logs"
DEMO_LOGS="$ROOT/demo/logs"
BACKUP="$ROOT/orchestrations/logs.real"

MODE="${1:-on}"

if [[ "$MODE" == "on" ]]; then
  if [[ -L "$LOGS_DIR" ]]; then
    echo "[demo-mode] Already in demo mode (logs is a symlink)."
    exit 0
  fi
  if [[ ! -d "$DEMO_LOGS" ]]; then
    echo "[demo-mode] ERROR: demo/logs not found. Run from the repo root." >&2
    exit 1
  fi
  mv "$LOGS_DIR" "$BACKUP"
  ln -s "$DEMO_LOGS" "$LOGS_DIR"
  echo "[demo-mode] ON — dashboards now reading from demo/logs/"
  echo "            Run 'bash scripts/demo-mode.sh off' to restore live logs."

elif [[ "$MODE" == "off" ]]; then
  if [[ ! -L "$LOGS_DIR" ]]; then
    echo "[demo-mode] Not in demo mode (logs is a real directory)."
    exit 0
  fi
  rm "$LOGS_DIR"
  mv "$BACKUP" "$LOGS_DIR"
  echo "[demo-mode] OFF — dashboards restored to live logs."

else
  echo "Usage: bash scripts/demo-mode.sh [on|off]" >&2
  exit 1
fi
