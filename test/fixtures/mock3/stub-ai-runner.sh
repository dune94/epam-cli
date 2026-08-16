#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# stub-ai-runner.sh — a deterministic stand-in for ai-run.sh, for mock3.
#
# Same contract as the real runner: the prompt arrives on STDIN, the reply goes to
# STDOUT as text. Nothing else about the pipeline changes, so every seam, gate,
# guard, schema check and file write executes for real — only the model is fake.
#
# WHY A STUB. mock3 exists to find PIPELINE bugs: a prompt that never reaches an
# agent, a seam wired to nothing, a schema the engine cannot parse, an artefact
# nobody persists. Those are deterministic faults, and a real model makes them
# expensive to hit and non-reproducible when hit, because every run is a fresh
# draw. A stub makes the pipeline the only variable.
#
# DISPATCH IS ON THE SCHEMA, NOT THE PROMPT TEXT.
# The first version recognised prompts by keyword, and the roster-review prompt
# matched the mint's pattern first — so the stub confidently answered the wrong
# question and the step failed three stages later with "the tag was missing".
# The engine already states which answer it wants: EPAM_RESPONSE_SCHEMA carries
# {name, schema} for the tool being invoked. That is exact, and it costs nothing.
# Prompt text is consulted ONLY for calls that declare no schema (free text).
#
# Replies are built FROM the schema where possible, so a schema change does not
# leave this stub answering an obsolete shape while still looking green.
#
# EPAM_STUB_LOG     — append "tool<TAB>agent" per call, so a test can assert which
#                     agents actually ran rather than inferring it.
# EPAM_STUB_FAIL_FOR— substring of the tool name; exit non-zero to exercise the
#                     pipeline's own failure handling.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

PROMPT="$(cat)"
SCHEMA="${EPAM_RESPONSE_SCHEMA:-}"
TOOL=""
[ -n "$SCHEMA" ] && TOOL=$(printf '%s' "$SCHEMA" | jq -r '.name // ""' 2>/dev/null || echo "")

if [ -n "${EPAM_STUB_LOG:-}" ]; then
  printf '%s\t%s\n' "${TOOL:-<no-schema>}" "${EPAM_AGENT_NAME:-?}" >> "$EPAM_STUB_LOG" 2>/dev/null || true
fi

# RECORD THE INVOCATION ENVIRONMENT for the settings a seam is supposed to supply. A grant that
# is declared in the registry and never reaches the call is indistinguishable, from the registry,
# from one that works -- so the only place to prove it is here, at the receiving end.
if [ -n "${LOG_DIR:-}" ]; then
  {
    printf 'AGENT=%s\n'                       "${EPAM_AGENT_NAME:-}"
    printf 'EPAM_ALLOWED_TOOLS=%s\n'          "${EPAM_ALLOWED_TOOLS:-}"
    printf 'AI_GATE_ALLOW_TOOLS=%s\n'         "${AI_GATE_ALLOW_TOOLS:-}"
    printf 'EPAM_PROMPT_TEMPLATES_DIR=%s\n'   "${EPAM_PROMPT_TEMPLATES_DIR:-}"
    printf 'EPAM_REASONING_EFFORT=%s\n'       "${EPAM_REASONING_EFFORT:-}"
    printf 'EPAM_MAX_ITERATIONS=%s\n'         "${EPAM_MAX_ITERATIONS:-}"
  } >> "${LOG_DIR}/stub-env.txt" 2>/dev/null || true
fi

if [ -n "${EPAM_STUB_FAIL_FOR:-}" ] && [ -n "$TOOL" ] && [ "${TOOL#*${EPAM_STUB_FAIL_FOR}}" != "$TOOL" ]; then
  echo "[stub] deliberate failure for tool: $TOOL" >&2
  exit 1
fi

# The engine accepts a bare JSON object, but wrapping it in the tag it asked for
# exercises the same extraction path a real model's answer takes. The tag is the
# tool name minus its verb prefix, upper-cased — derived, never listed here.
_tag() { printf '%s' "${TOOL#submit_}" | tr '[:lower:]' '[:upper:]'; }
_emit() { printf '<%s>%s</%s>\n' "$(_tag)" "$1" "$(_tag)"; }

