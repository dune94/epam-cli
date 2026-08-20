/**
 * THE REQUIREMENT: the engine knows an ecosystem in ONE place.
 *
 * Two scanners each carried their own table and they had already drifted.
 * codeline-structure.js knows six manifest files; codeline-discovery.js's repo scan knew three, so
 * a Rust or Ruby repository was labelled `unknown` in the manifest handed to the discovery agent —
 * on the one input it uses to decide which client repository gets written to.
 *
 * Adding an ecosystem must be an edit in one place. These tests prove it by MUTATION: a manifest
 * file that exists in the registry and nowhere in either scanner's own code still gets detected.
 *
 * Nothing here names a project. A repository fixture is built from scratch per case.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib');

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'ecosystem-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

/** A git repo whose only distinguishing feature is which manifest file it carries. */
function repoWith(name: string, manifestFile: string, contents: string): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, manifestFile), contents);
  writeFileSync(join(dir, 'README.md'), `# ${name}\n\nThis service handles the ${name} domain for the estate.\n`);
  spawnSync('git', ['-C', dir, 'init', '--quiet']);
  return dir;
}

const ecosystems = () => require(join(LIB, 'ecosystem-registry.js'));

describe('one ecosystem registry serves every scanner', () => {
  it('the registry exists and names every manifest file the structure scanner already knew', () => {
    const reg = ecosystems();
    const files = reg.MANIFESTS.map((m: { file: string }) => m.file);
    // The six the structure scanner shipped with. Losing one here would silently stop detecting
    // that ecosystem in BOTH scanners now that they share this.
    for (const f of ['package.json', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'Gemfile']) {
      expect(files, `the registry dropped ${f}`).toContain(f);
    }
  });

  it('every registry entry carries the ecosystem label the repo scan reports', () => {
    for (const m of ecosystems().MANIFESTS) {
      expect(m.stack, `${m.file} has no ecosystem label, so a repo carrying it scans as unknown`)
        .toBeTruthy();
    }
  });

  it('the repo scan labels an ecosystem the registry knows and its own code does not name', () => {
    // MUTATION, in the only direction that matters: Cargo.toml is in the registry and appears
    // nowhere in codeline-discovery.js. A scanner with its own table reports `unknown` here.
    const { buildRepoManifest } = require(join(LIB, 'codeline-discovery.js'));
    repoWith('cargo-repo', 'Cargo.toml', '[package]\nname = "cargo-repo"\n');

    const entry = buildRepoManifest(work).find((e: { name: string }) => e.name === 'cargo-repo');
    expect(entry, 'the scan did not see the repository at all').toBeTruthy();

    const expected = ecosystems().MANIFESTS.find((m: { file: string }) => m.file === 'Cargo.toml').stack;
    expect(entry.stack, 'the repo scan carries its own table and does not know this ecosystem')
      .toBe(expected);
  });

  it('neither scanner writes a manifest filename of its own', () => {
    // A second table is how the first drift happened. Any manifest filename appearing as a literal
    // outside the registry is a table forming again.
    const files = ecosystems().MANIFESTS.map((m: { file: string }) => m.file);
    for (const scanner of ['codeline-discovery.js', 'codeline-structure.js']) {
      const src = readFileSync(join(LIB, scanner), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))     // comments explain the drift; they are not it
        .join('\n');
      for (const f of files) {
        expect(src, `${scanner} names ${f} in its own code — that is the second table re-forming`)
          .not.toContain(`'${f}'`);
      }
    }
  });
});

/**
 * The scan's exclusions were a `/^docs\./i` literal — one naming convention as an engine fact. A
 * project whose documentation repos are named otherwise got no exclusion, and a project with an
 * in-scope repo matching the pattern could not opt out without editing the engine.
 */
describe('what the repo scan skips is data', () => {
  const scan = (root: string) => {
    delete require.cache[require.resolve(join(LIB, 'codeline-discovery.js'))];
    return require(join(LIB, 'codeline-discovery.js')).buildRepoManifest(root)
      .map((e: { name: string }) => e.name);
  };

  it('excludes by the shipped patterns when nothing overrides them', () => {
    repoWith('docs.portal', 'README.md', '# docs\n');
    repoWith('alpha-service', 'package.json', '{"name":"alpha"}');
    delete process.env.EPAM_CODELINE_EXCLUDE;
    const seen = scan(work);
    expect(seen, 'a documentation repo reached the candidate list').not.toContain('docs.portal');
    expect(seen).toContain('alpha-service');
  });

  it('follows an override rather than the shipped pattern', () => {
    // MUTATION in both directions at once: the repo the default excludes comes BACK, and one it
    // keeps is dropped. A literal in the scanner can do neither.
    repoWith('docs.portal', 'README.md', '# docs\n');
    repoWith('alpha-service', 'package.json', '{"name":"alpha"}');
    process.env.EPAM_CODELINE_EXCLUDE = '^alpha';
    try {
      const seen = scan(work);
      expect(seen, 'the override did not bring the default-excluded repo back').toContain('docs.portal');
      expect(seen, 'the override did not exclude what it named').not.toContain('alpha-service');
    } finally {
      delete process.env.EPAM_CODELINE_EXCLUDE;
    }
  });

  it('names no exclusion pattern in the scanner itself', () => {
    const src = readFileSync(join(LIB, 'codeline-discovery.js'), 'utf8')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const p of JSON.parse(readFileSync(
      join(ROOT, 'orchestrations/config/codeline-scan.json'), 'utf8')).exclude) {
      expect(src, `the scanner writes the pattern ${p} in its own code`).not.toContain(p);
    }
  });
});
