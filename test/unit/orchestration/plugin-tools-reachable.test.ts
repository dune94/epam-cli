/**
 * DRIFT GUARD — a plugin tool that exists, is provisioned into .epam/settings.json,
 * and has green unit tests is still DEAD CODE if no agent prompt ever names it, or
 * if that agent's own tool allow-list filters it out before the model sees it.
 *
 * Both failure modes shipped green live (2026-08-03):
 *   1. check_anti_patterns was added with 5 passing unit tests proving the
 *      function returns correct JSON — and was never named in any prompt, so no agent
 *      ever called it. The unit tests could not fail for the reason that mattered.
 *   2. team-lead-review.sh sets EPAM_ALLOWED_TOOLS="bash,read_file,list_files,search".
 *      applyToolAllowlist() (src/tools/createTools.ts) FILTERS to exactly that set when
 *      it is non-empty, so the reviewer structurally cannot invoke a plugin tool even
 *      if the prompt named one.
 *
 * codegraph_query is the proven-good template: claude.sh names it in real prompt text
 * ("A codegraph_query tool is available — call it directly (NOT via Bash)") and the
 * writer's invocation sets no allow-list, so it is genuinely reachable.
 *
 * This test enumerates the REAL tools exported by orchestrations/plugins/*.js — it is
 * not a hand-maintained list, so a newly added tool is covered automatically.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const PLUGIN_DIR = join(REPO_ROOT, 'orchestrations/plugins');

/**
 * Agent-prompt-building scripts: the places a tool must be NAMED to ever be called.
 *
 * `restrictsEveryInvocation` records whether EVERY agent invocation in that script sets a
 * non-empty EPAM_ALLOWED_TOOLS. It is deliberately reviewed data, not inference — a bash
 * script's invocation sites cannot be attributed to their env prefixes by static text
 * matching, and guessing produced a FALSE POSITIVE on the first run of this test (it
 * flagged codegraph_query as unreachable when it demonstrably works today). The
 * `restrictsEveryInvocation` self-check test below fails if either value goes stale.
 */
const PROMPT_SCRIPTS: Array<{ path: string; restrictsEveryInvocation: boolean }> = [
  {
    // The writer's execute pass sets no allow-list, so plugin tools are available to it —
    // this is why codegraph_query works. The three restrictive literals here are GATE
    // invocations (small read-only agents), not the writer.
    path: 'orchestrations/scripts/claude.sh',
    restrictsEveryInvocation: false,
  },
  {
    // Exactly one agent invocation, and it hard-codes a non-empty allow-list that omits
    // every plugin tool — so naming a plugin in the reviewer prompt achieves nothing
    // until that literal is extended.
    path: 'orchestrations/scripts/team-lead-review.sh',
    restrictsEveryInvocation: true,
  },
];
const SCRIPT_PATHS = PROMPT_SCRIPTS.map(s => s.path);

/** Every tool actually exported by the real plugin modules. */
function realPluginTools(): string[] {
  const names: string[] = [];
  for (const file of readdirSync(PLUGIN_DIR).filter(f => f.endsWith('.js'))) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(join(PLUGIN_DIR, file)) as { tools?: Array<{ name: string }> };
    for (const t of mod.tools ?? []) names.push(t.name);
  }
  return names;
}

/** Script source with comment-only lines removed — a name surviving here is real prompt
 *  text or real code, not a note ABOUT the tool. This distinction is the whole point:
 *  codeline_facts is mentioned twice in claude.sh, both times in comments
 *  explaining that the agent ignored it. */
function nonCommentSource(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8')
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n');
}

/** Literal EPAM_ALLOWED_TOOLS="..." values assigned anywhere in a script. */
function allowlistLiterals(relPath: string): string[] {
  const src = readFileSync(join(REPO_ROOT, relPath), 'utf8');
  const out: string[] = [];
  const re = /EPAM_ALLOWED_TOOLS=(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1] ?? m[2] ?? '');
  return out;
}

/** Mirrors applyToolAllowlist() in src/tools/createTools.ts. */
function allowlistAdmits(literal: string, tool: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[_\s-]/g, '');
  const expanded = literal.replace(/\$\{[^}]*:-([^}]*)\}/g, '$1'); // ${VAR:-default} -> default
  if (!expanded.trim()) return true; // empty/unset allow-list = every tool passes
  const allowed = new Set(expanded.split(/[,:]/).map(s => s.trim()).filter(Boolean).map(normalize));
  if (allowed.size === 0) return true;
  return allowed.has(normalize(tool));
}

/** Absolute paths of the real plugin modules, as a project's plugins.json would list them. */
function realPluginModulePaths(): string[] {
  return readdirSync(PLUGIN_DIR)
    .filter(f => f.endsWith('.js'))
    .map(f => join(PLUGIN_DIR, f));
}

/** Run the REAL _build_project_tools_block from claude.sh over a settings.json listing
 *  the given plugin modules, and return what the agent would actually be shown. */
