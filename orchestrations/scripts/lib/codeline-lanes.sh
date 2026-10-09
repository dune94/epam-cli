#!/usr/bin/env bash
# One more pass per release line a shared codeline's story plan names (_run_release_lines, called by the lane loops below).
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-lines.sh"
# lane_declared_passed <codeline> — the operator declared this lane already passed in this run
# (EPAM_PASSED_LANES, space/comma separated). AMSD-2974, 2026-10-04: cx-shared reached GO before
# lanes recorded it; a resume re-ran it (--reset) and was OOM-killed. Operator-chosen.
lane_declared_passed() {
    local _l
    for _l in ${EPAM_PASSED_LANES//,/ }; do [ "$_l" = "${1:-}" ] && return 0; done
    return 1
}

# codeline-lanes.sh — moved verbatim out of run-agent-orchestration.sh by tools/split-main-into-modules.py
# (12 functions). Sourced by run-agent-orchestration.sh; SCRIPT_DIR and the globals it sets
# are in scope exactly as they were. A move, not an edit: every body is byte-identical to
# the golden recorded at the move (see the identity test).

# ── WHICH ROLE IS THIS PROCESS? ──────────────────────────────────────────────
#
# This one script is BOTH the parent orchestrator and, re-invoked once per codeline with
# JIRA_CODELINE_RUN=1, each lane. That is a deliberate design — a lane gets the identical
# pipeline — but it means every per-run resource is allocated twice, and every parent-only
# step needs a guard that somebody has to REMEMBER to write. Two defects came from exactly
# that omission:
#
#   - the resume block sat below the dispatch and ran in neither role correctly, so every
#     "resume" silently started a fresh run;
#   - the control-plane port derived identically in both roles, so the first lane killed the
#     parent's control plane and took its port.
#
# The role is named here, once, so a step can DECLARE which role it belongs to instead of
# re-deriving it from a raw environment variable at each site. Defined at the very top
# because entry guards and port resolution both run before anything else.
#
# A lane is a lane by virtue of JIRA_CODELINE_RUN — that variable is the contract between the
# parent's re-invocation and this block, and is read NOWHERE ELSE. See the guard test in
# test/unit/orchestration/orchestrator-role-is-explicit.test.ts.
orch_role() {
    if [ -n "${JIRA_CODELINE_RUN:-}" ]; then printf 'lane'; else printf 'parent'; fi
}

# is_lane — true in a per-codeline re-invocation. Guard work that is scoped to one repository.
is_lane() { [ "$(orch_role)" = 'lane' ]; }

# Detect the Node.js binary — checks fnm, nvm, and PATH in order.
# ── Which Node the CODELINE requires, and which one is installed ─────────────
#
# detect_node() listed four literal paths (v20.20.2 / v20.20.0 under fnm and nvm) and checked them
# BEFORE whatever `node` is on PATH. next.metrolinx.com declares Node 22 in three places — .nvmrc,
# package.json engines, and the .epam/codeline-facts.json this pipeline generated itself, which
# says "Node 22.x is required; other versions may not work" — and the engine ran its 245-file jest
# suite under 20 anyway. Any failure then reads as a defect in the story's code, and no env var
# existed to correct it.
#
# The requirement is a fact of the CODELINE. The runtime is DISCOVERED from what is installed.
# Neither is a literal here: replacing the v20 list with a v22 list would just move the defect.
_codeline_node_requirement() {
    local _root="${1:-${PROJECT_ROOT:-}}"
    [ -n "$_root" ] || return 0
    # .nvmrc exists for exactly this purpose, so it is asked first.
    if [ -f "$_root/.nvmrc" ]; then
        head -1 "$_root/.nvmrc" | sed -E 's/^[[:space:]]*v?//; s/[^0-9].*$//' | tr -d '[:space:]'
        return 0
    fi
    # Otherwise the manifest's own engines field. Major only: a codeline pinning a patch is
    # pinning its own business, and the engine matches what it can actually satisfy.
    if [ -f "$_root/package.json" ] && command -v jq >/dev/null 2>&1; then
        jq -r '.engines.node // ""' "$_root/package.json" 2>/dev/null \
            | sed -E 's/[^0-9]*([0-9]+).*/\1/' | tr -d '[:space:]'
        return 0
    fi
    printf ''
}

# detect_node [codeline_root]
#
# Install ROOTS are locations of standard version managers, overridable with
# EPAM_NODE_INSTALL_ROOTS (colon-separated). Paths, not versions — adding a Node release requires
# no edit here.
detect_node() {
    local _root="${1:-${PROJECT_ROOT:-}}"
    local _want; _want="$(_codeline_node_requirement "$_root" 2>/dev/null)"
    # A codeline that declares nothing inherits the ENGINE's own declaration — this repo states it
    # in .nvmrc and package.json engines, so it is read the same way rather than written here.
    # Without this, "declares nothing" would mean "highest installed", silently moving a green
    # codeline (mock3 declares neither) onto a major nobody chose.
    if [ -z "$_want" ]; then
        _want="$(_codeline_node_requirement "${EPAM_ENGINE_ROOT:-$SCRIPT_DIR/../..}" 2>/dev/null)"
    fi
    local _roots="${EPAM_NODE_INSTALL_ROOTS:-$HOME/.local/share/fnm/node-versions:$HOME/.nvm/versions/node}"

    local _cands="" _d _vd _ver _bin _major
    local _oifs="$IFS"; IFS=':'
    for _d in $_roots; do
        IFS="$_oifs"
        [ -d "$_d" ] || continue
        for _vd in "$_d"/v*; do
            [ -d "$_vd" ] || continue
            _ver="$(basename "$_vd")"
            _bin=""
            [ -x "$_vd/bin/node" ] && _bin="$_vd/bin/node"
            [ -z "$_bin" ] && [ -x "$_vd/installation/bin/node" ] && _bin="$_vd/installation/bin/node"
            [ -n "$_bin" ] || continue
            _major="${_ver#v}"; _major="${_major%%.*}"
            if [ -n "$_want" ] && [ "$_major" != "$_want" ]; then continue; fi
            _cands="${_cands}${_ver}\t${_bin}\n"
        done
        IFS=':'
    done
    IFS="$_oifs"

    # Highest version wins within whatever survived the requirement filter.
    if [ -n "$_cands" ]; then
        printf '%b' "$_cands" | sort -V | tail -1 | cut -f2
        return 0
    fi

    # PATH node only when it SATISFIES the requirement. Handing back a runtime the codeline said
    # will not work is how a green suite stops meaning anything.
    local _p; _p="$(command -v node 2>/dev/null || true)"
    if [ -n "$_p" ] && [ -x "$_p" ]; then
        if [ -z "$_want" ]; then echo "$_p"; return 0; fi
        local _pv; _pv="$("$_p" --version 2>/dev/null)"; _pv="${_pv#v}"; _pv="${_pv%%.*}"
        [ "$_pv" = "$_want" ] && { echo "$_p"; return 0; }
    fi
    echo ""
    return 1
}

# resolve_codeline_node <codeline_root>
# Resolves a node binary satisfying <codeline_root>/package.json's OWN
# "engines.node" declaration, installing it on demand via fnm if not already
# present. Fully data-driven — the required version comes entirely from the
# codeline's own manifest; no version number is ever hardcoded here, so this
# works for any Node version any codeline happens to declare.
#
# Live bug this closes (2026-07-22): the regression guard ran a codeline's
# vitest using detect_node()'s orchestrator-side Node (whatever fnm/nvm
# version happens to be active for THIS shell — v24.14.1 at the time), not
# the Node version the codeline itself was built/tested against
# ("engines": {"node": "^22"}). Running vitest under a mismatched major Node
# version crashed outright (SIGBUS/segfault from a native module ABI break),
# which the regression guard then reported as "tests broken" even though the
# codeline's own tests were never actually exercised.
#
# Falls back to detect_node()'s existing generic candidate search if the
# codeline declares no engines.node, fnm is unavailable, or the declared
# range can't be resolved/installed for any reason — this must never be the
# thing that blocks a run outright.
# provision_env_local_from_sample <codeline_root> <dest_.env.local_path>
#
# Some client apps throw at config-load time (e.g. a CMS SDK guard) when an
# expected env var is merely ABSENT, well before any network call is made —
# blocking local tooling (type-check/lint via a pre-commit hook) even though
# nothing here ever talks to the real service. Values only need to be
# PRESENT, never real credentials.
#
# This used to be a per-codeline block hand-written into an engine-side
# env-vars.json (added 2026-08-02, commit 359f7fa) — keys picked by trial and
# error against whatever `tsc`/lint failure was visible at the time. It
# missed MANAGEMENT_TOKEN entirely (AMSD-2041, 2026-08-05) because nothing
# ever went back to keep that hand-picked list in sync with what the
# codeline's OWN config actually reads. A codeline that already declares its
# full set of expected vars in its own `.env.local.sample` makes any
# engine-side copy of that list redundant and guaranteed to drift.
#
# So: read the codeline's own sample file and derive placeholders from ITS
# keys, not a list a human maintains here. A new var the client adds is
# picked up on the next run with zero edits to this repo. A codeline with no
# sample file gets nothing — inventing keys nobody declared would be the same
# mistake in the other direction.
provision_env_local_from_sample() {
    local codeline_root="$1" dest="$2"
    local sample="$codeline_root/.env.local.sample"
    [ -f "$sample" ] || return 0

    # Every `KEY=` line (KEY is the only part that means anything — the
    # sample's own values are just whatever placeholder or blank the client
    # left there, not credentials to reuse). One deterministic placeholder
    # per key, not a fixed table, so this needs no maintenance as the
    # codeline's own required-var set changes.
    grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$sample" | while IFS='=' read -r key _; do
        printf '%s=sandbox-placeholder-%s\n' "$key" "$(printf '%s' "$key" | tr '[:upper:]_' '[:lower:]-')"
    done > "$dest"
}

# provision_lane_worktree <codeline_root> <worktree_path>
#
# A brownfield lane's worktree gets what `git worktree add` cannot give it — the untracked state the
# pipeline provisioned into the codeline: the .epam/ declaration (copied), the env file (provisioned
# from the codeline's own sample, as the lane does), and the vendor directory provisioning populates
# (the declaration's FIRST vendorDir, linked). Nothing is installed: an install would reach the
# codeline's package registry, a client system (AMSD-2974, 2026-10-02). Same pattern as the baseline
# gates' worktrees (lib/tsc-baseline-gate.sh). Build output is not linked — it stays in the worktree.
provision_lane_worktree() {
    local _root="${1:-}" _wt="${2:-}"
    [ -n "$_root" ] && [ -d "$_root" ] && [ -n "$_wt" ] && [ -d "$_wt" ] || return 0
    if [ -d "$_root/.epam" ] && [ ! -e "$_wt/.epam" ]; then
        cp -r "$_root/.epam" "$_wt/.epam" 2>/dev/null || warning "  [worktree] could not copy .epam/ into $_wt"
    fi
    if [ ! -e "$_wt/.env.local" ]; then
        provision_env_local_from_sample "$_wt" "$_wt/.env.local"
    fi
    # The declaration is read where the baseline gate reads it (_bg_vendor_dirs): the project's own
    # first, then the codeline's — ensure_story_branch cleans the checkout's untracked .epam/.
    local _cfg="${EPAM_PROJECT_CONFIG_DIR:+$EPAM_PROJECT_CONFIG_DIR/dependency-check.json}" _vd=""
    [ -n "$_cfg" ] && [ -f "$_cfg" ] || _cfg="$_root/.epam/dependency-check.json"
    [ -f "$_cfg" ] && _vd=$(jq -r '.vendorDirs[0]? // empty' "$_cfg" 2>/dev/null || true)
    if [ -n "$_vd" ] && [ -d "$_root/$_vd" ] && [ ! -e "$_wt/$_vd" ]; then
        ln -s "$_root/$_vd" "$_wt/$_vd" || warning "  [worktree] could not link $_vd into $_wt"
    fi
    [ -n "$_vd" ] && link_sibling_builds "$_root" "$_wt" "$_vd"
    return 0
}

# link_sibling_builds <root> <worktree> <vendor-dir> — A SITE BUILDS AGAINST ITS SIBLING'S CHANGE.
#
# Operator, 2026-10-03: nothing installed, packed, published or fetched — "shared gets updated then
# dependent codelines get the branch". A codeline of a spanning story that declares a package another
# codeline of the SAME story provides (lib/handlers/sibling-providers.js) tests against that sibling's
# checkout — its story branch, its lane already merged — after the sibling's OWN declared build ran
# there (its ecosystem's buildCommand). The worktree gets its own vendor directory: a link to every
# entry of the codeline's, except the sibling's package, linked to the sibling's checkout. The
# codeline's own vendor directory is never touched, so its baseline keeps the installed release and
# a reproducing test still fails there.
# _link_entry <entry> <target> — point a vendor entry the worktree's own directory holds at <target>.
# The entry is only ever a link this file made (to the codeline's entry), so only a link is removed —
# never a directory, never anything whose path did not resolve.
_link_entry() {
    local _at="$1" _to="$2"
    [ -n "$_at" ] && [ -n "$_to" ] || return 1
    if [ -L "$_at" ]; then rm -f -- "$_at"; elif [ -e "$_at" ]; then warning "  [sibling] $_at is not a link — left as it is"; return 1; fi
    ln -s "$_to" "$_at"
}

# _place_sibling_package <at> <provider_checkout> <vendor_dir> — THE SIBLING'S PACKAGE, AS AN INSTALL HAS IT.
# A hard-linked copy of every entry of the provider's checkout except its own dependency directory and
# .git: real files inside the lane, so Node and Jest resolve the package's dependencies from the SITE.
# A link to the checkout loaded cx-shared's own React beside gotransit's (AMSD-2974, 2026-10-04): two
# React instances, hooks broken, the site's tests failing whatever the writer did. Same disk, no copy
# cost, nothing fetched. Only a copy this function made (its marker) is ever replaced.
_place_sibling_package() {
    local _at="$1" _from="$2" _vd="$3" _release="${4:-}" _e _n
    [ -n "$_at" ] && [ -n "$_vd" ] && [ -d "$_from" ] || return 1
    if [ -L "$_at" ]; then
        rm -f -- "$_at"
    elif [ -e "$_at" ]; then
        if [ -f "$_at/.epam-sibling-copy" ]; then
            rm -rf -- "${_at:?}"
        else
            warning "  [sibling] $_at is not a copy this pipeline made — left as it is"
            return 1
        fi
    fi
    mkdir -p "$_at" || return 1
    # SEEDED FROM THE RELEASE THE SITE HAS INSTALLED: what a release ships and the sibling's own build
    # does not regenerate (cx-shared's migration-tool-build, built by its release process) stays.
    if [ -n "$_release" ] && [ -d "$_release" ]; then
        for _e in "$_release"/* "$_release"/.[!.]*; do
            [ -e "$_e" ] || continue
            cp -al "$_e" "$_at/$(basename "$_e")" 2>/dev/null || cp -a "$_e" "$_at/$(basename "$_e")"
        done
    fi
    # The sibling's change on top: each of its entries replaces the release's.
    for _e in "$_from"/* "$_from"/.[!.]*; do
        [ -e "$_e" ] || continue
        _n=$(basename "$_e")
        case "$_n" in "$_vd"|.git) continue ;; esac
        [ -e "$_at/$_n" ] || [ -L "$_at/$_n" ] && rm -rf -- "${_at:?}/${_n:?}"
        cp -al "$_e" "$_at/$_n" 2>/dev/null || cp -a "$_e" "$_at/$_n"
    done
    : > "$_at/.epam-sibling-copy"
}

link_sibling_builds() {
    local _root="$1" _wt="$2" _vd="$3" _pairs _name _prov _bc _scope _base _e _stamp _suffix _story _lb _ld
    [ -n "${PRD_FILE:-}" ] && [ -f "$PRD_FILE" ] && [ -d "$_root/$_vd" ] || return 0
    _pairs=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/sibling-providers.js" "$PRD_FILE" "$_root" 2>/dev/null) || return 0
    [ -n "$_pairs" ] || return 0
    # The worktree's own vendor directory: every entry of the codeline's, linked.
    if [ -L "$_wt/$_vd" ]; then rm -f "$_wt/$_vd"; fi
    mkdir -p "$_wt/$_vd"
    for _e in "$_root/$_vd"/* "$_root/$_vd"/.[!.]*; do
        [ -e "$_e" ] || [ -L "$_e" ] || continue
        [ -e "$_wt/$_vd/$(basename "$_e")" ] || ln -s "$_e" "$_wt/$_vd/$(basename "$_e")"
    done
    local _fresh_vd
    while IFS=$'\t' read -r _name _prov _suffix _story; do
        [ -n "$_name" ] && [ -d "$_prov" ] || continue
        _fresh_vd=0
        # THE PROVIDER'S RELEASE LINE THIS CONSUMER RECEIVES (the story's plan): built from that line's story branch, in a
        # worktree of its own, so the consumer is proved against the back-port it will actually get.
        if [ -n "${_suffix:-}" ] && [ -n "${_story:-}" ]; then
            _lb="${EPAM_BRANCH_PREFIX:-}AI-${_story}${_suffix}"
            _ld="${_prov}-line${_suffix}"
            if git -C "$_prov" rev-parse -q --verify "refs/heads/${_lb}" >/dev/null 2>&1; then
                if [ -d "$_ld" ]; then git -C "$_ld" checkout -q --detach "$_lb" 2>/dev/null || true
                else git -C "$_prov" worktree add -q --detach "$_ld" "$_lb" 2>/dev/null || true; fi
                # ITS DEPENDENCIES INSIDE IT, as the provider's checkout has them: a hard-linked copy, never a link —
                # a bundler resolves real paths, and through a link it laid the line's build out from the parent
                # folder (build/cx-shared-line-7.x/src/...), failing every consumer import (AMSD-2974 run 3).
                if [ -L "$_ld/$_vd" ]; then rm -f -- "$_ld/$_vd"; fi
                if [ ! -e "$_ld/$_vd" ] && [ -d "$_prov/$_vd" ] && [ -d "$_ld" ]; then
                    cp -al "$_prov/$_vd" "$_ld/$_vd" 2>/dev/null || cp -a "$_prov/$_vd" "$_ld/$_vd"
                    _fresh_vd=1
                fi
                [ -d "$_ld" ] && _prov="$_ld"
            else
                warning "  [sibling] ${_name}: release line branch ${_lb} does not exist yet — testing against ${_prov} as it stands"
            fi
        fi
        # The sibling's own build, once per checkout state: the only command it runs is the one the
        # sibling declares; a failure is reported and the lane tests against what it has.
        _bc=$("${NODE_BIN:-node}" "$SCRIPT_DIR/lib/handlers/codeline-ecosystem.js" "$_prov" 2>/dev/null | jq -r '.buildCommand // empty' 2>/dev/null)
        _stamp="${LOG_DIR:-/tmp}/sibling-build-$(printf '%s' "$_prov" | md5sum | cut -c1-12)-$(git -C "$_prov" rev-parse --short HEAD 2>/dev/null || echo none)"
        # A build made against another dependency directory is not this checkout's build.
        [ "${_fresh_vd:-0}" = 1 ] && rm -f -- "$_stamp"
        if [ -n "$_bc" ] && [ ! -f "$_stamp" ]; then
            log "  [sibling] building ${_name} from ${_prov} ($(git -C "$_prov" branch --show-current 2>/dev/null)): $_bc"
            if (cd "$_prov" && bash -c "$_bc") > "${_stamp}.log" 2>&1; then
                : > "$_stamp"
            else
                warning "  [sibling] the build of ${_name} failed — see ${_stamp}.log; the lane tests against what ${_prov} holds"
            fi
        fi
        # Link the sibling's package into the worktree's vendor directory, scope by scope.
        case "$_name" in
            */*) _scope="${_name%%/*}"; _base="${_name#*/}"
                 if [ -L "$_wt/$_vd/$_scope" ]; then
                     rm -f "$_wt/$_vd/$_scope"; mkdir -p "$_wt/$_vd/$_scope"
                     for _e in "$_root/$_vd/$_scope"/*; do [ -e "$_e" ] && ln -s "$_e" "$_wt/$_vd/$_scope/$(basename "$_e")"; done
                 fi
                 mkdir -p "$_wt/$_vd/$_scope"
                 _place_sibling_package "$_wt/$_vd/$_scope/$_base" "$_prov" "$_vd" "$_root/$_vd/$_scope/$_base" ;;
            *)   _place_sibling_package "$_wt/$_vd/$_name" "$_prov" "$_vd" "$_root/$_vd/$_name" ;;
        esac
        log "  [sibling] ${_name} → ${_prov} in $(basename "$_wt") (the codeline keeps its installed release)"
    done <<< "$_pairs"
    return 0
}

resolve_codeline_node() {
    local codeline_root="$1"
    local pkg="$codeline_root/package.json"
    local required=""

    if [ -f "$pkg" ]; then
        required=$(node "$SCRIPT_DIR/lib/handlers/package-engines-node.js" "$pkg" 2>/dev/null || true)
    fi

    if [ -z "$required" ] || ! command -v fnm &>/dev/null; then
        detect_node
        return
    fi

    # fnm install/exec want a partial semver (e.g. "22", "20.10"), not a full
    # range operator like "^22" or ">=22 <23" — extract the first version-like
    # token from whatever the codeline declares. This is a heuristic, not a
    # full semver-range resolver, but covers the common declaration shapes
    # (^N, ~N, >=N, N.x, exact N.N.N) without hardcoding any specific version.
    local fnm_version
    fnm_version=$(echo "$required" | grep -oE '[0-9]+(\.[0-9]+){0,2}' | head -1)

    if [ -z "$fnm_version" ]; then
        detect_node
        return
    fi

    fnm install "$fnm_version" >/dev/null 2>&1 || true

    local resolved_bin
    resolved_bin=$(fnm exec --using="$fnm_version" -- node -e 'process.stdout.write(process.execPath)' 2>/dev/null || true)

    if [ -n "$resolved_bin" ] && [ -x "$resolved_bin" ]; then
        echo "$resolved_bin"
        return 0
    fi

    detect_node
}

# ensure_node_modules_healthy <codeline_root> <node_bin> <test_bin>
# Detects a missing or CORRUPTED dependency install (not just "missing") and
# repairs it via detect_and_install_dependencies() — never by editing any
# manifest file, which stays purely a manual, case-by-case decision (see the
# azure.commerce.cdts cx-shared incident, 2026-07-22 — that repair required
# temporarily stripping a private-registry dependency and was done as an
# explicit, user-approved one-off, not baked into automated tooling).
#
# Live bug this closes: a prior interrupted/killed install left node_modules
# with truncated native binaries (esbuild, rollup) — present on disk, correct
# file names, but silently corrupted. A plain "does node_modules exist" check
# would have missed this entirely; the failure only surfaced when vitest
# actually tried to load them and crashed outright (SIGBUS/segfault) instead
# of a normal test failure. This function directly smoke-tests the SAME
# binary the regression guard is about to invoke ("<test_bin> --version"),
# which is the cheapest, most direct way to know whether it will actually
# work — no need to guess at which native files might be corrupted, or fetch
# reference file sizes from a registry.
#
# Returns 0 (healthy or successfully repaired) or 1 (still broken after a
# genuine repair attempt — e.g. a private-registry auth wall with no
# credentials available). Never silent: logs what it found and did either way.
ensure_node_modules_healthy() {
    local codeline_root="$1"
    local node_bin="$2"
    # Set for the child process invoked below, or read by a script that sources this file.
    # ShellCheck cannot see the consumer, so it reports these unused; removing them takes the value away.
    # shellcheck disable=SC2034
    local test_bin="$3"   # legacy: an arbitrary .bin entry, no longer trusted

    # Probe the runner the PROJECT DECLARES, not whatever sorts first in
    # node_modules/.bin. Live metrolinx 2026-07-29: the old probe picked
    # `escodegen` (alphabetically first), ran `node escodegen --version`, got
    # "Invalid option '--version'" — and condemned three codelines whose trees
    # were fine (`jest --version` -> 29.5.0 on the same tree). It had always
    # behaved this way; the caller's `|| true` hid it until that mask came off
    # and every lane stopped.
    local _declared _runner
    _declared="$(jq -r '.scripts.test // ""' "$codeline_root/package.json" 2>/dev/null || echo "")"
    # First word of the declared command is the runner: "jest --ci" -> jest.
    # Derived from what the project says, so an unknown stack needs no changes.
    _runner="${_declared%% *}"

    if [ -z "$_runner" ]; then
        # INCONCLUSIVE, not broken. We cannot identify a runner, so we cannot
        # claim the tree is unusable — and halting on "cannot tell" is the
        # escodegen bug with a different trigger. Step 5 runs the project's real
        # test command next, which is the actual question anyway.
        warning "  [node-modules-health] could not determine health: $codeline_root declares no test script — deferring to the real test command"
        return 0
    fi

    local _runner_bin="$codeline_root/node_modules/.bin/$_runner"
    if [ -x "$_runner_bin" ]; then
        if "$node_bin" "$_runner_bin" --version >/dev/null 2>&1; then
            return 0
        fi
        warning "  [node-modules-health] declared runner '$_runner' exists but failed --version — dependencies present but corrupted, attempting repair..."
    else
        warning "  [node-modules-health] declared runner '$_runner' not found in $codeline_root/node_modules/.bin — attempting install..."
    fi

    detect_and_install_dependencies "$codeline_root" "$node_bin"
}

# ── Codeline bridge agent ─────────────────────────────────────────────────────
# Runs after a codeline completes. Extracts its exported API surface and writes
# a cross-codeline contract to logs/cross-codeline-<cl>.md.
# Exports CROSS_CODELINE_CONTRACT_<CL_UPPER> so the next codeline's re-exec
# can inject the contract into its story agents' context.
#
# Retry policy: up to BRIDGE_MAX_RETRIES (default 2) re-attempts on failure or
# missing/empty output, with a corrective re-prompt on each retry explaining
# exactly what went wrong. After all retries:
#   CODELINE_BRIDGE_BLOCK_ON_FAILURE=true  → exit 1 (hard abort)
#   CODELINE_BRIDGE_BLOCK_ON_FAILURE=false → warn and continue (fe proceeds
#     without the contract — degraded but not pipeline-corrupting)
#
# $1 — completed codeline name (e.g. 'be')
# $2 — completed codeline worktree path
# $3 — filtered PRD path for the completed codeline
_run_codeline_bridge() {
  local _bcl="$1" _bwt="$2" _bprd="$3"
  local _bridge_out="${LOG_DIR}/cross-codeline-${_bcl}.md"
  local _profiles_file="${EPAM_AGENTS_DIR:-$AUTOMATION_DIR/agents}/profiles.json"
  local _bridge_max_retries="${BRIDGE_MAX_RETRIES:-2}"

  log "[bridge] Extracting cross-codeline contract for '${_bcl}' → ${_bridge_out}"

  # The bridge agent's identity is its SI (seam codeline-bridge-agent), resolved by the hub — never a
  # persona pasted into the prompt (operator, 2026-09-30: one path).

  _cp_vals=$(mktemp "${TMPDIR:-/tmp}/codeline-bridge-vals-XXXXXX.json")
  jq_vals \
        --arg bridge_out "${_bridge_out}" \
        --arg bprd "${_bprd}" \
        --arg bcl "${_bcl}" \
        --arg bwt "${_bwt}" \
        '{"__BRIDGE_OUT__":$bridge_out,"__BPRD__":$bprd,"__BCL__":$bcl,"__BWT__":$bwt}' > "$_cp_vals"
  local _base_prompt
  _base_prompt="$(render_engine_prompt codeline-bridge "$_cp_vals")"
  rm -f "$_cp_vals"

  local _bridge_attempt=0 _bridge_ok=0 _corrective_note=""
  while [ "$_bridge_attempt" -le "$_bridge_max_retries" ]; do
    # Prepend corrective note on retries so the agent knows exactly what failed
    local _bridge_prompt="${_corrective_note:+CORRECTION REQUIRED — YOUR PREVIOUS ATTEMPT FAILED: ${_corrective_note}

}${_base_prompt}"

    local _bridge_rc=0
    rm -f "$_bridge_out"
    # Tools granted below with no restricted allowlist (unlike the read-only
    # QA gates' ORCH_GATE_ALLOWED_TOOLS): this agent's whole job is
    # to read real source files in BRIDGE_SRC_DIR and WriteFile the extracted
    # contract to BRIDGE_OUT_FILE — the read-only allowlist would let it read
    # but never persist its own output. Found live (2026-07-31 agent audit):
    # this call went through plain run_orch_prompt with no tool grant at all,
    # --no-tools — the same class of gap already fixed once for
    # code-graph-detective/failure-analyst. Budgeted like every other
    # tool-bearing gate call in this file.
    local _bridge_reply; _bridge_reply="$(mktemp "${TMPDIR:-/tmp}/codeline-bridge-reply-XXXXXX")"
    AI_GATE_ALLOW_TOOLS=1 EPAM_MAX_TOOL_CALLS="${CODELINE_BRIDGE_MAX_TOOL_CALLS:-10}" \
        run_orch_prompt "$_bridge_prompt" "codeline-bridge-agent" "$_bcl" > "$_bridge_reply" || _bridge_rc=$?
    # THE ENGINE PERFORMS THE WRITE. The contract is the agent's ANSWER; the file lies outside the
    # folder the agent may write in, so on copilot every lane's three attempts returned the full
    # contract as text and "failed" (AMSD-2974, 2026-10-01). A file the agent wrote itself still wins.
    if [ "$_bridge_rc" = "0" ] && [ ! -s "$_bridge_out" ] && [ -s "$_bridge_reply" ]; then
      cp "$_bridge_reply" "$_bridge_out"
    fi
    rm -f "$_bridge_reply"

    # Determine success: exit 0 AND file exists AND file is non-empty
    if [ "$_bridge_rc" = "0" ] && [ -f "$_bridge_out" ] && [ -s "$_bridge_out" ]; then
      _bridge_ok=1
      break
    fi

    # Diagnose the specific failure for the corrective re-prompt
    if [ "$_bridge_rc" != "0" ]; then
      _corrective_note="run_orch_prompt exited with code ${_bridge_rc}. You must call WriteFile to write the contract to ${_bridge_out} before finishing."
    elif [ ! -f "$_bridge_out" ]; then
      _corrective_note="The file ${_bridge_out} was NOT written. You MUST call WriteFile with path=${_bridge_out} to produce the contract — do not finish without writing it."
    else
      _corrective_note="The file ${_bridge_out} was written but is EMPTY. The source directory ${_bwt} contains TypeScript files — read them and extract their exports before writing the contract."
    fi

    _bridge_attempt=$(( _bridge_attempt + 1 ))
    if [ "$_bridge_attempt" -le "$_bridge_max_retries" ]; then
      warning "[bridge] Attempt ${_bridge_attempt}/${_bridge_max_retries} failed for '${_bcl}' — retrying with corrective prompt"
    fi
  done

  if [ "$_bridge_ok" = "1" ]; then
    local _cl_upper="${_bcl^^}"
    export "CROSS_CODELINE_CONTRACT_${_cl_upper}=${_bridge_out}"
    export CROSS_CODELINE_CONTRACT="$_bridge_out"
    log "[bridge] ✓ Contract written: ${_bridge_out} (exported CROSS_CODELINE_CONTRACT_${_cl_upper})"
  else
    local _total_attempts=$(( _bridge_max_retries + 1 ))
    if [ "${CODELINE_BRIDGE_BLOCK_ON_FAILURE:-false}" = "true" ]; then
      error "[bridge] FATAL — contract extraction for '${_bcl}' failed after ${_total_attempts} attempt(s) and CODELINE_BRIDGE_BLOCK_ON_FAILURE=true. Aborting pipeline."
      return 1
    else
      warning "[bridge] Contract extraction for '${_bcl}' failed after ${_total_attempts} attempt(s) — downstream codelines proceed without cross-codeline contract (set CODELINE_BRIDGE_BLOCK_ON_FAILURE=true to abort instead)"
    fi
  fi
}

# Stop a lane and everything it spawned.
#
# A lane subshell is not the thing doing the work: it backgrounds `bash "$0"`,
# which runs the node LLM calls. `kill <lane pid>` orphans those rather than
# stopping them, so the halt reported an abort while the lane kept running and
# kept billing for ten more minutes (live AMSD-2041 2026-07-30). It only died
# by tripping over a PRD the parent's cleanup had already removed.
#
# Walks children before parents so nothing is reparented to init and left
# running. Deliberately NOT a process-group kill: lanes share this script's
# group, so `kill -- -$pgid` would take the orchestrator down with them.
_kill_lane_tree() {
  local _target="$1" _child
  [ -z "$_target" ] && return 0
  # Never accept our own PID or our parent's — that is self-termination
  # wearing a lane's clothes.
  if [ "$_target" = "$$" ] || [ "$_target" = "${BASHPID:-}" ] || [ "$_target" = "$PPID" ]; then
    return 0
  fi
  for _child in $(pgrep -P "$_target" 2>/dev/null); do
    _kill_lane_tree "$_child"
  done
  kill -TERM "$_target" 2>/dev/null || true
  return 0
}

# ── Run-scoped working directory ────────────────────────────────────────────
# Lane working files (per-codeline PRDs, cross-lane state) used to be written to a FLAT
# machine-global namespace: /tmp/orch-<codeline>-prd-<pid>.json. Every project and every
# concurrent run shared it, and archive-run-artifacts.sh then picked "the newest matching
# file" — so a clean mock1 run archived metrolinx's PRD, describing the wrong project, the
# wrong story and the wrong day (live 2026-08-05).
#
# Scoped to THIS run instead. Falls back to a private mktemp -d rather than the shared
# namespace when no run directory can be derived: a temp dir nobody else can glob is still
# isolated, which the old path never was.
_run_work_dir() {
    local _base="${EPAM_PROJECT_CONFIG_DIR:-}"
    if [ -n "$_base" ] && [ -n "${ORCH_RUN_ID:-}" ]; then
        local _d="$_base/runs/$ORCH_RUN_ID/work"
        mkdir -p "$_d" 2>/dev/null && { printf '%s' "$_d"; return 0; }
    fi
    mktemp -d "${TMPDIR:-/tmp}/orch-run-XXXXXX"
}

# archive_prior_lane_state — ONCE PER RUN, before any lane works: every file in the lane log folders (logs/lanes/<lane>,
# lines/<line>) older than this run's own start moves to logs/archive/lanes-before-<run>/ — never deleted. The folders
# survive every launch (the fresh-launch reset clears only logs/), so a run inherited another run's retry counters,
# ladder positions, rejection records, self-heal ledger and review/gate history (AMSD-2974 run 2 at pause 2,
# 2026-10-09: upexpress at attempt 10 of 12, 17 old self-heal events). What this run wrote is newer and stays.
archive_prior_lane_state() {
    local _lanes="${LOG_DIR:-}/lanes"
    [ -d "$_lanes" ] || return 0
    local _run="${EPAM_RESUME_RUN:-${ORCH_RUN_ID:-}}"
    [ -n "$_run" ] || return 0
    local _marker=""
    if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ]; then
        _marker="${EPAM_PROJECT_CONFIG_DIR}/runs/${_run}/lane-state-archived"
        [ -f "$_marker" ] && return 0
    fi
    # The run's start is in its id (YYYYMMDDTHHMMSSZ, UTC).
    local _start
    _start=$(printf '%s' "$_run" | sed -nE 's/^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z?$/\1-\2-\3 \4:\5:\6 UTC/p')
    [ -n "$_start" ] || return 0
    local _ref; _ref=$(mktemp "${TMPDIR:-/tmp}/run-start-XXXXXX") || return 0
    touch -d "$_start" "$_ref" 2>/dev/null || { rm -f "$_ref"; return 0; }
    local _dest="${LOG_DIR}/archive/lanes-before-${_run}" _n=0 _f _rel
    while IFS= read -r -d '' _f; do
        _rel="${_f#"$_lanes"/}"
        mkdir -p "$_dest/$(dirname "$_rel")" 2>/dev/null && mv "$_f" "$_dest/$_rel" 2>/dev/null && _n=$((_n + 1))
    done < <(find "$_lanes" -type f ! -newer "$_ref" -print0 2>/dev/null)
    rm -f "$_ref"
    [ "$_n" -gt 0 ] && log "[orch] archived ${_n} file(s) of earlier runs' lane state → ${_dest} (this run starts with none of it)"
    [ -n "$_marker" ] && { mkdir -p "${_marker%/*}" 2>/dev/null; date -u +%Y-%m-%dT%H:%M:%SZ > "$_marker"; }
    return 0
}

# base_fresh_story_branches <prd> — ONCE PER RUN, before anything reads them, every codeline a brownfield story may be
# worked in (its own and every one discovery grounded, lib/plan-scope.js) is put on the story's branch, freshly based on
# the codeline's baseline. ensure_story_branch pins any commit the reset would orphan under epam-rescue/*. Once per RUN,
# not per launch: with the operator's pauses the lanes are first reached by a resumed leg, so "not a resume" never held;
# the run's own marker (runs/<id>/story-branches-based) keeps every later leg — a resume after the writer included —
# off the branches, where this run's own work is.
base_fresh_story_branches() {
    local _prd="${1:-}"
    [ "${EPAM_BROWNFIELD:-0}" = "1" ] && [ -f "$_prd" ] || return 0
    command -v ensure_story_branch >/dev/null 2>&1 || return 0
    local _run="${EPAM_RESUME_RUN:-${ORCH_RUN_ID:-}}"
    local _marker=""
    if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] && [ -n "$_run" ]; then
        _marker="${EPAM_PROJECT_CONFIG_DIR}/runs/${_run}/story-branches-based"
        [ -f "$_marker" ] && return 0
    fi
    local _line _root _story
    while IFS=$'\t' read -r _root _story; do
        [ -n "$_root" ] && [ -n "$_story" ] || continue
        log "[orch] fresh run: basing '${_root##*/}' on its story branch for ${_story} before anything reads it"
        ensure_story_branch "$_root" "$_story" "${JIRA_BASELINE_BRANCH:-}" || true
    done < <("$NODE_BIN" -e '
      const fs=require("fs"),path=require("path");const [prdF,cfg,lib]=process.argv.slice(1);
      const prd=JSON.parse(fs.readFileSync(prdF,"utf8"));let facts=null;
      try{facts=cfg?JSON.parse(fs.readFileSync(path.join(cfg,"codeline-facts.json"),"utf8")):null}catch{}
      const {planScope}=require(lib);const seen=new Set();
      for(const s of prd.stories||[]){if(!s||!s.id)continue;for(const d of planScope(s,prd,facts).outputDirs){const k=d.path+"\t"+s.id;if(!seen.has(k)){seen.add(k);console.log(k)}}}
    ' "$_prd" "${EPAM_PROJECT_CONFIG_DIR:-}" "$SCRIPT_DIR/lib/plan-scope.js" 2>/dev/null)
    [ -n "$_marker" ] && { mkdir -p "${_marker%/*}" 2>/dev/null; date -u +%Y-%m-%dT%H:%M:%SZ > "$_marker"; }
    return 0
}

