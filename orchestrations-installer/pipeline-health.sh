#!/bin/bash
# pipeline-health.sh — is THIS MACHINE able to run the pipeline, right now, in verbose detail?
#
# DIFFERENT QUESTION FROM install.sh --check. install.sh --check asks "did the install itself
# complete" (files present, dist built). This asks "can an operator launch a real run from here" —
# it probes runtimes rather than trusting `command -v`, warns about the OAuth-vs-API-key trap that
# has silently billed the wrong account before, checks free memory/disk given this exact machine's
# history of WSL crashes from unbounded processes, and reports the ACTIVE provider set's runner and
# credentials rather than assuming one. Every check prints WHY it matters and WHAT TO RUN next —
# built for someone reading this for the first time, not for someone who already knows the fixes.
#
# Exit 0 = healthy enough to launch. Exit 1 = at least one FAIL below.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# THE TREE TO CHECK IS AN ARGUMENT, not wherever this script happens to live.
#
# Resolving ROOT from $HERE/.. is right when an operator runs this from inside their install, and
# WRONG the moment anything else runs it: `npx amsd-pipeline` executes install.sh out of a temp
# clone, so install.sh's own post-install health check inspected /tmp/tmp.XXXX — reporting missing
# daemons and an absent .env for a directory that is not the install, while the real install was
# fine. Found immediately on the first install that ran it (2026-09-04, pipeline-tests-14).
ROOT="$(cd "$HERE/.." && pwd)"
while [ $# -gt 0 ]; do
    case "$1" in
        --dest|--root) ROOT="${2:-}"; shift 2 ;;
        --help|-h) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) shift ;;
    esac
done
if [ -z "$ROOT" ] || [ ! -d "$ROOT" ]; then
    printf '\033[0;31m  ✗\033[0m no such install root: %s\n' "$ROOT" >&2
    exit 1
fi
ROOT="$(cd "$ROOT" && pwd)"
CONFIG="$ROOT/orchestrations/config"
NODE_BIN="${NODE_BIN:-node}"
FAILED=0
WARNED=0

_ok()   { printf '\033[0;32m  ✓\033[0m %s\n' "$*"; }
_warn() { printf '\033[0;33m  !\033[0m %s\n' "$*"; WARNED=1; }
_bad()  { printf '\033[0;31m  ✗\033[0m %s\n' "$*" >&2; FAILED=1; }
_head() { printf '\n\033[1m%s\033[0m\n' "$*"; }
_fix()  { printf '      → %s\n' "$*"; }

_head "amsd-pipeline health check"
printf '  root: %s\n' "$ROOT"

# ── Platform ──────────────────────────────────────────────────────────────
_head "Platform"
UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
if grep -qi microsoft /proc/version 2>/dev/null; then
    _ok "WSL2 ($(uname -r 2>/dev/null))"
elif [ "$UNAME_S" = "Linux" ]; then
    _ok "Linux ($(uname -r 2>/dev/null))"
elif [ "$UNAME_S" = "Darwin" ]; then
    _ok "macOS"
else
    _warn "unrecognized platform '$UNAME_S' — this script is written and tested for Linux/WSL2/macOS"
fi
BASH_MAJOR="${BASH_VERSION%%.*}"
if [ "${BASH_MAJOR:-0}" -lt 4 ] 2>/dev/null; then
    _warn "bash $BASH_VERSION — this pipeline's own scripts assume bash >=4 in places"
else
    _ok "bash $BASH_VERSION"
fi

