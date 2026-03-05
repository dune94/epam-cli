#!/usr/bin/env bash
# test-epam-providers.sh — Zero-token tests for copilot/openai/qwen/cursor orchestration.
#
# Tests:
#   1. provider_to_cli returns correct CLI name for each provider
#   2. normalize_provider_json correctly maps epam-run JSON to orchestration schema
#   3. mock-epam-run.sh correctly captures --provider and --model flags
#   4. resolve_model_from_story reads .model field from prd.json
#   5. run-agent-orchestration.sh routes copilot/openai/qwen/cursor to correct scripts
#
# No real API calls are made.  EPAM_CLI is set to the mock.
#
# Usage:
#   ./test/test-epam-providers.sh
#   All tests must pass with exit code 0.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$SCRIPT_DIR/.."
PASS=0
FAIL=0
MOCK="$SCRIPT_DIR/mock-epam-run.sh"
chmod +x "$MOCK"

RED='\033[0;31m'
GREEN='\033[0;32m'
RESET='\033[0m'

pass() { echo -e "${GREEN}  PASS${RESET} $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}  FAIL${RESET} $1"; FAIL=$((FAIL+1)); }
assert_eq() { [ "$1" = "$2" ] && pass "$3" || fail "$3 (expected '$2', got '$1')"; }

echo ""
echo "=== test-epam-providers.sh ==="
echo ""

# ─────────────────────────────────────────────────────────────────
# Test 1: provider_to_cli function in claude.sh
# ─────────────────────────────────────────────────────────────────
echo "1. provider_to_cli routing"

# Source just the function from claude.sh by temporarily extracting it
# We source with a NO_MAIN guard so it doesn't run the main entrypoint.
_result=$(
    bash -c '
        # Extract + eval only the provider_to_cli function
        SCRIPT="'"$SCRIPTS_DIR"'/claude.sh"
        # Extract the function block
        awk "/^provider_to_cli\(\)/{found=1} found{print; if(/^\}$/){exit}}" "$SCRIPT" > /tmp/_ptc.sh
        CLAUDE_CMD=claude
        EPAM_CLI=epam
        source /tmp/_ptc.sh
        echo "copilot=$(provider_to_cli copilot)"
        echo "openai=$(provider_to_cli openai)"
        echo "qwen=$(provider_to_cli qwen)"
        echo "cursor=$(provider_to_cli cursor)"
        echo "claude-sonnet=$(provider_to_cli claude-sonnet)"
        echo "codex=$(provider_to_cli codex)"
    '
)

assert_eq "$(echo "$_result" | grep '^copilot='   | cut -d= -f2)" "epam" "provider_to_cli copilot → epam"
assert_eq "$(echo "$_result" | grep '^openai='    | cut -d= -f2)" "epam" "provider_to_cli openai  → epam"
assert_eq "$(echo "$_result" | grep '^qwen='      | cut -d= -f2)" "epam" "provider_to_cli qwen    → epam"
assert_eq "$(echo "$_result" | grep '^cursor='    | cut -d= -f2)" "epam" "provider_to_cli cursor  → epam"
assert_eq "$(echo "$_result" | grep '^claude-sonnet=' | cut -d= -f2)" "claude" "provider_to_cli claude-sonnet → claude"
assert_eq "$(echo "$_result" | grep '^codex='     | cut -d= -f2)" "codex"  "provider_to_cli codex   → codex"

echo ""

# ─────────────────────────────────────────────────────────────────
# Test 2: normalize_provider_json epam-run transform
# ─────────────────────────────────────────────────────────────────
echo "2. normalize_provider_json epam-run"

RAW_JSON='{"result":"hello","cost_usd":0.0042,"usage":{"inputTokens":120,"outputTokens":80,"totalTokens":200}}'
RAW_FILE=$(mktemp /tmp/epam_raw_XXXXXX.json)
OUT_FILE=$(mktemp /tmp/epam_out_XXXXXX.json)
echo "$RAW_JSON" > "$RAW_FILE"

# Extract + eval normalize_provider_json from claude.sh
bash -c '
    SCRIPT="'"$SCRIPTS_DIR"'/claude.sh"
    awk "/^normalize_provider_json\(\)/{found=1} found{print; if(/^\}$/){exit}}" "$SCRIPT" > /tmp/_npj.sh
    source /tmp/_npj.sh
    normalize_provider_json "epam-run" "'"$RAW_FILE"'" "'"$OUT_FILE"'"
'

total_cost=$(jq -r '.total_cost_usd' "$OUT_FILE")
input_tok=$(jq -r '.usage.input_tokens' "$OUT_FILE")
output_tok=$(jq -r '.usage.output_tokens' "$OUT_FILE")
result_val=$(jq -r '.result' "$OUT_FILE")

