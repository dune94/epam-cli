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

# ── Output-budget safety net ────────────────────────────────────────────────
# AgentRunner's default when EPAM_MAX_OUTPUT_TOKENS is unset is 4096
# (src/agent/AgentRunner.ts). That is fine for a non-reasoning model, and far
# too small for the glm-5.x / kimi models this pipeline actually routes: their
# <think> blocks are billed against the SAME budget, so the model can exhaust
# it reasoning and emit truncated intermediate text — which ai-run.sh then
# returns as "the result". Live 2026-07-25: the team-lead reviewer emitted 169
# bytes ("Now let me verify the test actually covers...") with no verdict, and
# the run blocked on "review output unparseable". A non-reasoning model fits
# under 4096, which is exactly why standalone testing on haiku never saw it.
#
# Per-site values still win — this only applies when the caller set nothing.
export EPAM_MAX_OUTPUT_TOKENS="${EPAM_MAX_OUTPUT_TOKENS:-32768}"

# ── Pillar 3: enforced-state verification ───────────────────────────────────
# Every agent invocation passes through here, so this is where a drifted KB
# surface must be caught. Only fires when constraints were actually applied
# (KB_STATE_DIGEST set); otherwise it is a no-op, so runs with no KB state are
# unaffected. Refusing to invoke is deliberate: running the agent unconstrained
# while the pipeline believes a healed rule is in force is worse than failing,
# because the KB then records a "fix that did not work" and ages the rule out.
if [ -n "${KB_STATE_DIGEST:-}" ]; then
  _kb_lib="$(dirname "${BASH_SOURCE[0]}")/lib/kb-apply.sh"
  if [ -f "$_kb_lib" ]; then
    # shellcheck disable=SC1090
    . "$_kb_lib"
    if ! kb_verify_state; then
      echo "[ai-run] ABORT: enforced KB state drifted before invocation — refusing to run the agent unconstrained." >&2
      exit 3
    fi
  fi
fi

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
    *)
      echo "ai-run.sh: no provider configured. Set AI_PROVIDER or EPAM_ORCHESTRATION_PROVIDER." >&2
      exit 1
      ;;
  esac
fi

# ── Who is calling? ─────────────────────────────────────────────────────────
# Agent identity drives the plan record, the Langfuse trace name and the cost
# row. Nineteen scripts invoke this one without setting EPAM_AGENT_NAME, so
# their agents were all recorded as `agent` — indistinguishable from each other
# and from anything else.
#
# Naming each caller explicitly is the real fix and a registry test drives it.
# Until then, derive a name from the invoking script rather than leaving the
# record anonymous: imperfect beats useless. An explicitly-set name always wins.
if [ -z "${EPAM_AGENT_NAME:-}" ] && [ -r "/proc/$PPID/cmdline" ]; then
  # `|| true`: this script runs under `set -euo pipefail`, and a grep that
  # matches nothing exits 1 — which killed every invocation whose caller was not
  # a .sh/.js file. A best-effort label must never be able to fail the call.
  # Match a script name ANYWHERE in the parent's argv, not only at line end:
  # execSync wraps the command as `sh -c "bash /path/ai-run.sh ... 2>/dev/null"`,
  # one argv element that does not end in .sh — so every lib/*.js agent stayed
  # anonymous. And skip ai-run.sh itself, or it names itself as the agent.
  _caller="$(tr '\0' '\n' < "/proc/$PPID/cmdline" 2>/dev/null \
             | grep -oE '[a-zA-Z0-9_.-]+\.(sh|js)' \
             | grep -v '^ai-run\.sh$' | head -1 || true)"
  [ -n "$_caller" ] && EPAM_AGENT_NAME="${_caller%.*}"
