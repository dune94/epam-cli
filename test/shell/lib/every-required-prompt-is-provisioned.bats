#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# A SEAM WITH NO PROJECT PROMPT CANNOT RUN, AND FINDS OUT MID-RUN.
#
# lib/prompt-library.js renders ONLY the project-authority copy and refuses to fall back to
# the generic template — deliberately: "a silent degrade is how an engine default runs a
# whole campaign without anyone noticing". So a missing project prompt is a hard failure,
# thrown at whichever seam needed it, after the roster is minted and the run is spending.
#
# lib/project-prompt-builder.js says the same about its own failure mode: "the builder
# throws rather than leaving a project half-provisioned."
#
# Found 2026-08-21: metrolinx is half-provisioned anyway. provisioningList() requires 53
# prompts; 37 exist. The 18 missing include cpa-system (where cpa-inference's whole output
# schema lives), spec-coordinator-review, spec-model-review, spec-agent-speckit and
# runtime-boundary-review. None surfaced in the run that completed that day because the
# resume skipped the spec pass — so the gap is invisible exactly until a full run reaches it.
#
# The required set is DERIVED, never listed: the seam registry is the source (a profile
# declaring `template: X` IS the statement that X needs a project copy), plus the auxiliary
# sub-prompts bootstrap.json declares. This test therefore covers a seam added tomorrow.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
    BUILDER="$REPO_ROOT/orchestrations/scripts/lib/project-prompt-builder.js"
    TEMPLATES="$REPO_ROOT/orchestrations/prompts/templates"
}

# The prompts a project must have, from the real resolver — not a list in this file.
required_for() {   # $1 = project dir
    "$NODE" -e '
      const fs = require("fs"), path = require("path");
      const m = require(process.argv[1]);
      const bootstrap = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
      const registry  = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
      const tdir = process.argv[4];
      const list = m.provisioningList({
        bootstrap, registry, templateExists: (id) => fs.existsSync(path.join(tdir, id + ".json")),
      });
      // copyVerbatim prompts are required too — installed byte-identical rather than generated.
      const all = [...new Set([...(bootstrap.copyVerbatim || []), ...list])];
      process.stdout.write(all.sort().join("\n"));
    ' "$BUILDER" "$REPO_ROOT/orchestrations/prompts/bootstrap.json" \
      "$REPO_ROOT/orchestrations/agents/invocation-profiles.json" "$TEMPLATES"
}

projects() { ls -1 "$REPO_ROOT/orchestrations/projects" 2>/dev/null; }

@test "the resolver answers, and the required set is non-trivial" {
    run required_for
    [ "$status" -eq 0 ]
    [ "$(printf '%s\n' "$output" | grep -c .)" -ge 20 ]
}

@test "the registry is the source — every seam template it names exists" {
    # provisioningList THROWS on a seam naming a template that exists nowhere, deliberately:
    # "a gap in it is an error, not something bootstrap quietly covers for". If this test
    # fails with a throw, that is the message.
    run required_for
    [ "$status" -eq 0 ] || { echo "$output"; false; }
}

@test "EVERY required prompt exists as a TEMPLATE to mint from" {
    missing=""
    while IFS= read -r id; do
        [ -n "$id" ] || continue
        [ -f "$TEMPLATES/$id.json" ] || missing="$missing $id"
    done < <(required_for)
    [ -z "$missing" ] || { echo "required but no template to mint from:$missing"; false; }
}

@test "EVERY project is fully provisioned — no seam can hard-fail mid-run for a missing prompt" {
    total_missing=0
    report=""
    while IFS= read -r p; do
        [ -n "$p" ] || continue
        dir="$REPO_ROOT/orchestrations/projects/$p/prompts"
        [ -d "$dir" ] || { report="${report}
  $p: no prompts/ directory at all"; total_missing=$((total_missing+1)); continue; }
        miss=""
        while IFS= read -r id; do
            [ -n "$id" ] || continue
            [ -f "$dir/$id.json" ] || miss="$miss $id"
        done < <(required_for)
        if [ -n "$miss" ]; then
            n=$(printf '%s' "$miss" | wc -w)
            total_missing=$((total_missing + n))
            report="${report}
  $p is missing $n required prompt(s):$miss"
        fi
    done < <(projects)
    [ "$total_missing" -eq 0 ] || {
        echo "half-provisioned project(s) — each missing prompt is a hard failure at the seam that needs it:"
        echo "$report"
        false
    }
}

@test "the check is not vacuous — it really inspects projects" {
    n=$(projects | wc -l)
    [ "$n" -ge 1 ]
    # and at least one project has a prompts dir, or the test above proves nothing
    found=0
    while IFS= read -r p; do
        [ -d "$REPO_ROOT/orchestrations/projects/$p/prompts" ] && found=$((found+1))
    done < <(projects)
    [ "$found" -ge 1 ]
}
