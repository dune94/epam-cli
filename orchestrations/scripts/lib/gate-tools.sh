# shellcheck shell=bash
# gate-tools — what tools a read-only gate agent may call.
#
# WHY THIS EXISTS. Four sites hardcoded the same literal:
#
#     ORCH_GATE_ALLOWED_TOOLS="${ORCH_GATE_ALLOWED_TOOLS:-bash,read_file,list_files,search}"
#
# and applyToolAllowlist() filters by tool NAME, dropping everything not listed. A project
# registers its plugins in EPAM_PROJECT_CONFIG_DIR/plugins.json, the orchestrator provisions
# them into each worktree's .epam/settings.json, createTools() loads them — and then the gate
# threw every one of them away. A live project granted five plugin tools — codeline facts,
# symbol and test-file resolution, and two dependency checks — and at these four seams the
# model was handed none of them. The project configured a capability and the generic pipeline
# overrode it with a literal, which is the same defect class as the agent roster.
#
# The base set stays in the engine: those are BUILT-IN tool names, not project facts, and the
# gate's read-only character is a policy decision (write_file is deliberately absent — that
# exclusion is what stops a reviewer rewriting the code it is judging).
#
# Project plugin tools are added from the project's own registration. Read-only by nature:
# they answer questions about the codeline. If a project ever ships a writing plugin, this is
# where it would need a declaration — not a reason to keep the literal.

_GATE_BASE_TOOLS="bash,read_file,list_files,search"

# gate_allowed_tools [repo_root]
#
# Emits a comma-separated allowlist: the built-in read-only set plus every tool exported by
# the plugins this project registered for that repo.
#
# Fails SAFE, never open: if settings.json is missing, unreadable, or a plugin cannot be
# loaded, the base set is emitted and the gate keeps exactly its previous capability. A
# plugin that cannot load must not take the gate down with it.
gate_allowed_tools() {
    local _repo="${1:-${PROJECT_ROOT:-$PWD}}"
    local _settings="${_repo}/.epam/settings.json"
    local _extra=""

    if [ -f "$_settings" ]; then
        _extra=$("${EPAM_NODE_BIN:-node}" -e '
            const fs = require("fs");
            let names = [];
            try {
                const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
                for (const entry of (settings.tools || [])) {
                    try {
                        const mod = require(entry);
                        for (const t of (mod.tools || [])) {
                            const n = t && (t.name || (t.definition && t.definition.name));
                            if (typeof n === "string" && n) names.push(n);
                        }
                    } catch (_) { /* one bad plugin must not blank the allowlist */ }
                }
            } catch (_) { names = []; }
            process.stdout.write([...new Set(names)].join(","));
        ' "$_settings" 2>/dev/null) || _extra=""
    fi

    if [ -n "$_extra" ]; then
        printf '%s,%s' "$_GATE_BASE_TOOLS" "$_extra"
    else
        printf '%s' "$_GATE_BASE_TOOLS"
    fi
}
