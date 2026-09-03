# shellcheck shell=bash
# evidence_window <name> — how much evidence an agent is shown, by name.
#
# A NUMBER THAT DECIDES WHAT AN AGENT SEES MUST HAVE A NAME.
#
# `head -c 8000` on a gate log, `head -40` on compiler output, `head -100` on a source file: each
# decides what an agent is shown and therefore what it can conclude. Written at the call site, none
# could be tuned by an operator, none appeared in a cost estimate, and none could be found by anyone
# asking why an agent missed something three lines past the cut.
#
# REFUSES AN UNKNOWN NAME. A window that silently falls back to some default is the literal again
# with a layer of indirection over it, and the caller would then truncate on a number nobody chose.
#
# The declaration is orchestrations/config/evidence-windows.json; EPAM_EVIDENCE_WINDOWS_FILE
# relocates it, the same way every other declared file in this pipeline can be relocated.
evidence_window() {
    local _name="${1:-}"
    [ -n "$_name" ] || { echo "[evidence-window] no window name given" >&2; return 1; }

    local _file="${EPAM_EVIDENCE_WINDOWS_FILE:-}"
    if [ -z "$_file" ]; then
        _file="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/config/evidence-windows.json"
    fi
    [ -f "$_file" ] || {
        echo "[evidence-window] declaration not found: $_file" >&2
        return 1
    }

    local _v
    _v=$(jq -r --arg n "$_name" '.windows[$n].value // empty' "$_file" 2>/dev/null)
    if [ -z "$_v" ]; then
        echo "[evidence-window] '${_name}' is not declared in $_file — declare it with a \$why," >&2
        echo "[evidence-window] rather than truncating on a number nobody chose." >&2
        return 1
    fi
    printf '%s' "$_v"
}
