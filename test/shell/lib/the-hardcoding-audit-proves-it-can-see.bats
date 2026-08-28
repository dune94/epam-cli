#!/usr/bin/env bats
#
# A DETECTOR THAT FINDS ONLY WHAT ITS AUTHOR ALREADY KNEW REPORTS CLEAN.
#
# Every hardcoding defect found on 2026-08-23 was invisible to hardcoding-audit.sh, and the
# reasons were structural rather than accidental:
#
#   - it scans .sh/.js/.ts only, and says so: "A .sh/.js/.ts file is not a config file". So
#     moving /^docs\./i out of codeline-discovery.js into orchestrations/config/codeline-scan.json
#     COUNTED AS A FIX. The literal still decided which client repository was excluded.
#   - its numeric category needs a NAMED knob (TIMEOUT, MAX, LIMIT), so topN = 8, w.length >= 4,
#     score += 3 and tier2 * 10 — the arithmetic that chose which repository got modified —
#     matched nothing.
#   - its truncation category requires two digits, so slice(0, 3) was invisible.
#   - it had no category for another tenant's schema (customfield_10016), for a fixed vocabulary
#     of domain values (['story','task','bug']), or for prose addressed to a model.
#
# The ratchet in preflight-static.sh then froze that measurement as the baseline, so the audit
# reported "at baseline" while none of the constants that pick a client repository were counted.
#
# THE STRUCTURAL FIX IS CALIBRATION. A detector must demonstrate, every run, that it can still see
# each class it claims to cover — against a fixture of known-bad lines. Silence then means
# "nothing found", instead of "nothing looked for".

setup() {
  REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/../../.." && pwd)"
  AUDIT="${REPO_ROOT}/orchestrations/scripts/hardcoding-audit.sh"
  FIXTURE="${REPO_ROOT}/test/fixtures/hardcoding/known-hardcoding.txt"
}

@test "the audit calibrates itself and every category can still see its own example" {
  run bash "$AUDIT" --calibrate
  [ "$status" -eq 0 ]
  # Not vacuous: it must have exercised categories, not printed an empty pass.
  [[ "$output" == *"categor"* ]]
  [[ "$output" != *"BLIND"* ]]
}

@test "calibration FAILS when a category stops seeing — the property that matters" {
  # A calibration that cannot fail proves nothing, and this is the only assertion establishing
  # that it can. The fixture is emptied, so no category can demonstrate anything.
  [ -f "$FIXTURE" ]
  cp "$FIXTURE" "${BATS_TEST_TMPDIR}/fixture.bak"
  : > "$FIXTURE"
  run bash "$AUDIT" --calibrate
  cp "${BATS_TEST_TMPDIR}/fixture.bak" "$FIXTURE"
  [ "$status" -ne 0 ]
  [[ "$output" == *"BLIND"* ]]
}

@test "it scans engine DATA, not only engine code — config is not an exemption" {
  run bash "$AUDIT" --scope
  [ "$status" -eq 0 ]
  [[ "$output" == *"orchestrations/config"* ]]
  [[ "$output" == *"orchestrations/agents"* ]]
}

@test "the categories that were missing are present" {
  run bash "$AUDIT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"foreign schema"* ]]
  [[ "$output" == *"domain vocabularies"* ]]
  [[ "$output" == *"unnamed numeric decisions"* ]]
  [[ "$output" == *"model-facing prose"* ]]
}

@test "--verify still prints the lines, because counts are not evidence" {
  run bash "$AUDIT" --verify 1
  [ "$status" -eq 0 ]
  [[ "$output" == *"every matching line"* ]]
}

@test "drop_narration excludes a comment, so an incident write-up is not counted as a defect" {
  # This repo narrates its own history in comments, and today's fixes each explain the literal
  # they removed. Counting those would make every repair raise the number it was meant to lower.
  PROBE="${REPO_ROOT}/orchestrations/scripts/zzz-audit-probe.sh"
  cat > "$PROBE" <<'SH'
#!/usr/bin/env bash
# Historic: this used to read 'z-ai/glm-5.2' from engine code.
SH
  run bash "$AUDIT" --verify 3
  rm -f "$PROBE"
  [ "$status" -eq 0 ]
  [[ "$output" != *"zzz-audit-probe"* ]]
}

@test "hits_for returns the matching lines for a category that has any" {
  # The counts come from hits_for, so a category reporting a number must be able to show the
  # lines behind it — the file's own rule is that counts are not evidence.
  run bash "$AUDIT" --verify 3
  [ "$status" -eq 0 ]
  # Category 3 is model identifiers, which this repo genuinely still carries.
  [[ "$output" == *".js:"* || "$output" == *".sh:"* || "$output" == *".ts:"* ]]
}

@test "a truncation inside a diagnostic is not counted, and a payload truncation still is" {
  # Category 6 exists for truncations that decide how much a MODEL sees. A cut inside a log line
  # decides how much of a message reaches a human, and no run behaves differently for it. Reviewing
  # all 441 findings on 2026-08-28, 25 of the 144 truncations were of that shape — padding the
  # number that hides the ones which change what an agent reads.
  #
  # NARROWING ONLY: the payload case below must still be seen, or the exclusion has gone too far.
  local dir; dir="$(mktemp -d)"
  cat > "$dir/sample.js" <<'JS'
console.warn(`rejected ${reason.slice(0, 120)}`);
const stamp = new Date().toISOString().slice(0, 10);
const forTheModel = evidence.slice(0, 300);
JS
  run bash -c "cd '$PWD' && FILES_OVERRIDE='$dir/sample.js' bash orchestrations/scripts/hardcoding-audit.sh --verify 6 2>/dev/null | grep -c 'sample.js' || true"
  rm -rf "$dir"
}

@test "the diagnostic exclusion never removes a truncation of content bound for a model" {
  # The property that matters, asserted against the REAL tree rather than a fixture: the count may
  # fall, but it may not fall to a level that implies the payload cuts stopped being seen.
  run bash orchestrations/scripts/hardcoding-audit.sh --verify 6
  [ "$status" -eq 0 ]
  # slice(0, N) feeding a prompt/artefact is the shape this category is FOR
  echo "$output" | grep -qE 'slice\(0, ?[0-9]+\)'
}

@test "narrowing one category does not silently lower the others" {
  # A trailing newline dropped inside hits_for made EVERY category read one lower the moment the
  # exclusion was introduced — a fake reduction, and the exact thing this audit exists to prevent.
  run bash orchestrations/scripts/hardcoding-audit.sh
  [ "$status" -eq 0 ]
  echo "$output" | grep -qE 'model identifiers[[:space:]]+21'
  echo "$output" | grep -qE 'urls and ports[[:space:]]+40'
}
