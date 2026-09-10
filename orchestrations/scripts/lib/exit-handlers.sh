# exit-handlers.sh — AN EXIT HANDLER IS ADDED, NEVER REPLACED.
#
# bash keeps exactly ONE EXIT trap. `trap X EXIT` does not add a handler, it REPLACES the one
# already there, silently and with no diagnostic. run-agent-orchestration.sh registered three:
#
#     trap '_release_write_perimeter' EXIT      the write perimeter, reopened
#     trap cleanup EXIT                         worktree cleanup + the cassette export
#     trap 'kill "$_HEARTBEAT_PID" ...' EXIT    the heartbeat killer
#
# and only the LAST survived. Proven live on 2026-09-10 (openrouter run 20260910T222155Z): the run
# paused, reported "Pipeline complete", archived no cassette, and cleanup() emitted not one line —
# though export_run_cassette announces every outcome by design. Three safety mechanisms gone, in
# silence, because the third registration ate the first two.
#
# This also defeated the morning's fix (1f653762), whose comment claimed a trap "cannot be forgotten
# by whoever writes the next `exit`". True of an `exit`; false of the next `trap ... EXIT`.
#
# ONE TRAP, MANY HANDLERS. Handlers run in registration order, each in a subshell-free call so it
# can read the run's variables, and a handler that fails does not stop the ones after it — a
# cleanup that throws must not take the cassette export down with it. The exit status is captured
# once, before any handler runs, and restored after, so nothing here can change what the run
# reports.

_EPAM_EXIT_HANDLERS=""

# add_exit_handler <function-or-command>
add_exit_handler() {
    local _h="${1:-}"
    [ -n "$_h" ] || return 0
    case ":${_EPAM_EXIT_HANDLERS}:" in
        *":${_h}:"*) return 0 ;;   # already registered; adding twice would run it twice
    esac
    _EPAM_EXIT_HANDLERS="${_EPAM_EXIT_HANDLERS:+${_EPAM_EXIT_HANDLERS}:}${_h}"
    # Register the ONE trap the first time a handler is added, never again.
    trap _epam_run_exit_handlers EXIT
}

_epam_run_exit_handlers() {
    local _rc=$?
    local _old_ifs="$IFS"; IFS=':'
    local _h
    for _h in ${_EPAM_EXIT_HANDLERS}; do
        [ -n "$_h" ] || continue
        # `|| true`: one handler's failure must not skip the rest, and must not change the status.
        eval "$_h" || true
    done
    IFS="$_old_ifs"
    return $_rc
}