# ── Core tooling ──────────────────────────────────────────────────────────
_head "Core tooling"
need() {
    local cmd="$1" why="$2" fix="$3"
    if command -v "$cmd" >/dev/null 2>&1; then
        local v=""
        case "$cmd" in
            node) v=" ($("$cmd" --version 2>/dev/null))" ;;
            git)  v=" ($("$cmd" --version 2>/dev/null | head -1))" ;;
            python3) v=" ($("$cmd" --version 2>/dev/null))" ;;
        esac
        _ok "$cmd$v"
    else
        _bad "$cmd is missing — $why"
        _fix "$fix"
    fi
}
need git     "the pipeline works on git codelines"          "install via your distro's package manager (e.g. apt install git)"
need jq      "the pipeline parses JSON with it throughout"  "apt install jq"
need node    "the engine and the CLI are node"               "install Node 20+ (nvm install 20, or apt install nodejs — verify >=18)"
need python3 "88 pipeline handlers are pure-stdlib python3, no venv needed" "apt install python3"

if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null)"
    if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
        _warn "node is v$NODE_MAJOR — this pipeline expects >=18 (20 is what's tested)"
        _fix "nvm install 20 && nvm use 20"
    fi
fi

# ── Container runtime — PROBED, not just found on PATH ─────────────────────
# `command -v docker` answers "is a binary present", not "will it actually run a container" — a
# stopped Docker daemon, no WSL2 integration, or a rootless Podman with no session all pass that
# check and then fail the first real `up -d`. Probing costs one real command per runtime.
_head "Container runtime (optional — needed only for dashboards/observability)"
_found_working_rt=""
for _rt in docker podman; do
    if ! command -v "$_rt" >/dev/null 2>&1; then
        continue
    fi
    if "$_rt" info >/dev/null 2>&1; then
        _ok "$_rt is installed AND responding"
        _found_working_rt="$_rt"
        break
    else
        _warn "$_rt is on PATH but not responding (daemon down, or no WSL2 integration)"
        _fix "$_rt info    # see the real error"
        if [ "$_rt" = "docker" ]; then
            _fix "on Windows: open Docker Desktop's WSL2 integration settings, or install Docker Engine directly inside this WSL2 distro (see the install guide) — no Docker Desktop license needed either way"
        fi
    fi
done
if [ -z "$_found_working_rt" ]; then
    _warn "no working container runtime — the pipeline itself still runs; dashboards/Langfuse/Grafana will not"
    _fix "either is fine: Docker Engine (free, no Desktop license) or Podman — see the install guide"
fi

# ── Active provider set — read live, never assumed ──────────────────────────
_head "Active provider set"
if [ ! -f "$CONFIG/provider-sets.json" ]; then
    _bad "no provider-sets.json at $CONFIG — is this a real amsd-pipeline checkout?"
