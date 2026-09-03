#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# A RUN DOES NOT WRITE THE ENGINE LAYER.
#
# The mint wrote orchestrations/agents/profiles.json, orchestrations/agents/invocation-profiles.json
# and orchestrations/agents/kb/KB-<codeline>.md on every run — because there was nowhere else to
# put a project's agents. That is why every project shared one roster, and why a client codeline's
# accumulated knowledge sat in the engine's folder where the next project would read it.
#
# There is somewhere else now. The roster is the project's, and so is its knowledge base.
#
# Templates already work this way and the pipeline understands the rule: the immutable layer is
# read during a run and written only by a deliberate change to the repository.
# ─────────────────────────────────────────────────────────────────────────────

# `env` does not execute its command in every environment this suite runs in — on 2026-08-28
# `env FOO=1 echo hello` produced no output and exited 0, so these assertions ran against
# nothing and failed for a reason that had nothing to do with the pipeline.
load "../helpers/env-run"

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
}

# Every write target in a JS file, resolved to the variable it writes and where that variable
# came from — a name-match would report the canonical PRD as the canonical roster, which it did.
# The scanner is written to a FILE, not passed with `node -e`. Inline JS inside a single-quoted
# shell string is terminated by any apostrophe in it — including one in a comment explaining that
# apostrophes terminate it, which is how this file came to parse as zero tests.
write_scanner() {
    cat > "$BATS_TEST_TMPDIR/scan.js" <<'JS'
const fs = require('fs');
const { execFileSync } = require('child_process');

// TWO CONDITIONS, not one regex: an assignment must mention an agents dir AND an engine filename.
// Requiring them adjacent missed path.join(agentsDir, "profiles.json"), which is the shape the code
// actually uses — and a scan that cannot see the real shape reports clean.
const ENGINE = (expr) => /\bagents\w*\b/.test(expr)
  && /(profiles\.json|invocation-profiles\.json)/.test(expr);

// argv[2] is the root. The first version passed `--` before it, so find scanned the
// current directory and reported a bundled dist/ file as an engine write.
const files = execFileSync('find', [process.argv[2], '-type', 'f', '-name', '*.js',
  '-not', '-path', '*/.venv*', '-not', '-path', '*/node_modules/*'], { encoding: 'utf8' })
  .split('\n').filter(Boolean);

// CROSS-FILE. A path assigned in one file and WRITTEN in another is the shape actually used:
// mint-agents-step.js resolves PROFILES_PATH = path.join(AGENTS_DIR, "profiles.json") and hands it
// to agent-roster.js, which does the writing. Tracking only same-file assignments reported that as
// clean, which is a green that means nothing.
//
// So: any identifier bound to an engine path ANYWHERE becomes suspect everywhere. That over-reports
// on a shared name, and over-reporting a write to the engine roster is the safe direction.
const enginePathNames = new Set();
for (const f of files) {
  let src;
  try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([^;]*)/g))
    if (ENGINE(m[2])) enginePathNames.add(m[1]);
  // a parameter named for one, called with one
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g))
    if (enginePathNames.has(m[2])) enginePathNames.add(m[1]);
}

const bad = [];
for (const f of files) {
  let src;
  try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const lines = src.split('\n');
  const vars = new Map();
  lines.forEach((l, i) => {
    const m = l.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=([^;]*)/);
    if (m && ENGINE(m[2])) vars.set(m[1], i + 1);
  });
  lines.forEach((l, i) => {
    if (/^\s*(\/\/|\*)/.test(l)) return;
    const w = l.match(/(?:write|append)FileSync\(\s*([A-Za-z_$][\w$]*)/);
    if (w && (vars.has(w[1]) || enginePathNames.has(w[1])))
      bad.push(f + ':' + (i + 1) + ' writes ' + w[1]);
    if (/(?:write|append)FileSync\(\s*[^,]*agents[^,]*(profiles\.json|invocation-profiles\.json)/.test(l))
      bad.push(f + ':' + (i + 1) + ' writes an engine path inline');
  });
}
process.stdout.write(bad.join('\n'));
JS
}

engine_writes() {
    write_scanner
    "$NODE" "$BATS_TEST_TMPDIR/scan.js" "$SCRIPTS"
}

@test "the scan is real — it finds writes when there are any" {
    # The SAME scanner, over a planted file. A calibration that reimplements the check proves the
    # reimplementation works.
    write_scanner
    mkdir -p "$BATS_TEST_TMPDIR/planted"
    cat > "$BATS_TEST_TMPDIR/planted/x.js" <<'JS'
const profilesPath = path.join(agentsDir, 'profiles.json');
fs.writeFileSync(profilesPath, JSON.stringify(profiles));
JS
    run "$NODE" "$BATS_TEST_TMPDIR/scan.js" "$BATS_TEST_TMPDIR/planted"
    [[ "$output" == *"writes profilesPath"* ]] || {
        echo "the scan cannot see a planted engine write — every green below is vacuous"
        echo "got: $output"
        false
    }
}

@test "NOTHING writes the engine roster or the seam registry during a run" {
    run engine_writes
    [ -z "$output" ] || {
        echo "engine-layer writes remain:"
        echo "$output"
        echo "A project's agents belong to the project. That is what the roster is for."
        false
    }
}

@test "the codeline KB RESOLVES under the project, not the engine folder" {
    # BEHAVIOURAL, not a grep. The first version scanned for the string "agents/kb" and reported
    # kb-canonical.sh — which manages the ENGINE's canonical seed and is the one caller for which
    # that path is right. What matters is where a RUN's knowledge lands, so this executes the
    # resolver instead of reading it.
    # -u before the assignments: env rejects it after one, and the failure surfaced as the
    # resolver returning an error string rather than a path.
    run env_run -u KB_ROOT EPAM_PROJECT_CONFIG_DIR="$BATS_TEST_TMPDIR/proj" "$NODE" -e '
      const path = require("path");
      const store = require(process.argv[1]);
      process.stdout.write(store.rootPath ? store.rootPath() : "");
    ' "$SCRIPTS/lib/kb-store.js"
    [[ "$output" == *"$BATS_TEST_TMPDIR/proj/kb"* ]] || {
        echo "a run's KB resolves outside the project: $output"; false; }
    [[ "$output" != *"orchestrations/agents/kb"* ]] || {
        echo "a run's KB still lands in the engine folder: $output"; false; }
}

@test "KB_ROOT still overrides — it is the deliberate escape hatch" {
    run env_run EPAM_PROJECT_CONFIG_DIR="$BATS_TEST_TMPDIR/proj" KB_ROOT="$BATS_TEST_TMPDIR/explicit" \
        "$NODE" -e '
      const store = require(process.argv[1]);
      store.configure({ root: process.env.KB_ROOT });
      process.stdout.write(store.rootPath ? store.rootPath() : "");
    ' "$SCRIPTS/lib/kb-store.js"
    [[ "$output" == *"explicit"* ]] || { echo "the override was ignored: $output"; false; }
}

@test "with NO project declared the engine path remains — engine-side tooling has no project" {
    run env_run -u EPAM_PROJECT_CONFIG_DIR -u KB_ROOT "$NODE" -e '
      const store = require(process.argv[1]);
      process.stdout.write(store.rootPath ? store.rootPath() : "");
    ' "$SCRIPTS/lib/kb-store.js"
    [[ "$output" == *"orchestrations/agents/kb"* ]] || {
        echo "engine-side tooling lost its KB: $output"; false; }
}
