#!/usr/bin/env bash
# install.sh — set this machine up to run the pipeline.
#
#   ./orchestrations-installer/install.sh                      install for the default stack, with dashboards if docker is up
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

# THE INSTALLER LIVES IN ITS OWN FOLDER; ROOT IS THE TREE IT INSTALLS.
#
# All 17 uses of $ROOT below address the install TREE — .env, dist/, orchestrations/, the compose
# file, the manifest. Resolving ROOT from this script's own directory would point every one of them
# inside orchestrations-installer/ and the install would silently configure the wrong tree.
#
# INSTALLER_DIR is separate and is only for this folder's own files, so the two can never be
# confused by a later edit.
INSTALLER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$INSTALLER_DIR/.." && pwd)"
CONFIG="$ROOT/orchestrations/config"
NODE_BIN="${NODE_BIN:-node}"

_ok()   { printf '\033[0;32m  ✓\033[0m %s\n' "$*"; }
_warn() { printf '\033[0;33m  !\033[0m %s\n' "$*"; }
_bad()  { printf '\033[0;31m  ✗\033[0m %s\n' "$*" >&2; }
_head() { printf '\n\033[1m%s\033[0m\n' "$*"; }

STACK=""; USE_DOCKER=auto; CHECK_ONLY=0; FAILED=0

# THE CONTAINER RUNTIME IS DECLARED, NEVER INFERRED (plan §5.1a).
#
# Podman is the default on Windows because Docker Desktop needs a paid subscription above 250
# employees or $10M revenue. A procurement conversation, not a technical preference, is what stalls
# a rollout — and Podman on Windows runs on WSL2 too, so this is not a fourth platform.
CONTAINER_RUNTIME="${EPAM_CONTAINER_RUNTIME:-}"

# REPLAY IS A CONFIG OPTION (plan §5.1c). Langfuse is the RECORDER, not a dashboard: a run executed
# without it can never be replayed, because the turns were never captured. Off by default — 2.36GB
# of images is not a silent opt-in — but the consequence is one-way, so it is STATED either way.
REPLAY_MODE="${EPAM_REPLAY:-off}"
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

# PYTHON IS A RUNTIME DEPENDENCY, not an optional extra: 88 handlers under
# orchestrations/scripts/lib/handlers are executed with it.
#
# Measured, because the assumption was bigger than the truth: every import across all 88 is
# stdlib, plus one LOCAL module (_testfile, imported by siblings in the same directory). So there
# is no venv to provision, no pip install, no requirements.txt — the interpreter is the whole
# requirement, and checking for it is the whole job.
if command -v python3 >/dev/null 2>&1; then
    _ok "python3 ($(python3 -V 2>&1 | awk '{print $2}')) — 88 handlers need it"
else
    _bad "python3 is not on PATH — 88 pipeline handlers cannot run without it"; FAILED=1
fi
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

# ── The `epam` shim ───────────────────────────────────────────────────────────
# THE SHIM MUST POINT AT THIS INSTALL. The one found on the development machine reads
#     exec node /home/<someone>/projects/ai/epam-cli/dist/epam.js "$@"
# which is correct for exactly one checkout and wrong for every install. The path is computed here,
# at install time, from where this script actually is.
_head "Command"
BIN_DIR="${EPAM_BIN_DIR:-$HOME/.local/bin}"
if [ "$CHECK_ONLY" = "1" ]; then
    if [ -x "$BIN_DIR/epam" ]; then _ok "epam shim present at $BIN_DIR/epam"
    else _warn "no epam shim at $BIN_DIR/epam"; fi
else
    mkdir -p "$BIN_DIR"
    printf '#!/usr/bin/env bash\nexec node "%s/dist/epam.js" "$@"\n' "$ROOT" > "$BIN_DIR/epam"
    chmod +x "$BIN_DIR/epam"
    _ok "epam shim written to $BIN_DIR/epam -> $ROOT/dist/epam.js"
    case ":$PATH:" in
        *":$BIN_DIR:"*) : ;;
        # Said, never done silently: editing a shell profile behind an operator is a surprise, and
        # a shim that is not on PATH is a shim that does nothing.
        *) _warn "$BIN_DIR is not on PATH — add it:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
    esac
fi

