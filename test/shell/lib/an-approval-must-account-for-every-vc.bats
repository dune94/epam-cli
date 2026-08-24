#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# AN APPROVAL THAT NAMES NO CRITERION CANNOT BE WRONG, AND SO CANNOT BE RIGHT.
#
# The reviewer is handed the story's verification criteria — __VC_BLOCK__, "the observable checks
# this change MUST satisfy". Its output contract asks only for a verdict, a list of issues and a
# summary. So "approved" never has to say WHICH criterion it checked or what it read, and there
# is nothing in the artefact anyone can falsify.
#
# Live 20260821T212250Z: the approval missed a dropped cleanup its own earlier cycle had caught.
# Nothing in the review output records which criteria were assessed.
#
# WHAT IS ENFORCED, and why it stops exactly there:
#   * SELF-CONTRADICTION IS REJECTED. Approving while the reviewer's OWN assessment marks a
#     criterion unmet is incoherent, and rejecting it is always satisfiable — the model only has
#     to be consistent with itself. No prompt compliance is required.
#   * INCOMPLETENESS IS REPORTED, NOT BLOCKED. Demanding an entry per criterion before a run may
#     approve is a gate a model can fail forever, which is the unwinnable-retry shape this
#     pipeline has already paid for. It warns, loudly, in the artefact.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    GATE="$SCRIPTS/lib/handlers/vc-assessment-gate.js"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
}

# The real gate, fed a review payload and the story's criteria.
judge() {  # $1 = review JSON, $2 = criteria (newline separated)
    printf '%s' "$1" | "$NODE" "$GATE" "$2"
}

@test "the reviewer's PROMPT asks for a per-criterion assessment" {
    run "$NODE" -e '
      const d=require(process.argv[1]);
      process.stdout.write(/vcAssessment/.test(d.body) ? "yes" : "no");' \
      "$REPO_ROOT/orchestrations/prompts/templates/team-lead-review.json"
    [ "$output" = "yes" ] || { echo "the output contract never asks which criteria were checked"; false; }
}

@test "and every project copy asks for it too — the template alone is never rendered" {
    for f in "$REPO_ROOT"/orchestrations/projects/*/prompts/team-lead-review.json; do
        [ -f "$f" ] || continue
        run "$NODE" -e '
          const d=require(process.argv[1]);
          process.stdout.write(/vcAssessment/.test(d.body) ? "yes" : "no");' "$f"
        [ "$output" = "yes" ] || { echo "$f does not ask for a per-criterion assessment"; false; }
    done
}

@test "APPROVED while its own assessment marks a criterion UNMET is rejected" {
    out=$(judge '{"verdict":"approved","issues":[],"summary":"looks fine",
      "vcAssessment":[{"criterion":"cleanup runs on unmount","met":false,"evidence":"src/a.ts:12 no cleanup"}]}' \
      'cleanup runs on unmount')
    [ "$(printf '%s' "$out" | jq -r '.verdict')" = "changes_requested" ] || {
        echo "a self-contradicting approval stood: $out"; false; }
    [ "$(printf '%s' "$out" | jq -r '.issues[0].severity')" = "blocker" ]
}

@test "the rejection quotes the criterion and the reviewer's OWN evidence" {
    out=$(judge '{"verdict":"approved","issues":[],"summary":"fine",
      "vcAssessment":[{"criterion":"cleanup runs on unmount","met":false,"evidence":"src/a.ts:12 no cleanup"}]}' \
      'cleanup runs on unmount')
    [[ "$(printf '%s' "$out" | jq -r '.issues[0].description')" == *"cleanup runs on unmount"* ]]
    [[ "$(printf '%s' "$out" | jq -r '.issues[0].evidence')" == *"src/a.ts:12"* ]] || {
        echo "the reviewer's own evidence was dropped from the rejection"; false; }
}

@test "a COHERENT approval passes through untouched" {
    payload='{"verdict":"approved","issues":[],"summary":"fine","vcAssessment":[{"criterion":"cleanup runs on unmount","met":true,"evidence":"src/a.ts:14"}]}'
    out=$(judge "$payload" 'cleanup runs on unmount')
    [ "$(printf '%s' "$out" | jq -r '.verdict')" = "approved" ]
    # and nothing else about it was rewritten
    [ "$(printf '%s' "$out" | jq -r '.summary')" = "fine" ]
}

@test "an INCOMPLETE assessment is reported, never blocked" {
    # Two criteria, one assessed. Blocking here would be a gate the model can fail forever.
    out=$(judge '{"verdict":"approved","issues":[],"summary":"fine",
      "vcAssessment":[{"criterion":"a","met":true,"evidence":"x:1"}]}' \
      'a
b')
    [ "$(printf '%s' "$out" | jq -r '.verdict')" = "approved" ]
    [ "$(printf '%s' "$out" | jq -r '.vcAssessmentIncomplete')" = "true" ] || {
        echo "an unassessed criterion left no trace at all: $out"; false; }
    [[ "$(printf '%s' "$out" | jq -r '.vcAssessmentUnassessed | join(",")')" == *"b"* ]]
}

@test "a review with NO assessment at all still yields a verdict — and says it was unassessed" {
    out=$(judge '{"verdict":"approved","issues":[],"summary":"fine"}' 'a')
    [ "$(printf '%s' "$out" | jq -r '.verdict')" = "approved" ]
    [ "$(printf '%s' "$out" | jq -r '.vcAssessmentIncomplete')" = "true" ]
}

@test "with NO criteria declared the gate is inert — it invents nothing" {
    out=$(judge '{"verdict":"approved","issues":[],"summary":"fine"}' '')
    [ "$(printf '%s' "$out" | jq -r '.verdict')" = "approved" ]
    [ "$(printf '%s' "$out" | jq -r '.vcAssessmentIncomplete // "absent"')" = "absent" ]
}

@test "changes_requested is never upgraded, whatever the assessment says" {
    out=$(judge '{"verdict":"changes_requested","issues":[{"severity":"major","description":"x"}],"summary":"s",
      "vcAssessment":[{"criterion":"a","met":true,"evidence":"x:1"}]}' 'a')
    [ "$(printf '%s' "$out" | jq -r '.verdict')" = "changes_requested" ]
    [ "$(printf '%s' "$out" | jq -r '.issues | length')" = "1" ]
}

@test "malformed input is passed through, not swallowed" {
    # A gate that eats an unparseable review turns a bad response into no response, and the
    # caller's own no-verdict handling is what should see it.
    out=$(printf 'not json at all' | "$NODE" "$GATE" 'a')
    [ "$out" = "not json at all" ]
}

@test "THE GATE IS WIRED — team-lead-review.sh actually runs it" {
    run grep -c 'vc-assessment-gate.js' "$SCRIPTS/team-lead-review.sh"
    [ "$output" -ge 1 ] || {
        echo "the gate exists but nothing calls it — a library with a test and no caller"
        echo "LOOKS covered, which is how plan-fidelity-gate.sh went unwired for weeks."
        false
    }
}
