/**
 * A TEXT MANIFEST DECLARES ITS DEPENDENCIES THROUGH ITS ECOSYSTEM.
 *
 * The dependency scan read the manifest as JSON and walked manifestKeys — package.json's shape —
 * and the manifest schema REQUIRED manifestKeys. A requirements.txt is a line list with no keys,
 * so the greenfield Python project's declaration was rejected ("manifestKeys: Field required"),
 * the scan reported itself "incomplete" on every writer attempt of every £0 run, and its declared
 * dependencies were invisible (2026-09-14). Every ecosystem provider already parses its own
 * manifest (deps(text)); the scan asks the provider whose manifest this is, and falls back to the
 * JSON keys only for a manifest no provider claims. Judged by executing the real plugin over a
 * real text manifest and the real schema over the real project declaration.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const plugin = require(join(ROOT, 'orchestrations/plugins/dependency-scan-plugin.js'));
const { loadProviders } = require(join(ROOT, 'orchestrations/scripts/lib/ecosystem-registry.js'));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('a text manifest declares its dependencies through its ecosystem', () => {
  // Every provider whose own stand-in manifest declares at least one dependency by its own
  // parser — the ones whose manifest can carry a dependency the scan must see.
  const declaring = loadProviders().filter((e: any) => {
    try { const m = typeof e.standIn.manifest === 'function' ? e.standIn.manifest(e.file) : e.standIn.manifest; return typeof e.deps === 'function' && (e.deps(m) || []).length > 0; } catch { return false; }
  });
  it('there are providers whose stand-in manifest declares a dependency', () => { expect(declaring.length).toBeGreaterThan(1); });
  it.each(declaring.map((e: any) => e.file))('%s: the scan sees every dependency the provider parses, with no manifestKeys', (file) => {
    const eco = declaring.find((e: any) => e.file === file)!;
    const d = mkdtempSync(join(tmpdir(), 'depscan-')); dirs.push(d);
    const manifest = typeof eco.standIn.manifest === 'function' ? eco.standIn.manifest(file) : eco.standIn.manifest;
    writeFileSync(join(d, file), manifest);
    const got = plugin.declaredDependencies(d, { manifestFile: file, scanFileExtensions: ['.x'], importPattern: 'x', vendorDirs: [] });
    for (const dep of eco.deps(manifest)) expect([...got], `${file}: ${dep} declared in the manifest is invisible to the scan`).toContain(dep);
  });
  it('the schema accepts a declaration without manifestKeys, and the scan does not call it incomplete', () => {
    const d = mkdtempSync(join(tmpdir(), 'depcfg-')); dirs.push(d);
    const cfgDir = join(d, 'proj'); mkdirSync(cfgDir);
    writeFileSync(join(d, 'requirements.txt'), 'pytest\n');
    const decl = { manifestFile: 'requirements.txt', scanFileExtensions: ['.py'], importPattern: '^import (\\w+)', installCommand: 'pip install {package}', vendorDirs: ['.venv'] };
    writeFileSync(join(cfgDir, 'dependency-check.json'), JSON.stringify(decl));
    const r = spawnSync('python3', [join(ROOT, 'orchestrations/scripts/lib/manifest_schema.py'), '--validate', '--repo', d], { input: JSON.stringify(decl), encoding: 'utf8' });
    const verdict = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(verdict.issues.filter((i: string) => /schema:/.test(i)), 'the schema refused a text-manifest declaration').toEqual([]);
    const m = plugin.readScanManifest(d, { EPAM_PROJECT_CONFIG_DIR: cfgDir });
    expect(m.ok, m.reason).toBe(true);
  });
});
