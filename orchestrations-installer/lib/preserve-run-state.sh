# preserve-run-state.sh — AN UPDATE MUST NEVER DESTROY RUN EVIDENCE.
#
# `git archive <ref> | tar -x -C dest` overwrites every tracked file the ref contains,
# unconditionally. Found 2026-09-03: orchestrations/logs/ alone carries 5,268 tracked files
# (agent-mint.json, .rejection-AMSD-1919, agent-io/AMSD-1919/fix-plan, ...) genuinely shaped like
# real run evidence rather than app code that happened to live there. Re-packaging a newer ref into
# an EXISTING install would silently overwrite a colleague's real run history with whatever that
# ref's git history held at the same path.
#
# The boundary between "app code, safe to overwrite" and "run state, never touched by an update" is
# declared in run-state-paths.json, not hardcoded here — a new run-state location needs an entry
# there, not a script edit.

# run_state_exclude_args <run_state_paths_json>
#
# One `--exclude=<path>` and one `--exclude=<path>/*` per declared path, so tar skips both the
# directory entry itself and everything inside it.
run_state_exclude_args() {
    local _json="$1"
    "${NODE_BIN:-node}" -e '
      const fs = require("fs");
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const p of j.paths || []) {
        const clean = String(p).replace(/\/+$/, "");
        if (!clean) continue;
        process.stdout.write(`--exclude=${clean}\n`);
        process.stdout.write(`--exclude=${clean}/*\n`);
      }
    ' "$_json"
}

# run_state_ensure_dirs <run_state_paths_json> <dest>
#
# --exclude (above) means tar never creates these paths AT ALL — not just "leaves old data alone".
# This file's own comment used to claim "a first install into an empty $DEST is unaffected either
# way"; true for DATA (there is nothing to lose), false for EXISTENCE. Confirmed live 2026-09-04,
# fresh install pipeline-tests-8: orchestrations/logs did not exist after packaging, so the FIRST
# thing to touch it was Docker's bind-mount for the dashboard's /logs-dir (pre-run-reset.sh's
# agent-monitor restart) — and the Docker daemon runs as root, so it auto-created the missing host
# directory as root:root. pre-run-reset.sh then could not write its own archive dir into it:
# "mkdir: cannot create directory '.../orchestrations/logs/archive': Permission denied", and
# correctly refused to launch rather than proceed with partial state-clearing.
#
# Whichever process reaches a declared path first creates it, under whatever identity THAT process
# happens to run as. The fix is to make sure that process is always this one — the installer,
# running as the operator — by creating every declared path right after extraction, before Docker
# or anything else can get there first. Idempotent: an update finds these already owned correctly
# and does nothing.
#
# A '*' path is a glob over per-project directories (orchestrations/projects/*/kb) — expanded only
# where the project directory already exists; a project not yet extracted has nothing that would
# look for its subdirectory either. A .json/.jsonl path (phase-cost.jsonl) is a declared FILE, not
# a directory — nothing to mkdir.
run_state_ensure_dirs() {
    local _json="$1" _dest="$2"
    local _p
    while IFS= read -r _p; do
        [ -n "$_p" ] || continue
        case "$_p" in
            *.json|*.jsonl) continue ;;
        esac
        case "$_p" in
            *'*'*)
                # Glob only the PREFIX (the part before '*'), which already exists — extracted
                # normally, never excluded. Globbing the full pattern (prefix*/suffix) fails
                # silently: with the suffix not yet created, nothing matches, bash leaves the
                # pattern un-expanded, and every existence check on it is checking a literal
                # asterisk that can never be a real path.
                local _prefix="${_p%%\**}" _suffix="${_p#*\*}" _proj
                for _proj in "$_dest/$_prefix"*/; do
                    [ -d "$_proj" ] || continue
                    mkdir -p "${_proj%/}$_suffix"
                done
                ;;
            *)
                mkdir -p "$_dest/$_p"
                ;;
        esac
    done < <("${NODE_BIN:-node}" -e '
      const fs = require("fs");
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const p of j.paths || []) {
        const clean = String(p).replace(/\/+$/, "");
        if (clean) process.stdout.write(clean + "\n");
      }
    ' "$_json")
}
