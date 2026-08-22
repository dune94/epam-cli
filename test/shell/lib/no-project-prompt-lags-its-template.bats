#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# A PROJECT PROMPT THAT LAGS ITS TEMPLATE LOSES EVIDENCE, IN SILENCE.
#
# The layer rule: the TEMPLATE is the immutable generic source, the PROJECT copy is the only
# thing ever rendered. Nothing enforced that the copy still declares what its template declares.
# So a template gains a placeholder, the minted copy does not, the caller keeps supplying the
# value, and prompt-library.js drops it on the floor.
#
# Live 20260821T212250Z: prior-reviews.py built the reviewer's history correctly and supplied it
# as __PRIOR_REVIEW__. metrolinx/team-lead-review.json declared no such placeholder. All three
# review cycles ran with no memory of each other, and the approval missed a regression the
# EARLIER CYCLE HAD CAUGHT. The run log mentions prior review zero times.
#
# That was one of eleven. The rest silently dropped the typecheck command, the test command, the
# test-file conventions, the config surface, the CVE rule prefix and a survey hypothesis.
#
# This is the ratchet: drift is now a test failure, not a live-run discovery.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
    DRIFT="$REPO_ROOT/orchestrations/scripts/lib/prompt-drift.js"
    TEMPLATES="$REPO_ROOT/orchestrations/prompts/templates"
    PROJECTS="$REPO_ROOT/orchestrations/projects"
}

@test "the detector runs and really inspects project prompts" {
    # Guard against a vacuous pass: if it compared nothing, every assertion below is empty.
    run "$NODE" -e '
      const m = require(process.argv[1]);
      process.stdout.write(String(m.pairs().length));' "$DRIFT"
    [ "$status" -eq 0 ] || { echo "$output"; false; }
    [ "$output" -ge 20 ] || { echo "only $output template/project pairs compared"; false; }
}

@test "NO project prompt is missing a placeholder its template uses" {
    run "$NODE" "$DRIFT" report
    [ "$status" -eq 0 ] || {
        echo "$output"
        echo "Each line is evidence a caller computes and the model never sees."
        echo "Port it: node orchestrations/scripts/lib/prompt-drift.js patch"
        false
    }
}

@test "the reviewer's prior-review memory specifically reaches its prompt" {
    # Named on its own because this one cost an approval. A regression here is not generic drift.
    for proj in metrolinx mock3; do
        f="$PROJECTS/$proj/prompts/team-lead-review.json"
        [ -f "$f" ] || continue
        run "$NODE" -e '
          const d = require(process.argv[1]);
          process.stdout.write(d.body.includes("__PRIOR_REVIEW__") ? "yes" : "no");' "$f"
        [ "$output" = "yes" ] || {
            echo "$proj reviewer cannot see its own previous verdicts — every cycle starts blind"
            false
        }
    done
}

@test "and the value it is supplied is the one the prompt now consumes" {
    # The other half: team-lead-review.sh must still SUPPLY __PRIOR_REVIEW__. A prompt that
    # declares it while the caller stopped sending it fails render outright.
    run grep -c '__PRIOR_REVIEW__' "$REPO_ROOT/orchestrations/scripts/team-lead-review.sh"
    [ "$output" -ge 1 ] || { echo "nothing supplies __PRIOR_REVIEW__ any more"; false; }
}

@test "a patched prompt still RENDERS — declared and used agree in both directions" {
    # prompt-library.render() refuses a prompt that uses an undeclared placeholder AND one that
    # declares a placeholder it never uses. A patch that satisfied only one would take the seam
    # down mid-run instead of here.
    lib="$REPO_ROOT/orchestrations/scripts/lib/prompt-library.js"
    run "$NODE" -e '
      const fs=require("fs"), path=require("path");
      const {placeholdersIn}=require(process.argv[1]);
      const P=process.argv[2]; const bad=[];
      for (const proj of fs.readdirSync(P)) {
        const dir=path.join(P,proj,"prompts"); if(!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter(x=>x.endsWith(".json"))) {
          const d=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"));
          if (typeof d.body!=="string") continue;
          const used=new Set(placeholdersIn(d.body)), dec=new Set(d.placeholders||[]);
          const undeclared=[...used].filter(x=>!dec.has(x));
          const orphan=[...dec].filter(x=>!used.has(x));
          if (undeclared.length||orphan.length)
            bad.push(`${proj}/${f}: undeclared=${undeclared} orphanDeclared=${orphan}`);
        }
      }
      process.stdout.write(bad.join("\n"));' "$lib" "$PROJECTS"
    [ -z "$output" ] || { echo "$output"; false; }
}

@test "the patcher is DETERMINISTIC — a second run is a no-op" {
    # It ports template text into a project file. If it were not idempotent, running it twice
    # would duplicate blocks in a prompt nobody re-reads.
    run "$NODE" "$DRIFT" patch --dry-run
    [ "$status" -eq 0 ] || { echo "$output"; false; }
    [[ "$output" != *"would patch"* ]] || {
        echo "the tree is not settled — drift remains after patching: $output"; false; }
}

@test "NO project prompt is missing a RULE its template states" {
    # Placeholder drift was closed first; this is prose drift, and it is what actually cost the
    # approval on 20260821T212250Z. The template says a finding must carry evidence, and that a
    # blocker raised on an earlier iteration still stands unless the code changed. Neither
    # sentence was in the copy that ran.
    #
    # WHOLLY-ABSENT BLOCKS ONLY. A project prompt is a specialisation — it is SUPPOSED to differ,
    # and a reworded rule is not a missing one. Porting on a line diff would duplicate every
    # sentence a project legitimately rephrased.
    run "$NODE" "$DRIFT" prose
    [ "$status" -eq 0 ] || {
        echo "$output"
        echo "Each line is a rule the template states and the executed prompt does not carry."
        echo "Port it: node orchestrations/scripts/lib/prompt-drift.js patch-prose"
        false
    }
}

@test "the reviewer's evidence and anti-decay rules specifically reach its prompt" {
    # Named on their own because these two cost an approval, and because a generic count is easy
    # to look at without noticing which rule is behind it.
    for proj in metrolinx mock3; do
        f="$PROJECTS/$proj/prompts/team-lead-review.json"
        [ -f "$f" ] || continue
        run "$NODE" -e '
          const d = require(process.argv[1]);
          const miss = [];
          if (!/evidence. field/i.test(d.body)) miss.push("the evidence requirement");
          if (!/blocker still stands/i.test(d.body)) miss.push("the anti-decay rule");
          process.stdout.write(miss.join(", "));' "$f"
        [ -z "$output" ] || { echo "$proj reviewer is missing: $output"; false; }
    done
}