# ── Project config: the three things that cannot be derived ───────────────────
# JIRA_URL, JIRA_PROJECT_KEY and JIRA_CODELINE_ROOT are answers, not defaults — nothing in the tree
# can infer which Jira site, which project, or where the codelines live.
#
# NON-SECRET VALUES ONLY. Credentials live in one .env, owned by the operator. This never prompts
# for a token, never echoes one, and never writes one into project config: one file, one owner, one
# place to look.
_head "Project"
EPAM_PROJECT="${EPAM_PROJECT:-}"
if [ -n "$EPAM_PROJECT" ] && [ -d "$ROOT/orchestrations/projects/$EPAM_PROJECT" ]; then
    _cfg="$ROOT/orchestrations/projects/$EPAM_PROJECT/config.env"
    if [ "$CHECK_ONLY" = "1" ]; then
        [ -f "$_cfg" ] && _ok "config.env present for '$EPAM_PROJECT'" || _warn "no config.env for '$EPAM_PROJECT'"
    else
        _missing=""
        for _v in JIRA_URL JIRA_PROJECT_KEY JIRA_CODELINE_ROOT; do
            eval "_val=\${$_v:-}"
            [ -z "$_val" ] && _missing="$_missing $_v"
        done
        if [ -n "$_missing" ]; then
            _warn "project '$EPAM_PROJECT' not configured — missing:$_missing"
        else
            {
                echo "# Written by install.sh. NON-SECRET VALUES ONLY — credentials live in .env."
                echo "PROJECT_NAME=$EPAM_PROJECT"
                echo "JIRA_URL=$JIRA_URL"
                echo "JIRA_PROJECT_KEY=$JIRA_PROJECT_KEY"
                echo "JIRA_CODELINE_ROOT=$JIRA_CODELINE_ROOT"
            } > "$_cfg"
            _ok "wrote $_cfg (JIRA_URL, JIRA_PROJECT_KEY, JIRA_CODELINE_ROOT)"
        fi
    fi
else
    _ok "no project selected (set EPAM_PROJECT to configure one)"
fi

# ── Container runtime ─────────────────────────────────────────────────────────
_head "Container runtime"
# ONE RESOLVER, ASKED — not a third copy of the rule. The installer, dashboard-health-check.sh and
# pre-run-reset.sh each had their own idea of which runtime to use, and only this one had ever
# heard of podman.
_CR_LIB="$INSTALLER_DIR/lib/container-runtime.sh"
if [ -f "$_CR_LIB" ]; then
    # shellcheck source=orchestrations-installer/lib/container-runtime.sh
    . "$_CR_LIB"
else
    _bad "missing $_CR_LIB — this tree cannot resolve a container runtime"; FAILED=1
fi

_CR_DECLARED="$CONTAINER_RUNTIME"
if CONTAINER_RUNTIME="$(container_runtime 2>&1)"; then
    if [ -n "$_CR_DECLARED" ]; then _ok "runtime: $CONTAINER_RUNTIME (declared)"
    else                            _ok "runtime: $CONTAINER_RUNTIME (discovered)"
    fi
else
    # The resolver's own message says WHICH runtimes it looked for, so it is reported verbatim
    # rather than restated here in words that could drift from the declaration.
    _CR_WHY="$CONTAINER_RUNTIME"
    CONTAINER_RUNTIME=none
    if [ -n "$_CR_DECLARED" ]; then
        # A runtime the installer cannot drive must fail HERE, not surface later as a compose
        # command that does nothing.
        _bad "$_CR_WHY"; FAILED=1
    else
        # Nothing installed is not a failure: --no-docker is a supported install.
        _ok "runtime: none — no container runtime found, the pipeline still runs"
    fi
fi

# ── Replay ────────────────────────────────────────────────────────────────────
_head "Replay"
case "$REPLAY_MODE" in
    off)
        # The cost is one-way and must be stated: nothing recorded now can be replayed later.
        _ok "replay: off — runs will NOT be replayable (no Langfuse recorder installed)" ;;
    on)
        _ok "replay: on — Langfuse records every run so it can be replayed for \$0"
        # LangfuseTracer.ts:30 gates on BOTH keys. A fresh install has empty volumes, so no project
        # and no keys exist — and recording is silently off while the containers run and capture
        # nothing. That is the one case where a warning is not enough.
        _lf_missing=""
        [ -z "${LANGFUSE_SECRET_KEY:-}" ] && _lf_missing="$_lf_missing LANGFUSE_SECRET_KEY"
        [ -z "${LANGFUSE_PUBLIC_KEY:-}" ] && _lf_missing="$_lf_missing LANGFUSE_PUBLIC_KEY"
        if [ -n "$_lf_missing" ]; then
            _bad "replay: on but missing:$_lf_missing — nothing would be recorded, and a run not recorded can never be replayed"
            FAILED=1
        else
            _ok "Langfuse keys present — recording is active" ;
        fi ;;
    *)
        _bad "unknown replay mode '$REPLAY_MODE' — expected on or off"; FAILED=1 ;;
