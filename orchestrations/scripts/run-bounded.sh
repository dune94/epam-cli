#!/usr/bin/env bash
# NOTHING THIS REPO LAUNCHES MAY TAKE THE MACHINE.
#
# Twice in one day a process started here consumed the host: an unsharded vitest run (1,198 files,
# no per-worker heap ceiling) and a MockServer container started ad-hoc with no memory limit and a
# JVM entitled to 75% of RAM, which grew to 7.1GB of a 14GB box. Both were bounded by nothing, so
# both ran until the OS chose a victim — and on WSL the victim is the whole environment, taking
# docker, Langfuse and the user's session with it.
#
# The rule is not "be careful". A long-running command is placed in its own cgroup scope with a
# memory ceiling, so exceeding it kills THE COMMAND and names it, leaving the machine alone.
#
#   run-bounded.sh [--share N] -- <command> [args...]
#
# The ceiling is a SHARE OF THE MACHINE, read at launch — a bigger box grants more, a smaller one
# less, and no number is frozen here. MemoryHigh throttles first (reclaim, not death) so a command
# that merely spikes is slowed rather than killed; MemoryMax is the hard stop behind it.
set -uo pipefail

_share="${EPAM_BOUNDED_SHARE:-40}"          # percent of total RAM this command may use
_high_pct=80                                # MemoryHigh as a percent of the ceiling
_oom_policy=""                              # the scope's OOMPolicy; empty = systemd's default
# --high-pct 100 is NO THROTTLE BAND: the command is stopped at the ceiling instead of slowed below it.
# With swap bounded to 0, a process past MemoryHigh cannot be reclaimed, so it is throttled
# indefinitely — an agent's `node` allocating past it froze at 1536MB and its call hung until the
# caller's timeout (real copilot call, 2026-10-05). Where a stopped command is the right outcome
# (an agent's tool command: the agent sees it fail and carries on), the caller asks for 100.
while [ $# -gt 0 ]; do
    case "$1" in
        --share)    _share="$2"; shift 2 ;;
        --high-pct) _high_pct="$2"; shift 2 ;;
        # --oom-policy continue: the OOM killer takes the one process over the ceiling and the scope
        # carries on. The scope default (stop) ended the whole unit — the agent with its command —
        # so the agent never saw the failure and answered nothing (real copilot call, 2026-10-05).
        --oom-policy) _oom_policy="$2"; shift 2 ;;
        --)         shift; break ;;
        *)          break ;;
    esac
done
[ $# -eq 0 ] && { echo "usage: run-bounded.sh [--share N] [--high-pct N] -- <command> [args...]" >&2; exit 2; }

_total_kb="$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
if [ "${_total_kb:-0}" -le 0 ]; then
    echo "[bounded] cannot read MemTotal — refusing to launch unbounded" >&2
    exit 1
fi
_max_mb=$(( _total_kb / 1024 * _share / 100 ))
_high="$(( _max_mb * _high_pct / 100 ))M"
[ "$_high_pct" -ge 100 ] && _high=infinity

if command -v systemd-run >/dev/null 2>&1 && [ -d /sys/fs/cgroup ]; then
    echo "[bounded] ${_share}% of $(( _total_kb / 1024 ))MB -> MemoryHigh=${_high} MemoryMax=${_max_mb}M : $*" >&2
    # SWAP IS BOUNDED TOO, OR THE CEILING IS ADVISORY.
    #
    # Proven here: a process told to allocate 4GB under a 698MB ceiling allocated all of it. The
    # host never grew — the cgroup held — but the pages went to swap, so the run continued,
    # thrashing, instead of failing. A limit a process can walk around by swapping is a slowdown,
    # not a limit, and a thrashing run is the hang that wastes the operator's time.
    # HOME IS RESTORED EXPLICITLY, BECAUSE THE SCOPE RESETS IT.
    #
    # systemd-run --user --scope sets HOME to the login user's own directory. A free run isolates
    # HOME precisely so ~/.claude/.credentials.json does not exist for it — OAuth on disk is a
    # second, independent credential path, and a mock BASE_URL only out-prefers it. So wrapping a
    # rehearsal in this scope silently handed back the ability to spend real money, and the only
    # thing still standing between the two was a redirect. Proven here: the inner command saw the
    # real home while every other variable survived intact.
    #
    # Every caller-set variable is preserved; HOME is named because it is the one the scope takes.
    #
    # BOUND TO THE CALLER'S SCOPE when it runs in one (a run launched bounded): stopping or killing the
    # run stops this scope too, so nothing it started outlives it (an agent call's own scope, 2026-10-05).
    _bind=()
    _caller="$(basename "$(cut -d: -f3 /proc/self/cgroup 2>/dev/null | head -1)")"
    case "$_caller" in *.scope) _bind=(-p "BindsTo=$_caller" -p "After=$_caller") ;; esac
    [ -n "$_oom_policy" ] && _bind+=(-p "OOMPolicy=$_oom_policy")
    exec systemd-run --user --scope --quiet --collect \
        -p MemoryHigh="${_high}" -p MemoryMax="${_max_mb}M" -p MemorySwapMax=0 \
        ${_bind[@]+"${_bind[@]}"} \
        --setenv=HOME="$HOME" \
        -- "$@"
fi

# NO CGROUPS AVAILABLE: say so rather than pretending. An unbounded run is a decision the operator
# makes knowingly, never one this script makes silently on their behalf.
echo "[bounded] systemd-run/cgroups unavailable — cannot bound '$1'." >&2
echo "[bounded] Set EPAM_BOUNDED_ALLOW_UNBOUNDED=1 to run it anyway." >&2
[ "${EPAM_BOUNDED_ALLOW_UNBOUNDED:-0}" = "1" ] || exit 1
exec "$@"
