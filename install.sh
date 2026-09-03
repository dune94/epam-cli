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
    # THE TEMPLATE IS NAMED .env.example. This read .env.sample — a file that does not exist and
    # never has — guarded by `[ -f ]`, so the guard was false, the copy never happened, and NOTHING
    # WAS SAID. The operator was then told to fill in a file the installer had not created.
    #
    # Resolved from a declared list so a rename cannot silently reintroduce the same no-op, and an
    # ABSENT template is reported by name rather than passed over.
    _tpl=""
    for _c in "$ROOT/.env.example" "$ROOT/.env.sample"; do
        [ -f "$_c" ] && { _tpl="$_c"; break; }
    done
    if [ "$CHECK_ONLY" = "1" ]; then
        _bad ".env is missing"; FAILED=1
    elif [ -n "$_tpl" ]; then
        cp "$_tpl" "$ROOT/.env"
        _warn ".env created from $(basename "$_tpl") — FILL IT IN before running"
    else
        _bad "no .env and no template (.env.example) to create one from"; FAILED=1
    fi
fi

# ── Build ───────────────────────────────────────────────────────────────────
_head "Build"
# A PACKAGED INSTALL HAS NO src/. That is the artefact this installer exists to install: dist/ and
# orchestrations/ without the CLI source (§1.4 of the packaging plan). `npm run build` runs tsup,
# which needs src/ AND the dev dependencies — a client tree has neither, so building
# unconditionally fails at the one step that cannot be skipped.
#
# The rule: build when there is source to build FROM, verify otherwise, and SAY WHICH HAPPENED.
# Never silently skip; never fail on a tree that is already complete.
#
# EXISTENCE IS NOT A BUILD, either way. `[ -f dist/epam.js ]` passes on a 188-byte stub, so the old
# check reported success for a tree that could not run. The threshold sits far below any real
# bundle and far above any stub.
_dist="$ROOT/dist/epam.js"
_min_bytes="${EPAM_MIN_DIST_BYTES:-51200}"

# WHETHER dist/epam.js MATTERS DEPENDS ON THE STACK, and the stack declares it.
#
# claude.sh:1649-1650 routes copilot|openai|openrouter|cursor|minimax|epam to $EPAM_CLI
# (dist/epam.js), and `claude` to $CLAUDE_CMD. Every provider set declares `claude` or
# `codemie-claude` as its runner, so on those stacks dist/epam.js is NEVER executed — which is why
# this repo runs green with a 188-byte "Hello, World!" stub in dist/.
#
# So a hard failure here would refuse an install that works. It is reported instead, with what it
# means, and only FAILS when the stack actually routes to the epam CLI. The check that matters for
# every stack — is the declared RUNNER on PATH — already runs above.
_verify_dist() {
    local _needs_epam=0
    case "$RUNNER" in
        epam|"") _needs_epam=1 ;;
    esac

    if [ ! -f "$_dist" ]; then
        if [ "$_needs_epam" = "1" ]; then
            _bad "dist/epam.js is missing and the '$STACK' stack needs it"; FAILED=1; return 1
        fi
        _warn "dist/epam.js is absent — not needed by the '$STACK' stack (runner: $RUNNER)"
        return 0
    fi

    _size=$(wc -c < "$_dist" 2>/dev/null | tr -d ' ')
    if [ "${_size:-0}" -lt "$_min_bytes" ]; then
        if [ "$_needs_epam" = "1" ]; then
            _bad "dist/epam.js is only ${_size} bytes — that is a stub, not a build, and the '$STACK' stack needs it"
            FAILED=1; return 1
        fi
        _warn "dist/epam.js is a ${_size}-byte stub — harmless for the '$STACK' stack (runner: $RUNNER), but it is not a build"
        return 0
    fi
    _ok "dist/epam.js present (${_size} bytes)"
    return 0
}

if [ ! -d "$ROOT/src" ]; then
    # The packaged case. Stated explicitly so nobody reads "ok" and assumes a build happened here.
    _ok "packaged install — no src/, using the shipped pre-built bundle"
    _verify_dist
elif [ "$CHECK_ONLY" = "1" ]; then
    _verify_dist
else
    if [ ! -d "$ROOT/node_modules" ]; then
        _warn "installing dependencies (this takes a minute)"
        (cd "$ROOT" && npm install --silent) || { _bad "npm install failed"; FAILED=1; }
    else _ok "node_modules present"; fi
    if (cd "$ROOT" && npm run build --silent >/dev/null 2>&1); then
        _verify_dist
    else
        _bad "build failed — run 'npm run build' to see why"; FAILED=1
    fi
fi

# ── Dashboards: OPTIONAL, and never a reason to fail ────────────────────────
_head "Dashboards (optional)"
docker_up() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

# THE COMPOSE FILE IS NAMED. This ran `docker compose up -d` with no -f, and there is no
# docker-compose.yml at the repo root — only the named files below. It ended in `|| true`, so the
# failure was swallowed and the installer reported "docker is up" having started nothing.
COMPOSE_FILE="${EPAM_COMPOSE_FILE:-$ROOT/docker-compose.observability.yml}"
compose_up() {
    if [ ! -f "$COMPOSE_FILE" ]; then
        _bad "compose file not found: $COMPOSE_FILE"; FAILED=1; return 1
    fi
    if ! (cd "$ROOT" && docker compose -f "$COMPOSE_FILE" up -d >/dev/null 2>&1); then
        _bad "docker compose failed for $COMPOSE_FILE — the services are NOT running"; FAILED=1
        return 1
    fi
    return 0
}
case "$USE_DOCKER" in
    no)  _ok "skipped (--no-docker) — the pipeline runs without them" ;;
    yes) if docker_up; then
             if [ "$CHECK_ONLY" = "1" ] || compose_up; then _ok "docker is up — services started"; fi
         else _bad "--docker was requested but docker is not running"; FAILED=1; fi ;;
    auto) if docker_up; then
             if [ "$CHECK_ONLY" = "1" ] || compose_up; then _ok "docker is up — dashboards available"; fi
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