else
    read -r DEFAULT_SET ALL_SETS <<<"$("$NODE_BIN" -e '
      const j = require(process.argv[1]);
      process.stdout.write((j.defaultSet || "") + " " + Object.keys(j.sets || {}).join(","));
    ' "$CONFIG/provider-sets.json" 2>/dev/null)"
    STACK="${EPAM_PROVIDER_SET:-$DEFAULT_SET}"
    _ok "resolved stack: $STACK   (declared: ${ALL_SETS//,/, })"
    [ -n "${EPAM_PROVIDER_SET:-}" ] || printf '      (from provider-sets.json defaultSet — export EPAM_PROVIDER_SET to override)\n'

    RUNNER="$("$NODE_BIN" -e '
      const fs = require("fs"), path = require("path");
      const reg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const set = reg.sets[process.argv[2]];
      if (!set) process.exit(0);
      const s = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), set.settingsFile), "utf8"));
      process.stdout.write(Object.keys(s.runners || {})[0] || "");
    ' "$CONFIG/provider-sets.json" "$STACK" 2>/dev/null)"

    if [ -n "$RUNNER" ]; then
        if command -v "$RUNNER" >/dev/null 2>&1; then
            _ok "'$RUNNER' runner is on PATH"
        else
            _bad "'$RUNNER' is not on PATH — the '$STACK' stack cannot launch without it"
            case "$RUNNER" in
                claude)
                    _fix "install Claude Code, then run: claude login"
                    ;;
                codemie-claude)
                    _fix "codemie-claude is an internal EPAM tool, not something this repo installs — obtain it via your organization's internal distribution, put it on PATH, and complete its SSO login before re-running this check"
                    ;;
                *)
                    _fix "install '$RUNNER' and put it on PATH"
                    ;;
            esac
        fi

        # THE OAUTH-VS-API-KEY TRAP: an API key present in the environment OUTRANKS the claude
        # CLI's own OAuth session, silently billing the API account instead of the subscription —
        # this has actually happened here (7 runs billed wrong before it was caught).
        if [ "$RUNNER" = "claude" ]; then
            if [ -n "${ANTHROPIC_API_KEY:-}${EPAM_API_KEY_ANTHROPIC:-}" ]; then
                _warn "ANTHROPIC_API_KEY / EPAM_API_KEY_ANTHROPIC is SET — this OUTRANKS your claude subscription and will bill the API account instead"
                _fix "unset it if you intend to run on your Claude subscription: unset ANTHROPIC_API_KEY EPAM_API_KEY_ANTHROPIC"
            elif [ -f "$HOME/.claude/.credentials.json" ] || [ -f "$HOME/.config/claude/.credentials.json" ]; then
                _ok "claude subscription session found, no overriding API key set"
            else
                _warn "no claude OAuth session found, and no API key set — claude will prompt to log in on first use"
                _fix "claude login"
            fi
        fi
    else
        _warn "could not resolve a runner for stack '$STACK' — check $CONFIG/provider-sets.json"
    fi

    # Required credentials for the ACTIVE set, straight from provider-sets.json — never hardcoded.
    _MISSING="$("$NODE_BIN" -e '
      const fs = require("fs"), path = require("path");
      const reg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const set = reg.sets[process.argv[2]] || {};
      const missing = [];
      for (const c of (set.credentials || [])) {
        if (c.required && !process.env[c.from]) missing.push(c.from);
      }
      process.stdout.write(missing.join(" "));
    ' "$CONFIG/provider-sets.json" "$STACK" 2>/dev/null)"
    if [ -n "$_MISSING" ]; then
        _bad "the '$STACK' stack needs these env vars, currently unset: $_MISSING"
        _fix "add them to .env at the repo root (see the install guide's sample .env)"
    elif [ -f "$CONFIG/provider-sets.json" ]; then
        _ok "'$STACK' credentials satisfied (or the set requires none)"
    fi
fi

# ── .env present ─────────────────────────────────────────────────────────
_head "Credentials file"
if [ -f "$ROOT/.env" ]; then
    _ok ".env present"
else
    _warn "no .env at $ROOT/.env"
    _fix "cp .env.example .env, then fill in what the 'Active provider set' section above says you need"
fi

# ── Machine headroom — this exact machine has crashed WSL from unbounded runs before ──
_head "Machine headroom"
if command -v free >/dev/null 2>&1; then
    _MEM_AVAIL_MB="$(free -m 2>/dev/null | awk '/^Mem:/{print $7}')"
    if [ -n "$_MEM_AVAIL_MB" ]; then
        if [ "$_MEM_AVAIL_MB" -lt 2048 ]; then
            _bad "only ${_MEM_AVAIL_MB}MB memory available — a run is likely to OOM this machine"
            _fix "close other applications, or stop unused docker containers, before launching"
        elif [ "$_MEM_AVAIL_MB" -lt 4096 ]; then
            _warn "only ${_MEM_AVAIL_MB}MB memory available — fine for a single run, tight for a run plus dashboards"
        else
            _ok "${_MEM_AVAIL_MB}MB memory available"
        fi
    fi
else
    _warn "no 'free' command — cannot check memory headroom on this platform"
fi
_DISK_AVAIL_KB="$(df -Pk "$ROOT" 2>/dev/null | awk 'NR==2{print $4}')"
if [ -n "$_DISK_AVAIL_KB" ]; then
    _DISK_AVAIL_GB=$(( _DISK_AVAIL_KB / 1024 / 1024 ))
    if [ "$_DISK_AVAIL_GB" -lt 5 ]; then
        _warn "only ${_DISK_AVAIL_GB}GB disk free at $ROOT — docker images and run logs add up fast"
    else
        _ok "${_DISK_AVAIL_GB}GB disk free"
    fi
