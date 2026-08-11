/**
 * AN AGENT DOING CODE ARCHAEOLOGY MUST BE GRANTED THE SYMBOL INDEX.
 *
 * specAgentEnv granted a literal 'read_file,list_files,search' to every spec-mode agent —
 * openspec, speckit, the reviewers. codegraph_query was NOT in that grant, so the agents doing
 * brownfield elaboration (trace the call chain, find where this is wired) had only text search,
 * and no access to the tool that answers structural questions.
 *
 * Until 2026-08-09 that text search returned "(no matches found)" for everything, because `rg`
 * on this machine is a shell function with no binary on PATH and the grep fallback was
 * unreachable. So every spec-mode agent was looking at an apparently empty repository, with no
 * alternative instrument available to it.
 *
 * The plugin half is DERIVED: each codeline's .epam/settings.json already declares its plugins,
 * and every tool declares its own `permission`. A codeline provisioned with the codegraph
 * plugin therefore grants codegraph_query automatically, with no per-tool wiring and no tool
 * name written into the engine — the same derivation mintTools already used for the mint.
 *
 * The builtin half comes from config rather than from source. Deriving it as "every builtin
 * whose permission is safe" would also grant fetch_url, quietly giving every spec agent network
 * access, which is a different decision and not one to make silently.
 *
 * A tool that declares itself dangerous or review-gated is never granted here regardless of
 * what a plugin asks for.
 */
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { readOnlyToolGrant } = require('../../../orchestrations/scripts/lib/agent-tools.js');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
beforeEach(() => { delete process.env.EPAM_SPEC_MODE_DEFAULTS_FILE; });

/** A codeline provisioned with a plugin exporting tools of mixed permission. */
function codelineWithPlugin() {
  const dir = mkdtempSync(join(tmpdir(), 'grant-')); dirs.push(dir);
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.epam'), { recursive: true });

  const plugin = join(dir, 'plugin.js');
  writeFileSync(plugin, `module.exports = { tools: [
    { name: 'index_query', permission: 'safe' },
    { definition: { name: 'nested_named_tool' }, permission: 'safe' },
    { name: 'shell_exec', permission: 'dangerous' },
    { name: 'patcher', permission: 'review' }
  ] };\n`);
  writeFileSync(join(repo, '.epam', 'settings.json'), JSON.stringify({ tools: [plugin] }, null, 2));
  return repo;
}

const grant = (paths: string[]) => readOnlyToolGrant(paths).split(',').filter(Boolean);

describe('the builtin floor is present', () => {
  it('a codeline with no plugins still gets the configured read-only builtins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bare-')); dirs.push(dir);
    const g = grant([dir]);
    expect(g.length).toBeGreaterThan(0);
    expect(g).toContain('read_file');
    expect(g).toContain('search');
  });

  it('no path at all still yields the builtin floor rather than an empty grant', () => {
    // An empty grant means the agent runs with --no-tools and fabricates what it cannot read.
    expect(grant([]).length).toBeGreaterThan(0);
  });
});

describe('THE DEFECT: a provisioned plugin reaches the agent', () => {
  it('a safe plugin tool is granted', () => {
    expect(
      grant([codelineWithPlugin()]),
      'the codeline declares this plugin and the agent was never given its tools',
    ).toContain('index_query');
  });

  it('a tool that names itself under `definition` is found too', () => {
    expect(grant([codelineWithPlugin()])).toContain('nested_named_tool');
  });

  it('the real codegraph plugin yields codegraph_query', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-')); dirs.push(dir);
    mkdirSync(join(dir, '.epam'), { recursive: true });
    const real = join(__dirname, '../../../orchestrations/plugins/codegraph-plugin.js');
    writeFileSync(join(dir, '.epam', 'settings.json'), JSON.stringify({ tools: [real] }));
    expect(grant([dir])).toContain('codegraph_query');
  });
});

describe('permission is honoured — a read-only grant stays read-only', () => {
  it('a dangerous plugin tool is never granted', () => {
    expect(grant([codelineWithPlugin()])).not.toContain('shell_exec');
  });

  it('a review-gated plugin tool is never granted', () => {
    expect(grant([codelineWithPlugin()])).not.toContain('patcher');
  });

  it('a tool declaring no permission is not granted — silence is not consent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nop-')); dirs.push(dir);
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.epam'), { recursive: true });
    const plugin = join(dir, 'p.js');
    writeFileSync(plugin, "module.exports = { tools: [{ name: 'unstated' }] };\n");
    writeFileSync(join(repo, '.epam', 'settings.json'), JSON.stringify({ tools: [plugin] }));
    expect(grant([repo])).not.toContain('unstated');
  });
});

describe('no tool name is written into the engine', () => {
  it('the builtin floor comes from the config file, not the source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-')); dirs.push(dir);
    const f = join(dir, 'spec-mode-defaults.json');
    writeFileSync(f, JSON.stringify({
      toolCalls: { perAgent: 8, perCodelineSurvey: 8 },
      tools: { readOnlyBuiltins: ['only_this_one'] },
    }));
    process.env.EPAM_SPEC_MODE_DEFAULTS_FILE = f;
    const g = grant([]);
    expect(g).toEqual(['only_this_one']);
  });

  it('the module carries no builtin tool-name list of its own', () => {
    const src = require('node:fs').readFileSync(
      join(__dirname, '../../../orchestrations/scripts/lib/agent-tools.js'), 'utf8');
    expect(src).not.toMatch(/'read_file'\s*,\s*'list_files'/);
  });
});

describe('a broken plugin degrades, it does not blank the grant', () => {
  it('an unloadable plugin leaves the rest intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'broken-')); dirs.push(dir);
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.epam'), { recursive: true });
    writeFileSync(join(repo, '.epam', 'settings.json'),
      JSON.stringify({ tools: [join(dir, 'does-not-exist.js')] }));
    expect(grant([repo])).toContain('read_file');
  });

  it('malformed settings.json does not throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bad-')); dirs.push(dir);
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.epam'), { recursive: true });
    writeFileSync(join(repo, '.epam', 'settings.json'), '{ not json');
    expect(() => grant([repo])).not.toThrow();
  });

  it('the grant is deduplicated and stable across two codelines with the same plugin', () => {
    const a = codelineWithPlugin();
    const b = codelineWithPlugin();
    const g = grant([a, b]);
    expect(g.filter((t) => t === 'index_query').length).toBe(1);
    expect(readOnlyToolGrant([a, b])).toBe(readOnlyToolGrant([a, b]));
  });
});
