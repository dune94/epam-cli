set -uo pipefail
SCRIPT_DIR="$1"; OUT="$2"
source "$SCRIPT_DIR/lib/render-engine-prompt.sh"
error() { echo "ERROR: $*" >&2; }
src="$SCRIPT_DIR/claude.sh"
awk '/# RENDERED FROM THE TEMPLATE LAYER. Values go via a FILE/{f=1} f{print} f&&/^    rm -f "\$_rv_vals"$/{exit}' "$src" > "$OUT/rv.body"
awk '/# One renderer for both variants/{f=1} f{print} f&&/^    rm -f "\$_sum_vals"$/{exit}' "$src" > "$OUT/sm.body"
{ echo '_run_rv() {'; cat "$OUT/rv.body"; echo '  printf "%s" "$review_prompt" > "$1"'; echo '}'; } > "$OUT/rv.sh"
{ echo '_run_sm() {'; echo '  local _sum_template="$2"'; cat "$OUT/sm.body"; echo '  printf "%s" "$summarize_prompt" > "$1"'; echo '}'; } > "$OUT/sm.sh"
bash -n "$OUT/rv.sh" || { echo "rv.sh bad"; exit 1; }
bash -n "$OUT/sm.sh" || { echo "sm.sh bad"; exit 1; }
. "$OUT/rv.sh"; . "$OUT/sm.sh"
reviewer_profile="PROFILE_S"; story_id="STORY_S"; change_type="CHANGE_S"
before_json="BEFORE_S"; after_json="AFTER_S"; issues="ISSUES_S"; rejected_text="REJECTED_S"
_run_rv "$OUT/reviewer.now"
_run_sm "$OUT/tool.now" prd-change-summarizer-tool
_run_sm "$OUT/text.now" prd-change-summarizer-text
