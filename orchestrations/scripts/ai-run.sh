#!/usr/bin/env bash
# ai-run.sh — provider-agnostic prompt runner for orchestration scripts.
# Reads prompt from stdin, executes with configured provider, prints text output.
set -euo pipefail

EPAM_CLI="${EPAM_CLI:-epam}"
CLAUDE_CMD="${CLAUDE_CMD:-claude}"
AI_MODEL="${AI_MODEL:-}"
PRIMARY_PROVIDER="${AI_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-}}"
FALLBACKS_RAW="${AI_PROVIDER_FALLBACKS:-}"
# SDK invocation toggle — when 1, routes Claude provider through invoke.py.
# Inherited from environment; set by run-agent-orchestration.sh or caller.
EPAM_SDK_INVOKE="${EPAM_SDK_INVOKE:-0}"
_SCRIPT_DIR_AIRUN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVOKE_PY="$_SCRIPT_DIR_AIRUN/invoke.py"
INVOKE_PYTHON="${INVOKE_PYTHON:-$_SCRIPT_DIR_AIRUN/.venv/bin/python3}"
[ -x "$INVOKE_PYTHON" ] || INVOKE_PYTHON="python3"

load_env_file() {
  local env_file="$1"
  [ -f "$env_file" ] || return 0
  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
}

load_env_file "$(dirname "$(dirname "$_SCRIPT_DIR_AIRUN")")/.env"
load_env_file "${PROJECT_ROOT:-}/.env"

usage() {
  cat <<'EOF'
Usage: ai-run.sh [--provider NAME] [--model NAME]
Reads prompt from stdin and writes provider output to stdout.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider)
      PRIMARY_PROVIDER="${2:-}"
      shift 2
      ;;
    --model)
      AI_MODEL="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "ai-run.sh: unknown option '$1'" >&2
      exit 2
      ;;
  esac
done

if [ -z "$PRIMARY_PROVIDER" ]; then
  cmd_base="$(basename "$CLAUDE_CMD")"
  case "$cmd_base" in
    codex|openai|qwen|cursor|copilot|codemie-claude) PRIMARY_PROVIDER="$cmd_base" ;;
    *) PRIMARY_PROVIDER="claude" ;;
  esac
fi

PROMPT_FILE="$(mktemp)"
trap 'rm -f "$PROMPT_FILE"' EXIT
cat > "$PROMPT_FILE"

retryable_failure() {
  local text_lc
  text_lc="$(echo "$1" | tr '[:upper:]' '[:lower:]')"
  echo "$text_lc" | grep -Eq 'rate limit|quota|hit your limit|too many requests|resource exhausted|timeout'
}

