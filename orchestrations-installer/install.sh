#!/usr/bin/env bash
# install.sh — set this machine up to run the pipeline.
#
#   ./orchestrations-installer/install.sh                      install for the default stack, with dashboards if docker is up
#   ./install.sh --stack codemie      install for a specific stack
#   ./install.sh --no-docker          skip dashboards entirely
#   ./install.sh --check              verify an existing install, change nothing
#   ./install.sh --dest ~/somewhere --ref v1.7   package that ref into a NEW tree, then install it
#
# --dest IS THE WHOLE POINT FOR ANYONE WHO IS NOT THIS CHECKOUT. Without it, install.sh only ever
# configures the tree it is already sitting inside — which presupposes the code already arrived by
# some means nobody ever automated. A colleague with repo access runs ONE command, from their own
# clone, naming a tagged commit on the shared remote: no manual git archive, no manual re-provision,
# no LLM standing in for either.
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
DEST=""; REF=""; REPO_URL=""; UNINSTALL=0
while [ $# -gt 0 ]; do
    case "$1" in
        --dest)      DEST="${2:-}"; shift 2 ;;
        --ref)       REF="${2:-}"; shift 2 ;;
        --repo)      REPO_URL="${2:-}"; shift 2 ;;
        --stack)     STACK="${2:-}"; shift 2 ;;
        --no-docker) USE_DOCKER=no; shift ;;
        --docker)    USE_DOCKER=yes; shift ;;
        --check)     CHECK_ONLY=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        --help|-h)   sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)           _bad "unknown option '$1'"; exit 1 ;;
    esac
done

# ── Uninstall: the docker footprint ONLY, never the files on disk ────────────
#
# "we then have to be able to safely uninstall without affecting dev environment" (operator,
# 2026-09-03). STRUCTURALLY incapable of touching the dev environment, not merely unlikely to:
# isolated_project_name() always produces "test-install-amsd-pipeline-<suffix>-<number>"; the real
# hand-run dev stack names itself "dev-amsd-pipeline"/"dev-amsd-pipeline-launch" via each compose
# file's own top-level `name:` key. Those two prefixes cannot collide — verified live against real
# Docker, not assumed: the dev stack's actual volumes/networks/project name were confirmed
# completely distinct from an isolated install's.
#
# NEVER THE FILES. Run evidence and .env live under $ROOT (or --dest) either way — uninstall
# removes containers, the network, the volumes AND any images built for THIS install's own project
# (never a shared base image — `--rmi local` only removes images built by this compose file, not
# pulled ones), then prunes now-dangling build layers left behind by `--build`, and reports that
# the directory itself was left alone, in case an operator was about to `rm -rf` it on the
# assumption uninstall already did.
if [ "$UNINSTALL" = "1" ]; then
    _head "Uninstall"
    _UN_ROOT="$ROOT"
    if [ -n "$DEST" ]; then
        _UN_ROOT="$(cd "$DEST" 2>/dev/null && pwd)"
        if [ -z "$_UN_ROOT" ]; then
            _bad "--dest $DEST does not exist — nothing to uninstall there"
            exit 1
        fi
    fi
    # STOP THE RUNNER HOST FIRST — it is NOT docker-related (a plain host process), so it must not
    # be skipped by the "no container runtime, nothing to uninstall" exit below.
    _UN_RH_PIDFILE="$_UN_ROOT/launch-dashboard/.runner-host.pid"
    _UN_RH_WAS_RUNNING=""
    [ -f "$_UN_RH_PIDFILE" ] && _UN_RH_WAS_RUNNING="$(cat "$_UN_RH_PIDFILE" 2>/dev/null)"
    . "$INSTALLER_DIR/lib/runner-host-control.sh"
    if stop_runner_host "$_UN_ROOT/launch-dashboard" && [ -n "$_UN_RH_WAS_RUNNING" ]; then
        _ok "stopped runner-host (pid $_UN_RH_WAS_RUNNING)"
    fi
    _UN_SW_PIDFILE="$_UN_ROOT/orchestrations/dashboards/.snapshot-watch.pid"
    _UN_SW_WAS_RUNNING=""
    [ -f "$_UN_SW_PIDFILE" ] && _UN_SW_WAS_RUNNING="$(cat "$_UN_SW_PIDFILE" 2>/dev/null)"
    . "$INSTALLER_DIR/lib/snapshot-watch-control.sh"
    if stop_snapshot_watch "$_UN_ROOT" && [ -n "$_UN_SW_WAS_RUNNING" ]; then
        _ok "stopped snapshot-watch (pid $_UN_SW_WAS_RUNNING)"
    fi

    . "$INSTALLER_DIR/lib/isolated-compose-identity.sh"
    if [ -f "$INSTALLER_DIR/lib/container-runtime.sh" ]; then
        . "$INSTALLER_DIR/lib/container-runtime.sh"
    else
        _bad "missing $INSTALLER_DIR/lib/container-runtime.sh — cannot resolve a container runtime"
        exit 1
    fi
    if ! CONTAINER_RUNTIME="$(container_runtime 2>/dev/null)"; then
        _ok "no container runtime found — nothing docker-related to uninstall"
        exit 0
    fi
    _UN_OBS_PROJECT="$(isolated_project_name "$_UN_ROOT" obs)"
    _UN_LD_PROJECT="$(isolated_project_name "$_UN_ROOT" launch)"
    for _UN_SPEC in "docker-compose.observability.yml:$_UN_OBS_PROJECT" "launch-dashboard/docker-compose.yml:$_UN_LD_PROJECT"; do
        _UN_FILE="${_UN_SPEC%%:*}"; _UN_PROJECT="${_UN_SPEC##*:}"
        _UN_COMPOSE="$_UN_ROOT/$_UN_FILE"
        if [ -f "$_UN_COMPOSE" ]; then
            if (cd "$(dirname "$_UN_COMPOSE")" && container_compose \
                    -f "$(basename "$_UN_COMPOSE")" -p "$_UN_PROJECT" down -v --remove-orphans --rmi local) >/dev/null 2>&1; then
                _ok "removed $_UN_PROJECT (containers, network, volumes, images)"
            else
                _ok "$_UN_PROJECT: nothing to remove or already gone"
            fi
            # SCOPED PRUNE, never a bare `docker system prune` — that would also sweep up the dev
            # environment's own dangling layers. Compose stamps every image it builds with this
            # label, so filtering on it prunes only leftovers this exact project could have made.
            "$CONTAINER_RUNTIME" image prune -f --filter "label=com.docker.compose.project=$_UN_PROJECT" >/dev/null 2>&1 || true
        fi
    done
    _ok "files under $_UN_ROOT were NOT touched — remove the directory yourself when you are done with it"
    exit 0