fi
export EPAM_AGENT_NAME="${EPAM_AGENT_NAME:-agent}"

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
    openai|qwen|cursor|copilot|minimax)
      # Capture to temp file so pino JSON lines on stdout don't corrupt jq parsing
      local _epam_out
      _epam_out="$(mktemp)"
      # --no-tools: prevent the model from generating function-call markup (e.g. <function=bash>)
      # instead of the structured JSON output expected by spec-mode and pipeline agents.
      # AI_GATE_ALLOW_TOOLS=1: set by run_orch_prompt_with_tools for QA gate agents that must read
      # source files to ground their analysis (fuzz-weaver, perf-sentinel, sast-sentinel, etc.).
      # EPAM_MINIMAX_JSON_MODE=1: enable response_format:json_object for MiniMax to guarantee
      # syntactically valid JSON output (prevents M3 unescaped-char / truncation failures).
      local _tool_flag="--no-tools"
      local _skip_approval="0"
      if [ "${AI_GATE_ALLOW_TOOLS:-0}" = "1" ]; then
        _tool_flag=""
        _skip_approval="1"
      fi
      # Keep the CLI's stderr. It used to go to /dev/null, so an API exception
      # message was destroyed before the caller's err_file capture could see it:
      # Langfuse had the reason, the run log said "ai-run failed with no error
      # output", and retryable_failure classified against an empty string.
      local _epam_err
      _epam_err="$(mktemp)"
      if ! EPAM_MINIMAX_JSON_MODE=1 EPAM_DANGEROUS_SKIP_APPROVAL="$_skip_approval" \
          "$EPAM_CLI" run --provider "$provider" "${model_args[@]}" ${_tool_flag:+"$_tool_flag"} --json \
          < "$PROMPT_FILE" > "$_epam_out" 2>"$_epam_err"; then
        cat "$_epam_err" >&2
        cat "$_epam_out" >&2
        rm -f "$_epam_out" "$_epam_err"
        return 1
      fi

      # A call that produced NOTHING is not a success. jq exits 0 on empty output,
      # so this used to `return 0` with no stdout — no fallback provider tried, and
      # the caller could not tell it apart from a real answer. That is exactly how
      # the reviewer's truncated 169-byte non-verdict reached the pipeline as "the
      # reviewer's answer".
      #
      # The test is whether a COMPLETION RECORD exists, not whether the text is
      # non-empty: file-writing agents legitimately return an empty result string
      # because their work went to disk. Conflating those two caused an earlier bug.
      local _completions
      # Detect on has("result") ALONE. The extraction below still falls back to
      # .message/.output/.text for odd shapes, but they must not count as
      # COMPLETION: pino log lines carry .message, so accepting it here would let
      # "thinking..." register as an answer and defeat the whole check.
      _completions=$(jq -rs '[.[] | select(type == "object" and has("result"))] | length' \
        "$_epam_out" 2>/dev/null || echo 0)
      if [ "${_completions:-0}" -eq 0 ]; then
        echo "[ai-run] provider '$provider' returned NO completion record — truncated or empty reply, treating as FAILURE" >&2
        cat "$_epam_err" >&2
        rm -f "$_epam_out" "$_epam_err"
        return 1
      fi
      rm -f "$_epam_err"
      # When cost tracking is requested, save the normalized JSON result
      if [ -n "${ORCH_JSON_RESULT:-}" ]; then
        # Extract the result object (select lines that have a .result field)
        jq -rs '[.[] | select(.result != null)] | last // {}' "$_epam_out" \
          > "$ORCH_JSON_RESULT" 2>/dev/null || true
      fi
      # Extract text result, tolerating mixed pino JSON lines in output
      jq -rs '[.[] | select(type == "object" and (has("result") or has("message") or has("output") or has("text")))] | last // {} | .result // .message // .output // .text // empty' \
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

