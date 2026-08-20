set -uo pipefail
SCRIPT_DIR="$1"; OUT="$2"
source "$SCRIPT_DIR/lib/render-engine-prompt.sh"
# The blocks lifted below build their values file with jq_vals (values reach jq through
# files, never argv). Without this the lifted code is command-not-found and writes an EMPTY
# values file, which the renderer then rejects as invalid JSON.
source "$SCRIPT_DIR/lib/jq-vals.sh"
eval "$(awk '/^_render_change_reviewer\(\) \{/{f=1} f{print} f&&/^\}$/{exit}' "$SCRIPT_DIR/run-agent-orchestration.sh")"
story_id="STORYID_S"; phase_id="PHASEID_S"
_before_acs="BEFOREACS_S"; _candidate="CANDIDATE_S"; _pfa_diff="PFADIFF_S"; _profiles_change="PROFCHANGE_S"
_render_change_reviewer "$story_id" "ac_patch" "BEFORE:
${_before_acs}

AFTER:
${_candidate}" > "$OUT/now-1.txt"
_render_change_reviewer "pre-phase-assessment-${phase_id}" "profile_creation" "BEFORE/AFTER DIFF:
${_pfa_diff}" > "$OUT/now-2.txt"
_render_change_reviewer "gate-remediation" "profile_addendum" "THE CHANGE ITSELF (unified diff of the roster before and after):
${_profiles_change}" > "$OUT/now-3.txt"