fi

# ── Package a ref into a NEW tree, then install THAT — never a hand-run git archive ──
#
# THE SOURCE OF TRUTH IS THE GIT COMMIT, never a manual copy. `git archive` reads only tracked,
# committed content: untracked and gitignored files (real credentials among them) are structurally
# excluded, not filtered by a list that can miss one — proven this same repo: a raw tar shipped 8
# live credentials that git archive does not even see.
#
# INSTALLER_DIR NORMALLY NEVER MOVES. Every lib/*.sh this script sources still comes from where
# THIS install.sh lives, regardless of --dest — the archived copy that lands inside DEST is inert
# bystander content, same as it always has been. What --dest changes is $ROOT: everything below
# (.env, dist/, the compose files, the manifest) now addresses the freshly-packaged tree instead of
# wherever this script happened to be sitting.
#
# THE ONE EXCEPTION: a bare install.sh with no lib/ directory next to it (obtained alone — npx, a
# raw single-file download) self-clones below, and INSTALLER_DIR is repointed at that fresh clone's
# own orchestrations-installer/ — the only tree that is guaranteed to actually have the lib files
# this script is about to source.
if [ -n "$DEST" ]; then
    _head "Packaging"
    if git -C "$INSTALLER_DIR" rev-parse --git-dir >/dev/null 2>&1; then
        # THE REPO ROOT, NOT WHEREVER install.sh HAPPENS TO LIVE. `git archive` scopes its output
        # to the CURRENT WORKING TREE'S SUBDIRECTORY, not the whole repo — running it with `-C
        # $INSTALLER_DIR` (orchestrations-installer/, a SUBDIRECTORY) archived only install.sh and
        # lib/, silently dropping the entire rest of the pipeline. Caught by actually running the
        # packaged result and watching the very next step fail with "no provider-sets.json", not by
        # reading the git-archive docs and assuming.
        _GIT_ROOT="$(git -C "$INSTALLER_DIR" rev-parse --show-toplevel 2>/dev/null)"
        if [ -z "$_GIT_ROOT" ]; then
            _bad "could not resolve the repo root from $INSTALLER_DIR"
            exit 1
        fi
    else
        # NOTHING PRE-EXISTING REQUIRED. The only thing anyone needs to have obtained is
        # install.sh ITSELF — however (npx, a raw download, a shared drive) — everything else,
        # including the clone, happens here. This is what makes "for other people, not just me,
        # and no local to use" actually true: someone with only this one file and git+node on PATH
        # gets a full working install, no separate `git clone` step for them to run by hand.
        #
        # PUBLIC HTTPS, so no credential is needed to obtain it — the repo is public. --repo (or
        # EPAM_REPO) overrides for a fork or a private mirror.
        _REPO_URL="${REPO_URL:-${EPAM_REPO:-https://github.com/dune94/epam-cli.git}}"
        _CLONE_DIR="$(mktemp -d)" || { _bad "could not create a temp directory to clone into"; exit 1; }
        if ! git clone --quiet "$_REPO_URL" "$_CLONE_DIR" 2>&1; then
            _bad "could not clone $_REPO_URL — check network access, or pass --repo for a different URL"
            exit 1
        fi
        _ok "cloned $_REPO_URL"
        _GIT_ROOT="$_CLONE_DIR"
        # INSTALLER_DIR NOW MOVES — the one exception to the rule stated below. A bare install.sh
        # obtained alone (npx, a raw single-file download) has no lib/ directory sitting next to
        # it at all; every lib/*.sh source below would fail "No such file or directory" otherwise.
        # The freshly-cloned tree has a complete, version-consistent copy of everything install.sh
        # needs, so it becomes the new INSTALLER_DIR.
        if [ -d "$_CLONE_DIR/orchestrations-installer/lib" ]; then
            INSTALLER_DIR="$_CLONE_DIR/orchestrations-installer"
        fi
    fi
    _PKG_REF="${REF:-HEAD}"
    # FETCH FIRST: a colleague packaging a release just tagged by someone else may not have it yet.
    git -C "$_GIT_ROOT" fetch --tags --quiet >/dev/null 2>&1 || true
    if ! git -C "$_GIT_ROOT" rev-parse --verify "${_PKG_REF}^{commit}" >/dev/null 2>&1; then
        _bad "ref '$_PKG_REF' does not exist in this checkout, even after fetching tags"
        exit 1
    fi
    mkdir -p "$DEST" || { _bad "could not create $DEST"; exit 1; }
    DEST="$(cd "$DEST" && pwd)"
    # AN UPDATE MUST NEVER DESTROY RUN EVIDENCE. Extracting the ref straight over an EXISTING
    # install would overwrite whatever that ref's git history holds at orchestrations/logs/ (5,268
    # tracked files there, several genuinely real run evidence) — silently discarding a colleague's
    # actual run history on every re-run. run-state-paths.json declares what an update must never
    # touch; a first install into an empty $DEST is unaffected either way.
    _RUN_STATE_EXCLUDES=()
    if [ -f "$INSTALLER_DIR/run-state-paths.json" ]; then
        . "$INSTALLER_DIR/lib/preserve-run-state.sh"
        while IFS= read -r _excl; do
            [ -n "$_excl" ] && _RUN_STATE_EXCLUDES+=("$_excl")
        done < <(run_state_exclude_args "$INSTALLER_DIR/run-state-paths.json")
    fi

    # AN UPDATE MUST NEVER OVERWRITE AN OPERATOR'S EXISTING PROJECT CONFIG EITHER — a DIFFERENT
    # mechanism from the excludes above, deliberately: a blanket exclude would also block a
    # brand-new project's config.env from ever being extracted the first time a later ref adds
    # one. Snapshot whatever already exists now, extract, then restore it over what the ref just
    # wrote — so a first install (or a genuinely new project) is unaffected either way.
    _OPCFG_TMP=""
    if [ -f "$INSTALLER_DIR/operator-config-paths.json" ]; then
        . "$INSTALLER_DIR/lib/preserve-operator-config.sh"
        _OPCFG_TMP="$(mktemp -d)"
        snapshot_operator_config "$DEST" "$INSTALLER_DIR/operator-config-paths.json" "$_OPCFG_TMP"
    fi

    # The ${arr[@]+"${arr[@]}"} form, not bare "${arr[@]}": bash <4.4 (macOS ships 3.2 by default,
    # GPLv3 licensing) throws "unbound variable" under `set -u` expanding an empty array the plain
    # way. This form is safe on every bash this installer might run under.
    if ! git -C "$_GIT_ROOT" archive "$_PKG_REF" \
            | tar -x -C "$DEST" "${_RUN_STATE_EXCLUDES[@]+"${_RUN_STATE_EXCLUDES[@]}"}"; then
        _bad "packaging '$_PKG_REF' into $DEST failed"
        [ -n "$_OPCFG_TMP" ] && rm -rf "$_OPCFG_TMP"
        exit 1
    fi

    if [ -n "$_OPCFG_TMP" ]; then
        restore_operator_config "$DEST" "$_OPCFG_TMP"
        rm -rf "$_OPCFG_TMP"
    fi
    # THE EXCLUDES ABOVE MEAN TAR NEVER CREATES THESE PATHS, FRESH INSTALL INCLUDED — see
    # run_state_ensure_dirs in lib/preserve-run-state.sh for why that is a real defect (root-owned
    # orchestrations/logs, confirmed live 2026-09-04) and not just "nothing to restore yet". Created
    # here, owned by the operator running this installer, before Docker or anything else can create
    # one of them first under a different identity.
    if [ -f "$INSTALLER_DIR/run-state-paths.json" ]; then
        run_state_ensure_dirs "$INSTALLER_DIR/run-state-paths.json" "$DEST"
    fi
    _ok "packaged $_PKG_REF into $DEST"
    # THE VERSION ACTUALLY INSTALLED, resolved from the ref that was packaged — never a literal.
    # The dashboard shows this per run as the "code level", and it is the only answer an operator
    # has to "what version is this box on". It came from EPAM_CODE_LEVEL hardcoded in
    # launch-dashboard/.env.example and copied verbatim into every install ever made, so every
    # install on every version reported the same frozen string.
    _CODE_LEVEL="$(git -C "$_GIT_ROOT" describe --tags --exact-match "$_PKG_REF" 2>/dev/null \
                   || git -C "$_GIT_ROOT" describe --tags --always "$_PKG_REF" 2>/dev/null \
                   || printf '%s' "$_PKG_REF")"
    ROOT="$DEST"
    CONFIG="$ROOT/orchestrations/config"