# Codelines named in the prompt's scope block, so investigators name a real one:
# the lane looks its investigator up BY codeline and cannot find one that names none.
#
# Read them from the prompt first, because that is what a model has to do. Fall back to
# JIRA_CODELINES, which the run already declares: an investigator that names no codeline is
# refused by the schema, and minting none at all leaves the writer waiting on a plan nobody
# produces — validateWorkflow catches that, correctly, and the run stops.
_codelines() {
  # JIRA_CODELINES is the run's own declaration of scope — exact, and already in the env.
  # Parsing them out of the prompt looked more faithful and was worse: the schema's own
  # description bullets matched the pattern, so the stub minted "name-investigator" and
  # "rationale-investigator" for codelines that do not exist.
  printf '%s' "${JIRA_CODELINES:-}" | tr ', ' '\n\n' | sed '/^$/d' | sort -u
}

case "$TOOL" in
  submit_project_agents)
    {
      printf '{"proposedAgents":['
      printf '{"name":"mock-domain-engineer","kind":"implementer","codeline":"*",'
      printf '"systemPrompt":"You implement changes in this project. Follow the conventions already present in the files you edit, make the smallest change that satisfies the requirement, and reuse the helpers the codebase already provides rather than re-implementing them.",'
      printf '"rationale":"The project needs one implementer able to own a story."}'
      for _c in $(_codelines); do
        printf ',{"name":"%s-investigator","kind":"investigator","codeline":"%s",' "$_c" "$_c"
        printf '"systemPrompt":"You read this codeline and report what is actually there, quoting the file and line you found it in. You never write code and never own a story.",'
        printf '"rationale":"Each codeline needs a reader that cannot write."}'
      done
      printf ']}'
    } | { read -r _j; _emit "$_j"; }
    ;;

  submit_roster_review)
    # "sound" with no findings: mock3 tests the PIPELINE, and a stub inventing
    # defects would exercise the correction loop instead of the flow under test.
    _emit '{"verdict":"sound","findings":[]}'
    ;;

  submit_assignments|submit_role_assignments)
    # One assignment per (story, codeline) pair, read back from the prompt — the
    # coverage check downstream is keyed on exactly that pair.
    _ids=$(printf '%s' "$PROMPT" | grep -oE '\b[A-Z][A-Z0-9]+-[0-9]+\b' | sort -u)
    {
      printf '{"assignments":['
      _first=1
      for _id in $_ids; do
        [ $_first -eq 0 ] && printf ','
        printf '{"storyId":"%s","agentRole":"mock-domain-engineer","reason":"the only implementer in this roster"}' "$_id"
        _first=0
      done
      printf ']}'
    } | { read -r _j; _emit "$_j"; }
    ;;

  "")
    # No schema declared: a free-text call. The only one mock3 models is prompt
    # generation, which must reproduce exactly the placeholders it was given.
    if printf '%s' "$PROMPT" | grep -q 'specialising ONE generic agent prompt'; then
      # ECHO THE TEMPLATE BODY, then add a project line. That is what specialising actually
      # is — the generic instructions are kept and context is added — and it reproduces every
      # placeholder by construction.
      #
      # The first version listed placeholders from the prompt's "exactly:" line instead. That
      # line wraps for a template with nine of them, so the stub returned an incomplete set,
      # the contract refused it three times, and the step failed. The contract was right; the
      # stub was reconstructing something it had been handed verbatim.
      printf '%s\n' "$PROMPT" \
        | awk '/^-----BEGIN TEMPLATE BODY-----$/{n=1; next} /^-----END TEMPLATE BODY-----$/{n=0} n' \
        | sed '$a\
\
## This project\
Specialised for this project by mock3.'
    else
      echo "[stub] free-text call mock3 does not model — returning empty" >&2
      printf ''
    fi
    ;;

  *)
    # Loud. An unmodelled tool means the pipeline grew a call this stub does not
    # answer, and an empty reply would surface far away as "the agent produced
    # no output" rather than here, where the cause is obvious.
    echo "[stub] UNMODELLED TOOL '$TOOL' — mock3 does not answer this call" >&2
    _emit '{}'
    ;;
esac
