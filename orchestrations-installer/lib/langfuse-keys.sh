#!/usr/bin/env bash
# langfuse-keys.sh — THE KEYS AN INSTALL RECORDS WITH, resolved from what the install already declares.
#
# `--replay on` refused every fresh install with "missing: LANGFUSE_SECRET_KEY LANGFUSE_PUBLIC_KEY"
# unless an operator had typed keys into .env first — while the install's OWN Langfuse, brought up by
# the same installer from docker-compose.observability.yml, declares its project keys right there
# (LANGFUSE_INIT_PROJECT_PUBLIC_KEY / _SECRET_KEY). An install that owns the recorder knows its keys;
# asking a human to copy them from one file the installer wrote into another it also wrote is a
# manual step with no decision in it. Found 2026-09-13 opening the £0 greenfield rehearsal.
#
# Precedence, first non-empty wins: the environment, the install's .env, the compose declaration.
# Keys from the compose file are written INTO .env so every later reader (harvester, exporter,
# health) finds them where it looks. Nothing here invents a key: an install whose compose declares
# none stays exactly as refused as before.
#
# langfuse_keys_for_install <root> <compose-file>
#   stdout: "<secret>\t<public>\t<source>" where source is env | dotenv | compose | none

langfuse_keys_for_install() {
    local _root="${1:-}" _compose="${2:-}"
    local _sk="${LANGFUSE_SECRET_KEY:-}" _pk="${LANGFUSE_PUBLIC_KEY:-}" _src="env"
    if [ -z "$_sk" ] || [ -z "$_pk" ]; then
        if [ -f "$_root/.env" ]; then
            local _from
            _from="$( set -a; . "$_root/.env" 2>/dev/null; set +a
                      printf '%s\t%s' "${LANGFUSE_SECRET_KEY:-}" "${LANGFUSE_PUBLIC_KEY:-}" )"
            [ -z "$_sk" ] && _sk="$(printf '%s' "$_from" | cut -f1)"
            [ -z "$_pk" ] && _pk="$(printf '%s' "$_from" | cut -f2)"
            [ -n "$_sk" ] && [ -n "$_pk" ] && _src="dotenv"
        fi
    fi
    if { [ -z "$_sk" ] || [ -z "$_pk" ]; } && [ -f "$_compose" ]; then
        local _csk _cpk
        _csk=$(sed -nE 's/^[[:space:]]*LANGFUSE_INIT_PROJECT_SECRET_KEY:[[:space:]]*"?([^"[:space:]]+)"?.*$/\1/p' "$_compose" | head -1)
        _cpk=$(sed -nE 's/^[[:space:]]*LANGFUSE_INIT_PROJECT_PUBLIC_KEY:[[:space:]]*"?([^"[:space:]]+)"?.*$/\1/p' "$_compose" | head -1)
        if [ -n "$_csk" ] && [ -n "$_cpk" ]; then
            _sk="$_csk"; _pk="$_cpk"; _src="compose"
            if [ -f "$_root/.env" ]; then
                local _tmp; _tmp="$(mktemp)"
                grep -vE '^(LANGFUSE_SECRET_KEY|LANGFUSE_PUBLIC_KEY)=' "$_root/.env" > "$_tmp"
                printf 'LANGFUSE_SECRET_KEY=%s\nLANGFUSE_PUBLIC_KEY=%s\n' "$_sk" "$_pk" >> "$_tmp"
                cat "$_tmp" > "$_root/.env"; rm -f "$_tmp"
            fi
        fi
    fi
    if [ -z "$_sk" ] || [ -z "$_pk" ]; then _src="none"; fi
    printf '%s\t%s\t%s' "$_sk" "$_pk" "$_src"
}
