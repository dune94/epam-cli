#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# A PROJECT COPY IS FOR THE PROJECT LAYER ONLY.
#
# THIS FILE PREVIOUSLY ASSERTED THE WRONG THING. It compared provisioningList() against the
# files on disk and called 17 absent prompts a defect — "a hard failure waiting mid-run" —
# and recommended re-minting them. They had been deliberately DELETED on 2026-08-16 by
# dc7fb20, which explains exactly why:
#
#   "There are two prompt renderers and the split is deliberate: prompt-library.js reads the
#    PROJECT copy and treats a missing one as a hard failure; engine-prompt.js reads the
#    TEMPLATE, for prompts the engine assembles before any project agent exists. So a project
#    copy of an engine-layer prompt can never be executed. Under 'generate' an agent WRITES
#    each one: paid work producing files that read as live, that self-heal corrections land in
#    and do nothing, and that go stale invisibly."
#
# Re-minting them would have reintroduced the defect that commit removed, and paid for it.
# The absence was the fix.
#
# THE RULE IT SHOULD HAVE ASSERTED: bootstrap.generated is the list of AUXILIARY prompts that
# need a PROJECT copy. An id read through render_engine_prompt / renderEngineTemplate is
# engine-layer and must NOT be on it — the engine reads the template directly, and a project
# copy is dead weight that goes stale unseen.
#
# Verified per id rather than assumed: 14 of the 17 have an engine-layer reader and are
# correctly absent; 2 (manifest-analysis, prd-generation) are read by nothing at all.
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

@test "bootstrap.generated lists ONLY project-layer prompts" {
    # An id the engine renders from the template must not be here: provisioning a project copy
    # of it produces a file nothing can read. That is what dc7fb20 removed 39 of.
    engine=""
    while IFS= read -r id; do
        [ -n "$id" ] || continue
        if grep -rq "render_engine_prompt \"\?$id\b\|renderEngineTemplate('$id'" \
             "$REPO_ROOT/orchestrations/scripts" 2>/dev/null; then
            engine="$engine $id"
        fi
    done < <("$NODE" -e 'const b=require(process.argv[1]);(b.generated||[]).forEach(x=>console.log(x))' \
             "$REPO_ROOT/orchestrations/prompts/bootstrap.json")
    [ -z "$engine" ] || {
        echo "engine-layer prompts listed as needing a PROJECT copy:$engine"
        echo "the engine renders these from the template; a project copy can never be executed."
        false
    }
}

@test "EVERY seam-declared template has a project copy — that layer IS project-authority" {
    # Seam templates are rendered by prompt-library.js, which refuses to fall back. A missing
    # one here really is a hard failure at that seam. This is the check the old test should
    # have been: scoped to the layer where absence is a defect.
    reg="$REPO_ROOT/orchestrations/agents/invocation-profiles.json"
    for proj in $(projects); do
        dir="$REPO_ROOT/orchestrations/projects/$proj/prompts"
        [ -d "$dir" ] || continue
        miss=$("$NODE" -e '
          const fs=require("fs"),path=require("path");
          const reg=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
          const dir=process.argv[2];
          const seam=[...new Set(Object.values(reg.profiles||{}).map(p=>p&&p.template).filter(Boolean))];
          process.stdout.write(seam.filter(t=>!fs.existsSync(path.join(dir,t+".json"))).join(" "));
        ' "$reg" "$dir")
        [ -z "$miss" ] || { echo "$proj is missing seam prompt(s):$miss"; false; }
    done
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