fi

# AN IN-PLACE INSTALL RESOLVES ITS VERSION THE SAME WAY — from the tree it is installing, so the
# answer is a fact about that tree rather than about how the installer was invoked.
if [ -z "${_CODE_LEVEL:-}" ]; then
    _CODE_LEVEL="$(git -C "$ROOT" describe --tags --always 2>/dev/null || printf 'unknown')"
fi

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
# .env.example IS GENERATED, never hand-maintained — it went stale in both directions: this repo's
# root template never mentioned openrouter's own required OPENROUTER_API_KEY/MINIMAX_API_KEY
# (declared in provider-sets.json, absent from what an operator was told to fill in), and
# launch-dashboard's template kept calling EPAM_PROVIDER_SET "REQUIRED" long after that requirement
# was removed from config.js. Regenerated every install so it cannot drift stale again — .env
# itself is never touched, only the template.
if [ "$CHECK_ONLY" = "0" ] && [ -f "$CONFIG/provider-sets.json" ]; then
    . "$INSTALLER_DIR/lib/generate-env-example.sh"
    if generate_env_example "$CONFIG/provider-sets.json" "$CONFIG/env-vars.json" "$ROOT/.env.example" 2>/dev/null; then
        _ok ".env.example regenerated from provider-sets.json"
    else
        _warn "could not regenerate .env.example — using whatever is already there"
    fi
