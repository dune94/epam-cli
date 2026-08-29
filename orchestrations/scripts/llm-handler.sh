#!/usr/bin/env bash

# WHAT A CALL COST, recorded where every call passes. See lib/cost-record.sh.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/cost-record.sh" 2>/dev/null || true
# llm-handler.sh — THE CENTRAL LLM HANDLER.
#
# Every LLM call in the pipeline enters here and is dispatched to a vendor handler. Nothing
# else may read a credential or call a vendor endpoint. Renamed from ai-run.sh on 2026-08-25:
# the old name said nothing about what it does.
# Reads prompt from stdin, executes with configured provider, prints text output.
set -euo pipefail

EPAM_CLI="${EPAM_CLI:-epam}"
CLAUDE_CMD="${CLAUDE_CMD:-claude}"
AI_MODEL="${AI_MODEL:-}"
# resolve_primary_provider — the SET decides, not whatever a file left in the environment.
#
# This was a bare read of AI_PROVIDER / EPAM_ORCHESTRATION_PROVIDER, which knows nothing about the
# provider set in force. On 2026-08-29 a metrolinx run launched with EPAM_PROVIDER_SET=claude
# resolved the claude ladder — "at the top of its declared chain (claude-opus-5)" — and then asked
# provider 'qwen' for it, because the repo's .env still carried EPAM_ORCHESTRATION_PROVIDER=qwen
# from another stack. Three attempts, no completion record, and the run died AFTER the roster had
# been minted and reviewed against real client code.
#
# The repo already had this incident on record once. Twice is a design fault, not an accident.
#
# The set is the deliberate per-launch choice; the env var is whatever was left behind. So a
# provider the active set cannot route is replaced by one it can — and the substitution is
# ANNOUNCED, because an operator who really meant qwen has to see that they did not get it.
#
# A run that declares no set has expressed no preference this can contradict, and is left alone.
resolve_primary_provider() {
    local _env_provider="${AI_PROVIDER:-${EPAM_ORCHESTRATION_PROVIDER:-}}"
    local _set="${EPAM_PROVIDER_SET:-}"
    if [ -z "$_set" ]; then
        printf '%s' "$_env_provider"
        return 0
    fi

    local _routable
    _routable=$("${NODE_BIN:-node}" "${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}/lib/handlers/ladder-providers.js" 2>/dev/null || echo "")
    if [ -z "$_routable" ] || [ "$_routable" = "[]" ]; then
        printf '%s' "$_env_provider"
        return 0
    fi

    if [ -n "$_env_provider" ] \
       && printf '%s' "$_routable" | jq -e --arg p "$_env_provider" 'index($p) != null' >/dev/null 2>&1; then
        printf '%s' "$_env_provider"
        return 0
    fi

    local _first
    _first=$(printf '%s' "$_routable" | jq -r '.[0] // empty')
    [ -n "$_first" ] || { printf '%s' "$_env_provider"; return 0; }
    if [ -n "$_env_provider" ]; then
        # STDERR DIRECTLY, not warning(): this runs before llm-handler.sh defines its log helpers,
        # and under `set -euo pipefail` a command-not-found aborts the whole substitution — which
        # left the provider as whatever the environment said and failed the metrolinx run of
        # 2026-08-29 a SECOND time, with this very fix in place. A diagnostic must not be able to
        # break the thing it is diagnosing.
        printf '%s\n' "  [provider] '${_env_provider}' is not routable by the '${_set}' set — using '${_first}'." >&2
        printf '%s\n' "  [provider] The set is the launch's own choice; the env value was left by something else." >&2
    fi
    printf '%s' "$_first"
}

PRIMARY_PROVIDER="$(resolve_primary_provider)"
FALLBACKS_RAW="${AI_PROVIDER_FALLBACKS:-}"
# SDK invocation toggle — when 1, routes Claude provider through invoke.py.
# Inherited from environment; set by run-agent-orchestration.sh or caller.
EPAM_SDK_INVOKE="${EPAM_SDK_INVOKE:-0}"
_SCRIPT_DIR_AIRUN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVOKE_PY="$_SCRIPT_DIR_AIRUN/invoke.py"
INVOKE_PYTHON="${INVOKE_PYTHON:-$_SCRIPT_DIR_AIRUN/.venv/bin/python3}"
[ -x "$INVOKE_PYTHON" ] || INVOKE_PYTHON="python3"


. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/env-file.sh"
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/runner-settings.sh" 2>/dev/null || true
. "$_SCRIPT_DIR_AIRUN/lib/story-retry-state.sh"
# Delegates to lib/env-file.sh: loading configuration must not EXECUTE it. This function
# used to `. "$env_file"`, and a bare `cd` on line 1 of the repo's .env sent this script —
# the agent invoker — to $HOME every time it started.
load_env_file() {
  load_env_file_safe "$1"
}

load_env_file "$(dirname "$(dirname "$_SCRIPT_DIR_AIRUN")")/.env"
load_env_file "${PROJECT_ROOT:-}/.env"

# ── Output-budget safety net ────────────────────────────────────────────────
# AgentRunner's default when EPAM_MAX_OUTPUT_TOKENS is unset is 4096
# (src/agent/AgentRunner.ts). That is fine for a non-reasoning model, and far
# too small for the glm-5.x / kimi models this pipeline actually routes: their
# <think> blocks are billed against the SAME budget, so the model can exhaust
# it reasoning and emit truncated intermediate text — which this handler then
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
Usage: llm-handler.sh [--provider NAME] [--model NAME]
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
      echo "llm-handler.sh: unknown option '$1'" >&2
      exit 2
      ;;
  esac
done

# A REHEARSAL BRINGS ITS OWN PROVIDER. The cassette directory names it; this refusal is about a
# run that has no provider at all, and would otherwise reject a replay before the substitution
# below is ever reached.
if [ -z "$PRIMARY_PROVIDER" ] && [ -n "${EPAM_REPLAY_CASSETTE_DIR:-}" ]; then
  PRIMARY_PROVIDER="replay"
fi

