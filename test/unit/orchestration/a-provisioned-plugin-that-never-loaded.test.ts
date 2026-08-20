// A PLUGIN THE CODELINE PROVISIONED NEVER LOADED, AND ONLY A WARNING SAID SO.
//
// verification-plugin.js was added on 2026-08-11 with `name` nested inside `definition` where every
// sibling hoists it. PluginLoader rejected it on every invocation — 15 warnings across the runs of
// 2026-08-19/20 — and its tools were silently absent from every agent that should have had them.
//
// THIS WAS THE SECOND OCCURRENCE. Two days earlier, commit c041e25: "fix: revert read dedupe;
// scan_secrets has never loaded". The loader's own source records it:
//
//   "Live 2026-08-09: secret-scan-tools declared the number 1, `1.split('.')` threw, loadAll caught
//    it as a load failure, and scan_secrets was silently absent from every review — one warning
//    line in an agent log."
//
// The class was found, fixed, documented — and nothing was put in place to stop it recurring. Nine
// days later it recurred in a plugin written after the fix.
//
// FORTY-THREE TESTS TOUCH PLUGINS AND NONE CAUGHT IT. plugin-tools-reachable.test.ts enumerates
// every plugin and does `names.push(t.name)`, which for the broken one pushed `undefined`. Its
// assertions — length > 0, and contains 'codegraph_query' — both pass with a null in the list.
// Reconstructed from the pre-fix commit, that array was:
//
//   [... "dependency_scan", "scan_secrets", null]
//
// The test loaded the broken plugin, collected its missing name, and passed. Absence flowed through
// as a value instead of being rejected — the same pattern as every other defect this week.
//
// THIS TEST RESTATES NOTHING. It does not know what a valid plugin is: it runs the REAL loader over
// the plugins each codeline REALLY provisions, and asserts nothing failed. If the loader's contract
// changes, this follows automatically, because the loader is the only place the contract exists.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll } from 'vitest';
import { join } from 'node:path';
import { PluginLoader } from '../../../src/tools/PluginLoader';
import { replayRoots } from '../../support/replay-codeline';

const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** The only thing loadAll asks of a registry. A test double, not a fact about any project. */
function registryDouble() {
  const registered: string[] = [];
  return {
    registered,
    register(name: string, plugin: unknown) { registered.push(name); void plugin; },
  };
}

/** Every codeline that provisions plugins, discovered — never listed. */
function provisioningCodelines(): { repo: string; entries: string[] }[] {
  const out: { repo: string; entries: string[] }[] = [];
  for (const root of replayRoots()) {
    let names: string[] = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const name of names) {
      const repo = join(root, name);
      try { if (!statSync(repo).isDirectory()) continue; } catch { continue; }
      const settings = join(repo, '.epam', 'settings.json');
      if (!existsSync(settings)) continue;
      let entries: string[] = [];
      try {
        const j = JSON.parse(readFileSync(settings, 'utf8'));
        entries = Array.isArray(j.tools) ? j.tools : [];
      } catch { continue; }
      if (entries.length) out.push({ repo, entries });
    }
  }
  return out;
}

describe('the real loader, over the plugins really provisioned', () => {
  const codelines = provisioningCodelines();

  it('found codelines that provision plugins', () => {
    expect(codelines.length, 'no codeline declares tools — the assertions below would be vacuous')
      .toBeGreaterThan(0);
  });

  it('every provisioned plugin loads', () => {
    const failures: string[] = [];
    for (const { repo, entries } of codelines) {
      const loader = new PluginLoader({ projectRoot: repo, warn: false });
      const { failed } = loader.loadAll(entries, registryDouble() as never);
      for (const f of failed) failures.push(`${repo.split('/').pop()} → ${f.split('/').pop()}`);
    }
    expect(failures,
      `a plugin the codeline provisions does not load; its tools reach no agent:\n${failures.join('\n')}`)
      .toEqual([]);
  });

  it('and something was actually registered — a loader that registers nothing proves nothing', () => {
    let total = 0;
    for (const { repo, entries } of codelines) {
      const reg = registryDouble();
      new PluginLoader({ projectRoot: repo, warn: false }).loadAll(entries, reg as never);
      total += reg.registered.length;
    }
    expect(total).toBeGreaterThan(0);
  });

  it('every registered tool has a usable name', () => {
    // The enumeration in plugin-tools-reachable.test.ts collected `undefined` and passed. A name
    // is what an agent calls; a missing one is a tool that cannot be invoked.
    const bad: string[] = [];
    for (const { repo, entries } of codelines) {
      const reg = registryDouble();
      new PluginLoader({ projectRoot: repo, warn: false }).loadAll(entries, reg as never);
      for (const n of reg.registered) if (typeof n !== 'string' || !n.trim()) bad.push(String(n));
    }
    expect(bad, `a tool was registered under an unusable name: ${bad.join(', ')}`).toEqual([]);
  });
});

