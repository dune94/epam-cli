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
ROOT="$(cd "$HERE/.." && pwd)"
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