fi

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

# EXISTENCE IS NOT SUFFICIENCY — the same defect class already fixed for dist/epam.js
# ("EXISTENCE IS NOT A BUILD, either way"). A copied-but-unfilled .env (still holding the empty
# placeholders the template ships with) reported "present" and nothing more, so a stack's own
# REQUIRED credential could sit empty all the way to the first paid call before anyone noticed.
if [ -f "$ROOT/.env" ] && [ -f "$ROOT/orchestrations/scripts/lib/set-credentials.sh" ]; then
    _missing_creds="$(
        set -a; . "$ROOT/.env" 2>/dev/null; set +a
        . "$ROOT/orchestrations/scripts/lib/set-credentials.sh"
        while IFS=$'\t' read -r _c_env _c_from _c_req; do
            [ "$_c_req" = "1" ] || continue
            eval "_c_val=\${$_c_from:-}"
            [ -z "$_c_val" ] && printf '%s ' "$_c_from"
        done < <(EPAM_PROVIDER_SET="$STACK" _set_credentials_decl 2>/dev/null)
    )"
    if [ -n "$(printf '%s' "$_missing_creds" | tr -d '[:space:]')" ]; then
        _bad "the '$STACK' stack needs these, still empty in .env: $_missing_creds"
        FAILED=1
    else
        _ok "required '$STACK' credentials are filled in"
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

# BUILD BEFORE UP, OR THE HEALTHCHECK FAILS BY CONSTRUCTION. orchestrations/dashboards/live/ is
# gitignored — eleventy's own build output, never tracked — so on every fresh install it starts
# EMPTY. agent-monitor's healthcheck probes `/`, nginx has no index and autoindex is off, so a
# brand-new install was 403-unhealthy FOREVER regardless of docker, subnet or port: found live
# 2026-09-03, grafana (depends_on agent-monitor: condition service_healthy) never even started —
# stuck at "Created". Only a completed pipeline run (or this build) ever populated live/ before.
#
# Only when there is something to build FROM (src/ present, same test the Build section above
# uses) — a packaged, src/-less install ships no eleventy at all.
if [ -d "$ROOT/src" ] && [ -f "$ROOT/package.json" ]; then
    if (cd "$ROOT" && npm run dashboards:build --silent >/dev/null 2>&1); then
        _ok "dashboards built — agent-monitor has real content to serve"
    else
        _warn "dashboards:build failed — agent-monitor's healthcheck may fail until a run populates it"
    fi
