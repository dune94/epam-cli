#!/usr/bin/env bash
#
# RUN THE .bats SUITE, AND REFUSE TO REPORT SUCCESS FOR TESTS THAT DID NOT RUN.
#
# 28 .bats files sat in this repo executing nothing. `bats` on this machine exits 0 while running
# zero tests — its wrapper loses BATS_LIBEXEC, so the inner runner cannot find bats-exec-test and
# every file "passes" in silence. Nothing in package.json, vitest.config.ts or the shard runner
# referenced .bats at all, so the failure had no way to surface either.
#
# Among the files that never ran: the hardcoding audit's own calibration tests — the ones that prove
# each category can still SEE. A detector that goes blind and a test suite that cannot notice is the
# pairing this whole audit exists to prevent.
#
# So this runner treats "planned N, executed 0" as a FAILURE, not a pass. A test that did not run is
# not a test that succeeded, and an exit code that says otherwise is worse than no runner at all.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

mapfile -t FILES < <(find test -name '*.bats' -type f | sort)
if [ "${#FILES[@]}" -eq 0 ]; then
    echo "[shell-tests] no .bats files found — nothing to run" >&2
    exit 0
fi

if ! command -v bats >/dev/null 2>&1; then
    echo "[shell-tests] bats is not installed — ${#FILES[@]} shell test file(s) CANNOT run." >&2
    echo "[shell-tests] Reporting failure rather than silence: install bats-core, or remove the files." >&2
    exit 2
fi

_planned=0 _ran=0 _failed=0 _files_ok=0 _files_bad=0
for f in "${FILES[@]}"; do
    out=$(bats --tap "$f" 2>&1)
    # TAP: "1..N" is the plan; each "ok"/"not ok" is a test that actually executed.
    # THE FILE'S OWN @test COUNT IS THE TRUTH, not the plan the runner prints.
    #
    # A first version of this trusted the TAP plan — and `bats` here prints NO plan at all, so
    # "planned 0, executed 0" read as success and 57 files passed having run nothing. The same
    # silent pass this runner was written to end, reintroduced inside it within the hour.
    declared=$(grep -cE '^[[:space:]]*@test[[:space:]]' "$f" || true)
    p=$(printf '%s\n' "$out" | sed -n 's/^1\.\.\([0-9]\+\)$/\1/p' | head -1)
    p=${p:-$declared}
    r=$(printf '%s\n' "$out" | grep -cE '^(ok|not ok) ' || true)
    n=$(printf '%s\n' "$out" | grep -cE '^not ok ' || true)
    _planned=$(( _planned + ${p:-0} )); _ran=$(( _ran + r )); _failed=$(( _failed + n ))
    if [ "${declared:-0}" -gt 0 ] && [ "$r" -eq 0 ]; then
        echo "[shell-tests] ✗ $f — declares ${declared} @test(s), executed 0 (the runner is not running them)" >&2
        _files_bad=$(( _files_bad + 1 ))
    elif [ "$n" -gt 0 ]; then
        echo "[shell-tests] ✗ $f — ${n} failing of ${r}" >&2
        printf '%s\n' "$out" | grep -E '^not ok |^# ' | head -12 >&2
        _files_bad=$(( _files_bad + 1 ))
    else
        _files_ok=$(( _files_ok + 1 ))
    fi
done

echo "[shell-tests] files ok=${_files_ok} bad=${_files_bad}  tests planned=${_planned} executed=${_ran} failed=${_failed}"
if [ "$_files_bad" -gt 0 ]; then exit 1; fi
# Planned but never executed, in aggregate: the silent case this runner exists for.
if [ "$_planned" -gt 0 ] && [ "$_ran" -eq 0 ]; then
    echo "[shell-tests] ${_planned} test(s) were planned and NONE executed — treating as failure." >&2
    exit 1
fi
exit 0