# lane_paused_since <lane_log_dir> <marker> — did this lane (or a release line of it) record a pause after <marker>
# (touched when this run's lanes started)? A lane paused before its writer is not a lane that finished: it recorded
# paused-run.json in its OWN log dir, which no launcher reads. A record older than the marker is an earlier launch's.
lane_paused_since() {
    local _dir="${1:-}" _marker="${2:-}"
    [ -d "$_dir" ] && [ -f "$_marker" ] || return 1
    [ -n "$(find "$_dir" -name paused-run.json -newer "$_marker" 2>/dev/null | head -1)" ]
}

# record_lanes_pause <marker> — when any lane paused during this run, the RUN is paused: recorded where every launcher
# reads it (lib/checkpoints.sh record_run_pause, in LOG_DIR), with how to resume. Returns 1 when no lane paused.
# Found rehearsing AMSD-2974, 2026-10-09: every lane paused before its writer and the run reported "Pipeline complete".
record_lanes_pause() {
    local _marker="${1:-}"
    [ -f "$_marker" ] && [ -d "${LOG_DIR:-}/lanes" ] || return 1
    local _recs; _recs=$(find "${LOG_DIR}/lanes" -name paused-run.json -newer "$_marker" 2>/dev/null)
    [ -n "$_recs" ] || return 1
    local _n _stage
    _n=$(printf '%s\n' "$_recs" | awk -F/lanes/ '{split($2,a,"/"); print a[1]}' | sort -u | grep -c .)
    _stage=$(jq -r '.stage // ""' "$(printf '%s\n' "$_recs" | head -1)" 2>/dev/null)
    record_run_pause "${_stage:-pre-writer}"
    log "[orch] ⏸  Run paused — ${_n} lane(s) paused at ${_stage:-a pause}. Resume with: EPAM_RESUME_RUN=${ORCH_RUN_ID:-} <your launcher>"
    return 0
}

