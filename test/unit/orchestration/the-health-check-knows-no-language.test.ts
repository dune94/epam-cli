/**
 * THE HEALTH CHECK MUST NOT ASSUME AN ECOSYSTEM.
 *
 * It runs before a run spends anything, and its own header says it "knows no package manager, no
 * test runner and no language". Its body named package.json, node_modules and four npm lockfiles.
 *
 * So a Rust, Python or Ruby codeline declared nothing, had nothing checked, and was reported
 * HEALTHY without being assessed — a free pass from the one gate that exists to stop a run before
 * it pays for an unusable baseline. The failure is silent in the worst direction: it says the word
 * "healthy".
 *
 * Every ecosystem fact now comes from lib/ecosystems.js through one handler. These tests hold that
 * shut in both directions — the shell names no ecosystem, and a repository that declares tooling
 * it cannot resolve is still caught.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ROOT = join(__dirname, '../../..');
const HEALTH = join(ROOT, 'orchestrations/scripts/lib/codeline-health.sh');
const NODE = process.execPath;

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'health-generic-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function repo(name: string, files: Record<string, string>): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  spawnSync('git', ['-C', dir, 'init', '--quiet']);
  return dir;
}

const run = (...paths: string[]) =>
  spawnSync('bash', [HEALTH, ...paths], { encoding: 'utf8', env: { ...process.env, NODE_BIN: NODE } });

describe('the health check knows no language', () => {
  it('names no manifest, lockfile or vendored directory of its own', () => {
    // Every one of these was a literal here. A second table is how the first drift happened.
    const body = readFileSync(HEALTH, 'utf8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))          // comments explain the removal; they are not it
      .join('\n');
    for (const literal of ['package.json', 'node_modules', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']) {
      expect(body, `codeline-health.sh names ${literal} in its own code`).not.toContain(literal);
    }
  });

  it('still catches a repository that cannot resolve its declared tooling', () => {
    // The check that matters. If de-generalising it turned every codeline into a pass, the gate
    // would be gone and would still say "healthy".
    const r = run(repo('broken', {
      'package.json': JSON.stringify({ name: 'broken', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2' } }),
    }));
    expect(`${r.stdout}${r.stderr}`, 'a repo declaring an uninstalled runner was reported healthy')
      .toMatch(/UNHEALTHY/);
  });

  it('reports a repository that declares nothing as healthy, not as broken', () => {
    const r = run(repo('bare', { 'README.md': '# bare\n' }));
    expect(`${r.stdout}${r.stderr}`, 'a repo with nothing to install was called unhealthy')
      .not.toMatch(/UNHEALTHY/);
  });

  it('assesses an ecosystem that is not Node', () => {
    // MUTATION in the direction that was silently broken: a Rust repo used to be invisible to this
    // check entirely. It must at least be RECOGNISED — the registry knows Cargo.toml.
    const dir = repo('rusty', {
      'Cargo.toml': '[package]\nname = "rusty"\n\n[dependencies]\nserde = "1"\n',
      'Cargo.lock': '',
    });
    const facts = spawnSync(NODE, [
      join(ROOT, 'orchestrations/scripts/lib/handlers/codeline-ecosystem.js'), dir,
    ], { encoding: 'utf8' });
    const parsed = JSON.parse(facts.stdout);
    expect(parsed.stack, 'a Cargo repository is still not recognised').toBe('rust');
    expect(parsed.packageManager, 'the lockfile did not decide the package manager').toBe('cargo');
    expect(parsed.installDir, 'rust was given a vendored directory it does not use').toBeNull();
  });
});
