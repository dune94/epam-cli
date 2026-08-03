/**
 * lib/project-tools.sh — ONE shared implementation of "what plugin tools did this
 * codeline register, and how do we tell an agent about them".
 *
 * Two consumers need it and must not drift apart (the lesson from duplicated worktree
 * helpers that silently diverged): claude.sh advertises the tools to the WRITER, and
 * team-lead-review.sh must advertise them to the REVIEWER *and* extend its tool
 * allow-list — a reviewer that is told about a tool it is not permitted to call is
 * exactly as useless as one that is never told.
 *
 * Confirmed live 2026-08-03: team-lead-review.sh pinned EPAM_ALLOWED_TOOLS to
 * "bash,read_file,list_files,search", and applyToolAllowlist() (src/tools/createTools.ts)
 * filters to exactly that set when non-empty — so every plugin tool was dropped before
 * the reviewer model ever saw it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const LIB = join(REPO_ROOT, 'orchestrations/scripts/lib/project-tools.sh');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FIXTURE_PLUGIN = `
module.exports = { tools: [
  { name: 'acme_alpha', pluginApiVersion: '1.0.0', permission: 'safe', description: 'Alpha probe.',
    definition: { name: 'acme_alpha', description: 'd', inputSchema: { type: 'object', properties: {}, required: [] } },
    async execute() { return { toolUseId: '', content: '', isError: false }; } },
  { name: 'acme_beta', pluginApiVersion: '1.0.0', permission: 'safe', description: 'Beta probe.',
    definition: { name: 'acme_beta', description: 'd', inputSchema: { type: 'object', properties: {}, required: [] } },
    async execute() { return { toolUseId: '', content: '', isError: false }; } },
] };
`;

function runLibFn(fn: string, opts: { withSettings: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'proj-tools-lib-'));
  cleanupDirs.push(root);
  if (opts.withSettings) {
    const pluginPath = join(root, 'p.js');
    writeFileSync(pluginPath, FIXTURE_PLUGIN);
    mkdirSync(join(root, '.epam'), { recursive: true });
    writeFileSync(join(root, '.epam/settings.json'), JSON.stringify({ tools: [pluginPath] }));
  }
  const script = join(root, 'probe.sh');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      `NODE_BIN=${JSON.stringify(process.execPath)}`,
      `source ${JSON.stringify(LIB)}`,
      `${fn} ${JSON.stringify(root)}`,
    ].join('\n'),
  );
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 20000 });
  return (r.stdout || '') + (r.stderr || '');
}

describe('lib/project-tools.sh — one shared discovery implementation', () => {
  it('exists as a sourceable library, not duplicated per caller', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it('project_tool_names returns the registered tool names, comma-separated for an allow-list', () => {
    const out = runLibFn('project_tool_names', { withSettings: true }).trim();
    expect(out.split(',').sort()).toEqual(['acme_alpha', 'acme_beta']);
  });

  it('project_tool_names is empty (not an error) when the codeline registered nothing', () => {
    expect(runLibFn('project_tool_names', { withSettings: false }).trim()).toBe('');
  });

  it('build_project_tools_block advertises each tool with a call directive', () => {
    const out = runLibFn('build_project_tools_block', { withSettings: true });
    expect(out).toContain('acme_alpha');
    expect(out).toContain('Alpha probe.');
    expect(out).toMatch(/NOT via Bash/i);
  });

  it('build_project_tools_block is a silent no-op when nothing is registered', () => {
    expect(runLibFn('build_project_tools_block', { withSettings: false }).trim()).toBe('');
  });

  it('never crashes or leaks an error when a registered plugin module is broken', () => {
    const root = mkdtempSync(join(tmpdir(), 'proj-tools-broken-'));
    cleanupDirs.push(root);
    const bad = join(root, 'bad.js');
    writeFileSync(bad, 'this is not valid javascript {{{');
    mkdirSync(join(root, '.epam'), { recursive: true });
    writeFileSync(join(root, '.epam/settings.json'), JSON.stringify({ tools: [bad] }));
    const script = join(root, 'probe.sh');
    writeFileSync(
      script,
      [
        '#!/usr/bin/env bash',
        'set -uo pipefail',
        `NODE_BIN=${JSON.stringify(process.execPath)}`,
        `source ${JSON.stringify(LIB)}`,
        `build_project_tools_block ${JSON.stringify(root)}`,
        'echo "RC=$?"',
      ].join('\n'),
    );
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 20000 });
    const out = (r.stdout || '') + (r.stderr || '');
    expect(out).not.toMatch(/SyntaxError|Traceback/);
    expect(out).toMatch(/RC=0/);
  });

  it('the library itself carries no client or vendor vocabulary', () => {
    const src = readFileSync(LIB, 'utf8');
    expect(src).not.toMatch(/metrolinx/i);
    expect(src).not.toMatch(/contentstack/i);
  });
});

describe('both agents use the shared library — no per-caller reimplementation', () => {
  const claudeSrc = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
  const reviewSrc = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/team-lead-review.sh'), 'utf8');

  it('claude.sh sources the library rather than defining its own copy', () => {
    expect(claudeSrc).toMatch(/source\s+"?\$\{?SCRIPT_DIR\}?\/lib\/project-tools\.sh/);
    expect(
      claudeSrc,
      'claude.sh still defines a local copy — that is how two implementations drift apart',
    ).not.toMatch(/^_build_project_tools_block\(\)\s*\{/m);
  });

  it('team-lead-review.sh sources the library', () => {
    expect(reviewSrc).toMatch(/source\s+"?\$\{?SCRIPT_DIR\}?\/lib\/project-tools\.sh/);
  });

  it('the reviewer EXTENDS its tool allow-list with the discovered tools', () => {
    // Without this, naming a plugin in the reviewer prompt achieves nothing:
    // applyToolAllowlist() drops anything outside the literal list.
    expect(reviewSrc).toMatch(/project_tool_names/);
    const allowLine = reviewSrc.split('\n').find(l => l.includes('EPAM_ALLOWED_TOOLS='));
    expect(allowLine, 'reviewer allow-list line not found').toBeTruthy();
    expect(
      allowLine,
      'the reviewer allow-list is still a fixed literal — discovered plugin tools are filtered out',
    ).toMatch(/\$\{?_?review_plugin_tools/);
  });

  it('the reviewer prompt advertises the discovered tools', () => {
    expect(
      reviewSrc,
      'the reviewer is never shown the project tools, so it will not call them',
    ).toMatch(/build_project_tools_block|project_tools_block/);
  });
});
