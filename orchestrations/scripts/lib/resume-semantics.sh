#!/usr/bin/env bash
# resume-semantics.sh — THE ONE ANSWER to "what does a resume keep?"
#
# Declared once in config/resume-preserves.json (see its $why for the five incidents that each
# taught one component separately). Consumers ask `resume_preserves <aspect>` and never test
# EPAM_RESUME_RUN themselves for these decisions. An aspect the declaration does not name is
# refused loudly (exit 2, message on stderr) — a consumer that asks about something undeclared
# has found a gap in the declaration, not a reason to guess.
#
#   is_resume                  — exit 0 when EPAM_RESUME_RUN names a run
#   resume_preserves <aspect>  — exit 0 when this is a resume AND the aspect is declared kept;
#                                exit 1 on a fresh launch; exit 2 for an undeclared aspect.

_resume_preserves_file() {
    local _here; _here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    echo "${EPAM_RESUME_PRESERVES_FILE:-$_here/../../config/resume-preserves.json}"
}

is_resume() {
    [ -n "${EPAM_RESUME_RUN:-}" ]
}

resume_preserves() {
    local _aspect="${1:-}"
    local _file; _file="$(_resume_preserves_file)"
    if [ -z "$_aspect" ] || ! jq -e --arg a "$_aspect" '.preserves[$a] // empty' "$_file" >/dev/null 2>&1; then
        echo "[resume-semantics] aspect '${_aspect}' is not declared in ${_file} — nothing says whether a resume keeps it; declare it before asking" >&2
        return 2
    fi
    is_resume
}