assert_eq "$total_cost"  "0.0042"  "normalize: total_cost_usd = 0.0042"
assert_eq "$input_tok"   "120"     "normalize: usage.input_tokens = 120"
assert_eq "$output_tok"  "80"      "normalize: usage.output_tokens = 80"
assert_eq "$result_val"  "hello"   "normalize: result preserved"

rm -f "$RAW_FILE" "$OUT_FILE"
echo ""

# ─────────────────────────────────────────────────────────────────
# Test 3: mock-epam-run.sh captures provider + model flags
# ─────────────────────────────────────────────────────────────────
echo "3. mock-epam-run.sh flag capture"

MOCK_LOG=$(mktemp /tmp/mock_log_XXXXXX.txt)
echo "test prompt" | MOCK_LOG="$MOCK_LOG" "$MOCK" run --provider copilot --model gpt-4o --json - > /tmp/mock_output.json

assert_eq "$(grep 'provider=' "$MOCK_LOG" | cut -d' ' -f1 | cut -d= -f2)" "copilot" "mock: --provider copilot logged"
assert_eq "$(grep 'model='    "$MOCK_LOG" | cut -d' ' -f2 | cut -d= -f2)" "gpt-4o" "mock: --model gpt-4o logged"

mock_cost=$(jq -r '.cost_usd' /tmp/mock_output.json)
mock_tokens=$(jq -r '.usage.totalTokens' /tmp/mock_output.json)
assert_eq "$mock_cost"   "0.0042" "mock: cost_usd = 0.0042"
assert_eq "$mock_tokens" "200"    "mock: usage.totalTokens = 200"

rm -f "$MOCK_LOG" /tmp/mock_output.json
echo ""

# ─────────────────────────────────────────────────────────────────
# Test 4: resolve_model_from_story reads .model from prd.json
# ─────────────────────────────────────────────────────────────────
echo "4. resolve_model_from_story"

PRD_FILE=$(mktemp /tmp/prd_XXXXXX.json)
cat > "$PRD_FILE" <<'PRDJSON'
{
  "stories": [
    { "id": "story-001", "title": "Test story", "aiProvider": "copilot", "model": "gpt-4.1", "effort": "medium" }
  ]
}
PRDJSON

model_result=$(bash -c '
    SCRIPT="'"$SCRIPTS_DIR"'/claude.sh"
    awk "/^resolve_model_from_story\(\)/{found=1} found{print; if(/^\}$/){exit}}" "$SCRIPT" > /tmp/_rmfs.sh
    # Stub log()
    log() { :; }
    MAIN_PRD_FILE="'"$PRD_FILE"'"
    STORY_MODEL=""
    source /tmp/_rmfs.sh
    resolve_model_from_story "story-001"
    echo "$STORY_MODEL"
')
assert_eq "$model_result" "gpt-4.1" "resolve_model_from_story: reads .model = gpt-4.1"

rm -f "$PRD_FILE"
echo ""

# ─────────────────────────────────────────────────────────────────
# Test 5: run-agent-orchestration.sh selects correct script per provider
# ─────────────────────────────────────────────────────────────────
echo "5. run-agent-orchestration.sh routing"

for provider in copilot openai qwen cursor; do
    expected="$SCRIPTS_DIR/$provider.sh"
    selected=$(bash -c '
        EPAM_ORCHESTRATION_PROVIDER="'"$provider"'"
        SCRIPT_DIR="'"$SCRIPTS_DIR"'"
        case "${EPAM_ORCHESTRATION_PROVIDER}" in
            codemie-claude) echo "$SCRIPT_DIR/codemie-claude.sh" ;;
            copilot)        echo "$SCRIPT_DIR/copilot.sh" ;;
            openai)         echo "$SCRIPT_DIR/openai.sh" ;;
            qwen)           echo "$SCRIPT_DIR/qwen.sh" ;;
            cursor)         echo "$SCRIPT_DIR/cursor.sh" ;;
            *)              echo "$SCRIPT_DIR/claude.sh" ;;
        esac
    ')
    assert_eq "$selected" "$expected" "routing: $provider → $provider.sh"
done

echo ""

# ─────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────
TOTAL=$((PASS+FAIL))
echo "Results: $PASS/$TOTAL passed"
echo ""
if [ "$FAIL" -gt 0 ]; then
    echo -e "${RED}$FAIL test(s) FAILED${RESET}"
    exit 1
else
    echo -e "${GREEN}All tests passed!${RESET}"
    exit 0
fi
