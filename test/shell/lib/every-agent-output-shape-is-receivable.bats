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
// SINGLE-LINE AND MULTI-LINE. The first version took only one-line skeletons and missed
// every prompt that declares its shape as a pretty-printed block — cpa-system.json states
// its whole schema that way under "Output schema:", so cpa-inference looked shapeless and
// its round trip was skipped. A test that cannot see half the declarations under-reports
// coverage and calls it a gap in the prompt.
const skeletons = (t) => {
  const text = String(t);
  const out = [];
  // ONE SCANNER, NOT TWO. There used to be a line-anchored regex for single-line skeletons
  // beside the balanced scanner below, and it demanded the line BE the object: `^\{"..."\}$`.
  // Three real declarations failed that anchor and read as prompts with no contract at all —
  // `{ "enrichedAcs": [...] }` (whitespace after the brace), `[{"file":...}]` (an array of
  // objects), and `Emit ONLY: {"verdict":...}` (prose before the JSON). Widening the regex
  // instead made it greedy enough to capture unbalanced fragments. The scanner below already
  // answers all four cases correctly, because it balances braces rather than trusting line
  // boundaries — it was simply told to skip anything without a newline.
  // balanced multi-line blocks that open a line with '{' and contain a quoted key
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, j = i;
    for (; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) continue;
    const block = text.slice(i, j + 1);

    if (!/"[a-zA-Z_]+"\s*:/.test(block)) continue;        // must look like an object
    if (/__[A-Z_]+__/.test(block) && !/"/.test(block)) continue;
    out.push(block);
    i = j;
  }
  return out;
};
// EVERY placeholder convention the prompts actually use. Each was added only after being
// found in a real template — never invented to make a test pass. Extending this list is how
// a "broken shape" count of 8 came down to the ones that are genuinely broken.
const concrete = (s) => s
  .replace(/"<[^">]*>"/g, '"x"')                     // "<a path>"
  .replace(/"[a-zA-Z_]+"(\s*\|\s*"[a-zA-Z_]+")+/g, '"x"') // "a" | "b" | "c"
  .replace(/"[a-z_]+\|[a-z_|]+"/g, '"x"')             // "a|b"
  .replace(/__[A-Z_]+__/g, '')                       // schema-line inserts: nothing here
  .replace(/<[^<>]*>/g, '0')                         // <n>
  .replace(/\btrue\|false\b/g, 'true')
  .replace(/"\.\.\."/g, '"x"')
  .replace(/:\s*N\b/g, ': 0')                        // bare N as a number placeholder
  .replace(/\btrue\/false\b/g, 'true')               // slash union
  .replace(/,\s*\.\.\./g, '')                        // ["a", ...]
  // BARE ELLIPSIS AS A WHOLE VALUE — `[...]`, `{...}`, `: ...`. The prompts have always used
  // it; these declarations were simply invisible until the scanner stopped skipping
  // single-line blocks, so this is newly VISIBLE shorthand, not newly broken output.
  .replace(/\[\s*\.\.\.\s*\]/g, '[]')
  .replace(/\{\s*\.\.\.\s*\}/g, '{}')
  .replace(/:\s*\.\.\.(\s*[,}\]])/g, ': "x"$1')
  .replace(/:\s*\|\s*/g, ': ')                       // ": | \"both\"" left by a removed insert
  .replace(/,(\s*[}\]])/g, '$1')                     // trailing comma left by an insert
  .replace(/""\s*:/g, '"x":');
const out = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  let j; try { j = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')); } catch { continue; }
  for (const s of skeletons(bodyOf(j))) out.push({ template: f.replace('.json', ''), raw: s, concrete: concrete(s), layer: 'prompt' });
}
// THE THIRD LAYER. Shapes are declared in three places, and reading only the prompt bodies
// under-counted coverage badly: agent-output-schema.js carries real JSON Schemas with
// `required` fields, validated at the seam by validateTaggedOutput — a stronger declaration
// than an illustrative example. guard-vocabulary, ticket-links and the spec agents all live
// here, and every one of them looked shapeless until this was added.
try {
  const mod = require(process.argv[2] + '/lib/agent-output-schema.js');
  for (const tag of Object.keys(mod.TAG_TO_TOOL || {})) {
    const sc = mod.itemSchemaFor ? mod.itemSchemaFor(tag) : null;
    out.push({ template: tag, raw: JSON.stringify(sc || {}), concrete: '{}', layer: 'schema',
               required: (sc && sc.required) || [] });
  }
} catch (_) { /* the module is its own test's subject */ }
module.exports = out;
JS
}

with_shapes() {  # $1 = js body receiving `shapes`
    local tmp="$BATS_TEST_TMPDIR/shapes.js"
    shapes_js > "$tmp"
    "$NODE" -e "const shapes = require('$tmp'); $1" "$TEMPLATES" "$SCRIPTS"
}

@test "the extraction is real — prompts do declare output shapes" {
    run with_shapes 'process.stdout.write(String(shapes.length))'
    [ "$output" -ge 15 ]
}

@test "EVERY declared output shape is valid JSON once its placeholders are filled" {
    # A prompt that says "respond with ONLY a JSON object" and then shows something that
    # cannot be emitted verbatim is teaching the agent to produce what its consumer rejects.
    run with_shapes '
      const bad = shapes.filter((s) => s.layer === "prompt")
                        .filter((s) => { try { JSON.parse(s.concrete); return false; } catch { return true; } })
                        .map((s) => s.template + " :: " + s.concrete.slice(0, 70));
      process.stdout.write(bad.join("\n"));'
    [ -z "$output" ] || { echo "declared shapes that are not valid JSON:"; echo "$output"; false; }
}

