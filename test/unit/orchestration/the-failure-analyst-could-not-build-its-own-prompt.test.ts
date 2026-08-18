/**
 * THE FAILURE ANALYST COULD NOT BUILD ITS PROMPT, ON EVERY ATTEMPT IT WAS NEEDED.
 *
 * Live 2026-08-18, both lanes, all twelve writer attempts each:
 *
 *   [FailureAnalyst] Analyzing test failure for MOCK3-1 (gate=z-ai/glm-5.2)...
 *   [ERROR] [FailureAnalyst] cannot build prompt: prompt 'failure-analyst' is missing values
 *           for: __MANIFEST_FILE__
 *
 * The template declares nine placeholders; the caller's jq supplied eight. So the component whose
 * only job is to diagnose a failing writer was blind for the entire run — the run where a
 * provider/model mismatch went undiagnosed for ten attempts and both stories were failed with
 * correct work already on disk.
 *
 * THE VALUE IS NOT WRITTEN IN THE ENGINE. __MANIFEST_FILE__ is the codeline's manifest name, and
 * the project already declares it — so it is read from dependency-check.json and a project on a
 * different stack answers for itself.
 *
 * AND THAT DECLARATION WAS ITSELF UNREADABLE. mock3's file described the stack as
 * {packageManager, manifest, lockfile} per codeline — a shape no consumer reads — so every
 * attempt also logged "dependency declaration is incomplete — missing: manifestFile,
 * manifestKeys, scanFileExtensions, importPattern, vendorDirs" and the dependency scan never ran.
 * One malformed data file, two silently disabled capabilities.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const TEMPLATES = join(ROOT, 'orchestrations/prompts/templates');
const LIB = join(ROOT, 'orchestrations/scripts/lib/prompt-library.js');
const MOCK3 = join(ROOT, 'orchestrations/projects/mock3');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readScanManifest, REQUIRED_KEYS } = require(join(ROOT, 'orchestrations/plugins/dependency-scan-plugin.js'));

const NODE = process.execPath;

describe('the failure analyst could not build its own prompt', () => {
  it('EVERY PLACEHOLDER THE TEMPLATE DECLARES HAS A VALUE — rendered, not inspected', () => {
    const tpl = JSON.parse(readFileSync(join(TEMPLATES, 'failure-analyst.json'), 'utf8'));
    const values: Record<string, string> = {};
    // The value must not itself contain the token, or the strict renderer sees it as unreplaced.
    for (const p of tpl.placeholders as string[]) values[p] = `value for ${p.replace(/_/g, ' ').trim()}`;

    // Render through the real library, against a project whose prompt copy is the template
    // itself — the bootstrap shape. The renderer is strict, so a missing value throws here
    // exactly as it did live.
    const dir = mkdtempSync(join(tmpdir(), 'analyst-render-'));
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'prompts', 'failure-analyst.json'), JSON.stringify(tpl));
    const vf = join(dir, 'values.json');
    writeFileSync(vf, JSON.stringify(values));
    const r = spawnSync(NODE, [LIB, 'render', 'failure-analyst', dir, vf], { encoding: 'utf8' });
    expect(r.status, `render failed: ${r.stderr}`).toBe(0);
    expect(r.stdout.length, 'the analyst prompt rendered empty').toBeGreaterThan(200);
    rmSync(dir, { recursive: true, force: true });
  });

  it('THE CALLER SUPPLIES ALL OF THEM — the eight-of-nine that killed the diagnosis', () => {
    // The engine's values file is built by one jq call; every declared placeholder must be a key
    // in it, or the render throws exactly as it did live.
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
    const tpl = JSON.parse(readFileSync(join(TEMPLATES, 'failure-analyst.json'), 'utf8'));
    const start = src.indexOf('"__ANALYST_PROFILE__":$profile');
    expect(start, 'the analyst values block was not found').toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('> "$_analyst_values"', start));
    for (const p of tpl.placeholders as string[]) {
      expect(block, `the analyst values block never supplies ${p}`).toContain(p);
    }
  });

  it("MOCK3'S DEPENDENCY DECLARATION IS READABLE BY ITS CONSUMER — executed", () => {
    const res = readScanManifest('/nonexistent-project-root', { EPAM_PROJECT_CONFIG_DIR: MOCK3 });
    expect(res.ok, `the dependency scan is still disabled: ${res.reason}`).toBe(true);
    for (const k of REQUIRED_KEYS) {
      expect(res.cfg[k], `dependency-check.json has no usable '${k}'`).toBeTruthy();
    }
  });

  it('the manifest name the analyst is given is the one the project declares', () => {
    const cfg = JSON.parse(readFileSync(join(MOCK3, 'dependency-check.json'), 'utf8'));
    const pkg = JSON.parse(readFileSync(
      '/home/bradleyjerome/projects/mock3/mock-a/package.json', 'utf8'));
    expect(cfg.manifestFile, 'the declared manifest is not the file the codeline actually has')
      .toBe('package.json');
    expect(pkg.name).toBe('mock-a');
  });

  it('AND THE ENGINE READS IT FROM THERE, not from a name written into the engine', () => {
    const src = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
    const i = src.indexOf('_analyst_manifest_file=$(jq');
    expect(i, 'the manifest name is not read from the project declaration').toBeGreaterThan(-1);
    expect(src.slice(i, i + 200), 'it reads from somewhere other than dependency-check.json')
      .toContain('dependency-check.json');
  });
});
