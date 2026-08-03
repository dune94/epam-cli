#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# lib/project-tools.sh — discover the plugin tools THIS codeline registered, and
# render them for an agent. Sourced identically by claude.sh (writer) and
# team-lead-review.sh (reviewer), for the same reason lib/story-guards.sh is:
# two copies of the same logic drift apart silently.
#
# Requires from the caller: nothing. NODE_BIN is honoured if set, else `node`.
# Every function is a silent no-op when the codeline registered no plugins — a
# project without plugins, or with a broken one, must never fail a real story.
#
# WHY THIS IS DISCOVERY AND NOT A LIST: naming a project's tools inline in an
# engine script would put one client's vocabulary into shared code, which is the
# standing no-hardcoding rule. These functions read whatever
# <codeline>/.epam/settings.json declares — written by run-agent-orchestration.sh
# from the project's own plugins.json — so adding, removing or renaming a tool is
# a config edit in the project directory and never a change to the engine.
#
# THE GAP THIS CLOSES (live, 2026-08-03): four plugin tools were provisioned,
# loadable and permitted, but no prompt named any of them, so across a full
# three-codeline run not one was ever called — including a tool that shipped with
# five passing unit tests. A model cannot call what it was never shown. Worse, the
# reviewer's EPAM_ALLOWED_TOOLS was a fixed literal that excluded every plugin
# tool, so even naming one would not have made it callable.
# ─────────────────────────────────────────────────────────────────────────────

# _project_tools_json <project_root>
# Emit one JSON object per registered tool: {"name":..., "description":...}
# Internal — callers use project_tool_names / build_project_tools_block.
_project_tools_json() {
    local project_root="${1:-${PROJECT_ROOT:-.}}"
    local settings_file="$project_root/.epam/settings.json"
    [ -f "$settings_file" ] || return 0
    "${NODE_BIN:-node}" -e '
      const fs = require("fs");
      try {
        const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const out = [];
        for (const p of (s.tools || [])) {
          try {
            const m = require(p);
            for (const t of (m.tools || [])) {
              if (t && t.name) {
                out.push(JSON.stringify({
                  name: String(t.name),
                  description: String(t.description || "").replace(/\s+/g, " ").trim(),
                }));
              }
            }
          } catch (e) { /* a broken project plugin must never break the story */ }
        }
        process.stdout.write(out.join("\n"));
      } catch (e) { /* unreadable settings = nothing registered, not a failure */ }
    ' "$settings_file" 2>/dev/null || return 0
}

# project_tool_names <project_root>
# Comma-separated tool names, shaped for EPAM_ALLOWED_TOOLS. Empty when none.
# An agent whose allow-list omits a tool cannot call it: applyToolAllowlist()
# (src/tools/createTools.ts) filters to exactly the listed set when it is
# non-empty, so any restricted agent must append these.
project_tool_names() {
    local json
    json=$(_project_tools_json "${1:-${PROJECT_ROOT:-.}}") || return 0
    [ -n "$json" ] || return 0
    printf '%s' "$json" | "${NODE_BIN:-node}" -e '
      let raw = "";
      process.stdin.on("data", d => { raw += d; });
      process.stdin.on("end", () => {
        const names = raw.split("\n").filter(Boolean).map(l => {
          try { return JSON.parse(l).name; } catch (e) { return null; }
        }).filter(Boolean);
        process.stdout.write(names.join(","));
      });
    ' 2>/dev/null || return 0
}

# build_project_tools_block <project_root>
# A prompt section naming each registered tool with its own description and an
# explicit directive to CALL it. Listing a tool without the directive is what left
# four tools dead — codegraph_query worked precisely because its prompt block says
# "call it directly (NOT via Bash)".
build_project_tools_block() {
    local json tools_list
    json=$(_project_tools_json "${1:-${PROJECT_ROOT:-.}}") || return 0
    [ -n "$json" ] || return 0
    tools_list=$(printf '%s' "$json" | "${NODE_BIN:-node}" -e '
      let raw = "";
      process.stdin.on("data", d => { raw += d; });
      process.stdin.on("end", () => {
        const lines = raw.split("\n").filter(Boolean).map(l => {
          try { const t = JSON.parse(l); return "- " + t.name + ": " + t.description; }
          catch (e) { return null; }
        }).filter(Boolean);
        process.stdout.write(lines.join("\n"));
      });
    ' 2>/dev/null) || return 0
    [ -n "$tools_list" ] || return 0
    printf '\n## Project Tools (registered by THIS codeline — call them directly, NOT via Bash)\nEach reports REAL state discovered from this repository or its installed dependencies. Call the relevant one instead of assuming — an assumption that contradicts one of these is a defect:\n%s\n' "$tools_list"
}
