'use strict';

/**
 * agent-tools — what a read-only agent is allowed to use, derived rather than listed.
 *
 * WHY THIS EXISTS. specAgentEnv granted a literal 'read_file,list_files,search' to every
 * spec-mode agent: openspec, speckit, the reviewers. codegraph_query was not in it. So the
 * agents doing brownfield archaeology — trace the call chain, find where this is wired — had
 * only text search, and no access to the tool that answers structural questions. Until
 * 2026-08-09 that text search returned "(no matches found)" for everything (rg was a shell
 * function with no binary on PATH, and the grep fallback was unreachable), so those agents
 * were reading an apparently empty repository with no alternative instrument available.
 *
 * The plugin half is DERIVED. Every codeline already declares its plugins in
 * .epam/settings.json, and every tool declares its own `permission`. A codeline provisioned
 * with the codegraph plugin therefore grants codegraph_query automatically — no per-tool
 * wiring, and no tool name written into the engine. This is the derivation mintTools already
 * used for the mint; it now has one implementation instead of two.
 *
 * The builtin floor comes from config, not from source. "Every builtin whose permission is
 * safe" would also grant fetch_url, quietly giving every spec agent network access — a
 * different decision, and not one to make as a side effect.
 *
 * PERMISSION IS HONOURED. Only tools that declare themselves `safe` are granted; a tool that
 * declares nothing is refused, because silence is not consent and a plugin is not trusted to
 * omit the field harmlessly. This is a grant for agents whose job is to read.
 */

const fs = require('fs');
const path = require('path');

const SAFE = 'safe';

/** The configured builtin floor. A missing or empty list is an error, never an empty grant. */
function builtinFloor() {
  const file = process.env.EPAM_SPEC_MODE_DEFAULTS_FILE
    || path.join(__dirname, '..', '..', 'config', 'spec-mode-defaults.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`[agent-tools] cannot read the read-only tool floor from ${file}: ${e.message}`);
  }
  const list = cfg && cfg.tools && cfg.tools.readOnlyBuiltins;
  if (!Array.isArray(list) || !list.length || !list.every((t) => typeof t === 'string' && t.trim())) {
    // An empty grant is not a safe default: ai-run.sh forces --no-tools without a grant, and an
    // agent that believes it can look but cannot fabricates <tool_call> text describing files
    // it never read. That is the incident this floor exists to prevent.
    throw new Error(`[agent-tools] ${file} — tools.readOnlyBuiltins must be a non-empty list of tool names`);
  }
  return list.map((t) => t.trim());
}

/** Safe tool names declared by the plugins one codeline provisions. */
function pluginToolsFor(codelinePath) {
  const names = [];
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(path.join(codelinePath, '.epam', 'settings.json'), 'utf8'));
  } catch {
    return names;                                   // this codeline provisions no plugins
  }
  for (const entry of (Array.isArray(settings.tools) ? settings.tools : [])) {
    let mod;
    try {
      mod = require(entry);
    } catch {
      continue;                                     // one unloadable plugin must not blank the grant
    }
    for (const t of ((mod && mod.tools) || [])) {
      if (!t || t.permission !== SAFE) continue;    // dangerous/review/unstated are never granted
      const n = t.name || (t.definition && t.definition.name);
      if (typeof n === 'string' && n.trim()) names.push(n.trim());
    }
  }
  return names;
}

/**
 * readOnlyToolGrant(paths) -> "tool,tool,tool"
 *
 * The configured builtin floor, plus every SAFE tool the given codelines provision.
 */
function readOnlyToolGrant(codelinePaths) {
  const paths = (Array.isArray(codelinePaths) ? codelinePaths : [codelinePaths])
    .filter((p) => typeof p === 'string' && p.trim());
  const names = [...builtinFloor()];
  for (const p of paths) names.push(...pluginToolsFor(p));
  return [...new Set(names)].join(',');
}

/**
 * THE TOOL LIST FOR A DECLARED GRANT KIND, RESOLVED PER PROJECT.
 *
 * A seam declares WHAT KIND of access its work needs — none, read-only, read-network, execute,
 * write. The list is resolved here, at invocation, because part of it belongs to the project:
 * mock3 grants codegraph_query because its codelines provision that plugin, and a project without
 * it must not be handed a tool that does not exist.
 *
 * This replaces two worse arrangements that ran side by side. Nine seams carried a literal
 * "bash,read_file,list_files,search" in the registry — one project's answer frozen into the
 * engine. The other twenty-six carried nothing, while their CALL SITES resolved a grant
 * dynamically anyway (ORCH_GATE_ALLOWED_TOOLS, SPEC_MODE_ALLOWED_TOOLS, TICKET_LINK_ALLOWED_TOOLS,
 * readOnlyToolGrant). So the registry both hardcoded and under-declared the same fact.
 *
 * An UNKNOWN kind throws. A seam that asks for a grant this engine does not define has been
 * mis-declared, and silently handing it the read-only floor would give it less than its work needs
 * without saying so.
 */
function toolGrantFor(kind, codelinePaths) {
  if (!kind) return '';
  const file = process.env.EPAM_SPEC_MODE_DEFAULTS_FILE
    || path.join(__dirname, '..', '..', 'config', 'spec-mode-defaults.json');
  let grants;
  try {
    grants = (JSON.parse(fs.readFileSync(file, 'utf8')).tools || {}).grants;
  } catch (e) {
    throw new Error(`[agent-tools] cannot read tool grants from ${file}: ${e.message}`);
  }
  if (!grants || !grants[kind]) {
    throw new Error(
      `[agent-tools] unknown tool grant '${kind}' — ${file} declares: ${Object.keys(grants || {}).join(', ')}`);
  }
  if (kind === 'none') return '';

  const base = readOnlyToolGrant(codelinePaths).split(',').filter(Boolean);
  const adds = Array.isArray(grants[kind].adds) ? grants[kind].adds : [];
  return [...new Set([...base, ...adds])].join(',');
}

module.exports = { readOnlyToolGrant, builtinFloor, pluginToolsFor, toolGrantFor };
