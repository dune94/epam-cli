/**
 * PluginLoader — real dynamic-`require()` coverage.
 *
 * The plugin architecture (src/tools/plugin.ts, PluginLoader.ts, createTools.ts)
 * shipped in commit 9006d42 (GAP-P16) but had NO dedicated tests: every existing
 * caller of createTools() runs with an empty "tools" array, so only the
 * zero-plugins fallback path was ever exercised. Written 2026-08-01 alongside
 * the first real plugin built against this architecture (the Metrolinx
 * codeline-context plugin) — this is the first test to actually load, validate,
 * and register a plugin via a real dynamic require() against real files on disk.
 *
 * Real temp files throughout, no mocking of fs/require.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginLoader } from '../../../src/tools/PluginLoader.js';
import { ToolRegistry } from '../../../src/tools/registry.js';

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-loader-'));
  cleanupDirs.push(dir);
  return dir;
}

const VALID_TOOL_SRC = (name: string) => `
module.exports = {
  default: {
    name: ${JSON.stringify(name)},
    pluginApiVersion: '1.0.0',
    description: 'test plugin',
    permission: 'safe',
    definition: { name: ${JSON.stringify(name)}, description: 'test', inputSchema: { type: 'object', properties: {} } },
    execute: async () => ({ toolUseId: '', content: 'ok', isError: false }),
  },
};
`;

describe('PluginLoader.readPluginList', () => {
  it('returns [] when the settings file does not exist', () => {
    expect(PluginLoader.readPluginList('/nonexistent/settings.json')).toEqual([]);
  });

  it('returns [] on malformed JSON', () => {
    const dir = makeTempDir();
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, '{ not valid json');
    expect(PluginLoader.readPluginList(settingsPath)).toEqual([]);
  });

  it('returns [] when "tools" is absent or not an array', () => {
    const dir = makeTempDir();
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ provider: 'claude' }));
    expect(PluginLoader.readPluginList(settingsPath)).toEqual([]);
  });

  it('reads a real "tools" array and filters non-string entries', () => {
    const dir = makeTempDir();
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ tools: ['./a.js', 42, '@org/pkg', null] }));
    expect(PluginLoader.readPluginList(settingsPath)).toEqual(['./a.js', '@org/pkg']);
  });
});

describe('PluginLoader.loadAll — real dynamic require()', () => {
  it('loads and registers a plugin via a relative path (default export, single tool)', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'tool.js'), VALID_TOOL_SRC('rel_tool'));
    const loader = new PluginLoader({ projectRoot: dir, warn: false });
    const registry = new ToolRegistry();

    const { loaded, failed } = loader.loadAll(['./tool.js'], registry);

    expect(loaded).toEqual(['./tool.js']);
    expect(failed).toEqual([]);
    expect(registry.get('rel_tool')).toBeTruthy();
  });

  it('loads and registers a plugin via an ABSOLUTE path, regardless of projectRoot', () => {
    const dir = makeTempDir();
    const otherDir = makeTempDir(); // projectRoot is deliberately a DIFFERENT dir
    const absPath = join(dir, 'abs-tool.js');
    writeFileSync(absPath, VALID_TOOL_SRC('abs_tool'));
    const loader = new PluginLoader({ projectRoot: otherDir, warn: false });
    const registry = new ToolRegistry();

    const { loaded, failed } = loader.loadAll([absPath], registry);

    expect(failed).toEqual([]);
    expect(loaded).toEqual([absPath]);
    expect(registry.get('abs_tool')).toBeTruthy();
  });

  it('loads every tool from a default export ARRAY', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'multi.js'),
      `module.exports = { default: [
        { name: 'multi_a', pluginApiVersion: '1.0.0', description: 'a', permission: 'safe',
          definition: { name: 'multi_a', description: 'a', inputSchema: { type: 'object', properties: {} } },
          execute: async () => ({ toolUseId: '', content: 'a', isError: false }) },
        { name: 'multi_b', pluginApiVersion: '1.0.0', description: 'b', permission: 'safe',
          definition: { name: 'multi_b', description: 'b', inputSchema: { type: 'object', properties: {} } },
          execute: async () => ({ toolUseId: '', content: 'b', isError: false }) },
      ] };`,
    );
    const loader = new PluginLoader({ projectRoot: dir, warn: false });
    const registry = new ToolRegistry();

    loader.loadAll(['./multi.js'], registry);

    expect(registry.get('multi_a')).toBeTruthy();
    expect(registry.get('multi_b')).toBeTruthy();
  });

  it('loads a named "tools" export (not just "default")', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'named.js'),
      `module.exports = { tools: [{
        name: 'named_tool', pluginApiVersion: '1.0.0', description: 'x', permission: 'safe',
        definition: { name: 'named_tool', description: 'x', inputSchema: { type: 'object', properties: {} } },
        execute: async () => ({ toolUseId: '', content: 'x', isError: false }),
      }] };`,
    );
    const loader = new PluginLoader({ projectRoot: dir, warn: false });
    const registry = new ToolRegistry();

    loader.loadAll(['./named.js'], registry);

    expect(registry.get('named_tool')).toBeTruthy();
  });

  it('skips (does not throw) a module that fails to require, and reports it as failed', () => {
    const dir = makeTempDir();
    const loader = new PluginLoader({ projectRoot: dir, warn: false });
    const registry = new ToolRegistry();

    const { loaded, failed } = loader.loadAll(['./does-not-exist.js'], registry);

    expect(loaded).toEqual([]);
    expect(failed).toEqual(['./does-not-exist.js']);
  });

  it('skips a module exporting neither "default" nor "tools"', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'empty.js'), `module.exports = { somethingElse: true };`);
    const loader = new PluginLoader({ projectRoot: dir, warn: false });
    const registry = new ToolRegistry();

    const { loaded, failed } = loader.loadAll(['./empty.js'], registry);

    expect(loaded).toEqual([]);
    expect(failed).toEqual(['./empty.js']);
  });

  it('skips a plugin missing "name" or "execute", without registering it', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'broken.js'),
      `module.exports = { default: { pluginApiVersion: '1.0.0', description: 'no name or execute' } };`,
    );
    const loader = new PluginLoader({ projectRoot: dir, warn: false });
    const registry = new ToolRegistry();

    const { loaded, failed } = loader.loadAll(['./broken.js'], registry);

    expect(loaded).toEqual([]);
    expect(failed).toEqual(['./broken.js']);
  });

  it('registers a plugin missing pluginApiVersion, warning but not failing', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'noversion.js'),
      `module.exports = { default: {
        name: 'noversion_tool', description: 'x', permission: 'safe',
        definition: { name: 'noversion_tool', description: 'x', inputSchema: { type: 'object', properties: {} } },
        execute: async () => ({ toolUseId: '', content: 'x', isError: false }),
      } };`,
    );
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const loader = new PluginLoader({ projectRoot: dir, warn: true });
    const registry = new ToolRegistry();

    const { loaded } = loader.loadAll(['./noversion.js'], registry);

    expect(loaded).toEqual(['./noversion.js']);
    expect(registry.get('noversion_tool')).toBeTruthy();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('missing pluginApiVersion'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('registers a plugin with a mismatched major API version, warning but not failing', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'oldversion.js'), VALID_TOOL_SRC('oldversion_tool').replace("'1.0.0'", "'99.0.0'"));
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const loader = new PluginLoader({ projectRoot: dir, warn: true });
    const registry = new ToolRegistry();

    const { loaded } = loader.loadAll(['./oldversion.js'], registry);

    expect(loaded).toEqual(['./oldversion.js']);
    expect(registry.get('oldversion_tool')).toBeTruthy();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('may have compatibility issues'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('suppresses stderr warnings when warn: false', () => {
    const dir = makeTempDir();
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const loader = new PluginLoader({ projectRoot: dir, warn: false });
    const registry = new ToolRegistry();

    loader.loadAll(['./does-not-exist.js'], registry);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('loading multiple entries where one fails does not prevent the others from loading', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'good.js'), VALID_TOOL_SRC('good_tool'));
    const loader = new PluginLoader({ projectRoot: dir, warn: false });
    const registry = new ToolRegistry();

    const { loaded, failed } = loader.loadAll(['./good.js', './missing.js'], registry);

    expect(loaded).toEqual(['./good.js']);
    expect(failed).toEqual(['./missing.js']);
    expect(registry.get('good_tool')).toBeTruthy();
  });
});