if [ -z "$PRIMARY_PROVIDER" ]; then
  cmd_base="$(basename "$CLAUDE_CMD")"
  case "$cmd_base" in
    codex|openai|qwen|cursor|copilot|codemie-claude) PRIMARY_PROVIDER="$cmd_base" ;;
    *)
      echo "llm-handler.sh: no provider configured. Set AI_PROVIDER or EPAM_ORCHESTRATION_PROVIDER." >&2
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
  # execSync wraps the command as `sh -c "bash /path/llm-handler.sh ... 2>/dev/null"`,
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

  # WHAT THE STACK DECLARED FOR THIS RUNNER — through the SHIM, not a second copy of it.
  #
  # lib/runner-settings.sh already resolves a runner declaration into exported env and a
  # RUNNER_FLAGS array, and claude.sh has called it since it was written. The hub did not, so
  # the two paths to the same runner disagreed: a story implemented through claude.sh got the
  # declared flags and the same model called through the hub did not. This calls the same
  # function rather than reimplementing it, so there is one place where the rule lives.
  local runner_args=()
  RUNNER_FLAGS=()
  if declare -F apply_runner_settings >/dev/null 2>&1; then
    apply_runner_settings "$(basename "$CLAUDE_CMD")" "${EPAM_PROJECT_CONFIG_DIR:-}" || true
    runner_args=(${RUNNER_FLAGS[@]+"${RUNNER_FLAGS[@]}"})
  fi
    # BIND THE OUTPUT CONTRACT AT THE PROVIDER, WHERE IT CAN ACTUALLY BE ENFORCED.
    #
    # Seams declare their output shape and pass it as EPAM_RESPONSE_SCHEMA. That variable was read
    # in exactly one place — src/agent/AgentRunner.ts, on the `epam run` arm — so on a one-shot
    # runner it bound NOTHING and the prompt was the contract's only channel. Asking a model in
    # prose for a JSON shape and hoping is what produced "no parseable output", "missing required
    # field" and "16 chars of unusable output" across this pipeline, and what the retry ladder,
    # self-heal and MINIMAX_JSON_MODE were all built to survive.
    #
    # The CLI enforces it directly: --json-schema validates structured output before the reply is
    # returned. The schema is the seam's OWN declaration, unwrapped from the {name, schema} envelope
    # schemaEnv() builds — nothing is authored here and no seam is named.
    #
    # Absent, unreadable, or on a runner that does not accept the flag, the call proceeds exactly as
    # before and the tag in the prompt remains the contract: enforcement is an upgrade, never a
    # precondition.
    if [ -n "${EPAM_RESPONSE_SCHEMA:-}" ] && command -v jq >/dev/null 2>&1; then
      _rs_schema="$(printf '%s' "$EPAM_RESPONSE_SCHEMA" | jq -c '.schema // empty' 2>/dev/null || true)"
      if [ -n "$_rs_schema" ] && "$CLAUDE_CMD" --help 2>/dev/null | grep -q -- '--json-schema'; then
        runner_args+=(--json-schema "$_rs_schema")
      fi
    fi


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
          # STDERR IS KEPT. It was sent to /dev/null, so when the runner rejected a flag the arm
          # produced an empty reply and NOTHING said why: codeline-discovery reported only
          # "Empty response from ai-run.sh (no stderr captured)" and the 2026-08-26 mock3 run
          # aborted three steps later on "codeline scope could not be resolved". The actual
          # message was `error: unknown option '-s'`.
          local _cc_err; _cc_err="$(mktemp "${TMPDIR:-/tmp}/claude-err-XXXXXX")"
          "$CLAUDE_CMD" --print --output-format json --dangerously-skip-permissions "${model_args[@]}" ${runner_args[@]+"${runner_args[@]}"} \
              < "$PROMPT_FILE" > "$_json_out" 2>"$_cc_err"
          if [ ! -s "$_json_out" ] && [ -s "$_cc_err" ]; then
            echo "[llm-handler] $(basename "$CLAUDE_CMD") produced no output: $(head -c 400 "$_cc_err")" >&2
          fi
          rm -f "$_cc_err"
          jq -r '.result // empty' "$_json_out" 2>/dev/null
          cp "$_json_out" "$ORCH_JSON_RESULT" 2>/dev/null || true
          rm -f "$_json_out"
        else
          "$CLAUDE_CMD" --print --output-format text --dangerously-skip-permissions "${model_args[@]}" ${runner_args[@]+"${runner_args[@]}"} < "$PROMPT_FILE"
        fi
      fi
      ;;
    codemie-claude)
      # THE SAME COST CAPTURE AS THE PLAIN CLAUDE ARM.
      #
      # This ran --output-format text and captured nothing, so swapping to this stack silently
      # swapped cost visibility off with it — and a hot swap that loses cost tracking is not a hot
      # swap. The wrapper runs Claude Code underneath and answers in the same JSON shape, so there
      # was never a reason for the two arms to differ.
      if [ -n "${ORCH_JSON_RESULT:-}" ]; then
        local _cm_json
        _cm_json=$(mktemp)
        codemie-claude --print --output-format json --dangerously-skip-permissions "${model_args[@]}" ${runner_args[@]+"${runner_args[@]}"} \
            < "$PROMPT_FILE" > "$_cm_json" 2>/dev/null
        jq -r '.result // empty' "$_cm_json" 2>/dev/null
        cp "$_cm_json" "$ORCH_JSON_RESULT" 2>/dev/null || true
        rm -f "$_cm_json"
      else
        codemie-claude --print --output-format text --dangerously-skip-permissions "${model_args[@]}" ${runner_args[@]+"${runner_args[@]}"} < "$PROMPT_FILE"
      fi
      ;;
    codex)
      if ! command -v codex >/dev/null 2>&1; then
        echo "llm-handler.sh: provider 'codex' requires codex CLI" >&2
        return 127
      fi
      # THE LADDER DICTATES THE MODEL — NO EXCEPTIONS.
      #
      # This defaulted to a literal twice: once when AI_MODEL was unset, and again when the
      # resolved model did not look codex-shaped. Either way a run that had resolved one model
      # called a different one, chosen here, with nothing in the log to say so.
      #
      # A provider that cannot serve the model the ladder chose is a routing error, not a licence
      # to pick another. Fail, and let the ladder escalate to a rung this provider can serve.
      local codex_model="${AI_MODEL:-}"
      if [ -z "$codex_model" ]; then
        echo "llm-handler.sh: provider 'codex' selected but no model resolved from the ladder" >&2
        return 78
      fi
      if ! echo "$codex_model" | grep -Eq '^(gpt-|o[0-9]|codex-)'; then
        echo "llm-handler.sh: the ladder resolved '$codex_model', which provider 'codex' cannot serve" >&2
        return 78
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
    # `replay` DISPATCHES HERE because this is the arm that runs the epam CLI, and the CLI is
    # where the replay provider lives — so the agent loop runs for real and the recorded tool
    # calls really execute. Selecting a provider and being able to RUN one are different things:
    # replay was selected while this case statement had no arm for it, so every rehearsal fell to
    # the default and failed without invoking anything.
    #
    # The tool posture is NOT special-cased. A replayed call carries the same env the recorded
    # call did, so a seam that had tools then has them now — which is what makes the recorded
    # tool calls executable rather than refused.
    openai|qwen|cursor|copilot|minimax|replay)
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
      echo "llm-handler.sh: unsupported provider '$provider'" >&2
      return 2
      ;;
  esac
}

