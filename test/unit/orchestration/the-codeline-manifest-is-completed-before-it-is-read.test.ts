/**
 * THE CODELINE'S MANIFEST IS COMPLETED FROM ITS ECOSYSTEM BEFORE IT IS READ.
 *
 * regintel 20260916T200108Z, 2026-09-17: a greenfield codeline starts with the project's declared
 * .epam/dependency-check.json; the only completion from the ecosystem provider lived in the
 * orchestrator's codeline loop (brownfield/multi-codeline), so a greenfield main-branch story was
 * verified against a manifest that never learned provisionCommand, runEnvironment or
 * emptyDeliverables after the scaffold story wrote requirements.txt — pytest ran without the
 * venv, an empty __init__.py was judged missing, the story failed through the ladder.
 *
 * complete_codeline_manifests (lib/external-verification.sh) is executed against a codeline on
 * disk with the real codeline-manifests.js; asserted on the manifest file — what verification reads.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function lift(name: string): string {
  const src = engineSource(CLAUDE_SH);
  const start = src.indexOf(`\n${name}() {`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('\n}\n', start) + 3);
}

function complete(seed: object | null, files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), 'manifest-complete-')); dirs.push(d);
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(d, p, '..'), { recursive: true }); writeFileSync(join(d, p), c); }
  if (seed) { mkdirSync(join(d, '.epam'), { recursive: true }); writeFileSync(join(d, '.epam/dependency-check.json'), JSON.stringify(seed)); }
  const script = ['set -uo pipefail', 'log(){ echo "LOG: $*"; }', `NODE_BIN=${JSON.stringify(NODE20)}`, `SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}`, `PROJECT_ROOT=${JSON.stringify(d)}`, lift('complete_codeline_manifests'), `complete_codeline_manifests ${JSON.stringify(d)}`].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60_000 });
  let manifest: any = null;
  try { manifest = JSON.parse(readFileSync(join(d, '.epam/dependency-check.json'), 'utf8')); } catch { /* none */ }
  return { r, manifest };
}

describe('the codeline manifest is completed before it is read', () => {
  // The project's seed: what greenfield_seed_codeline copies in — no provisioning, no run env, no empty-complete list.
  const seed = { manifestFile: 'requirements.txt', scanFileExtensions: ['.py'], importPattern: '^import', vendorDirs: ['__pycache__'], installCommand: 'pip install {package}' };

  it("run 200108Z's shape: once requirements.txt exists, the seeded manifest gains provisionCommand, runEnvironment and emptyDeliverables; its own keys are kept", () => {
    const { r, manifest } = complete(seed, { 'requirements.txt': 'fastapi\n' });
    expect(r.status, r.stderr).toBe(0);
    expect(manifest.provisionCommand, 'no provisioning — tests would run without the environment').toBeTruthy();
    expect(manifest.runEnvironment).toBeTruthy();
    expect(manifest.emptyDeliverables).toContain('__init__.py');
    expect(manifest.vendorDirs).toEqual(['__pycache__']);
    expect(manifest.installCommand).toBe('pip install {package}');
    expect(r.stdout).toMatch(/completed \.epam\/dependency-check\.json .* with .*provisionCommand/);
  });

  it('is idempotent — a second pass adds nothing and says nothing', () => {
    const first = complete(seed, { 'requirements.txt': 'fastapi\n' });
    const d = first.r ? null : null; void d;
    const script = ['set -uo pipefail', 'log(){ echo "LOG: $*"; }', `NODE_BIN=${JSON.stringify(NODE20)}`, `SCRIPT_DIR=${JSON.stringify(join(ROOT, 'orchestrations/scripts'))}`, lift('complete_codeline_manifests'), `complete_codeline_manifests ${JSON.stringify(dirs[dirs.length - 1])}`].join('\n');
    const again = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60_000 });
    expect(again.stdout).toBe('');
  });

  it('a codeline with no manifest file yet (before the scaffold story) is left exactly as seeded', () => {
    const { manifest, r } = complete(seed, {});
    expect(manifest).toEqual(seed);
    expect(r.stdout).toBe('');
  });

  it('a codeline with no .epam/dependency-check.json at all is not given one here', () => {
    const { manifest } = complete(null, { 'requirements.txt': 'x\n' });
    expect(manifest).toBeNull();
  });
});