# ── Plan-execute ────────────────────────────────────────────────────────────
# Every agent states what it intends to do before it does it.
#
# Runs 8 and 9 (metrolinx, same ticket, same model, temperature 0) explored the
# identical eight files and hit the identical tool budget — 282 of 283 log lines
# byte-identical — then named different root causes: one the function that
# COMPUTES the discount, one the function that DISPLAYS it. There was no stage
# in between at which the intent could be read and checked, because exploring
# and answering happened in a single call.
#
# This lives here because every agent in the pipeline funnels through this
# script. One seam, so no agent is quietly left behind.
#
# It must never become a new way to fail: if the planning call produces nothing,
# the execute call runs exactly as it does today.
_plan_text=""
_plan_cost_json=""
if [ "${EPAM_PLAN_EXECUTE:-1}" = "1" ] && [ "${_EPAM_IN_PLAN_PASS:-0}" != "1" ]; then
  _plan_file="$(mktemp)"
  {
    cat "$PROMPT_FILE"
    printf '\n\n---\n'
    printf 'BEFORE YOU ANSWER: state your PLAN, and nothing else.\n\n'
    printf 'Say what you believe the answer is going to be and WHY, name the\n'
    printf 'specific targets you will examine or produce, and state how you will\n'
    printf 'know if you are wrong. If the task above sets a requirement your\n'
    printf 'answer must satisfy, say in one line how your plan satisfies it.\n\n'
    printf 'Do NOT produce the final answer yet. Do NOT emit the output format\n'
    printf 'the task asks for. Plain prose, at most 200 words.\n'
  } > "$_plan_file"

  _plan_json=""
  [ -n "${ORCH_JSON_RESULT:-}" ] && _plan_json="$(mktemp)"

  # The plan pass is an ordinary invocation with planning suppressed, so it
  # cannot recurse.
  # A distinct agent label, so the planning call is a separate, identifiable
  # generation in Langfuse instead of a second trace with the same name. Both
  # passes previously inherited EPAM_AGENT_NAME, which made plan and answer
  # indistinguishable in the one place their cost and latency are comparable.
  # NO TOOLS, and its own short deadline.
  #
  # Inheriting the tool budget made the detective explore twice — seven calls to
  # plan, seven more to answer — for work already done. And because the agent's
  # timeout wraps this whole script, a second exploration pushed agents toward
  # deadlines set for one pass, manufacturing timeouts that read as model
  # failures.
  #
  # It does not need them: the prompt already carries pre-seeded CodeGraph
  # output, so a hypothesis can be formed without spending a call — and a plan
  # made BEFORE looking is the more useful artefact, because the answer can be
  # checked against it. The execute pass keeps the full budget.
  _plan_text="$(
    _EPAM_IN_PLAN_PASS=1 \
    EPAM_AGENT_NAME="${EPAM_AGENT_NAME:-agent}:plan" \
    EPAM_ALLOWED_TOOLS="" \
    EPAM_MAX_TOOL_CALLS=0 \
    ORCH_JSON_RESULT="$_plan_json" \
    PROMPT_FILE="$_plan_file" \
    timeout "${EPAM_PLAN_TIMEOUT_SECS:-90}" \
    bash "$0" ${PRIMARY_PROVIDER:+--provider "$PRIMARY_PROVIDER"} ${AI_MODEL:+--model "$AI_MODEL"} \
      < "$_plan_file" 2>/dev/null || true
  )"
  rm -f "$_plan_file"

  if [ -n "$_plan_text" ]; then
    _plan_cost_json="$_plan_json"

    # Langfuse is off in mock1 and in any run without LANGFUSE_* configured, so
    # the plan is also written somewhere that always exists. Runs 8 and 9
    # produced byte-identical logs and different answers; without the plans
    # there is nothing to compare. Best-effort: a plan that cannot be recorded
    # must never break the agent call it belongs to.
    if [ -n "${LOG_DIR:-}" ] && [ -d "$LOG_DIR" ]; then
      jq -cn --arg agent "${EPAM_AGENT_NAME:-agent}" \
             --arg story "${EPAM_STORY_ID:-}" \
             --arg model "${AI_MODEL:-}" \
             --arg phase "${PHASE:-unknown}" \
             --arg plan  "$_plan_text" \
             '{ts:(now|todate), agent:$agent, story:$story, model:$model, phase:$phase, plan:$plan}' \
        >> "$LOG_DIR/plans-${PHASE:-unknown}.jsonl" 2>/dev/null || true
    fi
    _exec_file="$(mktemp)"
    {
      cat "$PROMPT_FILE"
      printf '\n\n---\n'
      printf 'YOUR PLAN (you wrote this a moment ago):\n%s\n\n' "$_plan_text"
      printf 'Now produce the final answer, in exactly the format the task above\n'
      printf 'requires. If carrying out the plan showed it to be wrong, say so and\n'
      printf 'answer correctly rather than following it.\n'
    } > "$_exec_file"
    mv "$_exec_file" "$PROMPT_FILE"
  else
    [ -n "$_plan_json" ] && rm -f "$_plan_json"
  fi
