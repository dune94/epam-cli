#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# A SEAM THAT CANNOT RESOLVE ITS MODEL MUST REFUSE, NOT PICK ONE.
#
# `process.env.ORCH_GATE_MODEL || 'z-ai/glm-5.2'` reads as a harmless default. It is not. It
# is the same shape as the ladder position that never matched: the project DECLARES a model,
# the declaration fails to reach the seam, and a literal wins silently. Nothing errors, the
# run completes, and the answer came from a model nobody chose.
#
# 'z-ai/glm-5.2' is metrolinx's gate model. Every other project inherits it by accident.
#
# The rule: the model is configuration. Absent configuration is a refusal — loud, at the seam,
# before the call — never a substitution.
#
# The forbidden set is DERIVED from what projects declare, so a new literal is caught without
# this file being edited.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    PROJECTS="$REPO_ROOT/orchestrations/projects"
}

# Every model name any project declares, from the files that own that decision.
declared_models() {
    { for f in "$PROJECTS"/*/llm-settings.json; do
        [ -f "$f" ] || continue
        jq -r '.. | objects | (.to? // .from? // .model? // empty)' "$f" 2>/dev/null
      done
      for f in "$PROJECTS"/*/config.env; do
        [ -f "$f" ] || continue
        grep -hoE '^[A-Z_]*MODEL[A-Z_]*="?[^"#]+' "$f" 2>/dev/null | sed 's/.*=//' | tr -d '"'
      done
    } | sed 's/[[:space:]]*$//' | grep -E '[a-zA-Z]' | sort -u
}

# Executable lines only, across the pipeline.
code_lines() {
    grep -rn '' "$SCRIPTS"/*.sh "$SCRIPTS"/lib/*.sh "$SCRIPTS"/*.js "$SCRIPTS"/lib/*.js 2>/dev/null \
      | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(#|//|\*)'
}

@test "the derivation is not vacuous — projects really do declare models" {
    n=$(declared_models | wc -l)
    [ "$n" -ge 3 ]
    declared_models | grep -q '/' || declared_models | grep -qi 'minimax'
}

@test "NO SEAM SUBSTITUTES A MODEL IT WAS NOT GIVEN" {
    bad=""
    while IFS= read -r m; do
        [ -n "$m" ] || continue
        # the shape that matters: a declared model appearing as a FALLBACK
        while IFS= read -r hit; do
            [ -n "$hit" ] || continue
            bad="${bad}
  ${hit}"
        done < <(code_lines | grep -F -- "$m" \
                 | grep -E "(\|\| *['\"]${m}|\?\? *['\"]${m}|:-${m}[}\"]|:-${m}$)" \
                 | cut -c1-140)
    done < <(declared_models)
    [ -z "$bad" ] || {
        echo "a declared model is hardcoded as a fallback — the seam substitutes instead of refusing:$bad"
        false
    }
}
