#!/usr/bin/env bash
# roster-read.sh — read this project's roster. The ONLY source of an agent's identity.
#
# Every consumer used to do this:
#
#   AGENT_PROFILES_FILE="${AGENT_PROFILES_FILE:-$AUTOMATION_DIR/agents/profiles.json}"
#   jq -r '.["review-agent"] // ""' "$AGENT_PROFILES_FILE"
#
# Two defects in two lines. The default points at the roster SHARED WITH THE ENGINE, so a client
# codeline's reviewer ran with a persona describing this repository. And `// ""` turns a missing
# entry into an empty system prompt, so an agent answers from nothing and the log says nothing.
#
# Here: no default, and absence is an error. A run that cannot resolve its roster has no agent
# identities, and there is nothing to fall back to — the engine roster is not a safety net, it is
# the thing that was wrong.
#
# The resolution lives here rather than at six call sites because that is how the previous version
# drifted: three of the six defaulted differently, and one exported a path the others only read.

# shellcheck disable=SC2034
_ROSTER_READ_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# roster_dir — the project config dir holding roster.json. No default: a launcher that cannot say
# which project it is running must stop, exactly as project_config_dir does for the same reason.
roster_dir() {
    if [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ]; then
        printf '%s' "$EPAM_PROJECT_CONFIG_DIR"
        return 0
    fi
    echo "[roster] EPAM_PROJECT_CONFIG_DIR is unset — cannot resolve this project's roster." >&2
    echo "[roster] An agent's identity comes only from it; there is no engine roster to read instead." >&2
    return 1
}

# roster_file — the roster's path, whether or not it exists.
roster_file() {
    local _d
    _d="$(roster_dir)" || return 1
    printf '%s/roster.json' "$_d"
}

# roster_persona <agent-name> — that agent's persona, or a loud failure.
#
# Delegates to lib/project-roster.js so the refusal rules are stated ONCE, in the same place the
# producer validates them. A shell reimplementation is a second definition of what a roster is.
roster_persona() {
    local _agent="${1:?usage: roster_persona <agent-name>}" _d
    _d="$(roster_dir)" || return 1
    # The refusal is printed, not thrown: a node stack trace in a run log reads as a crash in the
    # pipeline rather than as a stated defect in the roster, and the next reader chases the wrong
    # thing. Exit status still carries the failure.
    "${NODE_BIN:-node}" -e '
      const m = require(process.argv[1]);
      try { process.stdout.write(m.personaFor(process.argv[2], process.argv[3])); }
      catch (e) { process.stderr.write((e && e.message ? e.message : String(e)) + "\n"); process.exit(1); }
    ' "$_ROSTER_READ_LIB_DIR/project-roster.js" "$_agent" "$_d"
}

# roster_agents_of_kind <implementer|investigator|seam> — newline separated.
#
# This is the write perimeter's question. It had its own registry file; the roster answers it from
# the `kind` field, because who may author code is a property of an agent, not another file.
roster_agents_of_kind() {
    local _kind="${1:?usage: roster_agents_of_kind <kind>}" _d
    _d="$(roster_dir)" || return 1
    "${NODE_BIN:-node}" -e '
      const m = require(process.argv[1]);
      try { process.stdout.write(m.agentsOfKind(process.argv[2], process.argv[3]).join("\n")); }
      catch (e) { process.stderr.write((e && e.message ? e.message : String(e)) + "\n"); process.exit(1); }
    ' "$_ROSTER_READ_LIB_DIR/project-roster.js" "$_kind" "$_d"
}

# roster_exists — 0 when this project has a roster, 1 otherwise. For callers that must REPORT the
# absence rather than fail on it (a launcher printing what it is about to run, say). Never use it
# to choose a fallback: there isn't one.
roster_exists() {
    local _f
    _f="$(roster_file 2>/dev/null)" || return 1
    [ -s "$_f" ]
}
