#!/usr/bin/env bats
#
# A CANONICAL PRD THAT DECLARES A SCOPE SILENTLY DISABLES DISCOVERY.
#
# resolve-codeline-scope.sh asks one question before it scans anything: does the PRD already
# declare codelines? If so it exits 0 with "nothing to resolve", and apply-codeline-scope.js
# refuses to overwrite a declared scope. That is correct — a project that owns a fixed scope has
# answered the question, and discovery should stand aside.
#
# What is NOT correct is answering it by accident. metrolinx/prd.canonical.json carried
# outputDirs:[cdts], left over from an earlier run, and pre-run-reset restores that file over
# prd.json at the start of EVERY run. So discovery would never have run, and every run would have
# been scoped to azure.commerce.cdts whatever the ticket said — including a run launched
# specifically to let discovery choose freely.
#
# Caught before a launch, not by one.

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)"
  NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
  COUNT="${REPO_ROOT}/orchestrations/scripts/lib/handlers/cl-count.js"
}

@test "no canonical PRD declares a codeline scope, so discovery is never pre-empted" {
  bad=""
  checked=0
  for prd in "${REPO_ROOT}"/orchestrations/projects/*/prd.canonical.json; do
    [ -f "$prd" ] || continue
    checked=$(( checked + 1 ))
    n=$("$NODE_BIN" "$COUNT" "$prd" 2>/dev/null || echo 0)
    [ "${n:-0}" -eq 0 ] || bad="$bad $(basename "$(dirname "$prd")")=${n}"
  done
  # Not vacuous: there must be canonical PRDs to check.
  [ "$checked" -ge 1 ]
  [ -z "$bad" ] || {
    echo "canonical PRD(s) declaring a scope, which disables discovery every run:$bad"
    echo "Discovery exits with 'nothing to resolve' and the run uses whatever is declared here."
    false
  }
}

@test "the check is real — it sees a scope when one IS declared" {
  # Without this, the assertion above passes for a counter that never counts.
  PROBE="${BATS_TEST_TMPDIR}/probe.json"
  cat > "$PROBE" <<'JSON'
{"project":{"name":"p","outputDirs":[{"codeline":"x","path":"/tmp/x"}]},"stories":[]}
JSON
  n=$("$NODE_BIN" "$COUNT" "$PROBE" 2>/dev/null || echo 0)
  [ "${n:-0}" -ge 1 ]
}
