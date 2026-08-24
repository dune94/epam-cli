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