_run_codeline_loop() {
  local _prd_path="$1"
  local _log_file="${2:-/tmp/orch-$(date +%Y%m%dT%H%M%S).log}"
  # When the tier3 launcher (or any external phase-managing caller) drives the
  # phase loop itself (calling us once per phase via --phase X), set this to
  # run only that phase across all codelines. Empty = run every PRD phase.
  local _phase_filter="${3:-}"
  # When this run's lanes started: a lane pause recorded after it is this run's (lane_paused_since, record_lanes_pause).
  local _lanes_started="${LOG_DIR:-/tmp}/.lanes-started"
  mkdir -p "${LOG_DIR:-/tmp}" 2>/dev/null; : > "$_lanes_started"

  # ── THE PLAN COMES FIRST, AND IT DECIDES THE LANES ─────────────────────────
  # A fresh run's codelines are put on their story branches, freshly based, BEFORE anything reads them: the detective
  # and the spec pass read the checkout, and a fresh AMSD-2974 run read earlier runs' commits as existing code
  # (2026-10-09). A codeline a killed line pass left on the line's branch is put back. Then the story without a plan
  # gets one (lib/handlers/write-missing-plans.js), shown every codeline discovery grounded; the codelines the plan
  # names join the story and the run's outputDirs (lib/plan-scope.js) — so the lane list below is the plan's.
  archive_prior_lane_state
  base_fresh_story_branches "$_prd_path"
  _return_codelines_from_release_lines "$_prd_path"
  "$NODE_BIN" "$SCRIPT_DIR/lib/handlers/write-missing-plans.js" "$_prd_path" || true

  # Extract codeline:path entries from project.outputDirs.
  # Falls back to project.outputDir + JIRA_DEFAULT_CODELINE for single-codeline PRDs.
  local _cl_entries=()
  mapfile -t _cl_entries < <("$NODE_BIN" "$SCRIPT_DIR/lib/handlers/cl-entries.js" "${_prd_path}" 2>/dev/null)

  # CODELINE SELECTION — run a subset of the story's codelines, one launch at a time.
  #
  # A story spanning several repositories otherwise runs all of them in one launch. Naming a
  # subset makes each launch a natural pause: a failure blasts one lane instead of every lane,
  # each pause is an inspection point, and spend is bounded per launch instead of per story.
  #
  # Filtered HERE because this array is the single source every downstream path reads — the
  # parallel fan-out, the sequential loop, and the post-run merges. Filtering at any one of those
  # would leave the others running codelines nobody asked for.
  #
  # UNSET OR EMPTY MEANS ALL, so a run that does not use this is byte-for-byte today's run.
  # An unmatched selection yields NOTHING rather than everything: failing open here would run
  # every codeline when the operator asked for one, which is the expensive direction of a typo,
  # and the caller below already treats an empty list as a hard error rather than a silent pass.
  #
  # Matching is on the codeline NAME (the part before the colon), never the path, so a selection
  # cannot accidentally match a directory that merely contains the same text.
  # NO OPERATOR FILTER HERE. The lane list already IS the run's scope: it is built from the
  # PRD's project.outputDirs, which resolve-codeline-scope.sh writes for every project however
  # its PRD arrived. Filtering it again with a hand-typed EPAM_ONLY_CODELINES asked a human to
  # restate a fact the PRD already carried, and could only ever disagree with it.

  if [ ${#_cl_entries[@]} -eq 0 ]; then
    error "[orch] No codeline/worktree entries found in PRD: ${_prd_path}"
    error "[orch] Add project.outputDirs to the PRD or set JIRA_DEFAULT_CODELINE + project.outputDir"
    return 1
  fi

  # ── Codeline health: assess every lane BEFORE spending anything ────────────
  # Live AMSD-2041, 2026-07-28: all three discovered codelines declared a test
  # script and a runner, and none could resolve one — two had no node_modules at
  # all. Until that morning Step 5 skipped silently on exactly this, so an
  # unverified baseline was accepted once per lane. Making it fail was right, but
  # it fails INSIDE the phase, after the spec pass is already paid for: the next
  # launch would have cost a full spec pass per lane to discover a dependency
  # problem visible in seconds.
  #
  # Runs on whatever DISCOVERY returned. The codelines are resolved per ticket at
  # runtime, so preparing a fixed list would hardcode discovery's output.
  # lib/codeline-health.sh knows no package manager, runner or language — it
  # reads what each codeline declares and prepares it accordingly.
  if [ -f "$SCRIPT_DIR/lib/codeline-health.sh" ]; then
    local _ch_paths=()
    for _entry in "${_cl_entries[@]}"; do _ch_paths+=("${_entry#*:}"); done
    log "[orch] Assessing health of ${#_ch_paths[@]} codeline(s) before starting work..."
    if ! NODE_BIN="$NODE_BIN" bash "$SCRIPT_DIR/lib/codeline-health.sh" "${_ch_paths[@]}"; then
      error "[orch] One or more codelines are UNHEALTHY — aborting before any spend."
      error "[orch]   A codeline that cannot resolve its own declared tooling cannot run its gates,"
      error "[orch]   so the run would accept an unverified baseline for that lane."
      error "[orch]   Set SKIP_CODELINE_HEALTH=1 to proceed knowing the gates cannot run."
      return 1
    fi
  fi

  # Tear down and re-scaffold every codeline worktree so each run starts clean.
  # Pre-existing worktrees from prior runs poison the next run (stale package.json,
  # accumulated artifacts, mid-run file mutations). Full deletion is the only safe state.
  for _entry in "${_cl_entries[@]}"; do
    local _cl="${_entry%%:*}" _wt="${_entry#*:}"
    log "[orch] Codeline '${_cl}' → ${_wt}"

    if [ "${EPAM_BROWNFIELD:-0}" != "1" ]; then
      # ── Greenfield: full teardown + git init so every run starts clean ──
      # Stale package.json, accumulated artifacts, and mid-run file mutations from
      # prior runs all poison the next run. Full deletion is the only safe state.
      # Some node_modules subdirs end up 0444/0555 after npm install — force-write
      # access first so rm -rf is never blocked by restrictive permissions.
      if [ -d "$_wt" ]; then
        log "[orch] Tearing down '${_cl}' worktree at ${_wt}..."
        chmod -R u+w "$_wt" 2>/dev/null || true
        rm -rf "$_wt"
      fi

      local _scaffold="$SCRIPT_DIR/scaffold-${_cl}-repo.sh"
      if [ -f "$_scaffold" ]; then
        log "[orch] Scaffolding '${_cl}' repo at ${_wt}..."
        bash "$_scaffold" "$_wt" 2>&1 | tee -a "$_log_file"
      else
        # No scaffold script — create a bare git repo; agents fill in the stack.
        log "[orch] No scaffold-${_cl}-repo.sh found — creating bare git repo at ${_wt}..."
        mkdir -p "$_wt"
        git -C "$_wt" init --quiet
        git -C "$_wt" config user.email "epam-cli@local"
        git -C "$_wt" config user.name "epam-cli"
        git -C "$_wt" commit --allow-empty -m "init: ${_cl} codeline worktree" --quiet
      fi
    else
      # ── Brownfield: verify the existing repo; no teardown ──────────────────
      # The worktree must already exist as a git repository — agents modify
      # existing files in-place rather than building from scratch.
      if [ ! -d "$_wt" ]; then
        error "[orch] Brownfield worktree does not exist: ${_wt}"
        error "[orch] Codeline '${_cl}' must point to an existing local repository."
        return 1
      fi
      if [ ! -e "$_wt/.git" ]; then
        error "[orch] Brownfield worktree is not a git repository: ${_wt}"
        error "[orch] Ensure the path contains a .git directory."
        return 1
      fi
      log "[orch] Brownfield: using existing worktree '${_cl}' at ${_wt}"

      # Capture baseline SHA so gate diff oracles (review-ranger, mutant-hunter,
      # fuzz-weaver, sast-sentinel) diff only the story's changes against the
      # project's main branch — not the full commit history.
      local _baseline_branch="${JIRA_BASELINE_BRANCH:-main}"
      local _baseline_sha=""
      # --verify --quiet: fail cleanly for a ref that does not exist. Without it,
      # `git rev-parse origin/develop` ECHOES the literal "origin/develop" to stdout and exits
      # 128, so the || chain runs the next command and the substitution captures BOTH — a
      # two-line value whose first line is not a SHA. Every gate diff oracle reads this file
      # (review-ranger, mutant-hunter, fuzz-weaver, sast-sentinel), which is the known
      # "reviewers saw 0 files" failure. brownfield-preflight-reset.sh already guards this
      # exact shape; this call site did not. A repo with no remote hits it on every lane.
      _baseline_sha=$(git -C "$_wt" rev-parse --verify --quiet "origin/${_baseline_branch}" 2>/dev/null || \
                      git -C "$_wt" rev-parse --verify --quiet "${_baseline_branch}" 2>/dev/null || \
                      git -C "$_wt" rev-parse --verify --quiet HEAD 2>/dev/null || echo "")
      if [ -n "$_baseline_sha" ]; then
        # NOT WRITTEN HERE. See above: nothing reads this path, and the value means something
        # different from the one Step 8 writes into the lane's own directory.
        log "[orch] Brownfield baseline branch: ${_baseline_branch} @ ${_baseline_sha:0:8}"
      else
        warning "[orch] Could not resolve baseline branch '${_baseline_branch}' — gate diffs will use HEAD"
      fi
    fi
    # THE CODELINE'S DECLARATION IS DETECTED, NEVER AUTHORED HERE.
    #
    # This wrote three .epam/ manifests from heredocs -- 80 lines asserting, of a repository the
    # engine had never inspected, that its manifest is package.json, its sources are .ts/.tsx/.js,
    # its vendor directory is node_modules, and that it must carry typescript, @types/node, vitest
    # and tsx. Seventeen scripts read dependency-check.json as the codeline's OWN declaration, so
    # fabricating it defeated every generic component downstream at the source: a non-Node codeline
    # was handed a document saying it is TypeScript, in client-repo space, with facts nobody
    # detected.
    #
    # lib/handlers/codeline-manifests.js assembles them from the provider whose manifest the
    # repository actually carries. A codeline no provider recognises gets NOTHING and is reported
    # -- an undeclared codeline is a state to surface, never one to invent an answer for.
    #
    # A DECLARATION THE CODELINE CONTRADICTS IS RE-DERIVED. A greenfield launch seeds .epam/ from
    # the project directory before the codeline exists, so those files are the project author's
    # word about a stack not yet built. When the codeline then carries a manifest a provider
    # recognises and the seeded declaration names a manifest file that is not there, the codeline
    # is the truth and the seed was a guess: live 2026-09-12, a Python greenfield project carried
    # package.json / npm / vitest manifests copied from another project, and every generic gate
    # would have judged a pytest repository as TypeScript. Derived, and the seeded siblings the
    # provider does not declare are removed with it — they described the same wrong stack.
    local _clm_contradicted=0
    if [ -f "$_wt/.epam/dependency-check.json" ]; then
      local _clm_declared_manifest
      _clm_declared_manifest=$(jq -r '.manifestFile // ""' "$_wt/.epam/dependency-check.json" 2>/dev/null || echo "")
      if [ -n "$_clm_declared_manifest" ] && [ ! -f "$_wt/$_clm_declared_manifest" ] \
         && "$NODE_BIN" -e 'process.exit(require(process.argv[1]).resolveEcosystem(process.argv[2]) ? 0 : 1)' \
              "$SCRIPT_DIR/lib/handlers/codeline-manifests.js" "$_wt" 2>/dev/null; then
        _clm_contradicted=1
        warning "[orch] ${_wt}: .epam/dependency-check.json declares manifest '${_clm_declared_manifest}', which this codeline does not carry — the declaration is re-derived from the ecosystem the codeline actually has"
      fi
    fi
    if [ ! -f "$_wt/.epam/dependency-check.json" ] || [ "$_clm_contradicted" = "1" ]; then
      local _clm _clm_rc=0
      _clm=$("$NODE_BIN" "$SCRIPT_DIR/lib/handlers/codeline-manifests.js" "$_wt" 2>&1) || _clm_rc=$?
      if [ "$_clm_rc" -ne 0 ]; then
        warning "[orch] ${_wt}: no provider declares how this codeline is checked — .epam/ manifests NOT written"
        printf '%s\n' "$_clm" | sed 's/^/    /' >&2
      else
        mkdir -p "$_wt/.epam"
        if [ "$_clm_contradicted" = "1" ]; then
          local _clm_stale
          for _clm_stale in dependency-check.json contract-generation.json known-fixes.json; do
            if [ -f "$_wt/.epam/$_clm_stale" ] && ! printf '%s' "$_clm" | jq -e --arg k "$_clm_stale" 'has($k)' >/dev/null 2>&1; then
              rm -f "$_wt/.epam/$_clm_stale"
              log "[orch] Removed seeded .epam/${_clm_stale}: it described a stack this codeline is not, and its ecosystem declares no replacement"
            fi
          done
        fi
        printf '%s' "$_clm" | jq -r 'keys[]' | while IFS= read -r _mf; do
          [ -z "$_mf" ] && continue
          printf '%s' "$_clm" | jq --arg k "$_mf" '.[$k]' > "$_wt/.epam/$_mf"
        done
        log "[orch] Wrote .epam/ manifests to ${_wt} from the resolved ecosystem provider"
      fi
    fi
    # A DECLARATION MISSING A FACT ITS ECOSYSTEM DECLARES IS COMPLETED. The plug-in gained
    # provisionCommand and runEnvironment on 2026-09-16; a manifest written before that carries
    # neither, and a worktree provisioned from it has no environment. Only ABSENT keys are added
    # — every key the manifest already holds is the project's word and stays as it is.
    if [ -f "$_wt/.epam/dependency-check.json" ]; then
      local _clm_more _clm_more_rc=0
      _clm_more=$("$NODE_BIN" "$SCRIPT_DIR/lib/handlers/codeline-manifests.js" "$_wt" 2>/dev/null) || _clm_more_rc=$?
      if [ "$_clm_more_rc" -eq 0 ]; then
        local _clm_added
        _clm_added=$(jq -n --argjson have "$(cat "$_wt/.epam/dependency-check.json")" --argjson derive "$(printf '%s' "$_clm_more" | jq '."dependency-check.json" // {}')" \
          '[($derive | keys[]) as $k | select(($have | has($k)) | not) | $k]' 2>/dev/null || echo '[]')
        if [ "$(printf '%s' "$_clm_added" | jq 'length')" -gt 0 ]; then
          jq -s '.[1] * .[0]' "$_wt/.epam/dependency-check.json" <(printf '%s' "$_clm_more" | jq '."dependency-check.json"') > "$_wt/.epam/dependency-check.json.tmp" \
            && mv "$_wt/.epam/dependency-check.json.tmp" "$_wt/.epam/dependency-check.json"
          log "[orch] Completed .epam/dependency-check.json in ${_wt} with $(printf '%s' "$_clm_added" | jq -r 'join(", ")') from its ecosystem provider"
        fi
      fi
    fi

    # ── Plugin provisioning: config-driven, zero project-specific hardcoding ──
    # This script has no idea what a "plugin" IS or does, with ONE exception:
    # CodeGraph's query tool (orchestrations/plugins/codegraph-plugin.js) ships
    # with epam-cli itself — the same way ReadFile/Bash are always available
    # regardless of project — so it's provisioned for EVERY codeline
    # unconditionally, merged with whatever the project's own plugins.json
    # adds on top (never overwritten, never required to list it manually).
    # Everything else remains purely config-driven: EPAM_PROJECT_CONFIG_DIR/
    # codeline-facts.json (keyed by codeline name) has its entry for THIS
    # codeline extracted into .epam/codeline-facts.json. Adding, removing, or
    # repointing a PROJECT-specific plugin is purely a config edit in the
    # project's own directory — never a change to this script.
    local _project_tools_json="[]"
    if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] && [ -f "${EPAM_PROJECT_CONFIG_DIR}/plugins.json" ]; then
      _project_tools_json=$(jq -c '.tools // []' "${EPAM_PROJECT_CONFIG_DIR}/plugins.json" 2>/dev/null || echo "[]")
    fi
    local _codegraph_plugin_abs=""
    local _codegraph_plugin_src="${SCRIPT_DIR}/../plugins/codegraph-plugin.js"
    if [ -f "$_codegraph_plugin_src" ]; then
      _codegraph_plugin_abs="$(cd "$(dirname "$_codegraph_plugin_src")" 2>/dev/null && pwd)/$(basename "$_codegraph_plugin_src")"
    fi
    if [ -n "$_codegraph_plugin_abs" ] || [ "$_project_tools_json" != "[]" ]; then
      mkdir -p "$_wt/.epam"
      jq -n --argjson project "$_project_tools_json" --arg cg "$_codegraph_plugin_abs" \
        '{tools: (((if $cg != "" then [$cg] else [] end) + $project) | unique)}' \
        > "$_wt/.epam/settings.json"
      log "[orch] Provisioned .epam/settings.json (plugins, incl. built-in CodeGraph tool) for '${_cl}'"
    fi

    if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ]; then
      local _facts_cfg="${EPAM_PROJECT_CONFIG_DIR}/codeline-facts.json"
      if [ -f "$_facts_cfg" ]; then
        local _cl_facts
        _cl_facts=$(jq -c --arg cl "$_cl" '.[$cl] // empty' "$_facts_cfg" 2>/dev/null)
        if [ -n "$_cl_facts" ]; then
          mkdir -p "$_wt/.epam"
          echo "$_cl_facts" > "$_wt/.epam/codeline-facts.json"
          log "[orch] Provisioned .epam/codeline-facts.json for '${_cl}' from ${_facts_cfg}"
        else
          # SAY SO. This skipped in silence, so a file in the wrong SHAPE was indistinguishable
          # from no file and from an agent that observed nothing — three different problems with
          # one symptom, which is none. The file is keyed by codeline name at the top level;
          # a hand-written one nesting them under another key parses fine and yields nothing for
          # every codeline, which is exactly what happened to mock3's before discovery produced it.
          warning "[orch] '${_facts_cfg}' exists but has no entry for codeline '${_cl}' — agents there will work from the source alone. Codeline names must be TOP-LEVEL keys; the engine reads one with jq '.[\$cl]'."
        fi
      fi

      # .env.local: derived from the codeline's OWN .env.local.sample, not an
      # engine-side list. See provision_env_local_from_sample().
      provision_env_local_from_sample "$_wt" "$_wt/.env.local"
      if [ -s "$_wt/.env.local" ]; then
        log "[orch] Provisioned .env.local for '${_cl}' from ${_wt}/.env.local.sample"
      fi

      # anti-patterns.json (optional, per-project): not keyed by codeline —
      # copied whole into .epam/ so the check_anti_patterns plugin tool (and
      # run_anti_pattern_check's deterministic gate) both read the same,
      # already-provisioned file instead of reaching across worktree
      # boundaries into EPAM_PROJECT_CONFIG_DIR directly.
      local _antipatterns_cfg="${EPAM_PROJECT_CONFIG_DIR}/anti-patterns.json"
      if [ -f "$_antipatterns_cfg" ]; then
        mkdir -p "$_wt/.epam"
        cp "$_antipatterns_cfg" "$_wt/.epam/anti-patterns.json"
        log "[orch] Provisioned .epam/anti-patterns.json for '${_cl}' from ${_antipatterns_cfg}"
      fi
    fi
  done



  # Per-codeline execution loop
  local _work_dir; _work_dir="$(_run_work_dir)"
  local _overall=0 _completed_list="" _cross_prd="$_work_dir/cross.json"
  local _cl_prds=()


  # Rebuild cumulative cross-codeline PRD so later codelines can check
  # completed stories from earlier codelines (is_story_completed fallback).
  _rebuild_cross() {
    [ -z "$_completed_list" ] && { unset CROSS_CODELINE_PRD; return; }
    COMPLETED_LIST="$_completed_list" \
    "$NODE_BIN" "$SCRIPT_DIR/lib/handlers/rebuild-cross-contract.js" "${_cross_prd}" 2>/dev/null
    export CROSS_CODELINE_PRD="$_cross_prd"
  }

  # Build filtered PRD containing only stories for codeline $1, written to $2.
  # Returns story count on stdout.
  _filtered_prd() {
    local _fcl="$1" _fout="$2" _fsrc="$3"
    JIRA_DEFAULT_CODELINE="${JIRA_DEFAULT_CODELINE:-}" \
    "$NODE_BIN" "$SCRIPT_DIR/lib/handlers/filtered-prd.js" "${_fsrc}" "${_fout}" "${_fcl}" 2>/dev/null
  }

  # A LANE RESUMES FROM ITS OWN CHECKPOINT. On a resume, a lane whose own checkpoint was taken
  # pre-writer has finished its spec pass, and that checkpoint's PRD is the spec the operator
  # approved at pause 2. Rebuilding the lane's PRD from the canonical one instead — which a resume
  # restores from the run's post-roster checkpoint, taken before any spec — handed every lane a
  # PRD with no spec, so every lane ran its spec pass again, paid, and overwrote what had been
  # approved (AMSD-2974 writer relaunch, 2026-10-02). An edit the operator made at the pause to the
  # lane's working PRD is kept. A resume sent back to an earlier stage (EPAM_RESUME_FROM_STAGE)
  # redoes the work after it, so it never takes this path.
  # Sets _lane_spec_mode=0 and returns 0 when the lane resumes from its checkpoint.
  _lane_resume_prd() {
    local _rcl="$1" _rout="$2"
    _lane_spec_mode=""
    [ -n "${EPAM_RESUME_RUN:-}" ] || return 1
    local _rck="${EPAM_PROJECT_CONFIG_DIR:-${PROJECT_CONFIG_DIR:-}}/runs/${EPAM_RESUME_RUN}/lanes/${_rcl}/checkpoint"
    [ -f "$_rck/prd.json" ] && [ -f "$_rck/checkpoint.json" ] || return 1
    local _want; _want=$(_stage_rank pre-writer)
    [ "$(_stage_rank "$(jq -r '.stage // empty' "$_rck/checkpoint.json" 2>/dev/null)")" -ge "$_want" ] || return 1
    if [ -n "${EPAM_RESUME_FROM_STAGE:-}" ] && [ "$(_stage_rank "$EPAM_RESUME_FROM_STAGE")" -lt "$_want" ]; then
      return 1
    fi
    # A SPEC BUILT FROM INPUTS THAT NO LONGER HOLD IS SPECIFIED AGAIN (lib/run-checkpoint.sh).
    if ! lane_spec_is_current "$_rck" "$_rout"; then
      log "[orch] Codeline '${_rcl}': not resuming its pre-writer checkpoint — the lane is specified again"
      return 1
    fi
    if _operator_edited "$_rout" "$_rck/reviewed/$(basename "$_rout")"; then
      log "[orch] Codeline '${_rcl}': resuming from its pre-writer checkpoint — KEEPING its PRD, edited at the pause"
    else
      cp "$_rck/prd.json" "$_rout" || return 1
      log "[orch] Codeline '${_rcl}': resuming from its pre-writer checkpoint — its spec pass is done; the PRD approved at the pause is the lane's PRD"
    fi
    _lane_spec_mode=0
    return 0
  }

  # THE PATH THE CALLER PASSED, ACTUALLY FORWARDED.
  #
  # This took "$1" and never used it, so the handler read no PRD; and `2>/dev/null` hid the error
  # it raised about that. The phase list came back EMPTY, every lane's phase loop ran zero times,
  # and each lane reported "✓ completed" in five seconds having invoked nothing. Live 2026-08-17,
  # mock3: two lanes, two pending stories, no writer, no commit, "Pipeline complete".
  #
  # An empty phase list is a real answer ("this PRD declares no phases") and indistinguishable
  # from a failure to read one — so the failure must be loud, and is.
  _prd_phases() {
    local _pp_prd="${1:-${PRD_FILE:-}}"
    local _pp_err _pp_out _pp_rc=0
    _pp_err=$(mktemp "${TMPDIR:-/tmp}/prd-phases-err-XXXXXX")
    _pp_out=$("$NODE_BIN" "$SCRIPT_DIR/lib/handlers/prd-phases.js" "$_pp_prd" 2>"$_pp_err") || _pp_rc=$?
    if [ "$_pp_rc" -ne 0 ]; then
        error "[orch] could not read the phases of ${_pp_prd}: $(cat "$_pp_err" 2>/dev/null)"
        error "[orch]   Refusing to treat that as 'no phases' — a lane with no phases does nothing and reports success."
        rm -f "$_pp_err"
        return 1
    fi
    rm -f "$_pp_err"
    printf '%s' "$_pp_out"
  }

  # ── Lane execution: parallel by default ────────────────────────────────────
  # Lanes of a spanning story are independent units of work; running them in
  # sequence costs (N-1) x lane-duration in wall clock. On AMSD-2041 three
  # ~20-minute lanes take an hour to do 20 minutes of work.
  #
  # THREE THINGS SEQUENCING GAVE FOR FREE, and how each is kept:
  #
  #  1. The canonical PRD merge. Every lane writes the same file, so concurrent
  #     merges would clobber each other. Workers therefore never merge: each
  #     writes only its own filtered PRD, and the merges run here, after the
  #     wait, one at a time in declared order.
  #  2. The halt rule. Sequencing prevented spend outright. In parallel the
  #     lanes are already running, so the equivalent is to abort the survivors
  #     the moment one fails. Money already spent cannot be recovered; money not
  #     yet spent still can.
  #  3. The cross-codeline contract. _run_codeline_bridge feeds one lane's
  #     exported API into the NEXT lane's prompt, which presupposes an upstream
  #     that has already finished. In parallel there is no upstream, so it is
  #     skipped with a warning rather than silently writing a contract nobody
  #     consumed. Lanes that genuinely integrate must set
  #     EPAM_PARALLEL_CODELINES=0.
  _EPAM_PARALLEL_LANES="${EPAM_PARALLEL_CODELINES:-1}"
  if [ "$_EPAM_PARALLEL_LANES" = "1" ] && [ "${#_cl_entries[@]}" -gt 1 ]; then
    local _p_cls=() _p_wts=() _p_prds=() _p_pids=() _p_spec=() _lane_spec_mode=""
    local _p_statusdir; _p_statusdir="$(mktemp -d /tmp/orch-lanes-XXXXXX)"

    for _entry in "${_cl_entries[@]}"; do
      local _cl="${_entry%%:*}" _wt="${_entry#*:}"
      local _cl_prd="$_work_dir/${_cl}-prd.json"
      _cl_prds+=("$_cl_prd")
      local _n_stories
      if _lane_resume_prd "$_cl" "$_cl_prd"; then
        _n_stories=$(jq '(.stories // []) | length' "$_cl_prd" 2>/dev/null || echo 0)
      else
        _n_stories=$(_filtered_prd "$_cl" "$_cl_prd" "$_prd_path")
      fi
      # The lane's work copy carries the story's plan (a checkpoint may predate it; the checkpoint is not edited).
      "$NODE_BIN" "$SCRIPT_DIR/lib/handlers/carry-plan.js" "$_cl_prd" "$_prd_path" || true
      if [ "${_n_stories:-0}" -eq 0 ]; then
        log "[orch] Codeline '${_cl}': no stories — skipping"
        continue
      fi
      if lane_declared_passed "$_cl"; then
        log "[orch] Codeline '${_cl}': declared passed in this run (EPAM_PASSED_LANES) — its own line is not run again"
      # THE DECLARATION IS THE CODELINE'S RESULT (lib/handlers/record-declared-pass.js).
      "$NODE_BIN" "$SCRIPT_DIR/lib/handlers/record-declared-pass.js" "$_prd_path" "$_cl" || true
        # ITS OTHER RELEASE LINES STILL SHIP (lib/release-lines.sh): passed is the operator's word for the codeline's own line.
        _run_release_lines "$_cl" "$_cl_prd" "$_wt" "${LOG_DIR:-/tmp}/lanes/${_cl}" "$_log_file" "$_phase_filter" "$0" "$_prd_path" || _overall=1
        continue
      fi
      _p_cls+=("$_cl"); _p_wts+=("$_wt"); _p_prds+=("$_cl_prd"); _p_spec+=("${_lane_spec_mode}")
      log "[orch] Codeline '${_cl}' — ${_n_stories} stories → ${_wt}"
    done

    if [ "${#_p_cls[@]}" -gt 1 ]; then
      warning "[orch] Parallel lanes: cross-codeline contract bridge SKIPPED — no lane is upstream of another."
      warning "[orch]   Set EPAM_PARALLEL_CODELINES=0 if these lanes integrate with each other."
    fi

    log "[orch] Launching ${#_p_cls[@]} codeline(s) in PARALLEL..."
    _lane_idx=0
    while [ "$_lane_idx" -lt "${#_p_cls[@]}" ]; do
      _cl="${_p_cls[$_lane_idx]}"
      _wt="${_p_wts[$_lane_idx]}"
      _cl_prd="${_p_prds[$_lane_idx]}"
      _lane_spec_mode="${_p_spec[$_lane_idx]:-}"
      _lane_status="${_p_statusdir}/${_cl}.status"
      (
        _log_file="${LOG_DIR:-/tmp}/lane-${_cl}.log"
        # ── Per-lane LOG_DIR ──────────────────────────────────────────────
        # Lanes used to inherit ONE LOG_DIR, and several files in it are read
        # back as STATE rather than merely written as logs. The proven case is
        # phase-baseline-sha.txt, the git SHA every diff-based gate uses to
        # decide what a story changed. With three lanes on three different
        # repositories the last writer won, so two lanes diffed against a commit
        # that does not exist in them — an empty diff, and review-ranger /
        # mutant-hunter / team-lead-review passing on ZERO files. A false pass on
        # unreviewed code, which is worse than a crash because it looks like
        # success. Live metrolinx 2026-07-29, killed on discovery of this.
        #
        # Scoping LOG_DIR fixes every such file at once — the baseline SHA, the
        # review-incomplete-<phase> flag (PHASE is identical across lanes), the
        # story-outputs manifest and the worktree logs — instead of patching each
        # call site in seven scripts and missing the eighth.
        _lane_log_dir="${LOG_DIR:-/tmp}/lanes/${_cl}"
        mkdir -p "$_lane_log_dir" 2>/dev/null || true
        _cl_failed=0
    local _phases=()
    mapfile -t _phases < <(_prd_phases "$_cl_prd")
    local _cl_failed=0

    for _phase in "${_phases[@]}"; do
      [ -z "$_phase" ] && continue
      # When the tier3 launcher (or any external caller) manages phases externally
      # by calling run-agent-orchestration.sh once per phase, honour its filter so
      # only the requested phase runs. Without this, a --phase scaffold call would
      # still execute every phase across every codeline (double-execution bug).
      if [ -n "$_phase_filter" ] && [ "$_phase" != "$_phase_filter" ]; then
        log "[orch] Phase '${_phase}' — skipping (caller phase filter: '${_phase_filter}')"
        continue
      fi
      log "[orch] Phase '${_phase}' — codeline '${_cl}'..."
      local _pex=0
      JIRA_CODELINE_RUN=1 \
      EPAM_CODELINE="$_cl" \
      LOG_DIR="$_lane_log_dir" \
      AGENT_IO_DIR="$_lane_log_dir/agent-io" \
      PRD_FILE="$_cl_prd" \
      EPAM_SPEC_MODE="${_lane_spec_mode:-${EPAM_SPEC_MODE:-}}" \
      PROJECT_ROOT="$_wt" \
      OUTPUT_DIR="$_wt" \
      PHASE="$_phase" \
      CROSS_CODELINE_PRD="${CROSS_CODELINE_PRD:-}" \
      bash "$0" --reset 2>&1 | tee -a "$_log_file"
      # No pipefail in this script, so `| tee || _pex=` tests tee's exit (0) and never
      # fires — a phase exit-2 (gate block) was masked to _pex=0 → "done" → PASSED
      # (live AMSD-1820 run #3). Capture the inner orch's real exit; tee exits 0 so set -e is fine.
      _pex=${PIPESTATUS[0]}

      # exit 2 = gate remediation applied — reset stories and retry once (mirrors tier3 launcher)
      if phase_exit_is_retryable "$_pex"; then
        log "[orch] Gate remediation applied for '${_phase}' ('${_cl}') — retrying with SKIP_GATE_REMEDIATION=1"
        _pex=0
        JIRA_CODELINE_RUN=1 \
      EPAM_CODELINE="$_cl" \
      LOG_DIR="$_lane_log_dir" \
      AGENT_IO_DIR="$_lane_log_dir/agent-io" \
        PRD_FILE="$_cl_prd" \
        EPAM_SPEC_MODE="${_lane_spec_mode:-${EPAM_SPEC_MODE:-}}" \
        PROJECT_ROOT="$_wt" \
        OUTPUT_DIR="$_wt" \
        PHASE="$_phase" \
        SKIP_GATE_REMEDIATION=1 \
        CROSS_CODELINE_PRD="${CROSS_CODELINE_PRD:-}" \
        bash "$0" --reset 2>&1 | tee -a "$_log_file"
        _pex=${PIPESTATUS[0]}
        if [ "$_pex" -ne 0 ]; then
          error "[orch] Phase '${_phase}' for '${_cl}' failed after self-healing retry (exit $_pex)"
        else
          log "[orch] Self-healing retry succeeded for '${_phase}' ('${_cl}')"
        fi
      fi

      if [ "$_pex" -ne 0 ]; then
        error "[orch] Phase '${_phase}' for '${_cl}' failed (exit $_pex)"
        _cl_failed=1; _overall=1; break
      fi
      if lane_paused_since "$_lane_log_dir" "$_lanes_started"; then
        log "[orch] Phase '${_phase}' — '${_cl}' PAUSED (inputs ready, writer not started)."
      else
        log "[orch] Phase '${_phase}' — '${_cl}' done."
      fi
    done

    # A SHARED CODELINE SHIPS ON EVERY RELEASE LINE ITS STORY'S PLAN NAMES (lib/release-lines.sh): its stories,
    # done on its own base, are worked once more per line off it — 0, 1 or N, as the plan says.
    if [ "$_cl_failed" = "0" ]; then
      _run_release_lines "$_cl" "$_cl_prd" "$_wt" "$_lane_log_dir" "$_log_file" "$_phase_filter" "$0" "$_prd_path" || { _cl_failed=1; _overall=1; }
    fi

    [ "$_cl_failed" = "0" ] && \
      _completed_list="${_completed_list:+${_completed_list}:}${_cl_prd}"
        echo "$_cl_failed" > "$_lane_status"
      ) &
      _p_pids+=("$!")
      _lane_idx=$(( _lane_idx + 1 ))
    done

    _p_any_failed=0
    _p_running=1
    while [ "$_p_running" = "1" ]; do
      _p_running=0
      for _pid in "${_p_pids[@]}"; do
        kill -0 "$_pid" 2>/dev/null && _p_running=1
      done
      for _cl in "${_p_cls[@]}"; do
        if [ -f "${_p_statusdir}/${_cl}.status" ] && [ "$(cat "${_p_statusdir}/${_cl}.status" 2>/dev/null)" != "0" ]; then
          _p_any_failed=1
        fi
      done
      # Default: let sibling lanes run to natural completion even after one
      # lane has failed. Found live 2026-08-02 (Writer Retest, AMSD-2041):
      # gotransit failed on a deterministic gate blocking on a pre-existing,
      # unrelated broken import (see run_relative_import_check's scope fix,
      # same incident) — a FALSE failure — which killed upexpress and
      # metrolinx mid-attempt via SIGTERM, discarding real, valid,
      # independent work those lanes were producing. The per-lane fold-back
      # logic below already records each lane's own outcome independently
      # (a spanning story is complete only when NO lane is outstanding) —
      # nothing downstream needed the early kill. Set
      # EPAM_CASCADE_ABORT_ON_LANE_FAILURE=1 to restore the old behavior
      # (stop spending immediately once any lane's outcome is known to have
      # failed) for cost-conscious runs where sibling lanes' work has no
      # independent value once one lane is lost.
      if [ "${EPAM_CASCADE_ABORT_ON_LANE_FAILURE:-0}" = "1" ] && [ "$_p_any_failed" = "1" ] && [ "$_p_running" = "1" ]; then
        error "[orch] HALT: a codeline failed after its retries and self-heal completed."
        error "[orch]   Aborting the codeline(s) still running (EPAM_CASCADE_ABORT_ON_LANE_FAILURE=1) —"
        error "[orch]   recovery is exhausted, so letting them finish would spend on a run already decided."
        for _pid in "${_p_pids[@]}"; do _kill_lane_tree "$_pid"; done
        break
      fi
      [ "$_p_running" = "1" ] && sleep 5
    done
    wait 2>/dev/null || true

    _lane_idx=0
    while [ "$_lane_idx" -lt "${#_p_cls[@]}" ]; do
      _cl="${_p_cls[$_lane_idx]}"
      _cl_prd="${_p_prds[$_lane_idx]}"
      _cl_failed=1
      [ -f "${_p_statusdir}/${_cl}.status" ] && _cl_failed="$(cat "${_p_statusdir}/${_cl}.status" 2>/dev/null || echo 1)"
      # ── Fold this lane's ledgers back into the parent ────────────────────
      # Per-lane LOG_DIR fixed cross-lane state corruption, and fragmented the
      # cost ledger as a side effect: every reader of the canonical path — the
      # dashboard, validate-dashboards.sh, the run report — saw an EMPTY
      # phase-cost.jsonl for a parallel run while the real records sat in
      # lanes/<codeline>/. Cost tracking that silently reports zero is worse than
      # none, so the append-only ledgers are concatenated back, in declared lane
      # order, once the lane has finished writing them.
      for _ledger in phase-cost.jsonl agent-activity.jsonl healing-events.jsonl phase-gates.jsonl; do
        if [ -n "${LOG_DIR:-}" ] && [ -s "${LOG_DIR}/lanes/${_cl}/${_ledger}" ]; then
          cat "${LOG_DIR}/lanes/${_cl}/${_ledger}" >> "${LOG_DIR}/${_ledger}" 2>/dev/null || true
        fi
      done

      # PER-LANE OUTCOME, RECORDED. Lanes have their own log dir, PRD, worktree, investigator
      # and writer, run in parallel, and this script states that no lane is upstream of
      # another — then the result collapsed into one exit code, so one lane's gate decision
      # failed a run in which the others had cleared. Live 2026-08-07: two lanes reached the
      # writer pause cleanly and the run reported failure because a third was blocked by the
      # spec review gate. Nothing said which, or that two-thirds of the work was fine.
      _LANE_OUTCOMES="${_LANE_OUTCOMES:+${_LANE_OUTCOMES}
}${_cl}	$([ "$_cl_failed" = "0" ] && echo ok || echo blocked)"
      if [ "$_cl_failed" = "0" ]; then
        _completed_list="${_completed_list:+${_completed_list}:}${_cl_prd}"
      else
        # Always explain a failed lane, even when every lane had already
        # finished by the time the abort poll noticed. Without this the run ends
        # non-zero with no statement of which lane died or why the others were
        # stopped — the operator is left diffing timestamps.
        error "[orch] codeline '${_cl}' did not complete — its retries and self-heal are exhausted."
        # LANE INDEPENDENCE IS ABOUT WHAT KEEPS RUNNING — NOT ABOUT THE EXIT CODE.
        #
        # A lane that does not complete does not invalidate the ones that did, and it must not
        # kill a sibling still doing real work: that independence is real, and
        # EPAM_CASCADE_ABORT_ON_LANE_FAILURE=1 is the knob that restores the old cascade.
        #
        # But independence stops at the exit status. This briefly returned 0 when a lane had
        # failed, which is the silent-failure class this pipeline exists to eliminate: every
        # automated caller, wrapper and CI reader takes exit 0 as "the work is done", and the
        # per-lane summary printed below is prose no caller parses. A run in which any lane
        # exhausted its retries, its ladder and its self-heal is a failed run — it is reported
        # as one, and the summary says which lanes did complete so nothing is thrown away.
        error "[orch] HALT: codeline '${_cl}' failed — the run is reported as failed."
        error "[orch]   Lanes that completed keep their work on their own per-story branch;"
        error "[orch]   the lane summary below states exactly which."
        _overall=1
      fi
    # Merge this codeline's final story state (status/completed/completedAt/
    # testCriteria/etc — whatever claude.sh/TC-writer wrote into the filtered
    # temp copy during real execution) back into the canonical PRD. Without
    # this, _cl_prd is the only file that ever held the real completion
    # result, and it was being deleted at the end of the loop — so the
    # canonical PRD (the file every downstream consumer, dashboard, and test
    # actually reads) stayed "pending" forever even after a real, successful
    # run. Found live 2026-07-23 via mock1.
    # The merge itself is lib/story-merge.js: it is the same operation on both the
    # sequential and the parallel path, it decides what survives a multi-lane run,
    # and inline in a heredoc it could not be tested. See that module for why a
    # spanning story cannot be merged wholesale.
    if "$NODE_BIN" "$SCRIPT_DIR/lib/handlers/merge-lane-into-canonical.js" \
         "$SCRIPT_DIR" "${_prd_path}" "${_cl_prd}" "${_cl}"; then
      log "[orch] Merged codeline '${_cl}' story state back into canonical PRD"
    else
      # Previously 2>/dev/null: a failed merge was indistinguishable from a
      # successful one that logged nothing, and it silently discards this lane's
      # entire outcome — status, criteria and all.
      error "[orch] FAILED to merge codeline '${_cl}' back into the canonical PRD;"
      error "[orch]   that lane's status and verification criteria are NOT recorded."
      _overall=1
    fi
      _lane_idx=$(( _lane_idx + 1 ))
    done
    rm -rf "$_p_statusdir" 2>/dev/null || true
  else
  for _entry in "${_cl_entries[@]}"; do
    local _cl="${_entry%%:*}" _wt="${_entry#*:}"
    local _cl_prd="$_work_dir/${_cl}-prd.json"
    _cl_prds+=("$_cl_prd")

    local _n_stories _lane_spec_mode=""
    if _lane_resume_prd "$_cl" "$_cl_prd"; then
      _n_stories=$(jq '(.stories // []) | length' "$_cl_prd" 2>/dev/null || echo 0)
    else
      _n_stories=$(_filtered_prd "$_cl" "$_cl_prd" "$_prd_path")
    fi
    # The lane's work copy carries the story's plan (a checkpoint may predate it; the checkpoint is not edited).
    "$NODE_BIN" "$SCRIPT_DIR/lib/handlers/carry-plan.js" "$_cl_prd" "$_prd_path" || true

    if [ "${_n_stories:-0}" -eq 0 ]; then
      log "[orch] Codeline '${_cl}': no stories — skipping"
      continue
    fi
    if lane_declared_passed "$_cl"; then
      log "[orch] Codeline '${_cl}': declared passed in this run (EPAM_PASSED_LANES) — its own line is not run again"
      # THE DECLARATION IS THE CODELINE'S RESULT (lib/handlers/record-declared-pass.js).
      "$NODE_BIN" "$SCRIPT_DIR/lib/handlers/record-declared-pass.js" "$_prd_path" "$_cl" || true
      # ITS OTHER RELEASE LINES STILL SHIP (lib/release-lines.sh): passed is the operator's word for the codeline's own line.
      _run_release_lines "$_cl" "$_cl_prd" "$_wt" "${LOG_DIR:-/tmp}/lanes/${_cl}" "$_log_file" "$_phase_filter" "$0" "$_prd_path" || _overall=1
      continue
    fi

    _rebuild_cross
    log "[orch] Codeline '${_cl}' — ${_n_stories} stories → ${_wt}"

    # A SEQUENTIAL LANE GETS ITS OWN LOG_DIR TOO. The parallel loop scoped it (2026-07-29: state
    # files read back across lanes); this loop did not, so every lane shared phase-baseline-sha.txt
    # and story-retry-state/. Live AMSD-2974 2026-10-05: cx-shared's baseline commit was recorded in
    # the upexpress and metrolinx checkpoints (a commit their repos do not have), and the gotransit
    # writer resumed at attempt 10/12 on a counter the lanes had shared.
    local _lane_log_dir="${LOG_DIR:-/tmp}/lanes/${_cl}"
    mkdir -p "$_lane_log_dir" 2>/dev/null || true

    local _phases=()
    mapfile -t _phases < <(_prd_phases "$_cl_prd")
    local _cl_failed=0

    for _phase in "${_phases[@]}"; do
      [ -z "$_phase" ] && continue
      # When the tier3 launcher (or any external caller) manages phases externally
      # by calling run-agent-orchestration.sh once per phase, honour its filter so
      # only the requested phase runs. Without this, a --phase scaffold call would
      # still execute every phase across every codeline (double-execution bug).
      if [ -n "$_phase_filter" ] && [ "$_phase" != "$_phase_filter" ]; then
        log "[orch] Phase '${_phase}' — skipping (caller phase filter: '${_phase_filter}')"
        continue
      fi
      log "[orch] Phase '${_phase}' — codeline '${_cl}'..."
      local _pex=0
      JIRA_CODELINE_RUN=1 \
      EPAM_CODELINE="$_cl" \
      LOG_DIR="$_lane_log_dir" \
      AGENT_IO_DIR="$_lane_log_dir/agent-io" \
      PRD_FILE="$_cl_prd" \
      EPAM_SPEC_MODE="${_lane_spec_mode:-${EPAM_SPEC_MODE:-}}" \
      PROJECT_ROOT="$_wt" \
      OUTPUT_DIR="$_wt" \
      PHASE="$_phase" \
      CROSS_CODELINE_PRD="${CROSS_CODELINE_PRD:-}" \
      bash "$0" --reset 2>&1 | tee -a "$_log_file"
      # No pipefail in this script, so `| tee || _pex=` tests tee's exit (0) and never
      # fires — a phase exit-2 (gate block) was masked to _pex=0 → "done" → PASSED
      # (live AMSD-1820 run #3). Capture the inner orch's real exit; tee exits 0 so set -e is fine.
      _pex=${PIPESTATUS[0]}

      # exit 2 = gate remediation applied — reset stories and retry once (mirrors tier3 launcher)
      if phase_exit_is_retryable "$_pex"; then
        log "[orch] Gate remediation applied for '${_phase}' ('${_cl}') — retrying with SKIP_GATE_REMEDIATION=1"
        _pex=0
        JIRA_CODELINE_RUN=1 \
        EPAM_CODELINE="$_cl" \
        LOG_DIR="$_lane_log_dir" \
        AGENT_IO_DIR="$_lane_log_dir/agent-io" \
        PRD_FILE="$_cl_prd" \
        EPAM_SPEC_MODE="${_lane_spec_mode:-${EPAM_SPEC_MODE:-}}" \
        PROJECT_ROOT="$_wt" \
        OUTPUT_DIR="$_wt" \
        PHASE="$_phase" \
        SKIP_GATE_REMEDIATION=1 \
        CROSS_CODELINE_PRD="${CROSS_CODELINE_PRD:-}" \
        bash "$0" --reset 2>&1 | tee -a "$_log_file"
        _pex=${PIPESTATUS[0]}
        if [ "$_pex" -ne 0 ]; then
          error "[orch] Phase '${_phase}' for '${_cl}' failed after self-healing retry (exit $_pex)"
        else
          log "[orch] Self-healing retry succeeded for '${_phase}' ('${_cl}')"
        fi
      fi

      if [ "$_pex" -ne 0 ]; then
        error "[orch] Phase '${_phase}' for '${_cl}' failed (exit $_pex)"
        _cl_failed=1; _overall=1; break
      fi
      if lane_paused_since "$_lane_log_dir" "$_lanes_started"; then
        log "[orch] Phase '${_phase}' — '${_cl}' PAUSED (inputs ready, writer not started)."
      else
        log "[orch] Phase '${_phase}' — '${_cl}' done."
      fi
    done

    # A SHARED CODELINE SHIPS ON EVERY RELEASE LINE ITS STORY'S PLAN NAMES (lib/release-lines.sh): its stories,
    # done on its own base, are worked once more per line off it — 0, 1 or N, as the plan says.
    if [ "$_cl_failed" = "0" ]; then
      _run_release_lines "$_cl" "$_cl_prd" "$_wt" "$_lane_log_dir" "$_log_file" "$_phase_filter" "$0" "$_prd_path" || { _cl_failed=1; _overall=1; }
    fi

    # The append-only ledgers back into the parent, as the parallel loop folds them.
    for _ledger in phase-cost.jsonl agent-activity.jsonl healing-events.jsonl phase-gates.jsonl; do
      if [ -n "${LOG_DIR:-}" ] && [ -s "${_lane_log_dir}/${_ledger}" ]; then
        cat "${_lane_log_dir}/${_ledger}" >> "${LOG_DIR}/${_ledger}" 2>/dev/null || true
      fi
    done

    [ "$_cl_failed" = "0" ] && \
      _completed_list="${_completed_list:+${_completed_list}:}${_cl_prd}"

    # Run codeline-bridge agent after each successful codeline (multi-codeline PRDs only).
    # Extracts exported types/functions/endpoints and writes a cross-codeline contract
    # consumed by downstream codeline agents via CROSS_CODELINE_CONTRACT_<CL_UPPER>.
    if [ "$_cl_failed" = "0" ] && [ "${#_cl_entries[@]}" -gt 1 ]; then
      _run_codeline_bridge "$_cl" "$_wt" "$_cl_prd"
    fi

    # Merge this codeline's final story state (status/completed/completedAt/
    # testCriteria/etc — whatever claude.sh/TC-writer wrote into the filtered
    # temp copy during real execution) back into the canonical PRD. Without
    # this, _cl_prd is the only file that ever held the real completion
    # result, and it was being deleted at the end of the loop — so the
    # canonical PRD (the file every downstream consumer, dashboard, and test
    # actually reads) stayed "pending" forever even after a real, successful
    # run. Found live 2026-07-23 via mock1.
    # The merge itself is lib/story-merge.js: it is the same operation on both the
    # sequential and the parallel path, it decides what survives a multi-lane run,
    # and inline in a heredoc it could not be tested. See that module for why a
    # spanning story cannot be merged wholesale.
    if "$NODE_BIN" "$SCRIPT_DIR/lib/handlers/merge-lane-into-canonical.js" \
         "$SCRIPT_DIR" "${_prd_path}" "${_cl_prd}" "${_cl}"; then
      log "[orch] Merged codeline '${_cl}' story state back into canonical PRD"
    else
      # Previously 2>/dev/null: a failed merge was indistinguishable from a
      # successful one that logged nothing, and it silently discards this lane's
      # entire outcome — status, criteria and all.
      error "[orch] FAILED to merge codeline '${_cl}' back into the canonical PRD;"
      error "[orch]   that lane's status and verification criteria are NOT recorded."
      _overall=1
    fi

    # ── Halt once a lane has finally failed ───────────────────────────────────
    # The failure path inside the PHASE loop above ends in a bare `break`, which
    # leaves that inner loop only — the CODELINE loop carried on to the next
    # lane. Live AMSD-2041 (2026-07-28): 'gotransit' hit a FATAL after 3/3 spec
    # attempts and the self-heal retry, and five seconds later the run started
    # 'upexpress'. A comment below this loop asserted "Lane failures already stop
    # the loop"; it was never true, and being written down is what kept anyone
    # from checking.
    #
    # By this point retries, the ladder and self-heal have ALL completed and the
    # step is still failed — the standing mandate is to stop there. The merge
    # above runs first deliberately, so the canonical PRD still records where the
    # run died. Nothing is guessed about WHY it failed: a lane that reached here
    # exhausted every recovery the pipeline has.
    if [ "$_cl_failed" = "1" ]; then
      error "[orch] HALT: codeline '${_cl}' failed."
      _halt_recovery_state "${_cl_failed_story:-}"
      error "[orch]   Not starting the remaining codeline(s)."
      break
    fi
  done
  fi

  # ── Partial coverage is a failure, not a pass ──────────────────────────────
  # A spanning story names the codelines it must be delivered in. Lane failures
  # already stop the loop; this catches the quieter case — a lane that never ran,
  # or ran and produced no result for this story — where every lane "succeeded",
  # the pipeline reports complete, and part of the work simply never happened.
  # Checked against what the story DECLARED, not against how many lanes we
  # happened to execute.
  if [ "$_overall" = "0" ] && [ -f "$_prd_path" ]; then
    _mc_incomplete=$("$NODE_BIN" "$SCRIPT_DIR/lib/handlers/spanning-stories-incomplete.js" "$_prd_path" 2>/dev/null || true)
    if [ -n "$_mc_incomplete" ]; then
      error "[orch] Spanning story INCOMPLETE — a declared codeline never ran: ${_mc_incomplete}"
      error "[orch] The run touched fewer codelines than the story requires; this is not a success."
      _overall=1
    fi
  fi

  # NOT deleted. This `rm -f` was /tmp hygiene: the lane PRDs used to live in a shared,
  # machine-global namespace and had to be swept. They now live in this run's OWN directory
  # (<project-config>/runs/<run-id>/work/), which makes them run EVIDENCE — the archiver
  # reads the working PRD from there, and deleting it first is why working-prd.json came
  # back "missing" on run 20260805T182214Z after the isolation fix.
  #
  # The cross-lane scratch file has no evidentiary value and is still removed.
  rm -f "$_cross_prd" 2>/dev/null || true
  unset CROSS_CODELINE_PRD

  # THE SUMMARY IS THE POINT. A story spanning codelines can now finish with some lanes
  # complete and some not, and the one thing that must never happen is someone merging two of
  # three without knowing the third is missing.
  if [ -n "${_LANE_OUTCOMES:-}" ]; then
    local _ok_n _blocked_n
    _ok_n=$(printf '%s\n' "$_LANE_OUTCOMES" | grep -c 'ok$' || true)
    _blocked_n=$(printf '%s\n' "$_LANE_OUTCOMES" | grep -c 'blocked$' || true)
    log "[orch] Lane outcomes — ${_ok_n} completed, ${_blocked_n} did not:"
    printf '%s\n' "$_LANE_OUTCOMES" | while IFS=$'\t' read -r _lc _ls; do
      [ -n "$_lc" ] || continue
      if [ "$_ls" = "ok" ]; then log "[orch]   ✓ ${_lc}"; else error "[orch]   ✗ ${_lc} — did not complete"; fi
    done
    if [ "${_blocked_n:-0}" != "0" ] && [ "${_ok_n:-0}" != "0" ]; then
      warning "[orch] This story spans codelines and did NOT complete on all of them."
      warning "[orch] Work sits on a per-story branch in each completed codeline; merging is yours to decide."
      warning "[orch] The run is reported as FAILED because a lane did not complete; the"
      warning "[orch] completed lanes' work is intact on their branches and is yours to merge."
    fi
  fi

  [ "$_overall" = "0" ] \
    && # A RUN THAT SPENT MONEY MUST NOT REPORT NOTHING. Checked here, at the end, where the run knows
