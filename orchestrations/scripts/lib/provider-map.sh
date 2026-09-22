#!/usr/bin/env bash
# THE MODEL→PROVIDER ROUTING, IN ONE PLACE.
#
# Which vendor endpoint serves which model is a fact the PROJECT declares, as
# EPAM_MODEL_PROVIDER_MAP — pipe-separated "glob-pattern=provider" pairs, e.g.
# "moonshotai/*=openrouter|MiniMax-*=minimax". Nothing here names a vendor or a
# model: an unmatched model returns EMPTY, which every caller reads as "no
# override, leave the routing alone".
#
# It lived in three copies (lib/model-ladder.sh's resolve_model_provider,
# team-lead-review.sh's _provider_for_model, brownfield-repro-test-writer.sh's).
# One copy fell back to EPAM_ORCHESTRATION_PROVIDER when the map was empty,
# which is a guess wearing a resolution's clothes. One home, one rule.
resolve_model_provider() {
    local model="$1"
    local map="${EPAM_MODEL_PROVIDER_MAP:-}"
    [ -z "$map" ] && { echo ""; return; }
    local pair pattern provider IFS_SAVE="$IFS"
    IFS='|'
    read -ra _rmp_pairs <<< "$map"
    IFS="$IFS_SAVE"
    for pair in "${_rmp_pairs[@]}"; do
        pattern="${pair%%=*}"
        provider="${pair#*=}"
        # shellcheck disable=SC2254 # intentional glob match against a config-supplied pattern
        case "$model" in
            $pattern) echo "$provider"; return ;;
        esac
    done
    echo ""
}
