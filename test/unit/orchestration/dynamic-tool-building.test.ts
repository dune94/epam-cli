/**
 * Dynamic tool-building — a new self-heal target (target=tool) alongside the
 * existing prd|tc|skill|kb|none targets.
 *
 * Design constraint from the user: tools must NOT be pre-shipped/hardcoded in
 * the CLI (no new src/tools/builtin/*.ts class, no createTools.ts change).
 * Instead, tool-building is part of the ORCHESTRATION self-heal loop:
 *
 *   1. The existing failure-analyst (no new agent) can emit target=tool with
 *      a tool_spec {name, purpose, recipe} when a failure is a repeated
 *      MECHANICAL step (e.g. "add a package before importing it") rather than
 *      a knowledge gap.
 *   2. The script is written to <PROJECT_ROOT>/.epam/dynamic-tools/<name>.sh,
 *      gated by the same prd-change-reviewer pattern as every other
 *      self-heal write (change type tool_creation), with no persist on reject.
 *   3. Subsequent story prompts (build_kb_prompt_section) list any existing
 *      dynamic tools so agents invoke them via the EXISTING bash tool — no
 *      new Tool class, no createTools.ts registration.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const PROFILES  = join(REPO_ROOT, 'orchestrations/agents/profiles.json');
const PROFILES_ORIG = join(REPO_ROOT, 'orchestrations/agents/profiles.json.original');
const CREATE_TOOLS = join(REPO_ROOT, 'src/tools/createTools.ts');

const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const profiles = JSON.parse(readFileSync(PROFILES, 'utf8'));
const profilesOrig = JSON.parse(readFileSync(PROFILES_ORIG, 'utf8'));
const createToolsSrc = readFileSync(CREATE_TOOLS, 'utf8');

// ── Design constraint: no static/hardcoded tool class ────────────────────────

describe('design constraint — dynamic tools are NOT hardcoded in the CLI core', () => {
  it('createTools.ts is unmodified — no AddDependency or dynamic-tool builtin registered', () => {
    expect(createToolsSrc).not.toMatch(/AddDependency/i);
    expect(createToolsSrc).not.toMatch(/DynamicTool/i);
  });

  it('no new builtin tool file exists for this feature', () => {
    const fs = require('fs');
    const builtinDir = join(REPO_ROOT, 'src/tools/builtin');
    const files = fs.readdirSync(builtinDir);
    expect(files).not.toContain('AddDependency.ts');
  });
});

// ── target=tool in the failure-analyst decision schema ───────────────────────

describe('claude.sh — failure-analyst decision schema includes target=tool', () => {
  it('output schema lists tool as a valid target alongside prd|tc|skill|kb|none', () => {
    expect(claudeSrc).toMatch(/"target":"prd\|tc\|skill\|kb\|tool\|none"/);
  });

  it('output schema includes tool_spec with name/purpose/recipe fields', () => {
    expect(claudeSrc).toMatch(/"tool_spec":\{"name"/);
    expect(claudeSrc).toMatch(/"purpose"/);
    expect(claudeSrc).toMatch(/"recipe"/);
  });

  it('decision rules explain when to use target=tool (mechanical vs knowledge gap)', () => {
    const idx = claudeSrc.indexOf('target=tool: the failure is a repeated MECHANICAL step');
    expect(idx).toBeGreaterThan(-1);
  });

  it('decision rules require the recipe to be idempotent', () => {
    expect(claudeSrc).toMatch(/tool_spec\.recipe must be idempotent/);
  });

  it('tool_spec is only included when target=tool (documented constraint)', () => {
    expect(claudeSrc).toMatch(/Only include tool_spec when target=tool/);
  });
});

// ── field extraction ──────────────────────────────────────────────────────────

describe('claude.sh — tool_spec field extraction', () => {
  it('extracts tool_name, tool_purpose, tool_recipe from the analyst JSON', () => {
    expect(claudeSrc).toMatch(/tool_name=\$\(echo "\$analyst_json" \| jq -r '\.tool_spec\.name/);
    expect(claudeSrc).toMatch(/tool_purpose=\$\(echo "\$analyst_json" \| jq -r '\.tool_spec\.purpose/);
    expect(claudeSrc).toMatch(/tool_recipe=\$\(echo "\$analyst_json" \| jq -r '\.tool_spec\.recipe/);
  });
});

// ── tool) case in the target switch ──────────────────────────────────────────

describe('claude.sh — tool) case in the failure-analyst target switch', () => {
  const caseIdx = claudeSrc.indexOf('                tool)');
  const caseEnd = claudeSrc.indexOf('                none)', caseIdx);
  const block = claudeSrc.slice(caseIdx, caseEnd);

  it('tool) case exists and appears before none) in the switch', () => {
    expect(caseIdx).toBeGreaterThan(-1);
    expect(caseEnd).toBeGreaterThan(caseIdx);
  });

  it('writes the script to <PROJECT_ROOT>/.epam/dynamic-tools/<name>.sh', () => {
    expect(block).toMatch(/PROJECT_ROOT\/\.epam\/dynamic-tools/);
    expect(block).toMatch(/tool_path="\$\{tools_dir\}\/\$\{tool_name\}\.sh"/);
  });

  it('creates the dynamic-tools directory if missing', () => {
    expect(block).toMatch(/mkdir -p "\$tools_dir"/);
  });

  it('snapshots the existing script (if any) before overwriting, for revert', () => {
    expect(block).toMatch(/_tool_before=/);
  });

  it('builds the candidate script with a shebang, purpose comment, and set -e', () => {
    expect(block).toMatch(/#!\/usr\/bin\/env bash/);
    expect(block).toMatch(/set -e/);
  });

  it('gates the write through run_change_with_reviewer_retry with change type tool_creation (3 summarize-and-resubmit rounds, same mechanism as kb_entry/skill_note)', () => {
    expect(block).toMatch(/run_change_with_reviewer_retry "\$story_id" "tool_creation"/);
  });

  it('does NOT write the script when the reviewer verdict is fail after all retry rounds', () => {
    const failIdx = block.indexOf('_tool_review_verdict" = "fail"');
    expect(failIdx).toBeGreaterThan(-1);
    const failBlock = block.slice(failIdx, failIdx + 200);
    expect(failBlock).toMatch(/rejected by reviewer after 3 attempts — NOT written/);
    expect(failBlock).not.toMatch(/> "\$tool_path"/);
  });

  it('writes and chmod +x the (possibly reformatted) script only on approval (else branch)', () => {
    expect(block).toMatch(/printf '%s' "\$REVIEWER_RETRY_TEXT" > "\$tool_path"/);
    expect(block).toMatch(/chmod \+x "\$tool_path"/);
  });

  it('falls back to diagnosis-only when tool_spec is incomplete (missing name or recipe)', () => {
    expect(block).toMatch(/target=tool but tool_spec incomplete/);
  });
});

// ── prompt injection of available dynamic tools ──────────────────────────────

describe('claude.sh — build_kb_prompt_section surfaces existing dynamic tools', () => {
  const fnIdx = claudeSrc.indexOf('build_kb_prompt_section()');
  const fnEnd = claudeSrc.indexOf('\n}', fnIdx);
  const body = claudeSrc.slice(fnIdx, fnEnd);

  it('checks for .epam/dynamic-tools directory with at least one script', () => {
    expect(body).toMatch(/tools_dir="\$PROJECT_ROOT\/\.epam\/dynamic-tools"/);
    expect(body).toMatch(/find "\$tools_dir" -maxdepth 1 -name '\*\.sh'/);
  });

  it('emits an "Available Dynamic Tools" section when tools exist', () => {
    expect(body).toMatch(/## Available Dynamic Tools/);
  });

  it('instructs the agent to invoke tools via bash rather than repeating steps by hand', () => {
    expect(body).toMatch(/Use them via the bash tool instead of repeating/i);
  });

  it('extracts the purpose comment from line 2 of each script for the listing', () => {
    expect(body).toMatch(/sed -n '2p' "\$_tool_file"/);
  });
});

// ── prd-change-reviewer: tool_creation change type ───────────────────────────

describe('prd-change-reviewer — tool_creation change type coverage', () => {
  const reviewer: string = profiles['prd-change-reviewer'];

  it('documents tool_creation as a recognized change type', () => {
    expect(reviewer).toMatch(/tool_creation/);
  });

  it('rejects non-idempotent recipes', () => {
    expect(reviewer).toMatch(/not idempotent/i);
  });

  it('rejects recipes that do more than the stated purpose', () => {
    expect(reviewer).toMatch(/does anything beyond the stated purpose/i);
  });

  it('rejects recipes that delete files, force-push, or touch outside the project', () => {
    expect(reviewer).toMatch(/deletes files, force-pushes git/i);
  });

  it('rejects tool_creation used for knowledge/judgment problems (should be KB/skill instead)', () => {
    expect(reviewer).toMatch(/knowledge\/judgment problem/i);
  });

  it('rejects scripts missing a shebang or `set -e`', () => {
    expect(reviewer).toMatch(/no shebang or does not set/i);
  });

  it('is present identically in profiles.json.original', () => {
    expect(profilesOrig['prd-change-reviewer']).toBe(reviewer);
  });
});

// ── failure-analyst: aware of the tool-preference rule ───────────────────────

describe('failure-analyst — prefers target=tool for mechanical (not knowledge) failures', () => {
  const analyst: string = profiles['failure-analyst'];

  it('mentions preferring target=tool over target=kb for mechanical steps', () => {
    expect(analyst).toMatch(/MECHANICAL step/);
    expect(analyst).toMatch(/target=tool over target=kb/);
  });

  it('is present identically in profiles.json.original', () => {
    expect(profilesOrig['failure-analyst']).toBe(analyst);
  });
});