function renderProjectToolsBlock(modulePaths: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'reachable-'));
  cleanupDirs.push(root);
  mkdirSync(join(root, '.epam'), { recursive: true });
  writeFileSync(join(root, '.epam/settings.json'), JSON.stringify({ tools: modulePaths }));
  const scriptPath = join(root, 'probe.sh');
  writeFileSync(
    scriptPath,
    [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      `NODE_BIN=${JSON.stringify(process.execPath)}`,
      'log() { :; }',
      'warning() { :; }',
      `source ${JSON.stringify(join(REPO_ROOT, 'orchestrations/scripts/lib/project-tools.sh'))}`,
      `build_project_tools_block ${JSON.stringify(root)}`,
    ].join('\n'),
  );
  const r = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 20000 });
  return (r.stdout || '') + (r.stderr || '');
}

/** Extract a bash function body from claude.sh by name. */
function claudeSrcFunction(name: string): string {
  const src = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
  const m = new RegExp(`^${name}\\(\\)\\s*\\{`, 'm').exec(src);
  if (!m) throw new Error(`No function definition found for ${name}()`);
  return src.slice(m.index, src.indexOf('\n}', m.index) + 2);
}

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TOOLS = realPluginTools();

describe('plugin tools are reachable — enumerated from the real plugin modules', () => {
  it('finds the real exported tools (guards against the enumeration itself silently breaking)', () => {
    expect(TOOLS.length).toBeGreaterThan(0);
    expect(TOOLS).toContain('codegraph_query');
  });

  it('the reviewed restrictsEveryInvocation data still matches the real scripts', () => {
    // team-lead-review.sh must still be single-invocation + non-empty allow-list, or the
    // flag above is stale and the reachability test below would silently pass.
    const reviewLiterals = allowlistLiterals('orchestrations/scripts/team-lead-review.sh');
    expect(reviewLiterals).toHaveLength(1);
    expect(reviewLiterals[0].trim()).not.toBe('');
    // claude.sh must still have at least one restrictive literal (its gates) — if that
    // changes, the writer/gate split this data encodes needs re-checking.
    expect(allowlistLiterals('orchestrations/scripts/claude.sh').length).toBeGreaterThan(0);
  });

  it.each(TOOLS)('%s is advertised to the agent by runtime discovery', (tool) => {
    // NOT a source grep for the tool name: the engine must never contain a client's tool
    // vocabulary. _build_project_tools_block discovers whatever the codeline registered,
    // so the real check is that running it over the REAL plugin modules advertises this
    // tool. codegraph_query is additionally named inline in claude.sh (its own prompt
    // block), which is fine — it ships with the engine rather than with a project.
    const advertised =
      renderProjectToolsBlock(realPluginModulePaths()).includes(tool) ||
      SCRIPT_PATHS.some(s => nonCommentSource(s).includes(tool));
    expect(
      advertised,
      `${tool} is exported by a plugin but nothing advertises it to any agent — no agent ` +
        `can call what it was never shown. It must be discovered by ` +
        `_build_project_tools_block (via .epam/settings.json) or named in a prompt.`,
    ).toBe(true);
  });

  it('build_implementation_prompt actually injects the discovered project-tools block', () => {
    // The block builder existing is worthless if the prompt never includes it — that is
    // precisely how four tools shipped dead. Assert the real call and the real injection.
    const fn = claudeSrcFunction('build_implementation_prompt');
    expect(fn, 'build_implementation_prompt never calls build_project_tools_block').toMatch(
      /build_project_tools_block/,
    );
    expect(
      fn,
      'the block is computed but never interpolated into the emitted prompt',
    ).toMatch(/\$\{?project_tools_block/);
  });

  it.each(TOOLS)('%s is not filtered out by the allow-list of every script that names it', (tool) => {
    const naming = PROMPT_SCRIPTS.filter(s => nonCommentSource(s.path).includes(tool));
    if (naming.length === 0) return; // covered by the naming test above
    const reachable = naming.filter(s => {
      // A script with any unrestricted agent invocation can reach every loaded plugin.
      if (!s.restrictsEveryInvocation) return true;
      if (allowlistLiterals(s.path).some(l => allowlistAdmits(l, tool))) return true;
      // AN ALLOW-LIST MAY BE EXTENDED DYNAMICALLY, and reading only literals cannot see that.
      // team-lead-review.sh builds EPAM_ALLOWED_TOOLS as
      //   "bash,read_file,list_files,search${_review_plugin_tools:+,${_review_plugin_tools}}"
      // where _review_plugin_tools comes from project_tool_names(), which returns every tool
      // the codeline registered — scan_secrets among them, verified by executing it. A literal
      // scan reported the tool as filtered out while it was in fact permitted at runtime, and
      // the honest fix is to recognise the expansion rather than to hardcode the tool name here.
      return allowlistLiterals(s.path).some(l => /\$\{?\w*(plugin|project)_tools?\w*/i.test(l));
    });
    expect(
      reachable.map(s => s.path),
      `${tool} is named in [${naming.map(s => s.path).join(', ')}] but every EPAM_ALLOWED_TOOLS ` +
        `there excludes it — applyToolAllowlist() drops it before the model sees it, so naming ` +
        `it achieves nothing.`,
    ).not.toEqual([]);
  });
});
