#!/usr/bin/env bash
# archive-run-artifacts.sh — keep the evidence a successful run leaves behind.
#
# Everything that explains WHY a run did what it did is destroyed shortly after
# it finishes:
#
#   working PRD    lives in /tmp as orch-<codeline>-prd-<pid>.json and is cleaned
#                  up. It holds the verification criteria, the test criteria, the
#                  fix-site analysis and the declared file list. Asked for those
#                  on 2026-07-26, hours after a successful run, they were gone —
#                  the report could say "4 verification criteria were written"
#                  but not what they said.
#   profiles.json  restored from canonical at the START of every run, so the
#                  agent instructions a run actually used are overwritten by the
#                  next launch.
#   KB self-heals  the scratchpad is cleared by pre-run-reset.sh and the
#                  constraint/healing store keeps mutating.
#
# So the artefacts needed to audit or reproduce a run survive only until the next
# one starts. This captures them once, at the point of success, and records what
# was missing rather than leaving a silent gap.
#
# Never fails the run it is archiving: this is a post-success convenience, and
# turning a green run red would be a far worse defect than a missing copy.
#
# Env: AUTOMATION_DIR, LOG_DIR, RUN_ARTIFACT_DIR, WORKING_PRD (optional)

set -uo pipefail

AUTOMATION_DIR="${AUTOMATION_DIR:-}"
LOG_DIR="${LOG_DIR:-${AUTOMATION_DIR}/logs}"
OUT="${RUN_ARTIFACT_DIR:-}"

[ -n "$OUT" ] || { echo "[archive] RUN_ARTIFACT_DIR unset — nothing to do" >&2; exit 0; }
mkdir -p "$OUT/kb" 2>/dev/null || exit 0

_captured=()
_missing=()

_take() {   # _take <src> <dest-rel> <label>
    local src="$1" dest="$2" label="$3"
    if [ -e "$src" ]; then
        if cp -r "$src" "$OUT/$dest" 2>/dev/null; then
            _captured+=("$label")
            return 0
        fi
    fi
    _missing+=("$label")
    return 0
}

# The working PRD: verification criteria, test criteria, fix-site analysis.
_prd="${WORKING_PRD:-}"
if [ -z "$_prd" ]; then
    # The orchestration script names it orch-<codeline>-prd-<pid>.json; take the
    # newest, which is this run's.
    _prd=$(ls -t /tmp/orch-*-prd-*.json 2>/dev/null | head -1)
fi
_take "${_prd:-/nonexistent}" "working-prd.json" "working-prd.json"

# The agent instructions this run actually used.
_take "${AUTOMATION_DIR}/agents/profiles.json" "profiles.json" "profiles.json"

# Self-healing: the episodic scratchpad and the compiled constraint store.
_take "${LOG_DIR}/kb-scratchpad" "kb/kb-scratchpad" "kb/kb-scratchpad"
for _f in constraints.json healing-events.jsonl unmapped-rules.jsonl; do
    _take "${AUTOMATION_DIR}/agents/kb/${_f}" "kb/${_f}" "kb/${_f}"
done

# A manifest, so an absent file is never ambiguous: did it not exist, or did the
# archiving quietly fail?
{
    printf '{\n  "capturedAt": "%s",\n' "$(date -Iseconds 2>/dev/null || echo unknown)"
    printf '  "captured": ['
    for i in "${!_captured[@]}"; do
        [ "$i" -gt 0 ] && printf ', '
        printf '"%s"' "${_captured[$i]}"
    done
    printf '],\n  "missing": ['
    for i in "${!_missing[@]}"; do
        [ "$i" -gt 0 ] && printf ', '
        printf '"%s"' "${_missing[$i]}"
    done
    printf ']\n}\n'
} > "$OUT/artifacts.json" 2>/dev/null || true

echo "[archive] kept ${#_captured[@]} artefact(s) in $OUT${_missing[0]:+ (${#_missing[@]} missing)}"
exit 0
