#!/usr/bin/env bash
# A RUN THAT FINISHES LEAVES A CASSETTE. THERE IS NO OTHER WAY TO GET ONE.
#
# Four runs on 2026-09-09 produced none, and nothing anywhere said so:
#
#   - EPAM_REPLAY is read in ONE place, install.sh:57. No run script reads it, so setting it on a
#     launch did nothing. It looked like the recorder was on for every run; it was on for nothing.
#   - A Langfuse trace is not a cassette. A cassette exists only when cassette-export.js runs, and
#     nothing ran it — the exporter had no caller in the whole pipeline.
#   - orchestrations/cassettes/, the durable home, had received nothing since 2026-08-26.
#
# Run 20260908T215555Z recorded 278 traces across 35 seams. The machine restarted, Langfuse went
# down with it, and the run became unreplayable — while the operator had asked, repeatedly, for
# replay to be available for every run.
#
# The recording living in Langfuse is not the artefact. The artefact is the directory on disk, and
# it only exists if something writes it. This is that something.

# export_run_cassette <run_id> <project> <cassettes_dir>
#
# NEVER FAILS THE CALLER. It runs after the work is finished; a run that succeeded must not be
# reported as failed because its recording could not be fetched. Every outcome is announced —
# silence here would restore exactly the condition this exists to end.
#
# NEVER OVERWRITES. A cassette is run evidence ([[fb_never_rewrite_run_evidence]]): a second export
# of the same id keeps the first and says so.
#
# The exporter is overridable through EPAM_CASSETTE_EXPORTER for tests; it defaults to the real
# cassette-export.js beside this library, which is the only thing that can produce one.
export_run_cassette() {
    local _run_id="${1:-}" _project="${2:-project}" _cass_dir="${3:-}"

    if [ -z "$_run_id" ]; then
        warning "[cassette] no run id — this run leaves no cassette and cannot be replayed"
        return 0
    fi
    if [ -z "$_cass_dir" ]; then
        warning "[cassette] no cassette directory given for run '$_run_id' — nothing archived"
        return 0
    fi

    local _dest="$_cass_dir/${_project}-${_run_id}"
    if [ -d "$_dest" ]; then
        info "[cassette] $_dest already exists — keeping the original, exporting nothing"
        return 0
    fi

    local _exporter="${EPAM_CASSETTE_EXPORTER:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../cassette-export.js}"
    if [ ! -f "$_exporter" ]; then
        warning "[cassette] exporter not found at $_exporter — run '$_run_id' leaves no cassette"
        return 0
    fi

    # STAGED, THEN MOVED. A failed export must not leave a half-written directory that looks like a
    # cassette — the replayer would accept it and diverge, which is worse than having none.
    local _tmp; _tmp="$(mktemp -d "${TMPDIR:-/tmp}/cassette-XXXXXX")" || {
        warning "[cassette] could not create a staging directory — run '$_run_id' leaves no cassette"
        return 0
    }

    local _node="${NODE_BIN:-node}"
    command -v "$_node" >/dev/null 2>&1 || _node="node"

    local _out _rc
    _out="$("$_node" "$_exporter" --session "$_run_id" --out "$_tmp/c" 2>&1)"; _rc=$?

    if [ "$_rc" -ne 0 ] || [ ! -f "$_tmp/c/manifest.json" ]; then
        warning "[cassette] could not export run '$_run_id': $(printf '%s' "$_out" | tr '\n' ' ' | tail -c 300)"
        warning "[cassette] this run is NOT replayable. Langfuse must be reachable at export time."
        rm -rf "$_tmp"
        return 0
    fi

    mkdir -p "$_cass_dir" 2>/dev/null
    if mv "$_tmp/c" "$_dest" 2>/dev/null; then
        success "[cassette] run '$_run_id' archived to $_dest — $(printf '%s' "$_out" | tr '\n' ' ' | tail -c 120)"
    else
        warning "[cassette] export succeeded but could not be moved into $_dest — run not archived"
    fi
    rm -rf "$_tmp"
    return 0
}