fi

# The plan pass billed real money. Fold its cost into the result the caller
# reads, or every run reports less than it actually spent.
_merge_plan_cost() {
  [ -n "${ORCH_JSON_RESULT:-}" ] || return 0
  [ -n "$_plan_cost_json" ] && [ -s "$_plan_cost_json" ] || return 0
  [ -s "$ORCH_JSON_RESULT" ] || return 0
  local _merged
  _merged="$(jq -s '
      (.[0] // {}) as $plan | (.[1] // {}) as $exec |
      $exec
      | .total_cost_usd = (($exec.total_cost_usd // 0) + ($plan.total_cost_usd // 0))
      | .tokens         = (($exec.tokens         // 0) + ($plan.tokens         // 0))
      | .planCostUsd    = ($plan.total_cost_usd // 0)
    ' "$_plan_cost_json" "$ORCH_JSON_RESULT" 2>/dev/null)"
  [ -n "$_merged" ] && printf '%s\n' "$_merged" > "$ORCH_JSON_RESULT"
  rm -f "$_plan_cost_json"
}

# ─── UNIFORM CALL RESILIENCE ─────────────────────────────────────────────────
# Retry, ladder escalation and self-heal for EVERY model call, applied here
# because this is the one seam all of them pass through.
#
# Live AMSD-2041 run 9: discovery's call returned an empty response, nothing
# retried it, and its fallback answered a three-codeline ticket with ONE
# repository — silently. Six earlier runs hid that it was always one bad response
# away from doing a third of the work and reporting success.
#
# The audit that followed found the gap is structural. Of 20 call sites:
#   retry      hand-rolled, 6 sites
#   ladder     _ladder_next_model() copy-pasted into 3 files, 6 sites
#   self-heal  lib/kb-apply.sh — a library, called from claude.sh ONLY
# Everything inside the orchestrator phase was protected; the ingest and helper
# layer had none of it — including the two most consequential calls in the run,
# the AC gate (which writes what "done" means) and codeline discovery (which
# chooses the repositories the run modifies).
#
# Fixing it per-site would leave the same hole open for the next site added, as
# it did for these. Here, a caller cannot omit it, cannot hand-roll a different
# version of it, and a new call site inherits it by construction.
#
# The three do different jobs and all three are needed:
#   RETRY      absorbs a transport-level transient (empty/unusable output).
#   LADDER     changes the model between attempts, so a retry is not the same
#              coin flip re-flipped. Uses the escalation the project configures;
#              no model name appears here.
#   SELF-HEAL  applies this agent's learned constraints before the call and
#              records the episode after a failure, so knowledge is not confined
#              to story agents. Keyed on EPAM_AGENT_NAME, which is always set by
#              now (explicitly by the caller, or derived from /proc above), so
#              every agent accumulates its own KB.

# The project's ladder. Shared here rather than copied a fourth time.
_ai_ladder_next_model() {
  local _m="$1" _map="${EPAM_MODEL_LADDER_HIGH:-${EPAM_MODEL_LADDER:-}}" _pair
  [ -z "$_map" ] && return 0
  IFS='|' read -ra _pairs <<< "$_map"
  for _pair in "${_pairs[@]}"; do
    case "$_pair" in "${_m}="*) echo "${_pair#*=}"; return 0 ;; esac
  done
}

# Self-heal is best-effort: a missing or broken KB must never take a model call
# down with it, which is why every hook is guarded and `|| true`.
_AI_KB_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/kb-apply.sh"
if [ -r "$_AI_KB_LIB" ]; then
  # shellcheck source=/dev/null
  . "$_AI_KB_LIB" 2>/dev/null || true
fi

_ai_kb_before() {
  command -v kb_apply_constraints >/dev/null 2>&1 || return 0
  kb_apply_constraints "${EPAM_AGENT_NAME:-agent}" "agent:${EPAM_AGENT_NAME:-agent}" 2>/dev/null || true
}

_ai_kb_after_failure() {
  command -v kb_record_episode >/dev/null 2>&1 || return 0
  printf '%s' "${1:-}" | kb_record_episode \
    "${EPAM_STORY_ID:-}" "${EPAM_AGENT_NAME:-agent}" "model call produced no usable output" \
    2>/dev/null || true
}

# The plan pass re-invokes this script; without this guard the retry budget would
# multiply (attempts x attempts) and a slow call could spend the whole run.
_ai_max_attempts="${EPAM_CALL_MAX_ATTEMPTS:-3}"
[ "${_EPAM_IN_PLAN_PASS:-0}" = "1" ] && _ai_max_attempts=1

_ai_kb_before

last_err=""
# Bound ONE attempt, so a hung call cannot consume the whole retry budget.
#
# Runs IN THIS SHELL: run_provider_once is a function that depends on this
# script's other functions and variables, so `timeout bash -c ...` would lose
# all of it.
#
# Two details are load-bearing, both found by measuring rather than reading:
#   - The watchdog's stdout is closed. Command substitution waits for EVERY
#     process holding the captured stdout open, so a watchdog that inherits it
#     makes even a 20ms call take the full budget.
#   - Output goes to FILES, not through the captured pipe. This is what stops a
#     surviving child from holding the caller open: with the pipe, killing the
#     job left `sleep` alive and the caller waited the full 30s anyway.
# `set -m` + the group kill (-PID) is DEFENSIVE, not proven necessary: mutating
# it back to a plain `kill "$_work"` leaves these tests green, because the file
# redirection already removes the dependency on the writer dying. It is kept for
# a child that ignores a TERM sent only to its parent, and this comment says so
# rather than claiming a load-bearing role the tests do not demonstrate.
_ai_attempt_timeout() {
  local _secs="${EPAM_CALL_ATTEMPT_TIMEOUT_SECS:-240}" _rc=0
  local _o _e
  _o="$(mktemp)"; _e="$(mktemp)"
  set -m
  ( "$@" ) >"$_o" 2>"$_e" &
  local _work=$!
  set +m
  ( sleep "$_secs"; kill -TERM "-${_work}" 2>/dev/null || kill -TERM "$_work" 2>/dev/null ) >/dev/null 2>&1 &
  local _watch=$!
  wait "$_work" 2>/dev/null; _rc=$?
  kill "-${_watch}" 2>/dev/null || kill "$_watch" 2>/dev/null
  wait "$_watch" 2>/dev/null || true
  cat "$_o"; cat "$_e" >&2
  rm -f "$_o" "$_e"
  return "$_rc"
}

for _call_attempt in $(seq 1 "$_ai_max_attempts"); do
if [ "$_call_attempt" -gt 1 ]; then
  # Escalate before retrying: repeating the same model on the same prompt is the
  # same gamble, which is how run 9 lost its premise on a single bad response.
  _ai_next="$(_ai_ladder_next_model "${AI_MODEL:-}")"
  if [ -n "$_ai_next" ] && [ "$_ai_next" != "${AI_MODEL:-}" ]; then
    echo "[ai-run] attempt ${_call_attempt}/${_ai_max_attempts} for '${EPAM_AGENT_NAME:-agent}' — escalating ${AI_MODEL} -> ${_ai_next}" >&2
    AI_MODEL="$_ai_next"; export AI_MODEL
  else
    echo "[ai-run] attempt ${_call_attempt}/${_ai_max_attempts} for '${EPAM_AGENT_NAME:-agent}' — no further ladder rung, retrying on ${AI_MODEL:-default}" >&2
  fi
fi

for provider in "${providers[@]}"; do
  err_file="$(mktemp)"
  if out="$(_ai_attempt_timeout run_provider_once "$provider" 2>"$err_file")"; then
    _merge_plan_cost
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

# Every provider failed on this attempt. Teach the agent's KB what happened, then
# let the outer loop escalate and try again.
_ai_kb_after_failure "$last_err"
done

# All attempts, all providers, every ladder rung exhausted. This is a real
# failure and must stay one: retry that converts a failure into a silent success
# is worse than no retry.
echo "${last_err:-ai-run failed with no error output}" >&2
echo "[ai-run] '${EPAM_AGENT_NAME:-agent}' failed after ${_ai_max_attempts} attempt(s) across every provider and ladder rung." >&2
exit 1
