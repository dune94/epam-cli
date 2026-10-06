#!/usr/bin/env bash
# run_attempt_analyst <failure-class> <reason> <failed-output-file> [context-file]
#
# THE ONE WAY A SHELL CALLER REACHES THE SELF-HEAL ANALYST, AND THE REASON IS IN ITS SIGNATURE.
#
# Every caller knows why it refused an attempt — the validator's verdict, the repository's refusal, the
# criteria still missing — and until 2026-10-06 none of it reached the analyst: each of the three shell
# callers invoked agent-attempt-analyst.sh with a class and a log, nothing else (operator: "this has been
# an ongoing issue … correct this once and for all"). The JS edge is lib/self-heal.js; this is the shell
# edge. test/unit/orchestration/the-analyst-is-told-why.test.ts holds every engine caller to one of them.
#
# Everything else the caller sets for the analyst (AGENT_ANALYST_STORY_ID, STORY_ROLE, AI_RUNNER_CMD) is
# inherited as before. stdout and the exit status are the analyst's own (0 analysed or skipped, 2 the
# analyst itself failed).
run_attempt_analyst() {
    local _cls="${1:-}" _reason="${2:-}" _out="${3:-/dev/null}" _ctx="${4:-}"
    if [ -n "$_ctx" ]; then
        AGENT_ANALYST_REASON="$_reason" bash "$SCRIPT_DIR/agent-attempt-analyst.sh" "$_cls" "$_out" "$_ctx"
    else
        AGENT_ANALYST_REASON="$_reason" bash "$SCRIPT_DIR/agent-attempt-analyst.sh" "$_cls" "$_out"
    fi
}