fi

# ── Project discovery root, if a project is selected ────────────────────────
_head "Project (optional)"
if [ -n "${EPAM_PROJECT:-}" ]; then
    _PCFG="$ROOT/orchestrations/projects/$EPAM_PROJECT/config.env"
    if [ ! -f "$_PCFG" ]; then
        _bad "EPAM_PROJECT=$EPAM_PROJECT but no config.env at $_PCFG"
    else
        _ok "config.env present for '$EPAM_PROJECT'"
        _ROOT_VAR="$(grep -E '^JIRA_CODELINE_ROOT=' "$_PCFG" 2>/dev/null | tail -1 | cut -d= -f2-)"
        if [ -n "$_ROOT_VAR" ]; then
            if [ -d "$_ROOT_VAR" ]; then
                _REPO_COUNT="$(find "$_ROOT_VAR" -maxdepth 2 -name .git -type d 2>/dev/null | wc -l | tr -d ' ')"
                if [ "${_REPO_COUNT:-0}" -gt 0 ]; then
                    _ok "JIRA_CODELINE_ROOT=$_ROOT_VAR — $_REPO_COUNT git repo(s) found"
                else
                    _warn "JIRA_CODELINE_ROOT=$_ROOT_VAR exists but no git repos found directly under it"
                    _fix "clone the client codelines there — the pipeline discovers them by scanning this directory, nothing needs listing by name"
                fi
            else
                _bad "JIRA_CODELINE_ROOT=$_ROOT_VAR does not exist"
                _fix "mkdir -p $_ROOT_VAR and clone the client repos into it, or edit JIRA_CODELINE_ROOT in $_PCFG"
            fi
        else
            _warn "$_PCFG declares no JIRA_CODELINE_ROOT — brownfield codeline discovery has nowhere to scan"
        fi
    fi
else
    _ok "no EPAM_PROJECT set — greenfield/no client-codeline discovery needed"
    printf '      (set EPAM_PROJECT=<name> once a project directory exists under orchestrations/projects/)\n'
fi

