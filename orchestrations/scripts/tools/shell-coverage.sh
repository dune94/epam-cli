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
# No per-process cap: every pass consumes the bytes it has read, so a long-running shell costs the
# same as a short one and nothing legitimate is ever discarded.

OFFSETS="$WORK/offsets"
mkdir -p "$WORK" "$TRACES" "$OFFSETS" "$(dirname "$OUT")"
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

# THE COMPACTOR, READING FORWARD ONLY.
#
# An appending writer never rewrites bytes it has already written, so a live trace can be read from
# where the last pass stopped — no truncation, no race, and nothing dropped. The first version
# instead DROPPED any process whose file grew past a cap, which threw away the coverage of exactly
# the long-running test shells that exercise the most code: three were discarded at 87MB, 85MB and
# 68MB, and those were tests doing their job, not loops.
#
# Disk stays bounded because every pass consumes the new bytes and only the unique `file:line` pairs
# are kept. A file is deleted once its owning pid is gone and its tail has been read.
compact() {
    local _f _pid _size _off _offfile
    for _f in "$TRACES"/*.trace; do
        [ -e "$_f" ] || continue
        _pid="$(basename "$_f" .trace)"
        _offfile="$OFFSETS/$_pid"
        _off=0; [ -s "$_offfile" ] && _off="$(cat "$_offfile" 2>/dev/null || echo 0)"
        _size="$(stat -c %s "$_f" 2>/dev/null || echo 0)"
        if [ "$_size" -gt "$_off" ]; then
            tail -c "+$((_off + 1))" "$_f" 2>/dev/null \
                | grep -o '@@[^@]*@@' 2>/dev/null | sort -u >> "$UNIQ"
            printf '%s' "$_size" > "$_offfile"
        fi
        if ! kill -0 "$_pid" 2>/dev/null; then
            rm -f "$_f" "$_offfile"
        fi
    done
    [ -s "$UNIQ" ] && sort -u "$UNIQ" -o "$UNIQ"
    return 0
}

( while sleep 5; do [ -d "$TRACES" ] || break; compact; done ) & COMPACTOR=$!

echo "[shell-coverage] tracing into $TRACES (per-process, compacted continuously)"

run_suite() {
    # DIAGNOSTICS GO TO STDERR. A function's stdout is its return value the moment anyone captures
    # it, and a bracketed progress line inside a captured value is a defect this repo has paid for
    # before.
    local _label="$1"; shift
    echo "[shell-coverage] running $_label" >&2
    SHCOV_TRACES="$TRACES" BASH_ENV="$ENABLER" "$@" >"$WORK/$_label.log" 2>&1
    echo "[shell-coverage] $_label exited $? (output: $WORK/$_label.log)" >&2
    compact
}

# BOTH SUITES, because both execute shell. bats runs the .bats cases directly; the vitest suite
# spawns bash for nearly every pipeline test it has, and those are real executions of real scripts —
# exactly the lines this is meant to measure.
run_suite bats bash "$ROOT/orchestrations/scripts/run-shell-tests.sh"
# ONLY THE TESTS THAT ACTUALLY SPAWN BASH.
#
# Tracing the WHOLE vitest suite cost ~800s to measure shell, and most of it cannot contribute a
# single traced line: test/unit/agent, test/unit/providers and the rest are pure TypeScript that
# never starts a shell. Scoping to the directories whose tests execute pipeline scripts collects the
# same shell coverage for a fraction of the wall clock.
#
# SCOPE IS DISCOVERED, NOT LISTED. A directory qualifies if any test in it spawns bash — grep decides,
# so a new directory that starts executing scripts is measured without anyone remembering to add it.
mapfile -t _shell_test_dirs < <(
    grep -rl -e "spawnSync('bash'" -e 'spawnSync("bash"' -e "execFileSync('bash'" -e 'execFileSync("bash"' \
        --include='*.ts' "$ROOT/test" 2>/dev/null \
    | sed "s|$ROOT/||" | xargs -r -n1 dirname | sort -u
)
if [ "${#_shell_test_dirs[@]}" -eq 0 ]; then
    echo "[shell-coverage] no test directory spawns bash — refusing to report a shell coverage of zero, which would be the collector's failure, not the suite's" >&2
    exit 5
fi
echo "[shell-coverage] tracing ${#_shell_test_dirs[@]} test directories that spawn bash" >&2
# Bounded workers: the collector once drove a 13GB box into swap.
run_suite vitest "$NODE_BIN" "$ROOT/node_modules/.bin/vitest" run \
    --maxWorkers="${SHELL_COVERAGE_WORKERS:-2}" "${_shell_test_dirs[@]}"

kill "$COMPACTOR" 2>/dev/null || true
sleep 1
compact

echo "[shell-coverage] $(wc -l < "$UNIQ") unique traced lines, $(du -sh "$UNIQ" | cut -f1) on disk"

"$NODE_BIN" "$ROOT/orchestrations/scripts/lib/handlers/shell-trace-to-lcov.js" "$UNIQ" "$OUT" || exit $?
echo "[shell-coverage] wrote $OUT"
