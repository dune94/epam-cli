/**
 * A MALFORMED VERSION FIELD TOOK A WHOLE PLUGIN OFF THE TABLE, SILENTLY.
 *
 * Live 2026-08-09, in the writer's own output:
 *
 *     [epam] Plugin load warning: .../orchestrations/plugins/secret-scan-plugin.js
 *            — plugin.pluginApiVersion.split is not a function
 *
 * validatePlugin() runs per TOOL and calls .split() on pluginApiVersion. The three working
 * plugins declare the string '1.0.0'; secret-scan-tools declared the NUMBER 1, so 1.split()
 * threw and the plugin never loaded. scan_secrets — the tool built that morning so the reviewer
 * could check for committed secrets — has never once been available, and the only trace was a
 * warning line inside an agent log nobody reads.
 *
 * Two defects, and both matter:
 *
 *   1. The plugin's own declaration was wrong. Mine.
 *   2. The loader turns a malformed version into a total loss of the plugin. Its sibling in
 *      gate_allowed_tools already states the right principle — "one bad plugin must not blank
 *      the allowlist" — and this path does the opposite of that for a field that is advisory:
 *      it exists to WARN about a version mismatch, and a version it cannot parse should warn,
 *      not delete the tools.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginLoader } from '../../../src/tools/PluginLoader';
import { ToolRegistry } from '../../../src/tools/registry';

const dirs: string[] = [];
const plugin = (versionLiteral: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'plug-')); dirs.push(dir);
  const file = join(dir, 'p.js');
  writeFileSync(file, `
    module.exports = { tools: [{
      name: 'probe_tool',
      pluginApiVersion: ${versionLiteral},
      permission: 'safe',
      description: 'probe',
      definition: { name: 'probe_tool', description: 'probe', inputSchema: { type: 'object', properties: {} } },
      async execute() { return { toolUseId: '', content: 'ok', isError: false }; },
    }] };
  `);
  return file;
};
/** loadAll registers into a ToolRegistry and reports loaded/failed — that is the real API. */
function load(file: string): string[] {
  const registry = new ToolRegistry();
  const result = new PluginLoader({ warn: false }).loadAll([file], registry);
  if (result.failed.length) return [];
  return registry.getAll().map((t: { name: string }) => t.name);
}

describe('the real plugin declares a version the loader can read', () => {
  it('secret-scan-plugin loads at all', () => {
    const tools = load(join(__dirname, '../../../orchestrations/plugins/secret-scan-plugin.js'));
    expect(tools, 'scan_secrets is still absent — the reviewer cannot call it')
      .toContain('scan_secrets');
  });

  it('and every shipped plugin loads', () => {
    for (const p of ['codegraph-plugin', 'codeline-context-plugin', 'dependency-contract-plugin', 'secret-scan-plugin']) {
      const tools = load(join(__dirname, `../../../orchestrations/plugins/${p}.js`));
      expect(tools.length, `${p} loaded no tools`).toBeGreaterThan(0);
    }
  });
});

describe('THE DEFECT: an advisory field cannot delete the plugin', () => {
  it('a NUMBER version still loads the tool', () => {
    expect(load(plugin('1'))).toContain('probe_tool');
  });

  it('a null version still loads', () => {
    expect(load(plugin('null'))).toContain('probe_tool');
  });

  it('an object version still loads', () => {
    expect(load(plugin('{ major: 1 }'))).toContain('probe_tool');
  });

  it('a well-formed version still loads', () => {
    expect(load(plugin("'1.0.0'"))).toContain('probe_tool');
  });
});

describe('genuinely broken plugins still fail', () => {
  it('a tool with no execute is still rejected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugbad-')); dirs.push(dir);
    const f = join(dir, 'bad.js');
    writeFileSync(f, `module.exports = { tools: [{ name: 'x', pluginApiVersion: '1.0.0' }] };`);
    expect(load(f)).toEqual([]);
  });
});
