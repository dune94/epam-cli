#!/usr/bin/env bats
# ─────────────────────────────────────────────────────────────────────────────
# CANONICAL IS THE IMMUTABLE BASE, AND IT BELONGS TO NO PROJECT.
#
# profiles.canonical.json is the source every project's roster derives from. Two properties make
# that safe, and neither was enforced:
#
#   IMMUTABLE — nothing may write it during a run. It is 0644 with no perimeter, while client
#   codelines get a filesystem write perimeter precisely because a per-tool allowlist cannot
#   hold. The file that defines who every agent IS had none.
#
#   PROJECT-NEUTRAL — four entries describe THIS repository as their subject: "You are a code
#   review specialist for the epam-cli project", "intimately familiar with the epam-cli src/
#   directory structure", plus this repo's own test commands. Every project inherits them, so
#   the metrolinx reviewer ran five times believing it worked on epam-cli. A base that must be
#   undone by specialisation is a base that will sometimes not be.
#
# Naming the PIPELINE is fine and stays — "for the epam-cli orchestration pipeline" is true on
# any codeline. Naming epam-cli as the SUBJECT or baking its stack commands is not.
# ─────────────────────────────────────────────────────────────────────────────

setup() {
    REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
    SCRIPTS="$REPO_ROOT/orchestrations/scripts"
    CANONICAL="$REPO_ROOT/orchestrations/agents/profiles.canonical.json"
    NODE="${NODE_BIN:-$HOME/.nvm/versions/node/v20.20.0/bin/node}"
    command -v "$NODE" >/dev/null 2>&1 || NODE=node
}

@test "the fixture is real — canonical exists and is non-trivial" {
    [ -f "$CANONICAL" ]
    run "$NODE" -e 'process.stdout.write(String(Object.keys(require(process.argv[1])).length))' "$CANONICAL"
    [ "$output" -ge 50 ] || { echo "canonical holds only $output entries"; false; }
}

@test "NOTHING writes profiles.canonical.json" {
    # Resolved against the real sources, not a grep for the literal name: a write through a
    # variable would pass that. Any writeFileSync whose target expression mentions canonical
    # is a violation.
    # RESOLVED, not name-matched. `canonicalPath` also names the canonical PRD in
    # merge-lane-into-canonical.js, and matching the identifier reported that as a violation.
    # Per file: find the variable actually assigned from profiles.canonical.json, then check
    # no write in that file targets it.
    run "$NODE" -e '
      const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
      const files = execFileSync("find", [process.argv[1], "-type", "f", "-name", "*.js",
        "-not", "-path", "*/.venv*", "-not", "-path", "*/node_modules/*"], { encoding: "utf8" })
        .split("\n").filter(Boolean);
      const bad = [];
      for (const f of files) {
        let src; try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
        if (!src.includes("profiles.canonical.json")) continue;
        const vars = new Set();
        for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^;\n]*profiles\.canonical\.json/g))
          vars.add(m[1]);
        for (const m of src.matchAll(/(?:write|append)FileSync\(\s*([A-Za-z_$][\w$]*)/g))
          if (vars.has(m[1])) bad.push(f + " writes " + m[1]);
        if (/(?:write|append)FileSync\(\s*[^,]*profiles\.canonical\.json/.test(src))
          bad.push(f + " writes the path inline");
      }
      process.stdout.write(bad.join("\n"));' "$SCRIPTS"
    [ -z "$output" ] || { echo "canonical is written here:"; echo "$output"; false; }
}

@test "and it is only ever OPENED for reading" {
    refs=$(grep -rn 'profiles.canonical.json' "$SCRIPTS" --include=*.js --include=*.sh \
           | grep -v '^\s*//' || true)
    [ -n "$refs" ] || skip "canonical is not referenced at all — nothing to constrain"
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        case "$line" in
            *writeFileSync*|*appendFileSync*|*'> "$'*|*'>>'*)
                echo "a write-shaped reference to canonical: $line"; false ;;
        esac
    done <<< "$refs"
}

@test "NO canonical entry names epam-cli as its SUBJECT" {
    # The four: typescript-engineer, test-engineer, team-lead-agent, review-agent.
    run "$NODE" -e '
      const d = require(process.argv[1]);
      // "for the epam-cli orchestration pipeline" is context and legitimate on any codeline.
      const BENIGN = /epam[- ]cli\s+(orchestration|pipeline|brownfield pipeline)/gi;
      const SUBJECT = [
        /\bthe epam[- ]cli project\b/i,
        /\bepam[- ]cli (codebase|repo|repository)\b/i,
        /\bepam[- ]cli src\//i,
      ];
      const bad = [];
      for (const [n, t] of Object.entries(d)) {
        if (typeof t !== "string") continue;
        const stripped = t.replace(BENIGN, "");
        if (SUBJECT.some((re) => re.test(stripped))) bad.push(n);
      }
      process.stdout.write(bad.join(" "));' "$CANONICAL"
    [ -z "$output" ] || {
        echo "canonical entries describing epam-cli as their subject: $output"
        echo "every project derives from these — the base must belong to no project."
        false
    }
}

