#!/usr/bin/env bash
# THE COMPLETION MARKER'S NAME — ONE DERIVATION, FOR EVERY SHELL CALL SITE.
#
# `.prompt-cache/.complete-<codeline>` is the claim that a codeline's prompts are fully
# provisioned, and its presence makes the mint skip ENTIRELY. It is tested in three shell places
# (run-agent-orchestration.sh twice, pre-run-reset.sh) and written by project-prompt-builder.js.
#
# A brownfield run generates DIFFERENT prompts from the same seams, so it must not inherit a
# greenfield codeline's claim — it would skip provisioning and serve the greenfield prompts on
# disk, which on a cached codeline means the brownfield variant never executes at all.
#
# Greenfield's name is unchanged, byte for byte: no marker already on disk is invalidated.
# The JS side of this rule is _markerPath in lib/project-prompt-builder.js; the two are asserted
# to agree by test/unit/orchestration/a-brownfield-run-generates-its-own-prompts.test.ts.
prompt_marker_key() {
    if [ "${EPAM_BROWNFIELD:-0}" = "1" ]; then
        printf '.complete-%s.brownfield' "$1"
    else
        printf '.complete-%s' "$1"
    fi
}

# codeline_prompts_complete <codeline> — were this codeline's prompts built from the CURRENT
# inputs? Answered by project-prompt-builder.js (the digest the marker records vs the digest
# of the template layer, registry and generator now). A marker's mere existence is not an
# answer: an empty one let a launch reuse prompts built from the previous day's templates
# (regintel 20260920T232518Z, $5.73). Says why on stderr when the answer is no.
codeline_prompts_complete() {
    local _cl="${1:-}"
    [ -n "$_cl" ] && [ -n "${EPAM_PROJECT_CONFIG_DIR:-}" ] || return 1
    local _here; _here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local _builder="${_here}/project-prompt-builder.js"
    local _out
    _out=$("${NODE_BIN:-node}" -e '
      const b = require(process.argv[1]);
      const r = b.codelinePromptsComplete({ projectConfigDir: process.argv[2], codeline: process.argv[3],
        templatesDir: process.env.EPAM_PROMPT_TEMPLATES_DIR || undefined, registryFile: process.env.EPAM_SEAM_REGISTRY_FILE || undefined });
      process.stdout.write((r.complete ? "yes" : "no") + "\t" + (r.reason || ""));
    ' "$_builder" "$EPAM_PROJECT_CONFIG_DIR" "$_cl" 2>/dev/null) || return 1
    case "$_out" in
        yes*) return 0 ;;
        *) echo "[prompts] codeline ${_cl}: ${_out#*	}" >&2; return 1 ;;
    esac
}
