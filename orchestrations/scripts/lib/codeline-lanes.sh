#!/usr/bin/env bash
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

  # Load the codeline-bridge-agent profile
  local _bridge_profile=""
  if [ -f "$_profiles_file" ]; then
    _bridge_profile=$(python3 "$SCRIPT_DIR/lib/handlers/bridge-profile.py" "$_profiles_file" 2>/dev/null || true)
  fi
  if [ -z "$_bridge_profile" ]; then
    warning "[bridge] codeline-bridge-agent profile not found in profiles.json — skipping"
    return 0
  fi

  _cp_vals=$(mktemp "${TMPDIR:-/tmp}/codeline-bridge-vals-XXXXXX.json")
  jq_vals \
        --arg bridge_profile "${_bridge_profile}" \
        --arg bridge_out "${_bridge_out}" \
        --arg bprd "${_bprd}" \
        --arg bcl "${_bcl}" \
        --arg bwt "${_bwt}" \
        '{"__BRIDGE_PROFILE__":$bridge_profile,"__BRIDGE_OUT__":$bridge_out,"__BPRD__":$bprd,"__BCL__":$bcl,"__BWT__":$bwt}' > "$_cp_vals"
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
    AI_GATE_ALLOW_TOOLS=1 EPAM_MAX_TOOL_CALLS="${CODELINE_BRIDGE_MAX_TOOL_CALLS:-10}" \
        run_orch_prompt "$_bridge_prompt" "codeline-bridge-agent" "$_bcl" || _bridge_rc=$?

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

_run_codeline_loop() {
  local _prd_path="$1"
  local _log_file="${2:-/tmp/orch-$(date +%Y%m%dT%H%M%S).log}"
  # When the tier3 launcher (or any external phase-managing caller) drives the
  # phase loop itself (calling us once per phase via --phase X), set this to
  # run only that phase across all codelines. Empty = run every PRD phase.
  local _phase_filter="${3:-}"

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
      if [ ! -d "$_wt/.git" ]; then
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
    local _p_cls=() _p_wts=() _p_prds=() _p_pids=()
    local _p_statusdir; _p_statusdir="$(mktemp -d /tmp/orch-lanes-XXXXXX)"

    for _entry in "${_cl_entries[@]}"; do
      local _cl="${_entry%%:*}" _wt="${_entry#*:}"
      local _cl_prd="$_work_dir/${_cl}-prd.json"
      _cl_prds+=("$_cl_prd")
      local _n_stories
      _n_stories=$(_filtered_prd "$_cl" "$_cl_prd" "$_prd_path")
      if [ "${_n_stories:-0}" -eq 0 ]; then
        log "[orch] Codeline '${_cl}': no stories — skipping"
        continue
      fi
      _p_cls+=("$_cl"); _p_wts+=("$_wt"); _p_prds+=("$_cl_prd")
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
      log "[orch] Phase '${_phase}' — '${_cl}' done."
    done

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
      for _ledger in phase-cost.jsonl agent-activity.jsonl healing-events.jsonl; do
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

    local _n_stories
    _n_stories=$(_filtered_prd "$_cl" "$_cl_prd" "$_prd_path")

    if [ "${_n_stories:-0}" -eq 0 ]; then
      log "[orch] Codeline '${_cl}': no stories — skipping"
      continue
    fi

    _rebuild_cross
    log "[orch] Codeline '${_cl}' — ${_n_stories} stories → ${_wt}"

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
      PRD_FILE="$_cl_prd" \
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
        PRD_FILE="$_cl_prd" \
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
      log "[orch] Phase '${_phase}' — '${_cl}' done."
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
log "[orch] ✅ Pipeline complete." \
    || error "[orch] ⚠️  Pipeline completed with errors."

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
