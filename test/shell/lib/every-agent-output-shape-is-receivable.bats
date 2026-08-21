#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# THE SHAPE A PROMPT ASKS FOR MUST BE A SHAPE ITS CONSUMER CAN RECEIVE.
#
# Two suites already cover the ends of this: every-agent-end-to-end.bats checks what an
# agent RECEIVES, and every-agent-output-is-consumed.bats checks that silence is never
# mistaken for success. Neither checks the SHAPE in between — the thing the prompt tells the
# agent to emit, and whether the consumer can actually read it.
#
# That middle is where a whole class of failure lives, and this repo has paid for it:
#   2026-07-07  every changes_requested review fell through to a hardcoded `approved`,
#               because the extractor assumed flat single-line JSON and real reviews are
#               pretty-printed with nested issues.
#   2026-07-31  a complete 10-blocker review was discarded over one stray quote.
#
# The shapes are DERIVED from the prompts, never written here: the prompt is the contract,
# so a fixture invented in a test would prove agreement with itself. Placeholders are
# normalised using only the conventions the prompts already use.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    TEMPLATES="$REPO_ROOT/orchestrations/prompts/templates"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
}

# Every inline JSON shape any prompt declares, with placeholders made concrete.
# The conventions are the prompts' own: "<a path>", <n>, "a|b", true|false, "...", __X__.
shapes_js() {
    cat <<'JS'
const fs = require('fs');
const dir = process.argv[1];
const bodyOf = (j) => typeof j.body === 'string' ? j.body
                    : (j.bodies ? Object.values(j.bodies).join('\n') : '');
const skeletons = (t) => String(t).split('\n').map((l) => l.trim())
  .filter((l) => /^\{".{5,}\}$/.test(l) && /"[a-zA-Z_]+"\s*:/.test(l));
const concrete = (s) => s
  .replace(/"<[^">]*>"/g, '"x"')
  .replace(/<[^<>]*>/g, '0')
  .replace(/"[a-z_]+\|[a-z_|]+"/g, '"x"')
  .replace(/\btrue\|false\b/g, 'true')
  .replace(/"\.\.\."/g, '"x"')
  .replace(/__[A-Z_]+__/g, '0');
const out = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  let j; try { j = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')); } catch { continue; }
  for (const s of skeletons(bodyOf(j))) out.push({ template: f.replace('.json', ''), raw: s, concrete: concrete(s) });
}
module.exports = out;
JS
}

with_shapes() {  # $1 = js body receiving `shapes`
    local tmp="$BATS_TEST_TMPDIR/shapes.js"
    shapes_js > "$tmp"
    "$NODE" -e "const shapes = require('$tmp'); $1" "$TEMPLATES"
}

@test "the extraction is real — prompts do declare output shapes" {
    run with_shapes 'process.stdout.write(String(shapes.length))'
    [ "$output" -ge 15 ]
}

@test "EVERY declared output shape is valid JSON once its placeholders are filled" {
    # A prompt that says "respond with ONLY a JSON object" and then shows something that
    # cannot be emitted verbatim is teaching the agent to produce what its consumer rejects.
    run with_shapes '
      const bad = shapes.filter((s) => { try { JSON.parse(s.concrete); return false; } catch { return true; } })
                        .map((s) => s.template + " :: " + s.concrete.slice(0, 70));
      process.stdout.write(bad.join("\n"));'
    [ -z "$output" ] || { echo "declared shapes that are not valid JSON:"; echo "$output"; false; }
}

@test "every declared shape is an OBJECT — the extractors look for one" {
    # team-lead-review-json and its siblings raw_decode from the first '{'. A shape declared
    # as a bare array or scalar would not be found by any of them.
    run with_shapes '
      const bad = shapes.filter((s) => { try { const v = JSON.parse(s.concrete);
          return !v || typeof v !== "object" || Array.isArray(v); } catch { return false; } })
        .map((s) => s.template);
      process.stdout.write(bad.join(", "));'
    [ -z "$output" ] || { echo "shapes that are not objects: $output"; false; }
}

# ── ROUND TRIP: the declared shape, through the real consumer ────────────────

@test "ROUND TRIP: the reviewer's OWN declared approved shape is received" {
    # Taken from team-lead-review.json, not written here.
    raw=$(with_shapes '
      const s = shapes.find((x) => x.template === "team-lead-review" && /approved/.test(x.raw));
      process.stdout.write(s ? s.concrete : "");')
    [ -n "$raw" ]
    run bash -c "printf '%s' '$raw' | python3 '$SCRIPTS/lib/handlers/team-lead-review-json.py' | jq -r '.verdict'"
    [ "$output" = "approved" ]
}

@test "ROUND TRIP: the reviewer's declared changes_requested shape keeps every issue field" {
    # The 2026-07-07 defect was the extractor losing nested issues entirely. The fields the
    # prompt demands — severity, file, line, description — must survive the round trip, or
    # the reviewer's findings reach the writer stripped.
    raw=$(with_shapes '
      const s = shapes.find((x) => x.template === "team-lead-review" && /changes_requested/.test(x.raw));
      process.stdout.write(s ? s.concrete : "");')
    [ -n "$raw" ]
    out=$(printf '%s' "$raw" | python3 "$SCRIPTS/lib/handlers/team-lead-review-json.py")
    [ "$(printf '%s' "$out" | jq -r '.verdict')" = "changes_requested" ]
    [ "$(printf '%s' "$out" | jq '.issues | length')" -ge 1 ]
    for field in severity file line description; do
        [ "$(printf '%s' "$out" | jq "[.issues[0].$field] | map(select(. != null)) | length")" -eq 1 ] \
            || { echo "issue field '$field' did not survive the extractor"; false; }
    done
}

@test "ROUND TRIP: the same shape PRETTY-PRINTED still arrives whole" {
    # Models emit multi-line JSON. This is the exact 2026-07-07 regression.
    raw=$(with_shapes '
      const s = shapes.find((x) => x.template === "team-lead-review" && /changes_requested/.test(x.raw));
      process.stdout.write(s ? JSON.stringify(JSON.parse(s.concrete), null, 2) : "");')
    [ -n "$raw" ]
    out=$(printf '%s' "$raw" | python3 "$SCRIPTS/lib/handlers/team-lead-review-json.py")
    [ "$(printf '%s' "$out" | jq -r '.verdict')" = "changes_requested" ]
    [ "$(printf '%s' "$out" | jq '.issues | length')" -ge 1 ]
}

@test "ROUND TRIP: a shape-BROKEN variant is not received as a verdict" {
    # Right JSON, wrong shape: the consumer must not manufacture a verdict from it.
    run bash -c "printf '%s' '{\"findings\":[],\"note\":\"no verdict key\"}' \
                 | python3 '$SCRIPTS/lib/handlers/team-lead-review-json.py' | jq -r '.reviewIncomplete'"
    [ "$output" = "true" ]
}

@test "ROUND TRIP: cpa-inference receives its own declared shape" {
    raw=$(with_shapes '
      const s = shapes.find((x) => /^cpa/.test(x.template));
      process.stdout.write(s ? s.concrete : "");')
    if [ -z "$raw" ]; then skip "no inline shape declared for cpa-*"; fi
    run "$NODE" -e '
      const { extractJSON } = require(process.argv[1] + "/lib/cpa-inference.js");
      try { const v = extractJSON(process.argv[2]);
            process.stdout.write(v && typeof v === "object" ? "RECEIVED" : "LOST"); }
      catch (e) { process.stdout.write("THREW"); }' "$SCRIPTS" "$raw"
    [ "$output" = "RECEIVED" ]
}

@test "and a declared shape wrapped in prose still arrives — models narrate" {
    raw=$(with_shapes '
      const s = shapes.find((x) => x.template === "team-lead-review" && /approved/.test(x.raw));
      process.stdout.write(s ? s.concrete : "");')
    out=$(printf 'Here is my review:\n%s\nThat is all.' "$raw" \
          | python3 "$SCRIPTS/lib/handlers/team-lead-review-json.py")
    [ "$(printf '%s' "$out" | jq -r '.verdict')" = "approved" ]
}
