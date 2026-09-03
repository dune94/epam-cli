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
