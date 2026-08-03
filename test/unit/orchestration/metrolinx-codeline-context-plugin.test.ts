/**
 * Metrolinx codeline-context plugin (orchestrations/plugins/codeline-context-tools.js)
 * — the first real ToolPlugin built against the epam-cli plugin architecture
 * (src/tools/plugin.ts / PluginLoader.ts), added 2026-08-01 after two live
 * mistakes in the same session: a writer created a test file at a path that
 * didn't match the codeline's real convention, and a commit failed against a
 * real pre-commit hook because required env vars weren't documented anywhere
 * the agent could see.
 *
 * PROJECT-AGNOSTIC BY DESIGN: the plugin module itself contains no reference
 * to any project or codeline name — these tests exercise it against real
 * temp git repos, not against the live Metrolinx codelines.
 *
 * Real filesystem + real git repos throughout, no mocking.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PLUGIN_PATH = join(__dirname, '../../../orchestrations/plugins/codeline-context-tools.js');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'codeline-ctx-'));
  cleanupDirs.push(repo);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  return repo;
}

/** Load the real plugin module and run its execute() with cwd temporarily switched. */
async function runTool(name: string, repo: string, input: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tools } = require(PLUGIN_PATH) as { tools: Array<{ name: string; execute: (i: any) => Promise<any> }> };
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found in plugin`);
  const originalCwd = process.cwd();
  process.chdir(repo);
  try {
    return await tool.execute(input);
  } finally {
    process.chdir(originalCwd);
  }
}

describe('plugin module — loads via the real PluginLoader contract', () => {
  it('exports exactly the 3 expected tools, each pluginApiVersion 1.0.0', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tools } = require(PLUGIN_PATH) as { tools: Array<{ name: string; pluginApiVersion: string }> };
    expect(tools.map((t) => t.name).sort()).toEqual([
      'metrolinx_codeline_facts',
      'metrolinx_git_state',
      'metrolinx_resolve_test_file',
    ]);
    expect(tools.every((t) => t.pluginApiVersion === '1.0.0')).toBe(true);
  });

  it('every tool conforms to the Tool shape PluginLoader.validatePlugin requires', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tools } = require(PLUGIN_PATH) as Array<any> & { tools: any[] };
    for (const t of (tools as any).tools ?? tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.execute).toBe('function');
      expect(['safe', 'review', 'dangerous']).toContain(t.permission);
      expect(t.definition.inputSchema.type).toBe('object');
    }
  });
});

describe('metrolinx_resolve_test_file', () => {
  it('recommends the co-located __tests__ convention when it is the only one that exists', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'src/services/__tests__'), { recursive: true });
    writeFileSync(join(repo, 'src/services/contentstack.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, 'src/services/__tests__/contentstack.spec.ts'), 'describe("x", () => {});\n');

    const result = await runTool('metrolinx_resolve_test_file', repo, { sourceFile: 'src/services/contentstack.ts' });
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBe(false);
    expect(parsed.existingTestFiles).toContain('src/services/__tests__/contentstack.spec.ts');
    expect(parsed.recommendation).toContain('src/services/__tests__/contentstack.spec.ts');
  });

  it('reports ALL existing candidates when more than one exists (the exact scenario that caused a real mistake)', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'src/services/__tests__'), { recursive: true });
    mkdirSync(join(repo, 'test/unit/services'), { recursive: true });
    writeFileSync(join(repo, 'src/services/contentstack.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, 'src/services/__tests__/contentstack.spec.ts'), 'describe("real", () => {});\n');
    writeFileSync(join(repo, 'test/unit/services/contentstack.test.ts'), 'describe("wrong-path", () => {});\n');

    const result = await runTool('metrolinx_resolve_test_file', repo, { sourceFile: 'src/services/contentstack.ts' });
    const parsed = JSON.parse(result.content);

    expect(parsed.existingTestFiles).toHaveLength(2);
    expect(parsed.existingTestFiles).toContain('src/services/__tests__/contentstack.spec.ts');
    expect(parsed.existingTestFiles).toContain('test/unit/services/contentstack.test.ts');
    // Co-located __tests__ is the recommended one — it's tried first.
    expect(parsed.recommendation).toContain('src/services/__tests__/contentstack.spec.ts');
  });

  it('reports no existing test file and suggests the most conventional new location when nothing exists', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'src/utils'), { recursive: true });
    writeFileSync(join(repo, 'src/utils/brandNew.ts'), 'export const x = 1;\n');

    const result = await runTool('metrolinx_resolve_test_file', repo, { sourceFile: 'src/utils/brandNew.ts' });
    const parsed = JSON.parse(result.content);

    expect(parsed.existingTestFiles).toEqual([]);
    expect(parsed.checkedCandidates.length).toBeGreaterThan(0);
    expect(parsed.recommendation).toContain(parsed.checkedCandidates[0]);
  });

  it('returns an error result when sourceFile is missing', async () => {
    const repo = makeRepo();
    const result = await runTool('metrolinx_resolve_test_file', repo, {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('sourceFile');
  });
});

describe('metrolinx_codeline_facts', () => {
  it('returns a real, curated facts list when .epam/codeline-facts.json exists', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, '.epam'), { recursive: true });
    writeFileSync(
      join(repo, '.epam/codeline-facts.json'),
      JSON.stringify({ facts: ['fact one', 'fact two'] }),
    );

    const result = await runTool('metrolinx_codeline_facts', repo);
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBe(false);
    expect(parsed.facts).toEqual(['fact one', 'fact two']);
  });

  it('reports no facts configured when the file is absent (silent, not an error)', async () => {
    const repo = makeRepo();
    const result = await runTool('metrolinx_codeline_facts', repo);
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/no codeline-specific facts/i);
  });
});

describe('metrolinx_git_state', () => {
  it('reports the real branch, HEAD, and clean status', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: repo });

    const result = await runTool('metrolinx_git_state', repo);
    const parsed = JSON.parse(result.content);

    expect(result.isError).toBe(false);
    expect(parsed.branch).toBe('main');
    expect(parsed.head).toMatch(/^[0-9a-f]{40}$/);
    expect(parsed.dirty).toBe(false);
    expect(parsed.changedFiles).toEqual([]);
  });

  it('reports dirty=true with the real list of changed files', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-m', 'seed', '--quiet'], { cwd: repo });
    writeFileSync(join(repo, 'f.txt'), 'changed\n');
    writeFileSync(join(repo, 'new.txt'), 'new\n');

    const result = await runTool('metrolinx_git_state', repo);
    const parsed = JSON.parse(result.content);

    expect(parsed.dirty).toBe(true);
    expect(parsed.changedFiles.length).toBe(2);
  });

  it('returns an error result when run outside a git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeline-ctx-nogit-'));
    cleanupDirs.push(dir);
    const result = await runTool('metrolinx_git_state', dir);
    expect(result.isError).toBe(true);
  });
});