fi

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
# ISOLATED FROM EVERY OTHER INSTALL ON THIS MACHINE, DETERMINISTICALLY — never a human hand-picking
# a free subnet. The compose file's own default (EPAM_OBS_SUBNET:-172.31.0.0/16) is a FIXED
# constant: two installs, or this exact install colliding with an already-running dev checkout on
# that same default, hit "Pool overlaps with other one on this address space" — the launch-dashboard
# section already had this fix; the observability stack never did.
. "$INSTALLER_DIR/lib/isolated-compose-identity.sh"
_OBS_PROJECT="$(isolated_project_name "$ROOT" obs)"
compose_up() {
    if [ ! -f "$COMPOSE_FILE" ]; then
        _bad "compose file not found: $COMPOSE_FILE"; FAILED=1; return 1
    fi
    local _up=1 _log _subnet _i=0
    _log="$(mktemp)"
    for _subnet in $(isolated_subnet_candidates "$ROOT"); do
        # ATTEMPT 0 KEEPS THE WELL-KNOWN PORTS EXACTLY (offset 0) — a normal single-install machine
        # sees no change at all, still :3100, :8092, :8123, :3001. Only a genuine collision (this
        # exact stack already running, or a second install) steps to the next attempt's offset, so
        # no manual port flag is ever required for this to just work.
        local _off=$((_i * 10))
        if (cd "$ROOT" && EPAM_OBS_SUBNET="$_subnet" \
                EPAM_OBS_CLICKHOUSE_PORT=$((8123 + _off)) \
                EPAM_OBS_LANGFUSE_PORT=$((3100 + _off)) \
                EPAM_OBS_DASHBOARD_PORT=$((8092 + _off)) \
                EPAM_OBS_GRAFANA_PORT=$((3001 + _off)) \
                container_compose -f "$COMPOSE_FILE" -p "$_OBS_PROJECT" up -d) >"$_log" 2>&1; then
            _up=0
            break
        fi
        # ONLY RETRY ON A SUBNET OR PORT COLLISION — any other failure would fail identically on
        # every candidate, burning through all of them and hiding the real error behind repeats.
        grep -qiE 'overlap|pool|port is already allocated|address already in use' "$_log" || break
        # TEAR DOWN BEFORE THE NEXT ATTEMPT. A failed `up -d` still CREATES whatever services it
        # got to before the failing one — found live: postgres/redis/clickhouse started fine on
        # attempt 0, agent-monitor's port collision failed the overall command, and attempt 1's
        # NEW port env was silently ignored for the already-Created containers, which stayed bound
        # to attempt 0's (colliding) ports. Compose does not cleanly re-resolve an already-created
        # container's config from new env vars on a later `up` — each attempt needs a clean slate.
        (cd "$ROOT" && container_compose -f "$COMPOSE_FILE" -p "$_OBS_PROJECT" down) >/dev/null 2>&1 || true
        _i=$((_i + 1))
    done
    if [ "$_up" != "0" ]; then
        _bad "$CONTAINER_RUNTIME compose failed for $COMPOSE_FILE — the services are NOT running: $(tail -3 "$_log" 2>/dev/null)"
        FAILED=1
        rm -f "$_log" 2>/dev/null
        return 1
    fi
    # PERSISTED so `pipeline-services.sh --start` can bring this exact stack back up later
    # (after a WSL restart, a deliberate stop) WITHOUT re-rolling a different subnet/port —
    # `down` (no -v) removes the network, so a later `up` with no env at all would fall back to
    # the compose file's own default subnet and could collide with the dev stack or another
    # install. Written fresh on every successful compose_up() — this IS the current identity.
    {
        printf 'OBS_PROJECT=%s\n' "$_OBS_PROJECT"
        printf 'OBS_SUBNET=%s\n' "$_subnet"
        printf 'OBS_CLICKHOUSE_PORT=%s\n' "$((8123 + _off))"
        printf 'OBS_LANGFUSE_PORT=%s\n' "$((3100 + _off))"
        printf 'OBS_DASHBOARD_PORT=%s\n' "$((8092 + _off))"
        printf 'OBS_GRAFANA_PORT=%s\n' "$((3001 + _off))"
        # THE REHEARSAL SERVER'S IDENTITY, resolved here and started nowhere.
        #
        # llm-defaults.mockserver.json points all 40 seams at MockServer, and until now nothing in
        # the installer knew it existed: `grep -c mock install.sh` was zero. So the only running
        # instance belonged to whichever tree someone had hand-started it from — on 2026-09-04 a
        # TEST install was about to rehearse against the DEV checkout's container — and
        # pipeline-services.sh --stop, the operator's "pause everything", left a JVM running.
        #
        # RESOLVED, NOT STARTED: a rehearsal is an occasional act, and a permanently running
        # MockServer is memory held for a run nobody asked for. `--start --mock` brings it up, and
        # `--stop` always takes it down, using exactly the identity recorded here.
        #
        # The subnet sequence is seeded with a DIFFERENT string from the observability stack's, so
        # the two cannot deterministically pick the same range on the same destination.
        printf 'MOCK_PROJECT=%s\n' "$(isolated_project_name "$ROOT" mock)"
        printf 'MOCK_SUBNET=%s\n' "$(isolated_subnet_candidates "$ROOT-mock" | head -1)"
    } > "$ROOT/.pipeline-services-state.env"
    rm -f "$_log" 2>/dev/null
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

# ── Snapshot watch: keeps agent-monitor's build-info.json fresh ─────────────
# A HOST process, same class as runner-host.js: it writes orchestrations/dashboards/live/
# build-info.json on the host filesystem, which agent-monitor's nginx container only reads via a
# bind mount. Without it, a run's own pre-flight fails 3 checks every time — found live
# 2026-09-04 against a genuinely fresh install ("snapshot-watch.js is NOT running").
_head "Snapshot watch (keeps the dashboard's build-info.json fresh)"
if [ "$CHECK_ONLY" != "1" ] && [ -f "$ROOT/orchestrations/scripts/snapshot-watch.js" ]; then
    . "$INSTALLER_DIR/lib/snapshot-watch-control.sh"
    start_snapshot_watch "$ROOT" || FAILED=1
else
    _ok "skipped"
fi

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

# THE CODE LEVEL IS STAMPED WHETHER OR NOT DOCKER IS IN PLAY, and on EVERY install — it is a fact
# about this tree, not a setting and not a property of the dashboard stack. Stamped before the
# docker branch below so --no-docker installs are labelled correctly too, and re-stamped every
# time because the normal way an operator seeds launch-dashboard/.env is copying it forward from
# their previous install, which carries that install's version with it.
_stamp_code_level() {
    local _f="$1"
    [ -f "$_f" ] || return 0
    if grep -q '^EPAM_CODE_LEVEL=' "$_f"; then
        local _t; _t="$(mktemp)"
        sed "s|^EPAM_CODE_LEVEL=.*|EPAM_CODE_LEVEL=${_CODE_LEVEL}|" "$_f" > "$_t" && mv "$_t" "$_f"
    else
        printf '\nEPAM_CODE_LEVEL=%s\n' "$_CODE_LEVEL" >> "$_f"
    fi
}
_stamp_code_level "$LAUNCH_DIR/.env"

if [ ! -f "$LAUNCH_COMPOSE" ]; then
    _ok "not present in this tree — nothing to provision"
elif [ "$USE_DOCKER" = "no" ]; then
    LAUNCH_STATUS=skipped
    _ok "skipped (--no-docker)"
else
    . "$INSTALLER_DIR/lib/wait-for-health.sh"
    . "$INSTALLER_DIR/lib/isolated-compose-identity.sh"

    # A VENDOR/API CREDENTIAL IS A DECISION ONLY A HUMAN MAKES — never synthesized (see the root
    # .env handling: copy the template, never invent a secret). LAUNCH_PASSWORD is a DIFFERENT
    # risk class: it gates a loopback-only local UI, not a billed vendor account or a shared
    # system — a blank one previously meant install.sh already knew this stack could not start
    # (it had just written this exact warning) and then attempted `up -d` anyway, hard-failing on
    # compose's `${LAUNCH_PASSWORD:?...}` interpolation instead of the warning it already gave.
    #
    # Operator decision 2026-09-04, SUPERSEDING the 2026-09-03 random-generation decision: a
    # RANDOM value made every install's password unknowable without reading the file, and
    # unrecoverable once a running container had it in memory — copying a newer .env over an
    # older one (exactly what moving credentials between two installs looks like) silently
    # desynced the file from the live process, and the only fix was a manual docker restart.
    # A FIXED, KNOWN default removes the ambiguity entirely: every fresh install starts on the
    # same well-known password, printed here and in the file either way, and the change-password
    # flow (Flutter UI, not this script) is how an operator actually secures it afterward.
    _DEFAULT_LAUNCH_PW="abcd1234"
    if [ ! -f "$LAUNCH_DIR/.env" ]; then
        if [ -f "$LAUNCH_DIR/.env.example" ]; then
            cp "$LAUNCH_DIR/.env.example" "$LAUNCH_DIR/.env"
            # REPLACE the template's blank line in place — never append a second
            # LAUNCH_PASSWORD= key. Both parse fine (bash sourcing takes the last one) but a
            # duplicate key is a needless trap for whoever reads this file by hand next.
            if grep -q '^LAUNCH_PASSWORD=' "$LAUNCH_DIR/.env"; then
                _LD_TMP="$(mktemp)"
                sed "s|^LAUNCH_PASSWORD=.*|LAUNCH_PASSWORD=$_DEFAULT_LAUNCH_PW|" "$LAUNCH_DIR/.env" > "$_LD_TMP" \
                    && mv "$_LD_TMP" "$LAUNCH_DIR/.env"
            else
                printf '\nLAUNCH_PASSWORD=%s\n' "$_DEFAULT_LAUNCH_PW" >> "$LAUNCH_DIR/.env"
            fi
            _stamp_code_level "$LAUNCH_DIR/.env"
            _ok "launch-dashboard/.env created with the default LAUNCH_PASSWORD"
            printf '      LAUNCH_PASSWORD: %s\n' "$_DEFAULT_LAUNCH_PW"
            printf '      CHANGE THIS after your first login — it is the same on every fresh install.\n'
        else
            _bad "launch-dashboard/.env is missing and there is no .env.example to create one from"
            FAILED=1
        fi
    fi

    # PRE-CREATE THE BIND-MOUNT SOURCES, AS THE HOST USER, BEFORE DOCKER EVER SEES THEM.
    #
    # The compose file's own comment above (services.launch-api) already names this exact trap: a
    # bind mount onto a directory that doesn't exist yet gets auto-created BY DOCKER, as root — and
    # launch-api's own `user: "${LAUNCH_UID:-1000}:..."` then cannot write to it. Found live
    # 2026-09-03 against a genuinely fresh install: "unable to open database file", launch-api
    # crash-looping, nginx's launch-ui reporting "host not found in upstream" as a downstream
    # symptom of the crash — same bug CLASS as the dashboards live/ directory fixed above, here for
    # ./data and ./spool specifically.
    mkdir -p "$LAUNCH_DIR/data" "$LAUNCH_DIR/spool"

    _LD_PORT="$(grep -E '^LAUNCH_UI_PORT=' "$LAUNCH_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2)"
    _LD_PORT="${_LD_PORT:-8099}"
    _LD_PROJECT="$(isolated_project_name "$ROOT" launch)"
    _LD_HEALTH_URL="http://localhost:${_LD_PORT}/api/health"

    _LD_PW="$(grep -E '^LAUNCH_PASSWORD=' "$LAUNCH_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2-)"
    if [ ! -f "$LAUNCH_DIR/.env" ]; then
        LAUNCH_STATUS=failed
    elif [ -z "$_LD_PW" ] && [ "$CHECK_ONLY" != "1" ]; then
        # KNOWN ALREADY, NEVER A SURPRISE CRASH. A .env from before LAUNCH_PASSWORD was
        # auto-generated (or one an operator deliberately blanked) still fails compose's
        # `${LAUNCH_PASSWORD:?...}` interpolation — skip the attempt instead of hitting it.
        LAUNCH_STATUS=failed
        _warn "launch-dashboard/.env has no LAUNCH_PASSWORD — skipping start; set one and re-run to bring it up"
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
        # dev tree and a dogfood copy, say) must both be able to run at once. Retries on a subnet
        # OR a port collision — found live, both are real: a second install's observability stack
        # hit the subnet default, and THIS stack hit LAUNCH_UI_PORT's default (8099) already held
        # by an earlier install on the same machine. Attempt 0 keeps the .env-declared port exactly
        # (no surprise for an operator who set one deliberately); only a genuine collision steps to
        # the next offset. Any OTHER failure (a bad Dockerfile, a missing image) would fail
        # identically on every candidate, burning through all of them and hiding the real error.
        _LD_UP=1
        _LD_LOG="$(mktemp)"
        _LD_SUBNET=""; _LD_I=0
        for _LD_SUBNET in $(isolated_subnet_candidates "$ROOT"); do
            _LD_TRY_PORT=$((_LD_PORT + _LD_I * 10))
            if (cd "$LAUNCH_DIR" && LAUNCH_SUBNET="$_LD_SUBNET" LAUNCH_UI_PORT="$_LD_TRY_PORT" \
                    container_compose -f "$LAUNCH_COMPOSE" -p "$_LD_PROJECT" up -d --build) >"$_LD_LOG" 2>&1; then
                _LD_UP=0
                _LD_PORT="$_LD_TRY_PORT"
                _LD_HEALTH_URL="http://localhost:${_LD_PORT}/api/health"
                break
            fi
            grep -qiE 'overlap|pool|port is already allocated|address already in use' "$_LD_LOG" || break
            # TEAR DOWN BEFORE THE NEXT ATTEMPT — same fix as the observability stack's retry
            # loop: a failed `up -d` can still CREATE containers attached to the failed attempt's
            # network/port before the failure, and compose does not cleanly re-attach an
            # already-created container to a DIFFERENT network or port on a later `up`. Each
            # attempt needs a clean slate.
            (cd "$LAUNCH_DIR" && container_compose -f "$LAUNCH_COMPOSE" -p "$_LD_PROJECT" down) >/dev/null 2>&1 || true
            _LD_I=$((_LD_I + 1))
        done

        if [ "$_LD_UP" = "1" ]; then
            LAUNCH_STATUS=failed
            _bad "launch dashboard failed to start: $(tail -3 "$_LD_LOG" 2>/dev/null)"
            FAILED=1
        elif wait_for_health "$_LD_HEALTH_URL" "$LAUNCH_HEALTH_TRIES" "$LAUNCH_HEALTH_INTERVAL"; then
            LAUNCH_STATUS=up
            _ok "up and healthy at $_LD_HEALTH_URL (project: $_LD_PROJECT, subnet: $_LD_SUBNET)"
            # Same reason as the observability stack's own state file — appended, not truncated:
            # that one is always written first in a single install.sh run.
            {
                printf 'LAUNCH_PROJECT=%s\n' "$_LD_PROJECT"
                printf 'LAUNCH_SUBNET=%s\n' "$_LD_SUBNET"
                printf 'LAUNCH_UI_PORT=%s\n' "$_LD_PORT"
            } >> "$ROOT/.pipeline-services-state.env"
        else
            LAUNCH_STATUS=unhealthy
            _bad "containers started but never answered healthy at $_LD_HEALTH_URL"
            FAILED=1
        fi
        rm -f "$_LD_LOG" 2>/dev/null
    fi
