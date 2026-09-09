# cassette-watch-control.sh — start/stop orchestrations/scripts/cassette-watch.js, ONE place.
#
# THE HARVEST MUST OUTLIVE THE RUN. run-agent-orchestration.sh's EXIT trap covers every exit bash
# controls, but `kill -9` and an OOM kill run no trap — and those are exactly how this project lost
# recordings. Langfuse already holds a dying run's turns; something still alive has to fetch them.
#
# So this belongs to the INSTALL's lifetime, not a run's: started when services come up, stopped by
# uninstall. Same host-process class and the same daemonize shape as snapshot-watch-control.sh.
#
# It needs the Langfuse credentials the pipeline already uses to WRITE traces, and the cassette
# directory. Both come from the install's own environment — nothing is guessed here, and a watcher
# with no cassette directory refuses to start rather than inventing one.

# start_cassette_watch <root>
start_cassette_watch() {
    local _root="$1"
    local _script="$_root/orchestrations/scripts/cassette-watch.js"
    [ -f "$_script" ] || return 0
    local _pidfile="$_root/orchestrations/dashboards/.cassette-watch.pid"
    local _log="$_root/orchestrations/dashboards/.cassette-watch.log"
    local _old_pid=""
    [ -f "$_pidfile" ] && _old_pid="$(cat "$_pidfile" 2>/dev/null)"
    if [ -n "$_old_pid" ] && kill -0 "$_old_pid" 2>/dev/null; then
        _ok "already running (pid $_old_pid)"
        return 0
    fi

    local _daemonize="setsid"
    command -v setsid >/dev/null 2>&1 || _daemonize=""

    ( exec </dev/null >>"$_log" 2>&1
      export EPAM_CASSETTE_DIR="${EPAM_CASSETTE_DIR:-$_root/orchestrations/cassettes}"
      exec $_daemonize "${NODE_BIN:-node}" "$_script" "${EPAM_CASSETTE_WATCH_INTERVAL:-60}" ) &
    echo $! > "$_pidfile"
    sleep 0.3
    local _new_pid
    _new_pid="$(cat "$_pidfile" 2>/dev/null)"
    if [ -n "$_new_pid" ] && kill -0 "$_new_pid" 2>/dev/null; then
        _ok "started (pid $_new_pid, log: $_log)"
        return 0
    fi
    _bad "cassette-watch failed to start — see $_log"
    return 1
}

# stop_cassette_watch <root>
stop_cassette_watch() {
    local _root="$1"
    local _pidfile="$_root/orchestrations/dashboards/.cassette-watch.pid"
    [ -f "$_pidfile" ] || return 0
    local _pid
    _pid="$(cat "$_pidfile" 2>/dev/null)"
    if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then
        kill "$_pid" 2>/dev/null
        rm -f "$_pidfile"
        return 0
    fi
    rm -f "$_pidfile"
    return 1
}
