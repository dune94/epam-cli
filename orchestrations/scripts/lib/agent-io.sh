#!/usr/bin/env bash
# AGENT OUTPUTS ARE AGENT INPUTS. PUBLISHED ONCE, CONSUMED BY NAME.
#
# Before this, SEVEN scripts knew the investigator's internal data shape and each hand-wrote how
# it became prompt text — claude.sh, team-lead-review.sh, spec-mode-runner.js,
# run-agent-orchestration.sh, contextualize-stories.sh, brownfield-repro-test-writer.sh and
# detective-rerun-step.js. That is the hardcoding: not a filename, but the COUPLING. Every
# consumer reached into another agent's data and decided for itself what it meant.
#
# It fails exactly as you would expect. On 2026-08-13 a new field was added to the investigator's
# output and wired into ONE renderer; the reviewer's copy of the same rendering never got it.
# Two copies of one thing, drifted within the hour, by the person who wrote both.
#
# THE CONTRACT
#   - the PRODUCER renders its own output. It is the only actor that knows what its own fields
#     mean, so it is the only one that should be turning them into words.
#   - the output is published ONCE, carrying WHO produced it.
#   - a consumer DECLARES the kinds it wants, in the order it wants them, and receives them
#     rendered. It never names a producer's fields.
#   - ABSENT IS ABSENT. A kind nobody published contributes nothing — no heading, no empty
#     section, no conditional anywhere. That is why prompts need no `if`.
#
# THIS FILE KNOWS NOTHING ABOUT ANY AGENT. It moves opaque text with provenance. The moment it
# knows what a fix site is, it becomes the eighth place that has to change.

# Where published outputs live for this run. Under LOG_DIR by default so the pre-run reset
# clears them with everything else: an input surviving into the next run is how a writer ends up
# acting on a three-day-old review, which is the defect this week began with.
AGENT_IO_DIR="${AGENT_IO_DIR:-${LOG_DIR:-/tmp}/agent-io}"

# _agent_io_slug <text> — a filesystem-safe key. Kinds and story ids come from data, so they are
# never interpolated into a path unsanitised.
_agent_io_slug() {
    printf '%s' "${1:-}" | tr -c '[:alnum:]._-' '_' | cut -c1-120
}

# publish_agent_output <from> <kind> <story_id> <content>
#
# LATEST WINS. A second attempt supersedes the first rather than accumulating beside it: a
# consumer must never receive two answers to the same question and have to guess which is
# current. Empty content is the same as never publishing — the producer saying "nothing to add".
publish_agent_output() {
    local _from="${1:-}" _kind="${2:-}" _story="${3:-}" _content="${4:-}"
    [ -n "$_from" ] && [ -n "$_kind" ] && [ -n "$_story" ] || return 0

    local _dir="$AGENT_IO_DIR/$(_agent_io_slug "$_story")"
    local _file="$_dir/$(_agent_io_slug "$_kind")"

    if [ -z "$(printf '%s' "$_content" | tr -d '[:space:]')" ]; then
        # Nothing to say. Remove any earlier answer rather than leaving it to be re-served.
        rm -f "$_file" "$_file.from" 2>/dev/null || true
        return 0
    fi

    mkdir -p "$_dir" 2>/dev/null || return 0
    printf '%s' "$_content" > "$_file" || return 0
    printf '%s' "$_from" > "$_file.from" || true
    return 0
}

# collect_agent_inputs <story_id> <kind> [kind...]
#
# Emits the declared kinds, in the DECLARED order, each headed with the kind and the agent that
# produced it. Order is the consumer's business: "what the plan says" must precede "what the
# reviewer objected to", and publication order is an accident of scheduling.
#
# Provenance is not decoration. A consumer that cannot tell a plan from a demand treats both as
# equally binding — the writer used to receive sixteen sections of which three each claimed to be
# the highest priority.
collect_agent_inputs() {
    local _story="${1:-}"; shift || true
    [ -n "$_story" ] || return 0
    local _dir="$AGENT_IO_DIR/$(_agent_io_slug "$_story")"

    local _kind _file _from _first=1
    for _kind in "$@"; do
        _file="$_dir/$(_agent_io_slug "$_kind")"
        [ -s "$_file" ] || continue
        _from=$(cat "$_file.from" 2>/dev/null || echo "unknown")
        [ "$_first" -eq 1 ] || printf '\n'
        _first=0
        printf '## %s (from: %s)\n\n' "$_kind" "$_from"
        cat "$_file"
        printf '\n'
    done
    return 0
}

# agent_input_present <story_id> <kind> — did anyone publish this?
# For callers that must ACT on presence (a gate), never for rendering: rendering asks for what it
# wants and gets what exists.
agent_input_present() {
    local _story="${1:-}" _kind="${2:-}"
    [ -n "$_story" ] && [ -n "$_kind" ] || return 1
    [ -s "$AGENT_IO_DIR/$(_agent_io_slug "$_story")/$(_agent_io_slug "$_kind")" ]
}
