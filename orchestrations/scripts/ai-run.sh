#!/usr/bin/env bash
# ai-run.sh — provider-agnostic prompt runner for orchestration scripts.
# Reads prompt from stdin, executes with configured provider, prints text output.
set -euo pipefail

EPAM_CLI="${EPAM_CLI:-epam}"
CLAUDE_CMD="${CLAUDE_CMD:-claude}"
AI_MODEL="${AI_MODEL:-}"
PRIMARY_PROVIDER="${AI_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-}}"
FALLBACKS_RAW="${AI_PROVIDER_FALLBACKS:-}"

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
      env -u CLAUDECODE "$CLAUDE_CMD" --dangerously-bypass-approvals-and-sandbox < "$PROMPT_FILE"
      ;;
    codemie-claude)
      env -u CLAUDECODE codemie-claude --dangerously-bypass-approvals-and-sandbox < "$PROMPT_FILE"
      ;;
    codex)
      if ! command -v "$EPAM_CLI" >/dev/null 2>&1; then
        echo "ai-run.sh: provider 'codex' requires '$EPAM_CLI run --provider codex --json'" >&2
        return 127
      fi
      local raw_file
      raw_file="$(mktemp)"
      if "$EPAM_CLI" run --provider codex "${model_args[@]}" --json < "$PROMPT_FILE" > "$raw_file"; then
        if jq -e . "$raw_file" >/dev/null 2>&1; then
          jq -r '.result // .message // .output // .text // empty' "$raw_file"
        else
          cat "$raw_file"
        fi
        rm -f "$raw_file"
        return 0
      fi
      rm -f "$raw_file"
      return 1
      ;;
    openai|qwen|cursor|copilot)
      "$EPAM_CLI" run --provider "$provider" "${model_args[@]}" --json < "$PROMPT_FILE" \
        | jq -r '.result // .message // .output // .text // empty'
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
