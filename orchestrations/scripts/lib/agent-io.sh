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

# ONE IMPLEMENTATION, TWO BINDINGS. The store lives in lib/agent-io.js and this file calls it.
# Producers exist in both languages — claude.sh and team-lead-review.sh are shell, the detective's
# answer is persisted by spec-mode-runner.js — and a store implemented once per language is two
# implementations of one thing, which is the exact defect this framework was built to remove.

_AGENT_IO_JS="${_AGENT_IO_JS:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-io.js}"

# publish_agent_output <from> <kind> <story_id> <content>
#
# Content travels on STDIN, never in argv: prompt text carries quotes, backticks and newlines, and
# an argv round trip through a shell is where those become executed commands.
publish_agent_output() {
    [ -n "${1:-}" ] && [ -n "${2:-}" ] && [ -n "${3:-}" ] || return 0
    printf '%s' "${4:-}" | "${NODE_BIN:-node}" "$_AGENT_IO_JS" publish "$1" "$2" "$3"
}

# collect_agent_inputs <story_id> <kind> [kind...]
collect_agent_inputs() {
    [ -n "${1:-}" ] || return 0
    "${NODE_BIN:-node}" "$_AGENT_IO_JS" collect "$@"
}

# agent_input_present <story_id> <kind> — did anyone publish this?
agent_input_present() {
    [ -n "${1:-}" ] && [ -n "${2:-}" ] || return 1
    "${NODE_BIN:-node}" "$_AGENT_IO_JS" present "$1" "$2"
}
