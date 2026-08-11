/**
 * dependency_contract plugin tool — the DISCOVERED replacement for a hand-authored
 * anti-pattern rule.
 *
 * The defect class, stated with no vendor in it: *the agent wrote a config key that the
 * installed dependency does not actually consume*. That is universal to every SDK-config
 * task on every project, and it is determinable — the installed package ships the code
 * that reads (or ignores) the key.
 *
 * Three-way verdict per key, from the package's own installed files:
 *   consumed      — the key appears in the package's RUNTIME source (.js/.mjs/.cjs)
 *   declared_only — the key appears ONLY in a type declaration (.d.ts). This is the
 *                   signature of a STALE type declaration: the types promise a key the
 *                   runtime never reads, so satisfying the type silently breaks nothing
 *                   at compile time and everything at runtime.
 *   absent        — the key appears nowhere: a typo or an invented option.
 *   undetermined  — the package is not installed / not readable. NEVER a false pass.
 *
 * Why this exists (2026-08-03): a hand-written regex rule encoding one known-wrong key
 * for one vendor was carried in project config. It was authored after watching a failure,
 * which makes it an answer key, not configuration — and it could not help any other SDK
 * on any other project. This probe reads what the installed code actually does, so it
 * needs zero vendor knowledge and works on the next unknown dependency.
 *
 * REAL temp node_modules fixtures — no mocking, no network.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PLUGIN_PATH = join(__dirname, '../../../orchestrations/plugins/dependency-contract-plugin.js');

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake installed package whose TYPES declare a key its RUNTIME never reads — the exact
 *  stale-declaration shape, using invented names so no real vendor appears in this test. */
function makeProjectWithPackage(opts: { runtime?: string; types?: string; pkg?: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'dep-contract-'));
  cleanupDirs.push(root);
  const pkgName = opts.pkg ?? 'fake-sdk';
  const pkgDir = join(root, 'node_modules', pkgName);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: pkgName, version: '9.9.9' }));
  if (opts.runtime !== undefined) writeFileSync(join(pkgDir, 'index.js'), opts.runtime);
  if (opts.types !== undefined) writeFileSync(join(pkgDir, 'index.d.ts'), opts.types);
  return root;
}

async function probe(cwd: string, input: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tools } = require(PLUGIN_PATH) as { tools: Array<{ name: string; execute: (i: any) => Promise<any> }> };
  const tool = tools.find(t => t.name === 'dependency_contract');
  if (!tool) throw new Error('dependency_contract tool not found in plugin');
  const original = process.cwd();
  process.chdir(cwd);
  try {
    return await tool.execute(input);
  } finally {
    process.chdir(original);
  }
}

const RUNTIME_READS_GOOD_KEY = `
'use strict';
function init(opts) {
  const token = opts.preview_token;      // the key the runtime ACTUALLY reads
  return { token, enabled: opts.enable };
}
module.exports = { init };
`;

const TYPES_DECLARE_STALE_KEY = `
export interface LivePreviewLike {
  enable: boolean;
  management_token: string;   // STALE: promised by types, never read at runtime
  host?: string;
}
`;

describe('dependency_contract — three-way verdict from the installed package', () => {
  it('reports a key the runtime actually reads as consumed, with evidence', async () => {
    const root = makeProjectWithPackage({ runtime: RUNTIME_READS_GOOD_KEY, types: TYPES_DECLARE_STALE_KEY });
    const r = await probe(root, { package: 'fake-sdk', keys: ['preview_token'] });
    const out = JSON.parse(r.content);
    const v = out.results.find((x: any) => x.key === 'preview_token');
    expect(r.isError).toBe(false);
    expect(v.verdict).toBe('consumed');
    expect(v.evidence.length).toBeGreaterThan(0);
    expect(v.evidence[0].file).toMatch(/index\.js$/);
  });

  it('REPRODUCES the real defect: a key only in the .d.ts is declared_only, not consumed', async () => {
    const root = makeProjectWithPackage({ runtime: RUNTIME_READS_GOOD_KEY, types: TYPES_DECLARE_STALE_KEY });
    const r = await probe(root, { package: 'fake-sdk', keys: ['management_token'] });
    const out = JSON.parse(r.content);
    const v = out.results.find((x: any) => x.key === 'management_token');
    expect(v.verdict).toBe('declared_only');
    expect(v.evidence[0].file).toMatch(/\.d\.ts$/);
  });

  it('reports an invented key as absent', async () => {
    const root = makeProjectWithPackage({ runtime: RUNTIME_READS_GOOD_KEY, types: TYPES_DECLARE_STALE_KEY });
    const r = await probe(root, { package: 'fake-sdk', keys: ['totally_made_up_key'] });
    const out = JSON.parse(r.content);
    expect(out.results[0].verdict).toBe('absent');
  });

  it('grades several keys in one call', async () => {
    const root = makeProjectWithPackage({ runtime: RUNTIME_READS_GOOD_KEY, types: TYPES_DECLARE_STALE_KEY });
    const r = await probe(root, {
      package: 'fake-sdk',
      keys: ['preview_token', 'management_token', 'totally_made_up_key'],
    });
    const out = JSON.parse(r.content);
    const byKey = Object.fromEntries(out.results.map((x: any) => [x.key, x.verdict]));
    expect(byKey).toEqual({
      preview_token: 'consumed',
      management_token: 'declared_only',
      totally_made_up_key: 'absent',
    });
  });

  it('returns undetermined — never a false pass — when the package is not installed', async () => {
    const root = makeProjectWithPackage({ runtime: RUNTIME_READS_GOOD_KEY });
    const r = await probe(root, { package: 'not-installed-anywhere', keys: ['whatever'] });
    const out = JSON.parse(r.content);
    expect(out.results[0].verdict).toBe('undetermined');
    expect(r.isError).toBe(false);
  });

  it('errors clearly when required input is missing', async () => {
    const root = makeProjectWithPackage({ runtime: RUNTIME_READS_GOOD_KEY });
    const r = await probe(root, { package: 'fake-sdk' });
    expect(r.isError).toBe(true);
  });

  it('carries no vendor or client vocabulary in the plugin source itself', () => {
    const src = readFileSync(PLUGIN_PATH, 'utf8');
    expect(src).not.toMatch(/contentstack/i);
    expect(src).not.toMatch(/management_token/);
    expect(src).not.toMatch(/metrolinx/i);
  });

  it('conforms to the ToolPlugin contract PluginLoader validates', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { tools } = require(PLUGIN_PATH) as { tools: any[] };
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.execute).toBe('function');
      expect(['safe', 'review', 'dangerous']).toContain(t.permission);
      expect(t.definition.inputSchema.type).toBe('object');
      expect(t.pluginApiVersion).toBe('1.0.0');
    }
  });
});
