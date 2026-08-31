#!/usr/bin/env bash
#
# MEASURE WHAT THE SHELL HALF OF THIS ENGINE ACTUALLY RUNS.
#
# 138 files and 28,558 code lines are bash. The JS instrument sees none of them, so before this they
# all counted as wholly uncovered and no shell-heavy stage could clear any threshold, however many
# tests were written. Shell is not untestable — bats runs here, and the vitest suite spawns bash
# hundreds of times. What was missing was the conversion from "those runs happened" to "these lines
# executed".
#
# HOW: BASH_ENV names a file every non-interactive bash sources at startup. It points BASH_XTRACEFD
# at a private descriptor, sets PS4 to carry ${BASH_SOURCE}:${LINENO}, and turns xtrace on. The trace
# lands in its own file, NOT stderr, so nothing under test sees output it would not normally see.
#
# BOUNDED BEFORE IT STARTS. A full xtrace of both suites is large, so the trace file is capped and
# the cap is enforced by the collector itself rather than hoped for. Exceeding it is reported, never
# silently truncated mid-record.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

NODE_BIN="${NODE_BIN:-$(command -v node)}"
WORK="${SHELL_COVERAGE_WORK:-${TMPDIR:-/tmp}/shell-coverage-$$}"
TRACE="$WORK/trace"
ENABLER="$WORK/trace-on.sh"
OUT="${SHELL_COVERAGE_OUT:-$ROOT/coverage/lcov.shell.info}"
# Cap in megabytes. A trace bigger than this means something is looping, and an unbounded file here
# once filled a disk during a run.
CAP_MB="${SHELL_COVERAGE_CAP_MB:-2048}"

mkdir -p "$WORK" "$(dirname "$OUT")"
: > "$TRACE"

# The enabler is sourced by EVERY non-interactive bash, including ones this repo does not own, so it
# must be inert when the trace is not wanted and must never fail a shell that sources it.
cat > "$ENABLER" <<'ENABLER_EOF'
if [ -n "${SHCOV_TRACE:-}" ] && [ -z "${SHCOV_OFF:-}" ]; then
  exec 9>>"$SHCOV_TRACE" 2>/dev/null || true
  BASH_XTRACEFD=9
  PS4='@@${BASH_SOURCE}:${LINENO}@@
'
  set -x
fi
ENABLER_EOF

echo "[shell-coverage] tracing into $TRACE (cap ${CAP_MB}MB)"

# The watchdog is the bound. Without it a runaway trace fills the disk, and a truncated-by-accident
# trace reads as "these lines were never run" — a coverage result that is really a full disk.
(
  while sleep 10; do
    [ -f "$TRACE" ] || break
    sz=$(( $(stat -c %s "$TRACE" 2>/dev/null || echo 0) / 1048576 ))
    if [ "$sz" -ge "$CAP_MB" ]; then
      echo "[shell-coverage] TRACE HIT THE ${CAP_MB}MB CAP — stopping collection. The result is partial and must not be read as coverage." >&2
      : > "$WORK/.capped"
      break
    fi
  done
) & WATCHDOG=$!

run_suite() {
    local _label="$1"; shift
    echo "[shell-coverage] running $_label"
    SHCOV_TRACE="$TRACE" BASH_ENV="$ENABLER" "$@" >"$WORK/$_label.log" 2>&1
    echo "[shell-coverage] $_label exited $? (output: $WORK/$_label.log)"
}

# BOTH SUITES, because both execute shell. bats runs the .bats cases directly; the vitest suite
# spawns bash for nearly every pipeline test it has, and those runs are real executions of real
# scripts — exactly the lines this is meant to measure.
run_suite bats bash "$ROOT/orchestrations/scripts/run-shell-tests.sh"
run_suite vitest "$NODE_BIN" "$ROOT/node_modules/.bin/vitest" run

kill "$WATCHDOG" 2>/dev/null || true

if [ -f "$WORK/.capped" ]; then
    echo "[shell-coverage] REFUSING to emit lcov from a capped trace: a partial trace reports lines as never-run when they simply were not recorded." >&2
    exit 4
fi

"$NODE_BIN" "$ROOT/orchestrations/scripts/lib/handlers/shell-trace-to-lcov.js" "$TRACE" "$OUT" || exit $?
echo "[shell-coverage] wrote $OUT"
