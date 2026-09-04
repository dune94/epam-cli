# runner-host-control.sh — start/stop the host process that launches pipeline runs, ONE place.
#
# Extracted from install.sh so --uninstall, install.sh's own first-install path, and
# pipeline-services.sh (start/stop without touching docker or files) all share exactly the same
# logic — three independent copies of "how do I daemonize this" is how they drift.
#
# Requires from the caller: NODE_BIN set, and the _ok/_warn/_bad helpers already defined
# (install.sh's own convention, reused rather than redeclared here).

# start_runner_host <root> <launch_dir>
#
# Idempotent: does nothing (reports "already running") if a live process already owns the
# pidfile. NOT dockerized, deliberately — see runner-host.js's own header: "a container cannot
# exec a host process." It needs git access to the real codeline root, the claude/codemie-claude
# CLI's host auth, and host git credentials for anything that pushes.
start_runner_host() {
    local _root="$1" _launch_dir="$2"
    local _pidfile="$_launch_dir/.runner-host.pid"
    local _log="$_launch_dir/.runner-host.log"
    local _envfile="$_launch_dir/.runner-host.env-fingerprint"

    # THE ENVIRONMENT A DAEMON IS RUNNING WITH IS PART OF WHETHER IT IS "ALREADY RUNNING".
    #
    # This returned "already running" on any live pid and never asked what that process was
    # running WITH. A daemon started before the operator filled in .env therefore kept its empty
    # values forever, and re-running install.sh — the only sanctioned way to repair an environment
    # ("installer must do all restarts", operator 2026-09-04) — could never fix it.
    #
    # Live pipeline-tests-11: install.sh creates .env from .env.example (blank), starts
    # runner-host, the operator fills in LANGFUSE_SECRET_KEY/PUBLIC_KEY, and the daemon still held
    # "" for both. runner-host.js's langfuse passthrough forwarded nothing, every
    # launch-dashboard-triggered run traced to nothing, and the installer reported a clean healthy
    # install throughout.
    #
    # A FINGERPRINT, NOT A DIFF OF THE FILES: what matters is the environment this function would
    # hand the daemon, which is both .env files as they are RIGHT NOW. Same fingerprint = same
    # daemon, so idempotency is preserved exactly (a second install.sh with nothing changed still
    # spawns nothing). Different fingerprint = the running daemon cannot be the one this install
    # would produce, so it is replaced.
    local _fingerprint
    _fingerprint="$( { [ -f "$_root/.env" ] && cat "$_root/.env"; \
                       [ -f "$_launch_dir/.env" ] && cat "$_launch_dir/.env"; } 2>/dev/null \
                     | cksum | cut -d' ' -f1)"

    local _old_pid=""
    [ -f "$_pidfile" ] && _old_pid="$(cat "$_pidfile" 2>/dev/null)"
    if [ -n "$_old_pid" ] && kill -0 "$_old_pid" 2>/dev/null; then
        local _old_fingerprint=""
        [ -f "$_envfile" ] && _old_fingerprint="$(cat "$_envfile" 2>/dev/null)"
        if [ "$_old_fingerprint" = "$_fingerprint" ]; then
            _ok "already running (pid $_old_pid)"
            return 0
        fi
        # STOPPED THROUGH THE SAME FUNCTION THE UNINSTALLER USES, so there is one way a daemon
        # dies. Reported, never silent: an operator who filled in a credential needs to see that
        # the thing holding the old one was actually replaced.
        stop_runner_host "$_launch_dir" >/dev/null 2>&1 || true
        _ok "restarting runner-host (pid $_old_pid) — its .env has changed since it started"
    fi

    # setsid, NEVER nohup — found live: nohup made install.sh hang forever whenever its own
    # stdio was piped (any parent that captures its output), even with the daemon's own fds
    # explicitly redirected. setsid fully detaches into a new session (immune to SIGHUP by
    # construction, survives the launching shell/terminal closing — the WSL-restart case this
    # exists for) and closes cleanly. Falls back to a plain backgrounded process on a host with
    # no setsid (macOS ships none by default).
    local _daemonize="setsid"
    command -v setsid >/dev/null 2>&1 || _daemonize=""

    # `</dev/null >>log 2>&1` on the command ALONE is not enough — bash forking a background job
    # inherits ALL open fds, not just 0/1/2; a plain per-command redirect only dup2's those
    # three. `exec` with no command applies the redirect to the CURRENT shell (including
    # whatever else it inherited) before the second `exec` replaces that shell's own process
    # image with the daemon, so nothing is left holding a parent's pipe open.
    #
    # launch-dashboard/.env MUST BE SOURCED HERE — Docker Compose auto-loads a service's .env
    # into the CONTAINER's environment; a bare host process gets none of that for free, and
    # runner-host.js's own config.js hard-requires LAUNCH_PASSWORD ("gates a button that spends
    # real money"). SPOOL_DIR/RUNS_DB are exported to the REAL host paths — their code defaults
    # ('/spool', '/data/runs.db') are the CONTAINER's bind-mount paths, unwritable on the host.
    #
    # THE ROOT .env TOO — a SEPARATE file, sourced FIRST so launch-dashboard/.env's own values can
    # still override on a genuine conflict. LANGFUSE_SECRET_KEY/PUBLIC_KEY live there (.env.example's
    # own declared shape), never in launch-dashboard/.env (not even in its own .env.example
    # template). Confirmed live 2026-09-04: a real launch-dashboard-triggered run produced zero
    # Langfuse traces despite both keys being correctly filled in at the root — this daemon never
    # saw them, so runner-host.js's own langfuse-passthrough logic (deliberately explicit, so an
    # ambient credential cannot leak into a launch) always found them unset.
    ( exec </dev/null >>"$_log" 2>&1
      cd "$_root" && set -a && . "$_root/.env" 2>/dev/null; . "$_launch_dir/.env" 2>/dev/null; set +a
      EPAM_HOME="$_root" SPOOL_DIR="$_launch_dir/spool" RUNS_DB="$_launch_dir/data/runs.db" \
          exec $_daemonize "${NODE_BIN:-node}" "$_launch_dir/backend/src/runner-host.js" ) &
    echo $! > "$_pidfile"
    # RECORDED BESIDE THE PID, so the next install can tell whether this daemon is the one the
    # CURRENT .env files would produce. Written after the spawn, so a daemon that failed to start
    # never leaves a fingerprint claiming it is current.
    printf '%s\n' "$_fingerprint" > "$_envfile"
    sleep 0.3
    local _new_pid
    _new_pid="$(cat "$_pidfile" 2>/dev/null)"
    if [ -n "$_new_pid" ] && kill -0 "$_new_pid" 2>/dev/null; then
        _ok "started (pid $_new_pid, log: $_log)"
        return 0
    fi
    _bad "runner-host failed to start — see $_log"
    return 1
}

# stop_runner_host <launch_dir>
#
# Silent no-op (not even a message) when nothing is running — callers that always invoke this
# (uninstall, pipeline-services.sh --stop) decide for themselves whether absence is worth saying.
stop_runner_host() {
    local _launch_dir="$1"
    local _pidfile="$_launch_dir/.runner-host.pid"
    # The env fingerprint describes a RUNNING daemon; it goes wherever the pidfile goes, or a
    # stopped install would leave one claiming a process that no longer exists is current.
    local _envfile="$_launch_dir/.runner-host.env-fingerprint"
    [ -f "$_pidfile" ] || { rm -f "$_envfile"; return 0; }
    local _pid
    _pid="$(cat "$_pidfile" 2>/dev/null)"
    if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then
        kill "$_pid" 2>/dev/null
        rm -f "$_pidfile" "$_envfile"
        return 0
    fi
    rm -f "$_pidfile" "$_envfile"
    return 1
}