# A REHEARSAL REPLACES EVERY PROVIDER, AT ONE PLACE.
#
# Each seam names its own provider through project config, so rehearsing a run by editing them
# would mean touching dozens of declarations and putting them all back afterwards -- and the one
# left behind would spend real money in the mode whose whole purpose is not to. Every model call
# in the pipeline, from bash and from JS alike, execs THIS script, so the substitution belongs
# here and nowhere else.
#
# The cassette directory IS the switch. There is no separate "replay mode" flag that could be set
# without a recording, or a recording present with the flag forgotten.
if [ -n "${EPAM_REPLAY_CASSETTE_DIR:-}" ]; then
  if [ ! -d "$EPAM_REPLAY_CASSETTE_DIR" ]; then
    echo "[ai-run] EPAM_REPLAY_CASSETTE_DIR is set to '$EPAM_REPLAY_CASSETTE_DIR', which is not a directory." >&2
    echo "[ai-run] A rehearsal replays a recorded run; it does not fall back to a paid provider." >&2
    exit 1
  fi
  providers=("replay")
  AI_PROVIDER="replay"; export AI_PROVIDER
  # The FALLBACK CHAIN IS DROPPED DELIBERATELY. A fallback exists so a failing provider is retried
  # on a paid one, which is exactly what must not happen here: a replay that diverges from its
  # recording is a finding, and falling back would convert that finding into a bill.
  echo "[ai-run] REHEARSAL: replaying $EPAM_REPLAY_CASSETTE_DIR -- no provider is called and nothing is spent" >&2
else
  providers=("$PRIMARY_PROVIDER")
  if [ -n "$FALLBACKS_RAW" ]; then
    IFS=',' read -r -a _fallbacks <<< "$FALLBACKS_RAW"
    for p in "${_fallbacks[@]}"; do
      p="$(echo "$p" | xargs)"
      [ -n "$p" ] && providers+=("$p")
    done
  fi
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
# The project's ladder. Shared here rather than copied a fourth time.
# Defined THIS early (ahead of the plan-pass block below) because the
# cross-process ladder-resume seed right after it must take effect BEFORE the
# plan pass fires — the plan pass recurses into `bash "$0" --model
# "$AI_MODEL"`, so if AI_MODEL were resumed only later, the plan-pass
# sub-call would still use the un-resumed base model on every invocation.
# THE SHARED LADDER HANDLER — the same one claude.sh and the seam scripts use.
#
# What stood here was a second implementation, and it differed from the declaration in two ways
# that made every archetype's tier decorative:
#
#   IT ALWAYS CLIMBED THE *HIGH* CHAIN.  _ai_ladder_next_model read EPAM_MODEL_LADDER_HIGH
#   regardless of the tier the agent's archetype declares, so an agent declared HIGHEST escalated
#   along HIGH. Changing a declaration changed no model.
#
#   EVERY AGENT SHARED ONE COUNTER.  The rung state was keyed on ${EPAM_AGENT_NAME:-agent}, and
#   nothing set EPAM_AGENT_NAME except two callers — so the reviewer, the analyst, the tc-writer
#   and the test-updater all read and wrote "agent__<story>". One agent escalating advanced the
#   ladder for all of them; one agent exhausting it exhausted everyone's.
#
#   (team-lead-review.sh is NOT an instance of this: it keeps its own review-scoped key and
#   writes it via advance_ladder_escalation, so its resume does work. Its separate defect is that
#   its private chain is pinned to HIGH regardless of the tier it declares.)
#
# agent_ladder_model resolves the chain from the agent's ARCHETYPE and keeps rung state per
# agent AND per story, so both faults go away by construction.
# shellcheck source=lib/agent-ladder.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/agent-ladder.sh" 2>/dev/null || true

# WHICH AGENT THIS INVOCATION IS. Callers declare it; without it there is no per-agent rung state
# and the ladder cannot be resolved from a declaration, so say so rather than climbing the wrong
# chain silently.
_LADDER_AGENT="${EPAM_AGENT_NAME:-}"
_LADDER_STORY="${EPAM_STORY_ID:-global}"
if [ -z "$_LADDER_AGENT" ]; then
  echo "[ai-run] no EPAM_AGENT_NAME declared — this invocation has no archetype, so no ladder is resolved and no rung is recorded" >&2
fi

