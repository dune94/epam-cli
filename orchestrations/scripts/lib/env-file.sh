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

# Second argument: "preserve" — do not overwrite a variable that is already set and
# non-empty in the environment. This reproduces the `KEY="${KEY:-default}"` idiom that
# config files used to rely on, WITHOUT evaluating the file. Those lines only worked
# under `source`, which is the very thing this loader exists to stop: a config file
# declaring a project default must not clobber a value the operator exported at launch
# (live: config.env's SKIP_REGRESSION_GUARD overwrote SKIP_REGRESSION_GUARD=true from
# the launch environment, and the guard blocked a run it had been told to bypass).
# Default (no second argument) keeps the original always-assign behaviour.
load_env_file_safe() {
  local env_file="${1:-}"
  local _mode="${2:-}"
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

    # An already-set, non-empty value wins over the file's default: a .env supplies
    # DEFAULTS, it does not overwrite a decision the caller already made. This is the
    # DEFAULT because the opposite default silently undid the free-run credential scrub.
    # 14 call sites re-read .env; each one put the real key back, and a run labelled
    # mockserver carried a live key to a paid API for 34 minutes. The parent process
    # read as sealed because /proc/PID/environ shows the env a process was EXEC'd with,
    # so only the child exposed it.
    #
    # `overwrite` is the explicit opt-in for a caller that genuinely means to clobber.
    # `preserve` remains accepted and is now simply the default.
    if [ "$_mode" != "overwrite" ] && [ -n "${!key:-}" ]; then
      continue
    fi

    # printf -v assigns without evaluating: the value is text, whatever it contains.
    printf -v "$key" '%s' "$value" 2>/dev/null || continue
    export "${key?}"
  done < "$env_file"

  return 0
}

# load_project_env <project_config_dir> [preserve]
#
# A PROJECT'S ENV IS TWO FILES: the half that is true whatever stack it runs on, and the half
# the active provider set decides. This loads whichever exist.
#
# NEITHER FILENAME APPEARS HERE. lib/llm-settings-resolve.js reads them from
# config/provider-sets.json, so renaming them — or adding a set — stays a config edit. That
# resolver is also the one place that refuses an unknown set, so the settings layer and the env
# layer can never disagree about which stack is active.
#
# Order is not a policy: the two files must declare DISJOINT keys, which a test asserts. With
# overlap the winner would depend on load order AND on `preserve` mode, and no caller should
# have to know that.
#
# A missing overlay is NORMAL — a project that predates the split has only the base.
# An unresolvable set is FATAL: returning quietly would run the project on whichever stack the
# base happens to name, while every log line looked configured.
load_project_env() {
  local _dir="${1:-}" _mode="${2:-}"
  [ -n "$_dir" ] || return 0

  # require() needs an ABSOLUTE path: sourced by a relative path, ${BASH_SOURCE%/*} is
  # relative too, and node resolves it against its own module paths rather than the cwd.
  local _libdir _resolver
  _libdir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || return 1
  _resolver="$_libdir/llm-settings-resolve.js"
  local _files=""
  if [ -f "$_resolver" ] && { [ -n "${NODE_BIN:-}" ] || command -v node >/dev/null 2>&1; }; then
    _files=$("${NODE_BIN:-node}" -e '
      const { projectEnvFiles } = require(process.argv[1]);
      const f = projectEnvFiles(process.argv[2]);
      if (f) process.stdout.write(f.base + "\n" + f.overlay + "\n");
    ' "$_resolver" "$_dir" 2>&1) || {
      echo "[env-file] cannot resolve the env files for $_dir:" >&2
      printf '%s\n' "$_files" >&2
      return 1
    }
  fi

  if [ -z "$_files" ]; then
    # NO FILENAME IS SPELLED HERE. Writing the base name as a fallback would put it in code —
    # the one thing the registry exists to prevent — and it would then be a SECOND home for the
    # name, free to drift from the declared one without anything failing.
    #
    # If the resolver cannot answer, this cannot know which files a project has, so it says so
    # and stops. Guessing would load a file that may no longer be the base and report success.
    echo "[env-file] no provider-set registry resolved for $_dir — cannot know which env files" >&2
    echo "[env-file] this project has. Check ${_resolver} and config/provider-sets.json." >&2
    return 1
  fi

  local _f
  while IFS= read -r _f; do
    [ -n "$_f" ] && load_env_file_safe "$_f" "$_mode"
  done <<< "$_files"
  return 0
}