esac

# ── Dashboards: OPTIONAL, and never a reason to fail ────────────────────────
_head "Dashboards (optional)"
# THE PROBE ASKS THE RESOLVED RUNTIME. It said `docker` literally, so on a podman-only machine the
# installer announced "runtime: podman" and then started nothing — the report and the behaviour
# disagreeing, which is this file's recurring defect.
runtime_up() {
    [ "$CONTAINER_RUNTIME" = "none" ] && return 1
    command -v "$CONTAINER_RUNTIME" >/dev/null 2>&1 && "$CONTAINER_RUNTIME" info >/dev/null 2>&1
}

# THE COMPOSE FILE IS NAMED. This ran `docker compose up -d` with no -f, and there is no
# docker-compose.yml at the repo root — only the named files below. It ended in `|| true`, so the
# failure was swallowed and the installer reported "docker is up" having started nothing.
COMPOSE_FILE="${EPAM_COMPOSE_FILE:-$ROOT/docker-compose.observability.yml}"
compose_up() {
    if [ ! -f "$COMPOSE_FILE" ]; then
        _bad "compose file not found: $COMPOSE_FILE"; FAILED=1; return 1
    fi
    if ! (cd "$ROOT" && container_compose -f "$COMPOSE_FILE" up -d >/dev/null 2>&1); then
        _bad "$CONTAINER_RUNTIME compose failed for $COMPOSE_FILE — the services are NOT running"; FAILED=1
        return 1
    fi
    return 0
}
case "$USE_DOCKER" in
    no)  _ok "skipped (--no-docker) — the pipeline runs without them" ;;
    yes) if runtime_up; then
             if [ "$CHECK_ONLY" = "1" ] || compose_up; then _ok "$CONTAINER_RUNTIME is up — services started"; fi
         else _bad "--docker was requested but no container runtime is running (resolved: $CONTAINER_RUNTIME)"; FAILED=1; fi ;;
    auto) if runtime_up; then
             if [ "$CHECK_ONLY" = "1" ] || compose_up; then _ok "$CONTAINER_RUNTIME is up — dashboards available"; fi
         else _warn "no container runtime is running — dashboards unavailable, THE PIPELINE STILL RUNS"; fi ;;
esac

# ── Launch dashboard: OPTIONAL, and must be genuinely UP when it claims to be ─
# THIS CANNOT DEPEND ON A HUMAN OR AN LLM DOING IT BY HAND. A rebuild-and-restart done manually
# once is a rebuild-and-restart that must be done manually every time — this makes it the same
# re-run of install.sh as everything else above.
#
# `docker compose up -d` alone does NOT rebuild an image from changed source; it recreates
# containers from whatever image already exists. --build closes that. And `up -d` exiting 0 means
# containers were CREATED, not that the service inside is ready to answer a request — closed by
# actually polling the health endpoint below rather than trusting the exit code.
_head "Launch dashboard (optional)"
LAUNCH_DIR="$ROOT/launch-dashboard"
LAUNCH_COMPOSE="$LAUNCH_DIR/docker-compose.yml"
LAUNCH_HEALTH_TRIES="${EPAM_LAUNCH_HEALTH_TRIES:-30}"
LAUNCH_HEALTH_INTERVAL="${EPAM_LAUNCH_HEALTH_INTERVAL:-1}"
LAUNCH_STATUS=absent

if [ ! -f "$LAUNCH_COMPOSE" ]; then
    _ok "not present in this tree — nothing to provision"
elif [ "$USE_DOCKER" = "no" ]; then
    LAUNCH_STATUS=skipped
    _ok "skipped (--no-docker)"
