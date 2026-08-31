/**
 * THREE DISCOVERY PRODUCERS, EACH REPLACING A FABRICATION, NONE WITH A TEST.
 *
 * codeline-ecosystem.js: codeline-health.sh claims to know "no package manager, no test runner and
 * no language" and its body named package.json, node_modules and four npm lockfiles. A Rust, Python
 * or Ruby codeline declared nothing, had nothing checked, and was reported HEALTHY without being
 * assessed — a free pass from the one gate that exists to stop a run before it pays for an unusable
 * baseline.
 *
 * codeline-manifests.js: the orchestrator wrote .epam manifests into every worktree from heredocs
 * asserting, of a repository it had never inspected, that it is TypeScript with npm and vitest.
 * Seventeen scripts read that file as the codeline's OWN declaration, so a Python repository was
 * handed a document saying it is TypeScript and everything downstream behaved "generically" against
 * a lie, in client-repo space.
 *
 * codeline-facts.js: the shape is not negotiable. The engine reads it with `jq '.[$cl]'` — codeline
 * names at the TOP LEVEL. A file nesting them one level down parses fine, satisfies every structural
 * check anyone writes in JS, and returns empty for every codeline. The hand-written mock3 file did
 * exactly that and provisioning skipped it in silence.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');
const NODE = process.execPath;

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'cl-'));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

function run(script: string, args: string[]) {
  const r = spawnSync(NODE, [join(S, script), ...args], { encoding: 'utf8', timeout: 60_000 });
  let json: any = null;
  try { json = JSON.parse(r.stdout || ''); } catch { /* not JSON */ }
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '', json };
}

describe('codeline-ecosystem names what the repository carries, whatever that is', () => {
  it.each([
    ['package.json', '{"name":"x"}', 'node'],
    ['requirements.txt', 'requests==2.0\n', 'python'],
    ['go.mod', 'module x\n', 'go'],
    ['Cargo.toml', '[package]\nname="x"\n', 'rust'],
    ['Gemfile', "source 'https://rubygems.org'\n", 'ruby'],
    ['composer.json', '{"name":"x/y"}', 'php'],
  ])('%s is recognised', (manifest, body, stack) => {
    // Every one of these but the first was invisible before: the health gate named npm files only,
    // so these repositories were reported healthy without being assessed at all.
    const dir = repo({ [manifest]: body });
    const r = run('lib/handlers/codeline-ecosystem.js', [dir]);
    expect(r.code, r.err).toBe(0);
    expect(r.json.manifest, `${manifest} was not found`).toBe(manifest);
    expect(String(r.json.stack), `${manifest} resolved to no stack`).toBe(stack);
  }, 90_000);

  it('a repository declaring NOTHING says so, rather than being called node', () => {
    const dir = repo({ 'README.md': '# just docs\n' });
    const r = run('lib/handlers/codeline-ecosystem.js', [dir]);
    expect(r.code).toBe(0);
    expect(r.json.stack, 'a repository with no manifest was given a stack anyway').toBe('');
    expect(r.json.manifest).toBe('');
  }, 90_000);

  it('and it reports where that ecosystem vendors dependencies, or that it vendors none', () => {
    const node = run('lib/handlers/codeline-ecosystem.js', [repo({ 'package.json': '{}' })]);
    expect(node.json.installDir, 'node was not told where it vendors').toBeTruthy();
    const go = run('lib/handlers/codeline-ecosystem.js', [repo({ 'go.mod': 'module x\n' })]);
    expect('installDir' in go.json, 'installDir is missing rather than declared null').toBe(true);
  }, 90_000);

  it('a missing repository is refused rather than described', () => {
    const r = run('lib/handlers/codeline-ecosystem.js', ['/no/such/repo']);
    expect(r.json === null || r.json.stack === '',
      'a repository that does not exist was given an ecosystem').toBe(true);
  }, 90_000);
});

describe('codeline-manifests assembles from the provider, never from a template', () => {
  it('a PYTHON repository is not handed a document saying it is TypeScript', () => {
    // The fabrication this replaced: heredocs asserting package.json / .ts / node_modules / npm for
    // a repository nobody had inspected. Seventeen scripts read this document as ground truth.
    const dir = repo({ 'requirements.txt': 'requests==2.0\n' });
    const r = run('lib/handlers/codeline-manifests.js', [dir]);
    expect(r.code, r.err).toBe(0);
    const body = JSON.stringify(r.json);
    expect(r.json, 'no manifest was produced at all').toBeTruthy();
    expect(body, 'a python repository was declared to be TypeScript').not.toMatch(/\.tsx?"/);
    expect(body, 'a python repository was told its vendor directory is node_modules')
      .not.toContain('node_modules');
    expect(body, 'the python source extension is not declared').toContain('.py');
  }, 90_000);

  it('and a NODE repository still gets the node answer — the fix did not invert the bug', () => {
    const dir = repo({ 'package.json': '{"name":"x"}' });
    const r = run('lib/handlers/codeline-manifests.js', [dir]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.stringify(r.json)).toMatch(/package\.json/);
  }, 90_000);

  it('a repository declaring no ecosystem gets NOTHING, and is told why', () => {
    // Writing a guessed manifest here is the whole defect. Refusing names the missing declaration
    // instead of inventing one in client-repo space.
    const dir = repo({ 'README.md': '# docs\n' });
    const r = run('lib/handlers/codeline-manifests.js', [dir]);
    expect(r.code, 'a repository with no ecosystem was given a manifest anyway').not.toBe(0);
    expect(r.err, 'the refusal does not say what is missing').toMatch(/no provider declares/i);
  }, 90_000);

  it('no argument is refused rather than writing into the current directory', () => {
    const r = run('lib/handlers/codeline-manifests.js', []);
    expect(r.code, 'it ran with no codeline root and wrote somewhere').not.toBe(0);
  }, 90_000);
});
