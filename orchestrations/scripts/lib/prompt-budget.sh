#!/usr/bin/env bash
# prompt-budget — how much accumulated guidance an agent keeps, read from config.
#
# Two numbers used to be literals in claude.sh: the character threshold past which the prompt
# is persisted and trimmed, and how many recent guidance sections survive the trim. Live
# 2026-08-09 a writer's prompt reached 53366 chars against a 16000 threshold and ran with most
# of its coordinator guidance discarded; a WARNING was the only trace. Neither number is
# arbitrary — the section count replaced a 1 after a run repeated a mistake five retries after
# being told not to — and both are exactly what an operator reaches for when a run misbehaves.
#
# A missing or unusable value FAILS. Falling back to a literal would put the number back in the
# engine and do it silently on the one run the config failed to load — the fail-open shape this
# pipeline keeps producing.
#
# NO `set -u` here: this file is sourced by claude.sh, and a library configures nothing about
# its host.

_prompt_budget_file() {
    if [ -n "${EPAM_SPEC_MODE_DEFAULTS_FILE:-}" ]; then
        echo "$EPAM_SPEC_MODE_DEFAULTS_FILE"
    else
        echo "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../config" 2>/dev/null && pwd)/spec-mode-defaults.json"
    fi
}

# _prompt_budget_value <jq-key> <override-env-name>
_prompt_budget_value() {
    local key="$1" env_name="$2" file val
    val="$(eval "printf '%s' \"\${$env_name:-}\"")"
    # An explicit operator override wins, including the documented 0 opt-out.
    if [ -n "$val" ]; then printf '%s' "$val"; return 0; fi

    file="$(_prompt_budget_file)"
    if [ ! -f "$file" ]; then
        echo "[prompt-budget] cannot read $key: $file does not exist" >&2
        return 1
    fi
    val="$(jq -er --arg k "$key" '.promptTrim[$k]' "$file" 2>/dev/null)" || {
        echo "[prompt-budget] $file — promptTrim.$key is missing" >&2
        return 1
    }
    case "$val" in
        ''|*[!0-9]*) echo "[prompt-budget] $file — promptTrim.$key must be a number, got '$val'" >&2; return 1 ;;
    esac
    printf '%s' "$val"
}

prompt_trim_threshold()     { _prompt_budget_value thresholdChars      EPAM_PROMPT_SCRATCHPAD_THRESHOLD_CHARS; }
prompt_trim_keep_sections() { _prompt_budget_value keepRecentSections  EPAM_PROMPT_TRIM_KEEP_SECTIONS; }