# ── Host daemons: runner-host.js and snapshot-watch.js ──────────────────────
# Both are host processes install.sh/pipeline-services.sh start — neither runs in docker. Without
# runner-host.js, a run saved through the dashboard just sits "pending" forever, nothing polling
# for it. Without snapshot-watch.js, a launched run's own pre-flight HARD FAILS 3 checks
# immediately (confirmed live 2026-09-04: "3 check(s) FAILED — DO NOT run pipeline") — this is not
# optional the way docker/dashboards are elsewhere in this script.
_head "Host daemons"
_daemon_alive() {
    local _pidfile="$1"
    [ -f "$_pidfile" ] || return 1
    local _pid
    _pid="$(cat "$_pidfile" 2>/dev/null)"
    [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null
}
if [ -f "$ROOT/launch-dashboard/backend/src/runner-host.js" ]; then
    if _daemon_alive "$ROOT/launch-dashboard/.runner-host.pid"; then
        _ok "runner-host.js is running"
    else
        _bad "runner-host.js is NOT running — a run saved through the dashboard will sit 'pending' forever"
        _fix "bash orchestrations-installer/pipeline-services.sh --start"
    fi
fi
if [ -f "$ROOT/orchestrations/scripts/snapshot-watch.js" ]; then
    if _daemon_alive "$ROOT/orchestrations/dashboards/.snapshot-watch.pid"; then
        _ok "snapshot-watch.js is running"
    else
        _bad "snapshot-watch.js is NOT running — a launched run's own pre-flight will hard-fail"
        _fix "bash orchestrations-installer/pipeline-services.sh --start"
    fi
fi

# ── Service endpoints — PROBED, not assumed from a container being "Up" ────
#
# THIS IS THE WHOLE POINT OF A HEALTH CHECK, and it was the missing half: this script proved the
# DAEMONS were alive and never asked whether the services they exist to serve actually answer. Three
# separate operator-facing breakages got through it in one day, each found by a human opening a
# browser: the dashboard serving 404 for /prd.json ("data offline"), Langfuse and Grafana probed on
# the wrong ports, and nginx unable to serve /logs/*. Every one is a single curl.
#
# THE LIST IS DERIVED FROM config/services.json, NEVER NAMED HERE. A service added there tomorrow
# is probed tomorrow, rather than whenever someone remembers this file — the same rule the rest of
# this pipeline is held to. Endpoints resolve through service_url(), so an ISOLATED install is
# probed on the ports IT actually got; a literal would pass against a service nobody is using.
#
# REQUIRED vs OPTIONAL is derived too, not guessed: a service that declares a stateVar is one this
# install allocates a port for — it is part of the stack and must answer. One without is external
# (a story API, a graph browser someone may or may not run) and is reported, never failed.
_head "Service endpoints"
_SVC_LIB="$ROOT/orchestrations/scripts/lib/service-urls.sh"
_SVC_CFG="$CONFIG/services.json"
if [ ! -f "$_SVC_LIB" ] || [ ! -f "$_SVC_CFG" ]; then
    _warn "no service registry in this tree — cannot probe endpoints"
else
    # shellcheck source=/dev/null
    . "$_SVC_LIB"

    # Does THIS stack's runner emit Langfuse traces? Declared per runner (emitsTraces), because
    # traces are written by wrapWithTracing inside the epam CLI and a runner that shells out to a
    # vendor CLI never reaches it. Used below to decide whether a trace sink being down is a
    # failure or simply irrelevant here.
    _EMITS="$("$NODE_BIN" -e '
      const fs = require("fs"), path = require("path");
      try {
        const reg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const set = reg.sets[process.argv[2]];
        if (!set) { process.stdout.write("0"); process.exit(0); }
        const s = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), set.settingsFile), "utf8"));
        process.stdout.write(Object.values(s.runners || {}).some((r) => r && r.emitsTraces === true) ? "1" : "0");
      } catch { process.stdout.write("0"); }
    ' "$CONFIG/provider-sets.json" "${STACK:-}" 2>/dev/null || echo 0)"

    _probe_code() {
        curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null || echo 000
    }

    # name<TAB>required<TAB>tracesink — every declared service, in declaration order.
    while IFS="$(printf '\t')" read -r _svc _required _tracesink; do
        [ -n "$_svc" ] || continue
        _url="$(service_url "$_svc" 2>/dev/null || true)"
        if [ -z "$_url" ]; then
            _warn "$_svc: declared in services.json but no endpoint resolved"
            continue
        fi
        _code="$(_probe_code "$_url")"
        case "$_code" in
            2??|3??) _ok "$_svc: serving (HTTP $_code) — $_url" ;;
            *)
                if [ "$_tracesink" = "1" ] && [ "$_EMITS" != "1" ]; then
                    _warn "$_svc: not serving at $_url — not required here, the '$STACK' stack's runner emits no traces"
                elif [ "$_required" = "1" ]; then
                    _bad "$_svc: NOT serving (HTTP $_code) at $_url — this install allocates a port for it, so it is part of the stack"
                    _fix "bash orchestrations-installer/install.sh --dest \"$ROOT\"   # the installer owns the restarts"
                else
                    _warn "$_svc: not serving at $_url — optional (this install allocates no port for it)"
                fi ;;
        esac
    done <<EOF