fi

# ── Runner host: what actually launches a pipeline run from the dashboard ────
# "the install script must start all services" (operator, 2026-09-04) — a saved launch request
# sat "pending" forever with nothing polling for it, because nothing ever started this.
#
# NOT DOCKERIZED, DELIBERATELY — same as runner-host.js's own header says: "a container cannot
# exec a host process." It spawns the pipeline's real launcher on the HOST, which needs git access
# to the codeline root, the claude/codemie-claude CLI's host auth (~/.claude — a container has none
# of this unless it were bind-mounted in), and host git credentials for anything that pushes.
# Containerizing the poll loop alone is easy (the spool it watches is already bind-mounted into
# launch-api); containerizing what it SPAWNS on a hit would mean containerizing the whole pipeline.
_head "Runner host (launches pipeline runs the dashboard queues)"
if [ "$LAUNCH_STATUS" = "up" ]; then
    . "$INSTALLER_DIR/lib/runner-host-control.sh"
    start_runner_host "$ROOT" "$LAUNCH_DIR" || FAILED=1
else
    _ok "skipped — launch dashboard status is '$LAUNCH_STATUS', nothing to poll for"
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
  "version": "${_CODE_LEVEL}",
  "launchDashboard": "${LAUNCH_STATUS}"
}
MANIFEST
fi