# both what it did and what it recorded — see lib/cost-ledger.sh for the run this exists for.
assert_cost_ledger_not_silently_empty || true
# THE RECORDING IS NOT THE ARTEFACT. Langfuse holds the traces; a cassette is a directory on
# disk, and it exists only if something writes it. Nothing did — the exporter had no caller —
# so four runs on 2026-09-09 recorded 278 traces and left nothing replayable once the machine
# restarted and Langfuse went down with it.
#
# Here, at completion, because that is when the run knows its own id and the recording is
# whole. It cannot fail the run: the work is finished by this point, and a run that succeeded
# must not be reported failed because a recording could not be fetched.
# A RUN WHOSE LANES PAUSED IS PAUSED, NOT COMPLETE; and `log ... || error ...` always took the first branch (log returns
# 0), so a failed run printed "Pipeline complete" too (live AMSD-2974 run 9: "complete", then "aborting").
if [ "$_overall" = "0" ] && record_lanes_pause "$_lanes_started"; then
  :
elif [ "$_overall" = "0" ]; then
  log "[orch] ✅ Pipeline complete."
else
  error "[orch] ⚠️  Pipeline completed with errors."
fi

  return $_overall
}

# derive_sandbox_base_image <prd_file>
# Maps a project's OWN project.stack.language/.runtime (already written by
# the LLM-based `epam new generate` PRD pipeline for every scaffolded
# project — see src/scaffold/ManifestAnalyzer.ts's generatePrd(), currently
# unread by anything downstream) to a Docker base image for the sandbox.
# Generic pattern match, same shape as resolve_model_provider()'s
# EPAM_MODEL_PROVIDER_MAP glob convention elsewhere in this pipeline — no
# specific PROJECT is ever named here, only a small number of well-known
# language keywords. Falls back to node:20-slim (also correct for THIS
# project) when project.stack is missing/unrecognized, so an older PRD
# without stack data still gets a sane default rather than a build failure.
derive_sandbox_base_image() {
    local prd_file="$1"
    local stack_text=""
    if [ -f "$prd_file" ]; then
        stack_text=$(jq -r '[.project.stack.language, .project.stack.runtime] | map(select(. != null)) | join(" ")' "$prd_file" 2>/dev/null | tr '[:upper:]' '[:lower:]')
    fi
    case "$stack_text" in
        *python*)              echo "python:3.11-slim" ;;
        *golang*|*"go "*|*go)  echo "golang:1.22-bookworm" ;;
        *rust*)                echo "rust:1.75-slim" ;;
        *node*|*typescript*|*javascript*) echo "node:20-slim" ;;
        *)                     echo "node:20-slim" ;;
    esac
}
