#!/usr/bin/env bash
# install.sh — set this machine up to run the pipeline.
#
#   ./install.sh                      install for the default stack, with dashboards if docker is up
#   ./install.sh --stack codemie      install for a specific stack
#   ./install.sh --no-docker          skip dashboards entirely
#   ./install.sh --check              verify an existing install, change nothing
#
# DOCKER IS OPTIONAL, ALWAYS. The dashboards are observability; the pipeline runs without them.
# An installer that fails because a container is missing teaches people to skip the installer.
#
# The stacks, their runners and the services are all DECLARED (orchestrations/config/*). This
# script names none of them — adding a stack is a config edit, not an edit here.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$ROOT/orchestrations/config"
NODE_BIN="${NODE_BIN:-node}"

_ok()   { printf '\033[0;32m  ✓\033[0m %s\n' "$*"; }
_warn() { printf '\033[0;33m  !\033[0m %s\n' "$*"; }
_bad()  { printf '\033[0;31m  ✗\033[0m %s\n' "$*" >&2; }
_head() { printf '\n\033[1m%s\033[0m\n' "$*"; }

STACK=""; USE_DOCKER=auto; CHECK_ONLY=0; FAILED=0
while [ $# -gt 0 ]; do
    case "$1" in
        --stack)     STACK="${2:-}"; shift 2 ;;
        --no-docker) USE_DOCKER=no; shift ;;
        --docker)    USE_DOCKER=yes; shift ;;
        --check)     CHECK_ONLY=1; shift ;;
        --help|-h)   sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)           _bad "unknown option '$1'"; exit 1 ;;
    esac
done

# ── What stacks exist, and which is default? Read, never listed here. ────────
[ -f "$CONFIG/provider-sets.json" ] || { _bad "no provider-sets.json — is this the repo root?"; exit 1; }
read -r DEFAULT_SET ALL_SETS <<<"$("$NODE_BIN" -e '
  const j = require(process.argv[1]);
  process.stdout.write((j.defaultSet || "") + " " + Object.keys(j.sets || {}).join(","));
' "$CONFIG/provider-sets.json" 2>/dev/null)"
STACK="${STACK:-${EPAM_PROVIDER_SET:-$DEFAULT_SET}}"
case ",$ALL_SETS," in
    *",$STACK,"*) : ;;
    *) _bad "unknown stack '$STACK' — declared stacks are: ${ALL_SETS//,/, }"; exit 1 ;;
esac

_head "Stack: $STACK   (available: ${ALL_SETS//,/, })"

# ── Prerequisites the run genuinely needs ───────────────────────────────────
_head "Prerequisites"
need() {
    local cmd="$1" why="$2"
    if command -v "$cmd" >/dev/null 2>&1; then _ok "$cmd"
    else _bad "$cmd is missing — $why"; FAILED=1; fi
}
need git  "the pipeline works on git codelines"
need jq   "the pipeline parses JSON with it throughout"
need node "the engine and the CLI are node"

# The runner this stack declares. This is the commonest real failure.
RUNNER="$("$NODE_BIN" -e '
  const fs = require("fs"), path = require("path");
  const reg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const set = reg.sets[process.argv[2]];
  const s = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), set.settingsFile), "utf8"));
  process.stdout.write(Object.keys(s.runners || {})[0] || "");
' "$CONFIG/provider-sets.json" "$STACK" 2>/dev/null)"
if [ -n "$RUNNER" ]; then
    if command -v "$RUNNER" >/dev/null 2>&1; then _ok "$RUNNER (the '$STACK' runner)"
    else _bad "'$RUNNER' is not on PATH — the '$STACK' stack cannot run without it"; FAILED=1; fi
fi

# ── Credentials: what this stack needs, from what it declares ───────────────
_head "Credentials"
if [ -f "$ROOT/.env" ]; then
    _ok ".env present"
else
    if [ "$CHECK_ONLY" = "0" ] && [ -f "$ROOT/.env.sample" ]; then
        cp "$ROOT/.env.sample" "$ROOT/.env"; _warn ".env created from .env.sample — fill it in before running"
    else
        _bad ".env is missing"; FAILED=1
    fi
fi

# ── Build ───────────────────────────────────────────────────────────────────
_head "Build"
if [ "$CHECK_ONLY" = "1" ]; then
    [ -f "$ROOT/dist/epam.js" ] && _ok "dist/epam.js present" || { _bad "not built — run without --check"; FAILED=1; }
else
    if [ ! -d "$ROOT/node_modules" ]; then
        _warn "installing dependencies (this takes a minute)"
        (cd "$ROOT" && npm install --silent) || { _bad "npm install failed"; FAILED=1; }
    else _ok "node_modules present"; fi
    (cd "$ROOT" && npm run build --silent >/dev/null 2>&1) && _ok "built dist/epam.js" || { _bad "build failed — run 'npm run build' to see why"; FAILED=1; }
fi

# ── Dashboards: OPTIONAL, and never a reason to fail ────────────────────────
_head "Dashboards (optional)"
docker_up() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }
case "$USE_DOCKER" in
    no)  _ok "skipped (--no-docker) — the pipeline runs without them" ;;
    yes) if docker_up; then
             [ "$CHECK_ONLY" = "1" ] || (cd "$ROOT" && docker compose up -d >/dev/null 2>&1) || true
             _ok "docker is up"
         else _bad "--docker was requested but docker is not running"; FAILED=1; fi ;;
    auto) if docker_up; then
             [ "$CHECK_ONLY" = "1" ] || (cd "$ROOT" && docker compose up -d >/dev/null 2>&1) || true
             _ok "docker is up — dashboards available"
         else _warn "docker is not running — dashboards unavailable, THE PIPELINE STILL RUNS"; fi ;;
esac

# ── The command people will actually type ───────────────────────────────────
_head "Result"
if [ "$FAILED" = "1" ]; then
    _bad "install incomplete — fix the items marked ✗ above"
    exit 1
fi
_ok "ready"
printf '\n  Run a ticket:   %s\n' "./orchestrations/scripts/pipeline --jira ABC-1234"
printf '  Check first:    %s\n'   "./orchestrations/scripts/pipeline --jira ABC-1234 --dry-run"
printf '  Switch stack:   %s\n\n' "EPAM_PROVIDER_SET=<${ALL_SETS//,/|}> ./orchestrations/scripts/pipeline --jira ABC-1234"