run_provider_once() {
  local provider="$1"
  local model_args=()
  [ -n "$AI_MODEL" ] && model_args=(--model "$AI_MODEL")

  case "$provider" in
    claude)
      if [ "${EPAM_SDK_INVOKE:-0}" = "1" ] && [ -f "$INVOKE_PY" ]; then
        local _sdk_out
        _sdk_out="$(mktemp)"
        if "$INVOKE_PYTHON" "$INVOKE_PY" \
            ${AI_MODEL:+--model "$AI_MODEL"} \
            --output "$_sdk_out" < "$PROMPT_FILE" 2>/dev/null; then
          "$INVOKE_PYTHON" -c "import json,sys; d=json.load(open('$_sdk_out')); print(d.get('result',''),end='')" 2>/dev/null
          rm -f "$_sdk_out"
        else
          rm -f "$_sdk_out"
          return 1
        fi
      else
        # GAP-P22: when ORCH_JSON_RESULT is set, capture full JSON for cost tracking
        if [ -n "${ORCH_JSON_RESULT:-}" ]; then
          local _json_out
          _json_out=$(mktemp)
          "$CLAUDE_CMD" --print --output-format json --dangerously-skip-permissions "${model_args[@]}" \
              < "$PROMPT_FILE" > "$_json_out" 2>/dev/null
          jq -r '.result // empty' "$_json_out" 2>/dev/null
          cp "$_json_out" "$ORCH_JSON_RESULT" 2>/dev/null || true
          rm -f "$_json_out"
        else
          "$CLAUDE_CMD" --print --output-format text --dangerously-skip-permissions "${model_args[@]}" < "$PROMPT_FILE"
        fi
      fi
      ;;
    codemie-claude)
      codemie-claude --print --output-format text --dangerously-skip-permissions "${model_args[@]}" < "$PROMPT_FILE"
      ;;
    codex)
      if ! command -v codex >/dev/null 2>&1; then
        echo "ai-run.sh: provider 'codex' requires codex CLI" >&2
        return 127
      fi
      local codex_model="${AI_MODEL:-gpt-5-codex}"
      if ! echo "$codex_model" | grep -Eq '^(gpt-|o[0-9]|codex-)'; then
        codex_model="gpt-5-codex"
      fi
      local raw_file
      raw_file="$(mktemp)"
      if codex exec \
          --ephemeral \
          --skip-git-repo-check \
          --dangerously-bypass-approvals-and-sandbox \
          --model "$codex_model" \
          --json - < "$PROMPT_FILE" > "$raw_file"; then
        grep '"type":"item.completed"' "$raw_file" 2>/dev/null \
          | jq -rs '[.[].item.text // ""] | join("")' 2>/dev/null || true
        rm -f "$raw_file"
        return 0
      fi
      cat "$raw_file" >&2
      rm -f "$raw_file"
      return 1
      ;;
    openai|qwen|cursor|copilot)
      # Capture to temp file so pino JSON lines on stdout don't corrupt jq parsing
      local _epam_out
      _epam_out="$(mktemp)"
      # --no-tools: prevent the model from generating function-call markup (e.g. <function=bash>)
      # instead of the structured JSON output expected by spec-mode and pipeline agents
      if ! "$EPAM_CLI" run --provider "$provider" "${model_args[@]}" --no-tools --json \
          < "$PROMPT_FILE" > "$_epam_out" 2>/dev/null; then
        cat "$_epam_out" >&2
        rm -f "$_epam_out"
        return 1
      fi
      # When cost tracking is requested, save the normalized JSON result
      if [ -n "${ORCH_JSON_RESULT:-}" ]; then
        # Extract the result object (select lines that have a .result field)
        jq -rs '[.[] | select(.result != null)] | last // {}' "$_epam_out" \
          > "$ORCH_JSON_RESULT" 2>/dev/null || true
      fi
      # Extract text result, tolerating mixed pino JSON lines in output
      jq -rs '[.[] | select(.result != null and .result != "")] | last // {} | .result // .message // .output // .text // empty' \
        "$_epam_out"
      local _jq_rc=$?
      rm -f "$_epam_out"
      return $_jq_rc
      ;;
    *)
      echo "ai-run.sh: unsupported provider '$provider'" >&2
      return 2
      ;;
  esac
}

providers=("$PRIMARY_PROVIDER")
if [ -n "$FALLBACKS_RAW" ]; then
  IFS=',' read -r -a _fallbacks <<< "$FALLBACKS_RAW"
  for p in "${_fallbacks[@]}"; do
    p="$(echo "$p" | xargs)"
    [ -n "$p" ] && providers+=("$p")
  done
fi

last_err=""
for provider in "${providers[@]}"; do
  err_file="$(mktemp)"
  if out="$(run_provider_once "$provider" 2>"$err_file")"; then
    [ -n "$out" ] && printf '%s\n' "$out"
    rm -f "$err_file"
    exit 0
  fi

  this_err="$(cat "$err_file")"
  rm -f "$err_file"
  last_err="$this_err"

  if [ "$provider" = "${providers[-1]}" ]; then
    break
  fi
  if retryable_failure "$this_err"; then
    echo "[ai-run] provider '$provider' hit retryable failure, trying fallback..." >&2
  else
    echo "[ai-run] provider '$provider' failed, trying fallback..." >&2
  fi
done

echo "${last_err:-ai-run failed with no error output}" >&2
exit 1