# Resume: one rung per failure already recorded for THIS agent on THIS story.
# Skipped for a plan-pass sub-invocation, which inherits its parent's already-resumed model.
if [ -n "$_LADDER_AGENT" ] && [ -n "${LOG_DIR:-}" ] && [ "${_EPAM_IN_PLAN_PASS:-0}" != "1" ]; then
  _ai_resumed="$(agent_ladder_model "$_LADDER_AGENT" "$_LADDER_STORY" "${AI_MODEL:-}")"
  if [ -n "$_ai_resumed" ] && [ "$_ai_resumed" != "${AI_MODEL:-}" ]; then
    echo "[ai-run] '$_LADDER_AGENT' resuming ladder on '$_ai_resumed' (persisted from an earlier invocation)" >&2
    AI_MODEL="$_ai_resumed"; export AI_MODEL
  fi
fi

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
    printf 'the task asks for. Plain prose, at most 200 words.\n\n'
    printf 'You have NO tools available for THIS plan and cannot call any — do not\n'
    printf 'emit tool-call syntax (<tool_call>, <tool_use>, <function_call>) or\n'
    printf 'invent what a tool would return. Nothing executes it, so any such text\n'
    printf 'is fiction, not evidence — state your INTENT to examine a target, not a\n'
    printf 'fabricated result from having done so. If tools are available for the\n'
    printf 'answer that follows this plan, you will use them for real then.\n'
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
      | (if (($exec.total_cost_usd // $plan.total_cost_usd) != null)
         then .total_cost_usd = (($exec.total_cost_usd // 0) + ($plan.total_cost_usd // 0))
         else . end)
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

# (the shared ladder handler is sourced earlier, ahead of the plan-pass block —
# see that definition's docstring for why.)

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
  # THE SEAM'S DECLARED BUDGET, THEN THE OPERATOR OVERRIDE, THEN THE FLOOR.
  # invocation-profiles.json gives each seam a timeoutSecs and seam-invocation exports it as
  # EPAM_TIMEOUT_SECS. This watchdog read only EPAM_CALL_ATTEMPT_TIMEOUT_SECS, which nothing sets,
  # so 36 of 39 seams declared more than 240s and every one of them was killed at 240 — by SIGTERM,
  # which emits no stderr, so it surfaced as "failed with no error output" and burned all three
  # ladder attempts on the same silent kill.
  local _secs="${EPAM_CALL_ATTEMPT_TIMEOUT_SECS:-${EPAM_TIMEOUT_SECS:-240}}" _rc=0
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

# THE HIGHER RUNG MUST BE TOLD WHAT THE LOWER ONE GOT WRONG.
#
# Escalation recorded the failure, stepped the rung, and handed the stronger model the IDENTICAL
# prompt. So it re-derived the same answer from the same inputs with no idea what had just failed —
# a parse error, a truncated reply, a refused tool call — and the extra money bought a second guess
# rather than a correction. Same-rung retries already feed the reason back (refusalBlock in
# prompt-builder and the mint, retryUntilParsed in discovery); ladder escalation, which is the
# EXPENSIVE one, fed back nothing, for every agent.
#
# last_err already held the previous attempt's stderr. Nothing needed capturing; it needed passing.
#
# Rendered from the SAME previous-refusal template the content retries use, so an agent meets one
# format however it is being corrected.
_ai_prompt_with_failure() {
  local _why="$1"
  [ -n "$_why" ] || { printf '%s' "$PROMPT_FILE"; return 0; }

  # NEVER PUT A CREDENTIAL IN A PROMPT. stderr is arbitrary text from a vendor CLI and has carried
  # keys before; a prompt is the one place a leaked value is guaranteed to be transmitted.
  _why="$(printf '%s' "$_why" | sed -E 's/(sk-[A-Za-z0-9_-]{8,}|ey[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{32,})/[REDACTED]/g')"
  # Bounded: the reason is diagnostic, not the payload, and an unbounded stderr can dwarf the
  # prompt it is meant to annotate. The tail is kept — the error is at the end.
  _why="$(printf '%s' "$_why" | tail -c 1200)"

  local _blk _out
  _blk="$("${NODE_BIN:-node}" -e '
      try {
        const { renderEngineTemplate } = require(process.argv[1] + "/lib/engine-prompt.js");
        process.stdout.write(renderEngineTemplate("previous-refusal", {
          __REASON__: process.argv[2], __ARTEFACT__: process.argv[3] || "answer",
        }));
      } catch (e) { process.stdout.write(""); }
    ' "$_SCRIPT_DIR_AIRUN" "$_why" "${_LADDER_AGENT:-answer}" 2>/dev/null || printf '')"
  [ -n "$_blk" ] || { printf '%s' "$PROMPT_FILE"; return 0; }

  _out="$(mktemp "${TMPDIR:-/tmp}/prompt-retry-XXXXXX")"
  cat "$PROMPT_FILE" > "$_out"
  printf '%s\n' "$_blk" >> "$_out"
  printf '%s' "$_out"
}

_ai_original_prompt_file="$PROMPT_FILE"
for _call_attempt in $(seq 1 "$_ai_max_attempts"); do
if [ "$_call_attempt" -gt 1 ]; then
  # The prompt the escalated rung sees carries the previous rung's failure.
  PROMPT_FILE="$(_ai_prompt_with_failure "${last_err:-}")"
  # Escalate before retrying: repeating the same model on the same prompt is the
  # same gamble, which is how run 9 lost its premise on a single bad response.
  # RECORD THE FAILURE, THEN ASK. The handler steps one rung per recorded failure along the chain
  # this agent's ARCHETYPE declares, and keeps that count per agent AND per story — so recording
  # and resolving are one operation and cannot drift, which is how the previous counter ended up
  # written under one key and read under another.
  agent_ladder_record_failure "$_LADDER_AGENT" "$_LADDER_STORY"
  _ai_next="$(agent_ladder_model "$_LADDER_AGENT" "$_LADDER_STORY" "${AI_MODEL:-}")"
  if [ -n "$_ai_next" ] && [ "$_ai_next" != "${AI_MODEL:-}" ]; then
    echo "[ai-run] attempt ${_call_attempt}/${_ai_max_attempts} for '${_LADDER_AGENT:-unnamed}' — escalating ${AI_MODEL} -> ${_ai_next}" >&2
    AI_MODEL="$_ai_next"; export AI_MODEL
  elif agent_ladder_exhausted "$_LADDER_AGENT" "$_LADDER_STORY" "${AI_MODEL:-}"; then
    echo "[ai-run] attempt ${_call_attempt}/${_ai_max_attempts} for '${_LADDER_AGENT:-unnamed}' — at the top of its declared chain (${AI_MODEL:-default}), retrying the same rung" >&2
  else
    echo "[ai-run] attempt ${_call_attempt}/${_ai_max_attempts} for '${_LADDER_AGENT:-unnamed}' — no chain declared for this agent's tier, retrying on ${AI_MODEL:-default}" >&2
  fi
fi

for provider in "${providers[@]}"; do
  err_file="$(mktemp)"
  _call_started_at="$(date -Iseconds)"
  if out="$(_ai_attempt_timeout run_provider_once "$provider" 2>"$err_file")"; then
    _merge_plan_cost
    # WHAT IT COST, RECORDED HERE — the one place every call in the pipeline passes through.
    #
    # The reply's cost was captured all along and only team-lead-review ever read it: 39 of 40
    # seams produced the numbers and nothing recorded them. A 34-minute paid run logged zero
    # entries and its spend still cannot be stated. Recording per seam is 40 places to forget.
    # NOT IN THE PLAN PASS. A plan and its execute pass are ONE call from the ledger's point of
    # view, and _merge_plan_cost above has already folded the plan's cost into this reply — so
    # recording both counts the plan twice and makes every planned seam look ~2x its real spend.
    # ONE ROW PER CALL. A caller that keeps its own ledger says so, and the hub stays quiet.
    #
    # spec-mode-runner records every call it makes (invokeMode "spec-mode-runner", 29 fields);
    # this hub-level row (invokeMode "cli", 12 fields) exists for the callers that do NOT —
    # claude.sh's writer invocations among them. For seams routed through the runner BOTH fired,
    # so the 2026-08-26 mock3 ledger held 10 rows for 5 calls and a naive sum reported $2.57 of
    # spend against $1.29 actually billed. A cost ledger that double-counts is worse than none:
    # it is wrong in the direction that hides an underspend and invents an overspend.
    if declare -f record_call_cost >/dev/null 2>&1 \
       && [ "${_EPAM_IN_PLAN_PASS:-0}" != "1" ] \
       && [ "${EPAM_COST_RECORDED_BY_CALLER:-0}" != "1" ]; then
      record_call_cost "${ORCH_JSON_RESULT:-}" "${EPAM_AGENT_NAME:-agent}" \
          "${EPAM_STORY_ID:-pipeline}" "${AI_MODEL:-${EPAM_MODEL:-}}" "$_call_started_at" || true
    fi
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
