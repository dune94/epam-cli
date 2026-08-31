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
# BOUNDED BY CONSTRUCTION, NOT BY A WATCHDOG. The first version wrote one shared trace file and
# watched its size. `set -x` prints the whole expanded command after PS4, so the bats suite alone
# produced 2.7GB in minutes — and the watchdog could only NOTICE, not stop the writers, because
# every traced shell already held the descriptor. Truncating a file other processes are appending to
# loses records, and a lost record reads as "this line never ran".
#
# So nothing keeps the raw trace. Each shell writes to its OWN file named for its pid, and a
# compactor reduces each one to unique `file:line` pairs and deletes it — but only once that pid has
# exited, so there is no truncation race with a live writer. What survives is a set of roughly
# thirty thousand short lines, whatever the suites do.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

NODE_BIN="${NODE_BIN:-$(command -v node)}"
WORK="${SHELL_COVERAGE_WORK:-${TMPDIR:-/tmp}/shell-coverage-$$}"
TRACES="$WORK/traces"
UNIQ="$WORK/uniq"
ENABLER="$WORK/trace-on.sh"
OUT="${SHELL_COVERAGE_OUT:-$ROOT/coverage/lcov.shell.info}"
# A single process producing more than this is looping, not testing. Its own file is dropped and
# named, rather than the whole collection being silently truncated.
PER_PROC_CAP_MB="${SHELL_COVERAGE_PER_PROC_CAP_MB:-64}"

mkdir -p "$WORK" "$TRACES" "$(dirname "$OUT")"
: > "$UNIQ"

# Sourced by EVERY non-interactive bash, including ones this repo does not own, so it must be inert
# when unwanted and must never fail a shell that sources it. Each shell gets its OWN file: no shared
# writer, no truncation race, and a runaway process can be dropped on its own.
cat > "$ENABLER" <<'ENABLER_EOF'
if [ -n "${SHCOV_TRACES:-}" ] && [ -z "${SHCOV_OFF:-}" ]; then
  exec 9>>"$SHCOV_TRACES/$$.trace" 2>/dev/null || true
  BASH_XTRACEFD=9
  PS4='@@${BASH_SOURCE}:${LINENO}@@
'
  set -x
fi
ENABLER_EOF

# THE COMPACTOR. A trace file is only touched once its owning pid is gone, so a live writer is never
# read out from under. Everything it yields is a short `file:line` string, deduplicated on the spot.
compact() {
    local _f _pid _sz
    for _f in "$TRACES"/*.trace; do
        [ -e "$_f" ] || continue
        _pid="$(basename "$_f" .trace)"
        _sz=$(( $(stat -c %s "$_f" 2>/dev/null || echo 0) / 1048576 ))
        if [ "$_sz" -ge "$PER_PROC_CAP_MB" ] && kill -0 "$_pid" 2>/dev/null; then
            echo "[shell-coverage] pid $_pid produced ${_sz}MB of trace — dropping it; a single shell that large is looping, not testing" >&2
            : > "$_f"
            continue
        fi
        kill -0 "$_pid" 2>/dev/null && continue   # still writing; leave it alone
        grep -o '@@[^@]*@@' "$_f" 2>/dev/null | sort -u >> "$UNIQ"
        rm -f "$_f"
    done
    if [ -s "$UNIQ" ]; then
        sort -u "$UNIQ" -o "$UNIQ"
    fi
}

( while sleep 5; do [ -d "$TRACES" ] || break; compact; done ) & COMPACTOR=$!

echo "[shell-coverage] tracing into $TRACES (per-process, compacted continuously)"

run_suite() {
    local _label="$1"; shift
    echo "[shell-coverage] running $_label"
    SHCOV_TRACES="$TRACES" BASH_ENV="$ENABLER" "$@" >"$WORK/$_label.log" 2>&1
    echo "[shell-coverage] $_label exited $? (output: $WORK/$_label.log)"
    compact
}

# BOTH SUITES, because both execute shell. bats runs the .bats cases directly; the vitest suite
# spawns bash for nearly every pipeline test it has, and those are real executions of real scripts —
# exactly the lines this is meant to measure.
run_suite bats bash "$ROOT/orchestrations/scripts/run-shell-tests.sh"
run_suite vitest "$NODE_BIN" "$ROOT/node_modules/.bin/vitest" run

kill "$COMPACTOR" 2>/dev/null || true
sleep 1
compact

echo "[shell-coverage] $(wc -l < "$UNIQ") unique traced lines, $(du -sh "$UNIQ" | cut -f1) on disk"

"$NODE_BIN" "$ROOT/orchestrations/scripts/lib/handlers/shell-trace-to-lcov.js" "$UNIQ" "$OUT" || exit $?
echo "[shell-coverage] wrote $OUT"