# ── Post-install health check — PROVE IT, do not just report having done it ──
#
# An installer that finishes its own steps and declares "ready" is reporting on ITSELF. Every
# operator-facing breakage on 2026-09-04 got past exactly that: the install did each step correctly
# and said ready, while the dashboard served 404 for /prd.json, Langfuse was probed on the wrong
# port, and a daemon held credentials nobody had filled in. A human opening a browser was the test.
#
# pipeline-health.sh already asks the RIGHT question — "can an operator launch a run from here,
# right now" — and probes the real endpoints. Running it here makes that the last word of every
# install, which is what the operator asked for: "why can't pipeline-health be used to detect all of
# these issues ... a post-install step to check pipeline health is best practice."
#
# ADVISORY, NOT FATAL. It reports on things an install legitimately cannot settle (no PRD ingested
# yet, an optional service nobody runs), so its verdict is surfaced and the install's own FAILED
# state is left to stand on its own. Skipped for --check (which IS a verification already) and when
# the install has already failed, where a second wall of red helps nobody.
if [ "$CHECK_ONLY" != "1" ] && [ "$FAILED" != "1" ] && [ -f "$INSTALLER_DIR/pipeline-health.sh" ]; then
    _head "Post-install health check"
    # --dest "$ROOT": the tree that was INSTALLED, never the installer's own location. Under
    # `npx amsd-pipeline` install.sh runs from a temp clone, so without this the check inspects
    # /tmp/tmp.XXXX and reports failures about a directory nobody installed into.
    if bash "$INSTALLER_DIR/pipeline-health.sh" --dest "$ROOT" 2>&1 | sed 's/^/  /'; then
        _ok "health check passed"
    else
        # THE FINAL WORD MUST NOT CONTRADICT THE CHECK ABOVE IT. Printing "not healthy" and then
        # "✓ ready" two lines later leaves an operator to guess which one to believe; the whole
        # point of running the probe here is that its answer is the install's answer.
        HEALTH_FAILED=1
        _warn "health check reported problems above — the install completed, but this machine is not ready to launch"
        _warn "re-run it any time: bash orchestrations-installer/pipeline-health.sh --dest \"$ROOT\""
    fi
fi

_head "Result"
if [ "$FAILED" != "1" ] && [ "${HEALTH_FAILED:-0}" = "1" ]; then
    _warn "installed, but NOT ready to launch — see the health check above"
    exit 1
fi
if [ "$FAILED" = "1" ]; then
    _bad "install incomplete — fix the items marked ✗ above"
    exit 1
fi
_ok "ready"
printf '\n  Run a ticket:   %s\n' "./orchestrations/scripts/pipeline --jira ABC-1234"
printf '  Check first:    %s\n'   "./orchestrations/scripts/pipeline --jira ABC-1234 --dry-run"
printf '  Switch stack:   %s\n\n' "EPAM_PROVIDER_SET=<${ALL_SETS//,/|}> ./orchestrations/scripts/pipeline --jira ABC-1234"
