#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# stub-ai-runner.sh — a deterministic stand-in for ai-run.sh, for mock3.
#
# Same contract as the real runner: the prompt arrives on STDIN, the reply goes to
# STDOUT as text. Nothing else about the pipeline changes, so every seam, gate,
# guard, schema check and file write executes for real — only the model is fake.
#
# WHY A STUB AND NOT A REAL MODEL. mock3 exists to find PIPELINE bugs: a prompt
# that never reaches an agent, a seam wired to nothing, a schema the engine cannot
# parse, an artefact nobody persists. Those are deterministic faults, and a real
# model makes them expensive to hit and non-reproducible when hit — every run
# draws a different answer, so a failure cannot be re-run into the same state.
# A stub makes the pipeline the only variable.
#
# It answers by RECOGNISING THE PROMPT, not by counting calls: call order changes
# whenever a stage is added, and an order-indexed stub then answers the wrong
# question while still looking green.
#
# Every reply is deliberately MINIMAL and VALID. A stub that returns something the
# schema rejects tests the validator, not the flow; a stub that returns something
# lavish hides a consumer that only works on lavish input.
#
# EPAM_STUB_LOG (optional): append one line per call, so a test can assert WHICH
# agents were actually invoked rather than inferring it from side effects.
# EPAM_STUB_FAIL_FOR (optional): substring; if the prompt matches, exit non-zero
# to exercise the pipeline's own failure handling.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

PROMPT="$(cat)"

_kind="unknown"
case "$PROMPT" in
  *"submit_project_agents"*|*"propose 2-"*|*"engineering agent roles"*) _kind="mint" ;;
  *"Specialise "*|*"specialising ONE generic agent prompt"*)            _kind="prompt-generation" ;;
  *"estate"*|*"survey"*)                                                _kind="estate-survey" ;;
  *"roster"*|*"reviewing the proposed"*)                                _kind="roster-review" ;;
  *"assign"*)                                                           _kind="assignment" ;;
esac

if [ -n "${EPAM_STUB_LOG:-}" ]; then
  printf '%s\t%s\n' "$_kind" "${EPAM_AGENT_NAME:-?}" >> "$EPAM_STUB_LOG" 2>/dev/null || true
fi

if [ -n "${EPAM_STUB_FAIL_FOR:-}" ] && [ "${PROMPT#*${EPAM_STUB_FAIL_FOR}}" != "$PROMPT" ]; then
  echo "[stub] deliberate failure for: ${EPAM_STUB_FAIL_FOR}" >&2
  exit 1
fi

case "$_kind" in
  prompt-generation)
    # Reproduce EXACTLY the placeholders the generator declared, and nothing else.
    # The generator prompt states them, so they are read back from it rather than
    # listed here — a hardcoded set would drift from the templates it serves.
    _ph=$(printf '%s' "$PROMPT" | sed -n 's/.*placeholders \(.*\):.*/\1/p' | head -1)
    [ "$_ph" = "(none)" ] && _ph=""
    printf 'Specialised for this project.\n\n%s\n' "$(printf '%s' "$_ph" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | sed '/^$/d')"
    ;;

  mint)
    # One implementer, plus one investigator per codeline named in scope. The
    # investigator's codeline must match a real one: the lane looks it up by name
    # and cannot find one that names none.
    _cls=$(printf '%s' "$PROMPT" | sed -n 's/^[[:space:]]*-[[:space:]]*\([a-z0-9][a-z0-9._-]*\)[[:space:]]*(.*/\1/p' | sort -u)
    {
      printf '{"proposedAgents":['
      printf '{"name":"mock-domain-engineer","kind":"implementer","codeline":"*",'
      printf '"systemPrompt":"You implement changes in this project. Follow the conventions already present in the files you edit. Make the smallest change that satisfies the requirement, and reuse the helpers the codebase already provides rather than re-implementing them.",'
      printf '"rationale":"The project needs one implementer able to own a story."}'
      for _c in $_cls; do
        printf ',{"name":"%s-investigator","kind":"investigator","codeline":"%s",' "$_c" "$_c"
        printf '"systemPrompt":"You read this codeline and report what is actually there, quoting the file and line you found it in. You never write code and never own a story.",'
        printf '"rationale":"Each codeline needs a reader that cannot write."}'
      done
      printf ']}'
    }
    ;;

  roster-review)
    printf '{"verdict":"sound","findings":[]}'
    ;;

  estate-survey)
    printf '{"codelines":[],"violations":[]}'
    ;;

  *)
    # Loud rather than empty: an unrecognised prompt means the pipeline grew a call
    # this stub does not model, and a blank reply would surface far away as
    # "the agent produced no output".
    echo "[stub] UNRECOGNISED PROMPT — mock3 does not model this call" >&2
    printf '{}'
    ;;
esac