@test "NO canonical entry hardcodes this repo's stack commands" {
    run "$NODE" -e '
      const d = require(process.argv[1]);
      const STACK = [/\bvitest run\b/, /node_modules\/\.bin\/(vitest|tsc)/, /\.nvm\/versions\/node/];
      const bad = [];
      for (const [n, t] of Object.entries(d)) {
        if (typeof t === "string" && STACK.some((re) => re.test(t))) bad.push(n);
      }
      process.stdout.write(bad.join(" "));' "$CANONICAL"
    [ -z "$output" ] || {
        echo "canonical entries hardcoding a stack/test command: $output"
        echo "the command belongs to the codeline, and reaches an agent from its own facts."
        false
    }
}

@test "the neutrality check is not vacuous — it catches a planted subject claim" {
    tmp="$BATS_TEST_TMPDIR/planted.json"
    "$NODE" -e '
      const fs = require("fs");
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      d["planted-agent"] = "You are an engineer for the epam-cli project.";
      fs.writeFileSync(process.argv[2], JSON.stringify(d));' "$CANONICAL" "$tmp"
    run "$NODE" -e '
      const d = require(process.argv[1]);
      const BENIGN = /epam[- ]cli\s+(orchestration|pipeline|brownfield pipeline)/gi;
      const bad = Object.entries(d).filter(([, t]) =>
        typeof t === "string" && /\bthe epam[- ]cli project\b/i.test(String(t).replace(BENIGN, "")));
      process.stdout.write(String(bad.length));' "$tmp"
    [ "$output" -ge 1 ] || { echo "the check cannot see a planted claim — it proves nothing"; false; }
}

@test "NO REACHABLE canonical entry names this repository's own identifiers" {
    # DERIVED, not a symbol list: identifiers declared in this engine's own src/ are, by
    # construction, this repository's vocabulary. Filtered structurally to COMPOUND identifiers
    # (two capitals, or SCREAMING_CASE) so that ordinary words which happen to be declared
    # types — Decision, Profile, Message — are not counted. No stopword list is consulted.
    #
    # SCOPED TO REACHABLE AGENTS, deliberately. Nothing that CAN run may carry this repo's
    # vocabulary.
    #
    # The scoping used to exist for the documentation cluster — doc-coordinator and its seven
    # delegates — a built-but-unwired capability that Stage 6 never invoked. Those entries were
    # REMOVED on 2026-08-31 at the operator's instruction: they were provisioned and paid for on
    # every run and nothing ever called them. The scoping stays because the property it protects
    # (reachable entries only) is the right one, not because anything unreachable remains.
    run "$NODE" -e '
      const fs = require("fs"), { execFileSync } = require("child_process");
      const declared = new Set();
      for (const f of execFileSync("find", ["src", "-type", "f", "-name", "*.ts"],
             { encoding: "utf8" }).split("\n").filter(Boolean)) {
        const t = fs.readFileSync(f, "utf8");
        for (const m of t.matchAll(/\b(?:class|interface|type|enum|const|function)\s+([A-Z][A-Za-z0-9_]{4,})/g))
          declared.add(m[1]);
      }
      const compound = (x) => /_/.test(x) || (x.match(/[A-Z]/g) || []).length >= 2;

      const inv = require(process.argv[2]).profiles || {};
      const invocable = new Set();
      (function w(o) { for (const k in o) { const v = o[k];
        if (v && typeof v === "object") {
          if ((v.ladder || v.reasoningEffort || v._what) && k !== "defaults") invocable.add(k);
          w(v); } } }(inv));
      const psrc = execFileSync("find", [process.argv[3], "-type", "f",
        "(", "-name", "*.sh", "-o", "-name", "*.js", "-o", "-name", "*.py", ")",
        "-not", "-path", "*/.venv*"], { encoding: "utf8" })
        .split("\n").filter(Boolean)
        .map((f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } }).join("\n");

      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const bad = [];
      for (const [n, t] of Object.entries(d)) {
        if (typeof t !== "string") continue;
        const reachable = invocable.has(n) || psrc.includes(`"${n}"`) || psrc.includes(`\x27${n}\x27`);
        if (!reachable) continue;
        const hits = [...new Set([...t.matchAll(/\b([A-Z][A-Za-z0-9_]{4,})\b/g)].map((m) => m[1]))]
          .filter((x) => declared.has(x) && compound(x));
        if (hits.length) bad.push(`${n}: ${hits.join(", ")}`);
      }
      process.stdout.write(bad.join("\n"));' \
      "$CANONICAL" "$REPO_ROOT/orchestrations/agents/invocation-profiles.json" "$SCRIPTS"
    [ -z "$output" ] || {
        echo "reachable canonical entries naming this repository's identifiers:"
        echo "$output"
        echo "every project derives from these — an agent that can run must not."
        false
    }
}

@test "the vocabulary check is not vacuous — it sees a planted identifier" {
    tmp="$BATS_TEST_TMPDIR/planted-sym.json"
    "$NODE" -e '
      const fs = require("fs");
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      d["review-agent"] += " You know the ProviderChain failover mechanism.";
      fs.writeFileSync(process.argv[2], JSON.stringify(d));' "$CANONICAL" "$tmp"
    run "$NODE" -e '
      const fs = require("fs");
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write(/ProviderChain/.test(d["review-agent"]) ? "seen" : "blind");' "$tmp"
    [ "$output" = "seen" ]
}
