#!/usr/bin/env bash
# env-file.sh — load a .env as DATA.
#
# Every pipeline script did this instead:
#
#     set -a; source "$REPO_ROOT/.env"; set +a
#
# which does not read the file, it RUNS it. This repo's own .env begins with a bare `cd`,
# and a bare cd means "go to $HOME". So claude.sh, orchestrate.sh, ingest-jira-tickets.sh,
# five launchers and preflight-check.sh all relocated to the home directory at the moment
# they loaded configuration. preflight-check.sh then resolved every later relative path
# against $HOME and reported LOG_DIR unwritable, healing-events absent and snapshot-watch
# dead on a machine where all three were fine — checks that lie, in the only two launchers
# that ran them.
#
# The `cd` is one line in one file. The defect is that loading configuration could do
# anything at all. This loader parses assignments and ignores everything else, so no line
# in a config file — a stray command, a paste accident, an edit by a tool — can have an
# effect beyond setting a variable.
#
# What is deliberately NOT supported: command substitution and variable interpolation in
# values. `KEY=$(cmd)` and `KEY=$OTHER` are taken literally. Supporting them means
# evaluating the file again, which is the whole problem. A value that must be computed
# belongs in the script that computes it.
#
# Usage:  . lib/env-file.sh ; load_env_file_safe "$REPO_ROOT/.env"

load_env_file_safe() {
  local env_file="${1:-}"
  [ -n "$env_file" ] && [ -f "$env_file" ] || return 0

  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    # Strip a leading `export `, then require a NAME=... shape. Anything else — a bare
    # `cd`, a comment, a blank line, a stray command — simply is not an assignment and is
    # skipped without comment.
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line#export }"
    case "$line" in
      [A-Za-z_]*=*) ;;
      *) continue ;;
    esac

    key="${line%%=*}"
    value="${line#*=}"

    # A key must be a valid shell name; `foo bar=1` is not one.
    case "$key" in
      *[!A-Za-z0-9_]*) continue ;;
    esac

    # Trailing whitespace on an unquoted value is almost always accidental.
    value="${value%"${value##*[![:space:]]}"}"

    # Strip one matching pair of surrounding quotes. The quotes delimit the value in the
    # file; they are not part of it.
    case "$value" in
      \"*\") value="${value:1:${#value}-2}" ;;
      \'*\') value="${value:1:${#value}-2}" ;;
    esac

    # printf -v assigns without evaluating: the value is text, whatever it contains.
    printf -v "$key" '%s' "$value" 2>/dev/null || continue
    export "${key?}"
  done < "$env_file"

  return 0
}
