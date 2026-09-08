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