else
    . "$INSTALLER_DIR/lib/wait-for-health.sh"
    . "$INSTALLER_DIR/lib/isolated-compose-identity.sh"

    # A REAL PASSWORD IS A DECISION ONLY A HUMAN MAKES — never synthesized here. Mirrors the root
    # .env handling: copy the template so there is something to fill in, never invent a secret.
    if [ ! -f "$LAUNCH_DIR/.env" ]; then
        if [ -f "$LAUNCH_DIR/.env.example" ]; then
            cp "$LAUNCH_DIR/.env.example" "$LAUNCH_DIR/.env"
            _warn "launch-dashboard/.env created from .env.example — FILL IN LAUNCH_PASSWORD before it can start"
        else
            _bad "launch-dashboard/.env is missing and there is no .env.example to create one from"
            FAILED=1
        fi
    fi

    _LD_PORT="$(grep -E '^LAUNCH_UI_PORT=' "$LAUNCH_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2)"
    _LD_PORT="${_LD_PORT:-8099}"
    _LD_PROJECT="$(isolated_project_name "$ROOT" launch)"
    _LD_HEALTH_URL="http://localhost:${_LD_PORT}/api/health"

    if [ ! -f "$LAUNCH_DIR/.env" ]; then
        LAUNCH_STATUS=failed
    elif [ "$CHECK_ONLY" = "1" ]; then
        if wait_for_health "$_LD_HEALTH_URL" 3 1; then
            LAUNCH_STATUS=up
            _ok "up at $_LD_HEALTH_URL (project: $_LD_PROJECT)"
        else
            LAUNCH_STATUS=not-answering
            _warn "not answering at $_LD_HEALTH_URL"
        fi
    elif ! runtime_up; then
        LAUNCH_STATUS=no-runtime
        _warn "no container runtime is running — launch dashboard unavailable, THE PIPELINE STILL RUNS"
    else
        # ISOLATED FROM EVERY OTHER INSTALL ON THIS MACHINE, DETERMINISTICALLY. Two checkouts (a
        # dev tree and a dogfood copy, say) must both be able to run at once. Retries ONLY on a
        # subnet collision — any other failure (a bad Dockerfile, a missing image) would fail
        # identically on every candidate, burning through all of them and hiding the real error
        # behind four repeats of it.
        _LD_UP=1
        _LD_LOG="$(mktemp)"
        _LD_SUBNET=""
        for _LD_SUBNET in $(isolated_subnet_candidates "$ROOT"); do
            if (cd "$LAUNCH_DIR" && LAUNCH_SUBNET="$_LD_SUBNET" container_compose \
                    -f "$LAUNCH_COMPOSE" -p "$_LD_PROJECT" up -d --build) >"$_LD_LOG" 2>&1; then
                _LD_UP=0
                break
            fi
            grep -qi 'overlap\|pool' "$_LD_LOG" || break
        done

        if [ "$_LD_UP" = "1" ]; then
            LAUNCH_STATUS=failed
            _bad "launch dashboard failed to start: $(tail -3 "$_LD_LOG" 2>/dev/null)"
            FAILED=1
        elif wait_for_health "$_LD_HEALTH_URL" "$LAUNCH_HEALTH_TRIES" "$LAUNCH_HEALTH_INTERVAL"; then
            LAUNCH_STATUS=up
            _ok "up and healthy at $_LD_HEALTH_URL (project: $_LD_PROJECT, subnet: $_LD_SUBNET)"
        else
            LAUNCH_STATUS=unhealthy
            _bad "containers started but never answered healthy at $_LD_HEALTH_URL"
            FAILED=1
        fi
        rm -f "$_LD_LOG" 2>/dev/null
    fi
fi

# ── The command people will actually type ───────────────────────────────────
# ── What this install IS ──────────────────────────────────────────────────────
# An install whose mode can only be inferred from which containers happen to be running is an
# install nobody can reason about later. install.sh --check reads this rather than re-deriving.
if [ "$CHECK_ONLY" = "0" ]; then
    cat > "$ROOT/install-manifest.json" <<MANIFEST
{
  "stack": "${STACK}",
  "runner": "${RUNNER}",
  "containerRuntime": "${CONTAINER_RUNTIME}",
  "dashboards": "${USE_DOCKER}",
  "replay": "${REPLAY_MODE}",
  "project": "${EPAM_PROJECT:-}",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "installRoot": "${ROOT}",
  "launchDashboard": "${LAUNCH_STATUS}"
}
MANIFEST
fi

_head "Result"
if [ "$FAILED" = "1" ]; then
    _bad "install incomplete — fix the items marked ✗ above"
    exit 1
fi
_ok "ready"
printf '\n  Run a ticket:   %s\n' "./orchestrations/scripts/pipeline --jira ABC-1234"
printf '  Check first:    %s\n'   "./orchestrations/scripts/pipeline --jira ABC-1234 --dry-run"
printf '  Switch stack:   %s\n\n' "EPAM_PROVIDER_SET=<${ALL_SETS//,/|}> ./orchestrations/scripts/pipeline --jira ABC-1234"
