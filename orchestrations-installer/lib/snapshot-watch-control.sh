# snapshot-watch-control.sh — start/stop orchestrations/scripts/snapshot-watch.js, ONE place.
#
# A host process, same class as runner-host.js: it writes orchestrations/dashboards/live/
# build-info.json on the HOST filesystem, which agent-monitor's nginx container only reads via a
# bind mount — nothing about it belongs inside a container. Without it, pre-flight fails 3 checks
# every time ("snapshot-watch.js is NOT running", the nginx mount unreachable, build-info.json
# stale) — found live 2026-09-04 against a genuinely fresh install.
#
# Same daemonize shape as runner-host-control.sh (setsid, exec-based fd cleanup, idempotent
# pidfile) — kept as its own small file rather than force-sharing one generic helper, since the
# two processes need different environments and this stays simple to read either way.

# start_snapshot_watch <root>
start_snapshot_watch() {
    local _root="$1"
    local _script="$_root/orchestrations/scripts/snapshot-watch.js"
    [ -f "$_script" ] || return 0
    local _pidfile="$_root/orchestrations/dashboards/.snapshot-watch.pid"
    local _log="$_root/orchestrations/dashboards/.snapshot-watch.log"
    local _old_pid=""
    [ -f "$_pidfile" ] && _old_pid="$(cat "$_pidfile" 2>/dev/null)"
    if [ -n "$_old_pid" ] && kill -0 "$_old_pid" 2>/dev/null; then
        _ok "already running (pid $_old_pid)"
        return 0
    fi

    local _daemonize="setsid"
    command -v setsid >/dev/null 2>&1 || _daemonize=""

    ( exec </dev/null >>"$_log" 2>&1
      exec $_daemonize "${NODE_BIN:-node}" "$_script" ) &
    echo $! > "$_pidfile"
    sleep 0.3
    local _new_pid
    _new_pid="$(cat "$_pidfile" 2>/dev/null)"
    if [ -n "$_new_pid" ] && kill -0 "$_new_pid" 2>/dev/null; then
        _ok "started (pid $_new_pid, log: $_log)"
        return 0
    fi
    _bad "snapshot-watch failed to start — see $_log"
    return 1
}

# stop_snapshot_watch <root>
stop_snapshot_watch() {
    local _root="$1"
    local _pidfile="$_root/orchestrations/dashboards/.snapshot-watch.pid"
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
