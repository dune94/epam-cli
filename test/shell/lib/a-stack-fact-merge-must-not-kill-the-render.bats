#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# TWO IMPLEMENTATIONS OF ONE IDEA, AND THE WRONG ONE RAN FIRST.
#
# engine-prompt.js injects stack facts itself, and correctly: it adds ONLY the stack
# placeholders a template DECLARES (`stackDeclared`), because the renderer is strict in both
# directions — an unused value is as much an error as a missing one.
#
# lib/jq-vals.sh's merge_stack_facts merges ALL SEVEN into the values file before the render.
# For any template that does not declare all seven, the renderer then throws:
#
#   [engine-prompt] 'qa-fuzz-weaver' was given values it does not use: __STACK__, __MANIFEST_FILE__, ...
#
# and the caller reports "cannot render its prompt — refusing to gate". Five call sites do this
# and four of their templates declare fewer than seven, so those seams cannot run at all. That is
# why the fuzz-weaver never ran.
#
# merge_stack_facts was added to fix the OPPOSITE failure — sites that declared the placeholders
# and never supplied them. The renderer now owns that, so the pre-merge is a second answer to a
# solved problem, and the second answer is the broken one.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    export SCRIPT_DIR="$SCRIPTS"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
    export NODE_BIN="$NODE" NODE_CMD="$NODE"
    WORK="$(mktemp -d)"
}
teardown() { rm -rf "$WORK"; }

# The seven keys, from the renderer itself — never a list written out here.
stack_keys() {
    "$NODE" -e '
      const src = require("fs").readFileSync(process.argv[1], "utf8");
      const m = src.match(/STACK_FACT_KEYS\s*=\s*\[([^\]]*)\]/);
      process.stdout.write(m ? m[1].replace(/[\x27"\s,]+/g, " ").trim() : "");' \
      "$SCRIPTS/lib/engine-prompt.js"
}

@test "the fixture is real — the renderer declares stack fact keys" {
    run stack_keys
    [ -n "$output" ]
    [ "$(printf '%s' "$output" | wc -w)" -ge 5 ]
}

@test "EVERY template rendered after a stack-fact merge can actually render" {
    # Executes the REAL render_engine_prompt for each site's template, with only that site's own
    # values — the renderer supplies the stack facts it needs.
    . "$SCRIPTS/lib/render-engine-prompt.sh"
    failed=""
    # <template>:<body-key>. A multi-part template has no default part — the caller names it,
    # and skill-assessment-prephase is rendered as `with_prd_structure` by claude.sh and `basic`
    # by codemie-claude.sh. Omitting it here failed the template for a reason that was mine.
    for spec in qa-fuzz-weaver: post-failure-analyst: lint-finding-analyst: \
                skill-assessment-prephase:with_prd_structure skill-assessment-prephase:basic; do
        t="${spec%%:*}"; key="${spec#*:}"
        [ -f "$REPO_ROOT/orchestrations/prompts/templates/$t.json" ] || continue
        # every declared NON-stack placeholder gets a value; the stack ones are the renderer's job
        v="$WORK/$t-${key:-single}.json"
        "$NODE" -e '
          const fs=require("fs");
          const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
          const src=fs.readFileSync(process.argv[2],"utf8");
          const m=src.match(/STACK_FACT_KEYS\s*=\s*\[([^\]]*)\]/);
          const stack=new Set((m?m[1]:"").replace(/[\x27"\s]/g,"").split(",").filter(Boolean));
          const key=process.argv[4]||"";
          const body = d.bodies ? (d.bodies[key]||"") : (d.body||"");
          // Only the placeholders THIS PART uses: the declared list on a multi-part template is
          // the union across parts, and supplying another part\x27s values is itself an error.
          const {placeholdersIn}=require(process.argv[2]);
          const o={}; [...placeholdersIn(body)].forEach(p=>{ if(!stack.has(p)) o[p]="x"; });
          fs.writeFileSync(process.argv[3], JSON.stringify(o));' \
          "$REPO_ROOT/orchestrations/prompts/templates/$t.json" "$SCRIPTS/lib/engine-prompt.js" "$v" "$key"
        if ! render_engine_prompt "$t" "$v" $key >/dev/null 2>"$WORK/err"; then
            failed="$failed
  $t${key:+ ($key)}: $(head -c 200 "$WORK/err" | tr '\n' ' ')"
        fi
    done
    [ -z "$failed" ] || { echo "templates that cannot render:$failed"; false; }
}

@test "NOTHING pre-merges stack facts before a render any more" {
    # The renderer owns this. A second merge that adds keys the template does not declare turns
    # every such seam into "cannot render its prompt".
    run bash -c "grep -rn 'merge_stack_facts ' '$SCRIPTS' --include=*.sh | grep -v 'jq-vals.sh' || true"
    [ -z "$output" ] || {
        echo "call sites still pre-merge stack facts:"
        echo "$output"
        echo "engine-prompt.js already injects the stack facts a template DECLARES."
        false
    }
}

@test "and the renderer really does supply them — this is not just deletion" {
    # The guard against 'fixed it by removing the feature': a template that declares a stack
    # placeholder must still get a real value for it.
    . "$SCRIPTS/lib/render-engine-prompt.sh"
    v="$WORK/fz.json"
    "$NODE" -e '
      const fs=require("fs");
      const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
      const o={}; (d.placeholders||[]).forEach(p=>{ if(p!=="__TEST_COMMAND__") o[p]="x"; });
      fs.writeFileSync(process.argv[2], JSON.stringify(o));' \
      "$REPO_ROOT/orchestrations/prompts/templates/qa-fuzz-weaver.json" "$v"
    run render_engine_prompt qa-fuzz-weaver "$v"
    [ "$status" -eq 0 ] || { echo "$output"; false; }
    [[ "$output" != *"__TEST_COMMAND__"* ]] || {
        echo "the stack placeholder survived unrendered — the renderer supplied nothing"; false; }
    [ "${#output}" -gt 500 ]
}
