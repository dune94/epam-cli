#!/usr/bin/env bash
# HOW A GATE'S ANSWER BECOMES A DECISION — SOMEWHERE A TEST CAN SEE IT.
#
# 14 of the 40 declared seams are verdict-kind: their whole output is a judgement. The logic that
# turns one into fail/warn/pass lived inside run-agent-orchestration.sh, which cannot be sourced
# without running the pipeline, so none of it was ever executed by a test.
#
# That matters more here than anywhere: a gate that logs a block without enforcing it, or blocks
# on an ungrounded claim, looks identical in a log to one working correctly. Both have happened in
# this pipeline before.
#
# Expects its caller to provide SCRIPT_DIR (for lib/handlers/findings-grounded.py).


# runtime_boundary_verdict <gate-log> <project-root>
#
# THE VERDICT DECIDES, NOT THE EXIT CODE.
#
# This gate's result handling read $? and nothing else: the log was written, handed to the gate and
# never read again, so a grounded report that a change cannot execute printed "Step 22g — pass"
# because the process exited 0. Its sibling two lines below has always grepped the log.
#
# Grounding, same discipline as fuzz-weaver: a `fail` blocks only when a finding names a file that
# exists. A claim about a file that does not exist is not evidence, and a gate that blocks on one
# teaches the operator to ignore it.
#
# An unparseable or empty log is a WARN, never a pass: a gate that could not produce an answer has
# not cleared the change.
#
# Echoes: fail | warn | pass
runtime_boundary_verdict() {
    local _log="${1:-}" _root="${2:-}"
    [ -n "$_log" ] && [ -s "$_log" ] || { echo warn; return 0; }

    if grep -q '"verdict"[[:space:]]*:[[:space:]]*"fail"' "$_log" 2>/dev/null; then
        local _grounded
        _grounded=$(python3 "$SCRIPT_DIR/lib/handlers/findings-grounded.py" "$_log" "$_root" 2>/dev/null || echo 0)
        if [ "${_grounded:-0}" -gt 0 ]; then echo fail; else echo warn; fi
        return 0
    fi
    if grep -q '"verdict"[[:space:]]*:[[:space:]]*"warn"' "$_log" 2>/dev/null; then echo warn; return 0; fi
    if grep -q '"verdict"[[:space:]]*:[[:space:]]*"pass"' "$_log" 2>/dev/null; then echo pass; return 0; fi
    echo warn
}
