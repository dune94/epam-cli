set -uo pipefail
SCRIPT_DIR="$1"; OUT="$2"
source "$SCRIPT_DIR/lib/render-engine-prompt.sh"
# The blocks lifted below build their values file with jq_vals (values reach jq through
# files, never argv). Without this the lifted code is command-not-found and writes an EMPTY
# values file, which the renderer then rejects as invalid JSON.
source "$SCRIPT_DIR/lib/jq-vals.sh"
TC_WRITER_PROFILE="TCPROFILE_S"; STORY_CONTEXT="STORYCTX_S"; TC_OUT_FILE="TCOUT_S"
_REVIEW_PROFILE="REVPROFILE_S"; STORY_ID="STORYID_S"; STORY_TITLE="STORYTITLE_S"; STORY_AGENT="STORYAGENT_S"
ITERATION="ITER_S"; PROJECT_ROOT="PROJROOT_S"; AUTOMATION_DIR="AUTODIR_S"
_PRIOR_CONTEXT="PRIORCTX_S"; _STORY_ACS="ACS_S"; _STORY_DESC="DESC_S"; _STORY_DIFF="DIFF_S"; _STORY_FILES="FILES_S"
_vc="VC_S"; _test_src="TESTSRC_S"
grab() { awk -v id="$1" '$0 ~ (id "-vals-XXXXXX"){f=1} f{print} f && /^ *rm -f "\$_tpl_vals"$/{exit}' "$2" | sed 's/^    //'; }
eval "$(grab tc-writer "$SCRIPT_DIR/post-impl-tc-writer.sh")";        printf '%s' "$TC_PROMPT" > "$OUT/tc-writer.now"
eval "$(grab code-review-cycle "$SCRIPT_DIR/code-review-cycle.sh")";  printf '%s' "$_REVIEW_PROMPT" > "$OUT/code-review-cycle.now"
eval "$(grab vc-coverage "$SCRIPT_DIR/vc-coverage-check.sh")";        printf '%s' "$_prompt" > "$OUT/vc-coverage.now"