$("$NODE_BIN" -e '
  const fs = require("fs");
  const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const [name, svc] of Object.entries(j.services || {})) {
    const required = svc.stateVar ? "1" : "0";
    // A trace sink is identified by the env var it declares, not by its name — the same value
    // TracedProvider itself reads. Nothing here spells a service name.
    const traceSink = /^LANGFUSE_/.test(String(svc.env || "")) ? "1" : "0";
    process.stdout.write([name, required, traceSink].join("\t") + "\n");
  }
' "$_SVC_CFG" 2>/dev/null)
EOF

    # THE MOUNTS, NOT JUST THE SERVER. A dashboard answering on / proves the container is up; it
    # says nothing about whether this run's PRD and log directories are mounted INTO it, which is
    # what every panel actually reads. Both were broken while / returned 200 — "data offline" on a
    # healthy install. Derived from the same registry entry, never a second URL literal.
    _DASH_URL="$(service_url dashboard 2>/dev/null || true)"
    if [ -n "$_DASH_URL" ]; then
        # BEFORE THE FIRST RUN THERE IS NO MOUNT TO FIND, and saying "NOT serving" about that makes
        # a healthy fresh install read as broken. pre-run-reset.sh writes the compose override that
        # mounts this run's LOG_DIR, and it has not run yet. After a run it is a real failure — the
        # dashboards genuinely have nothing to read — so the two are distinguished by whether the
        # override exists, not by guessing.
        _lc="$(_probe_code "$_DASH_URL/logs/agent-status.json")"
        case "$_lc" in
            2??|3??) _ok "dashboard /logs mount: serving (HTTP $_lc)" ;;
            *) if [ -f "$ROOT/docker-compose.observability.override.yml" ]; then
                   _bad "dashboard /logs mount: NOT serving (HTTP $_lc) — agent-activity.html and health.html have nothing to read"
                   _fix "bash orchestrations-installer/install.sh --dest \"$ROOT\""
               else
                   _warn "dashboard /logs mount: not mounted yet (HTTP $_lc) — normal before the first run; pre-run-reset.sh mounts this run's log dir at launch"
               fi ;;
        esac
        _pc="$(_probe_code "$_DASH_URL/prd.json")"
        case "$_pc" in
            2??|3??) _ok "dashboard /prd.json: serving (HTTP $_pc)" ;;
            404)     _warn "dashboard /prd.json: 404 — no PRD ingested yet (normal before the first run); dashboards read 'data offline' until one exists" ;;
            *)       _bad "dashboard /prd.json: NOT serving (HTTP $_pc) — the /prd-dir mount is wrong, every dashboard shows 'data offline'"
                     _fix "bash orchestrations-installer/install.sh --dest \"$ROOT\"" ;;
        esac
    fi

    if [ "$_EMITS" != "1" ]; then
        _warn "langfuse will stay EMPTY on the '$STACK' stack BY DESIGN — its runner shells out to a vendor CLI and never reaches the tracing layer (declared: emitsTraces=false)"
    fi
fi

# ── epam shim ────────────────────────────────────────────────────────────
_head "epam command"
_SHIM="$HOME/.local/bin/epam"
if [ -f "$_SHIM" ]; then
    _TARGET="$(grep -o '"[^"]*epam\.js"' "$_SHIM" 2>/dev/null | tr -d '"' | head -1)"
    if [ -n "$_TARGET" ] && [ -f "$_TARGET" ]; then
        _ok "epam shim present and points at a real file"
    else
        _bad "epam shim at $_SHIM points at a missing file${_TARGET:+ ($_TARGET)}"
        _fix "re-run install.sh to regenerate the shim"
    fi
else
    _warn "no epam shim at $_SHIM — only matters if this stack's runner is 'epam'"
fi

# ── Summary ──────────────────────────────────────────────────────────────
_head "Result"
if [ "$FAILED" = "1" ]; then
    _bad "not healthy — fix the ✗ items above before launching a run"
    exit 1
elif [ "$WARNED" = "1" ]; then
    _warn "runnable, with warnings — review the ! items above"
    exit 0
else
    _ok "healthy — ready to launch"
    exit 0
fi
