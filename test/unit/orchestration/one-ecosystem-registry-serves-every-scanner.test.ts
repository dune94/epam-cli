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

  // REMOVED: 'the repo scan labels an ecosystem the registry knows and its own code does not name'.
  //
  // codeline-discovery.js no longer labels a repository's stack. It reported one by matching the
  // FIRST manifest file it found in registry order, so a repository with two ecosystems was
  // labelled by the order of a list — and that label went into the one decision that picks which
  // client repository gets modified. The discovery agent has read_file and dependency_contract
  // and establishes this itself, for the repositories it actually cares about.
  //
  // The registry still serves every OTHER scanner, which is this file's subject; the remaining
  // tests cover that.


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
// REMOVED: the suite holding the repo scan to declared exclusion patterns.
//
// The scan excluded repositories whose directory name matched a regex — /^docs\./i, then that
// same pattern relocated to config/codeline-scan.json. Moving the literal out of the scanner did
// not make it project data: it stayed an engine default asserting one client's naming habit over
// every project, and it failed in the direction of doing LESS, silently, on a project whose
// product is a documentation platform.
//
// Nothing is excluded now. The agent sees every repository and can rule one out with a reason,
// which a regex cannot.