@test "every declared shape is an OBJECT — the extractors look for one" {
    # team-lead-review-json and its siblings raw_decode from the first '{'. A shape declared
    # as a bare array or scalar would not be found by any of them.
    run with_shapes '
      const bad = shapes.filter((s) => s.layer === "prompt").filter((s) => { try { const v = JSON.parse(s.concrete);
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

# ── per-agent coverage, across ALL THREE declaration layers ──────────────────

# An agent's shape may be declared in its own prompt, in a related prompt (a system prompt
# or a differently-named template it points at), or as a JSON Schema in
# agent-output-schema.js. Reading only the first under-counted coverage badly enough that I
# reported 15 agents as shapeless when most of them were better declared than the ones I
# had counted.
agent_shape_layers() {
    local tmp="$BATS_TEST_TMPDIR/cover.js"
    shapes_js > "$tmp"
    "$NODE" -e '
      const shapes = require(process.argv[3]);
      const p = require(process.argv[4]);
      const declared = new Set(shapes.map((s) => s.template.toLowerCase()));
      // Agents whose invocation binds a response schema, read from the runner source itself.
      const boundSchemas = new Set();
      {
        const src = require("fs").readFileSync(process.argv[5], "utf8");
        const lines = src.split("\n");
        lines.forEach((l, i) => {
          // \x27 not a literal quote: this JS lives inside a single-quoted shell string.
          const m = l.match(/EPAM_AGENT_NAME:\s*\x27([a-z0-9-]+)\x27/);
          if (m && lines.slice(Math.max(0, i - 8), i + 8).some((x) => /schemaEnv\(|TOOL_[A-Z_]+/.test(x)))
            boundSchemas.add(m[1]);
        });
        // runAgentForJson(prompt, TOOL_X, 'TAG', ...) reached through a `what:` label
        for (const m of src.matchAll(/what:\s*\x27([a-z0-9-]+)\x27[\s\S]{0,900}?TOOL_[A-Z_]+/g))
          boundSchemas.add(m[1]);
      }
      const agents = []; const meta = {};
      (function w(o){ for (const k in o) { const v = o[k];
        if (v && typeof v === "object") {
          if ((v.ladder || v.reasoningEffort || v._what) && k !== "defaults") {
            agents.push(k); meta[k] = v; }
          w(v); } } })(p);
      const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const has = (a) => {
        const m = meta[a] || {};
        // _outputShapeIn is the DECLARED link, used where the real one lives in code and no
        // name rule could find it: contextualize-stories.sh renders cpa-system into
        // __SYSTEM_PROMPT__, and three agents are schema-declared rather than prompt-declared.
        const cands = [a, m.template, m._outputShapeIn, a + "-system", a + "-main",
                       (m.produces || "").replace(/-/g, "_").toUpperCase()];
        for (const c of cands) { if (!c) continue;
          for (const d of declared) { if (norm(d) === norm(c)) return true; } }
        // a schema tag whose name matches the agent loosely (GUARD_VOCABULARY <- guard-vocabulary)
        for (const d of declared) { if (norm(d) === norm(a)) return true; }
        // THE FOURTH LAYER: a JSON Schema BOUND AT THE INVOCATION. spec-mode-runner.js binds
        // EPAM_RESPONSE_SCHEMA: schemaEnv(TOOL_*) beside EPAM_AGENT_NAME, and passes a TOOL_*
        // constant straight into runAgentForJson. That is a stronger declaration than an
        // illustrative example in a prompt — the seam validates against it and retries on a
        // mismatch — and reading only the other three layers reported role-assigner,
        // roster-review and survey-review as shapeless when each is schema-bound.
        if (boundSchemas.has(a)) return true;
        return false;
      };
      const missing = [...new Set(agents)].sort().filter((a) => !has(a) && !meta[a]._outputIsArtefact);
      process.stdout.write(missing.join(" "));
    ' "$TEMPLATES" "$SCRIPTS" "$tmp" "$REPO_ROOT/orchestrations/agents/invocation-profiles.json" \
      "$SCRIPTS/spec-mode-runner.js"
}

@test "EVERY agent's output shape is declared in one of the three layers" {
    # An agent that delivers FILES rather than a payload has nothing to declare, and says so
    # in its own profile via _outputIsArtefact — declared, never inferred. toolGrant cannot
    # stand in for it: team-lead-review is `execute` and absolutely needs a shape.
    run agent_shape_layers
    [ -z "$output" ] || {
        echo "agents with no declared output shape and no _outputIsArtefact note:"
        echo "  $output"
        false
    }
}

@test "every artefact exemption states WHY, in the profile" {
    run "$NODE" -e '
      const p = require(process.argv[1]); const bad = [];
      (function w(o){ for (const k in o) { const v = o[k];
        if (v && typeof v === "object") {
          if (v._outputIsArtefact && String(v._outputIsArtefact).trim().length < 25) bad.push(k);
          w(v); } } })(p);
      process.stdout.write(bad.join(", "));' "$REPO_ROOT/orchestrations/agents/invocation-profiles.json"
    [ -z "$output" ] || { echo "exemptions with no real reason: $output"; false; }
}