describe('the engine refuses to run without what the codeline provisioned', () => {
  // 15 warnings across three runs, and every run continued. A capability the codeline explicitly
  // asked for, silently absent, is not a warning-level event.
  //
  // Asserted as BEHAVIOUR — a deliberately broken plugin, the real loader — not as source text.
  // "Does the file contain the word strict" would pass on a comment and prove nothing.
  const broken = (): { dir: string; entry: string } => {
    const d = mkdtempSync(join(tmpdir(), 'broken-plugin-')); made.push(d);
    const entry = join(d, 'broken-plugin.js');
    // Shaped exactly like the live defect: a tools array whose entry nests its identity where the
    // loader does not look.
    writeFileSync(entry, 'module.exports = { tools: [ { definition: { name: "x" }, execute: () => {} } ] };\n');
    return { dir: d, entry };
  };

  it('the loader still REPORTS the failure (the existing behaviour)', () => {
    const { dir: d, entry } = broken();
    const { failed, loaded } = new PluginLoader({ projectRoot: d, warn: false })
      .loadAll([entry], registryDouble() as never);
    expect(failed).toHaveLength(1);
    expect(loaded).toHaveLength(0);
  });

  it('and a caller asking for strictness gets a throw, not a return value to ignore', () => {
    const { dir: d, entry } = broken();
    expect(() => new PluginLoader({ projectRoot: d, warn: false, failOnError: true })
      .loadAll([entry], registryDouble() as never))
      .toThrow(/plugin/i);
  });

  it('a healthy plugin is unaffected by strictness', () => {
    const d = mkdtempSync(join(tmpdir(), 'ok-plugin-')); made.push(d);
    const entry = join(d, 'ok-plugin.js');
    writeFileSync(entry, 'module.exports = { tools: [ { name: "ok_tool", execute: () => {} } ] };\n');
    const reg = registryDouble();
    expect(() => new PluginLoader({ projectRoot: d, warn: false, failOnError: true })
      .loadAll([entry], reg as never)).not.toThrow();
    expect(reg.registered).toContain('ok_tool');
  });

  it('the agent tool factory uses strictness, so a provisioned failure cannot be ignored', async () => {
    // createTools discards loadAll's result entirely (createTools.ts:39). Driven here through the
    // real factory: a cwd whose .epam/settings.json provisions a broken plugin must not yield a
    // tool set as though nothing were missing.
    const d = mkdtempSync(join(tmpdir(), 'cwd-plugin-')); made.push(d);
    mkdirSync(join(d, '.epam'), { recursive: true });
    const entry = join(d, 'broken-plugin.js');
    writeFileSync(entry, 'module.exports = { tools: [ { definition: { name: "x" }, execute: () => {} } ] };\n');
    writeFileSync(join(d, '.epam', 'settings.json'), JSON.stringify({ tools: [entry] }));
    const prev = process.cwd();
    process.chdir(d);
    try {
      const mod = await import('../../../src/tools/createTools?t=' + Date.now());
      const fn = (mod as { createTools?: () => unknown }).createTools;
      expect(typeof fn, 'createTools is not exported under that name').toBe('function');
      expect(() => fn!()).toThrow(/plugin/i);
    } finally { process.chdir(prev); }
  });
});
