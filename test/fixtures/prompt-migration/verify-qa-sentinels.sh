set -uo pipefail
SCRIPT_DIR="$1"; OUT="$2"
source "$SCRIPT_DIR/lib/render-engine-prompt.sh"
error() { echo "ERROR: $*" >&2; }
PROJECT_ROOT="PROJECTROOT_S"; phase_id="PHASEID_S"
force_lightpanda="FORCELP_S"; force_playwright="FORCEPW_S"
mutant_oracle_summary="MUTANTORACLE_S"; review_diff_summary="REVIEWDIFF_S"; routing_decision="ROUTING_S"
_brownfield_gate_scope() { printf '%s' "GATESCOPE_S"; }
src="$SCRIPT_DIR/run-agent-orchestration.sh"
for pair in "sast:sast-sentinel" "spec:spec-validator" "review:review-ranger" "mutant:mutant-hunter" "fuzz:fuzz-weaver" "perf:perf-sentinel"; do
  v="${pair%%:*}"; n="${pair##*:}"
  awk -v n="$n" '$0 ~ ("qa-" n "-vals-XXXXXX"){f=1; print "  local _qa_vals; _qa_vals=$(mktemp \"${TMPDIR:-/tmp}/x-XXXXXX.json\")"; next} f{print} f && $0 ~ /^ *rm -f "\$_qa_vals"$/{exit}' "$src" > "$OUT/$n.body"
  { echo "_run_$v() {"; cat "$OUT/$n.body"; echo "  printf '%s' \"\$${v}_prompt\" > \"\$1\""; echo "}"; } > "$OUT/$n.fn"
  bash -n "$OUT/$n.fn" || { echo "$n: bad fn"; continue; }
  . "$OUT/$n.fn"; "_run_$v" "$OUT/$n.now"
done
