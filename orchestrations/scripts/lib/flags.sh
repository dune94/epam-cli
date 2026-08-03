#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# lib/flags.sh — ONE helper owns whether a boolean env flag is on.
#
# THE BUG THIS EXISTS FOR (hit live 2026-08-03): a run was launched with
# SKIP_REGRESSION_GUARD=1 and Step 5 ran anyway, because that check was
# `[ "${SKIP_REGRESSION_GUARD:-false}" != "true" ]` — only the literal string
# `true` worked. The flag silently did nothing and the operator had no signal.
#
# THE ACTUAL DEFECT was not one flag: the codebase ran TWO conventions at once —
#   != "true" : SKIP_REGRESSION_GUARD, SKIP_PRE_REVIEW_GATE, SKIP_LINT_GATE, SKIP_AUTO_PR
#   != "1"    : SKIP_CPA, SKIP_TC_WRITER, SKIP_SKILL_ASSESSMENT, SKIP_GATE_REMEDIATION
# so `SKIP_REGRESSION_GUARD=1` failed precisely BECAUSE it matched the other half
# of the same codebase. Every flag was a coin flip. A flag that silently does
# nothing is the same failure class as a gate that logs instead of blocking: the
# operator believes an instruction took effect when it did not.
#
# Usage — always pass a `:-` default so `set -u` cannot trip:
#     if is_truthy "${SKIP_SOMETHING:-}"; then ... ; fi
#     ! is_truthy "${SKIP_SOMETHING:-}" && run_the_thing
#
# Unset or empty is FALSE, so a gate is never skipped by accident — the safe
# default survives a typo in the variable name.
#
# Guarded by test/unit/orchestration/env-flags-truthy.test.ts, which also fails
# if any SKIP_* flag anywhere goes back to a bare literal comparison.
# ─────────────────────────────────────────────────────────────────────────────

# is_truthy <value> — 0 (success) when the value means "on".
# Accepts 1 / true / yes / on, case-insensitive. Everything else is off.
is_truthy() {
    local _v="${1:-}"
    _v="$(printf '%s' "$_v" | tr '[:upper:]' '[:lower:]')"
    case "$_v" in
        1|true|yes|on) return 0 ;;
        *) return 1 ;;
    esac
}
