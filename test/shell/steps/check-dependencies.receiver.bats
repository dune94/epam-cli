#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# check-dependencies.sh — 98 lines deciding whether a story may run, never executed by a test.
#
# claude.sh consumes it correctly (`if ! "$dep_checker" "$story_id"; then ... skipping`), so a wrong
# answer here does not get discarded — it gets ACTED ON. A false "satisfied" runs a story whose
# inputs do not exist yet; a false "blocked" skips work that was ready.
#
# The cases that matter most are the ones with nothing to read: a story the PRD does not contain,
# and a PRD that cannot be parsed. Both must refuse, not pass. "I could not tell" answered as "yes"
# is the defect class this pipeline keeps producing.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    DEPS="$REPO_ROOT/orchestrations/scripts/check-dependencies.sh"
    WORK="$(mktemp -d)"
    export PRD_FILE="$WORK/prd.json"
}
teardown() { rm -rf "$WORK"; }

write_prd() { cat > "$PRD_FILE"; }

@test "a story with no dependencies may run" {
    write_prd <<'PRD'
{ "stories": [ { "id": "S-1", "completed": false, "dependencies": [] } ] }
PRD
    run bash "$DEPS" S-1
    [ "$status" -eq 0 ]
}

@test "a story whose dependency is COMPLETE may run" {
    write_prd <<'PRD'
{ "stories": [
  { "id": "S-0", "completed": true,  "dependencies": [] },
  { "id": "S-1", "completed": false, "dependencies": ["S-0"] } ] }
PRD
    run bash "$DEPS" S-1
    [ "$status" -eq 0 ]
}

@test "a story whose dependency is INCOMPLETE is blocked" {
    write_prd <<'PRD'
{ "stories": [
  { "id": "S-0", "completed": false, "dependencies": [] },
  { "id": "S-1", "completed": false, "dependencies": ["S-0"] } ] }
PRD
    run bash "$DEPS" S-1
    [ "$status" -ne 0 ]
}

@test "a dependency that DOES NOT EXIST in the PRD is not treated as satisfied" {
    # A missing dependency means the PRD is inconsistent. Reading that as "nothing blocks me" runs
    # a story whose input will never arrive.
    write_prd <<'PRD'
{ "stories": [ { "id": "S-1", "completed": false, "dependencies": ["S-GHOST"] } ] }
PRD
    run bash "$DEPS" S-1
    [ "$status" -ne 0 ]
}

@test "a story the PRD does not contain is refused, not waved through" {
    write_prd <<'PRD'
{ "stories": [ { "id": "S-1", "completed": false, "dependencies": [] } ] }
PRD
    run bash "$DEPS" S-NOT-THERE
    [ "$status" -ne 0 ]
}

@test "an UNPARSEABLE prd is refused — absence is never satisfaction" {
    printf '{ not json' > "$PRD_FILE"
    run bash "$DEPS" S-1
    [ "$status" -ne 0 ]
}

@test "a MISSING prd is refused" {
    rm -f "$PRD_FILE"
    run bash "$DEPS" S-1
    [ "$status" -ne 0 ]
}

@test "no story id at all is a usage error, distinct from a verdict" {
    run bash "$DEPS"
    [ "$status" -eq 2 ]
}
