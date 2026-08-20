// THE DEPENDENCY INSTALLER WAS NINE `if` BRANCHES, ONE PER ECOSYSTEM THE ENGINE HAPPENED TO KNOW.
//
// run-agent-orchestration.sh:1003 tested for package.json, Pipfile, requirements.txt, pyproject.toml,
// Cargo.toml, go.mod, pom.xml, build.gradle, Gemfile and composer.json, and ran a hardcoded command
// for each. A tenth ecosystem meant a tenth branch in an 11,000-line engine file — the same defect
// as the ecosystems table, expressed as control flow instead of data.
//
// The providers already answer this: each declares `installCommand(manager, opts)` and `installDir`.
// The engine's job is the part that is NOT ecosystem-specific and must never be delegated:
//
//   - the default is NON-DESTRUCTIVE. `npm ci` deletes node_modules first; on 2026-07-28 that wiped
//     a working 1,530-package install, hit a 401 on a private dependency, aborted, and left the
//     codeline EMPTY — strictly worse than it found it. Clean installs are opt-in, per codeline.
//   - a repair that leaves LESS than it found is reported as destruction, not as a successful
//     install. That check generalises through `installDir`, which every provider declares.
//
// THE FABRICATED STACK IS THE PROOF. An ecosystem that has never existed must install correctly
// with no engine change; passing on node and python is consistent with a two-branch chain.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const PLAN = join(SCRIPTS, 'lib/handlers/install-plan.js');
const LIB = join(SCRIPTS, 'lib/deps-install.sh');
const NODE = process.execPath;
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'deps-')); made.push(d); return d; }

/** The plan the engine would execute for a codeline: one "manifest\tinstallDir\tcommand" per line. */
function plan(root: string, clean = '0', env: NodeJS.ProcessEnv = {}): string {
  const r = spawnSync(NODE, [PLAN, root, clean], { encoding: 'utf8', env: { ...process.env, ...env } });
  return ((r.stdout || '') + (r.stderr || '')).trim();
}

/** A provider directory for a stack that does not exist. */
function fabricatedProvider(): string {
  const d = tmp();
  writeFileSync(join(d, 'widget.js'), `module.exports = {
    file: 'widget.manifest', stack: 'widget', precedence: 1,
    installDir: 'widget_deps', artifactDirs: ['widget_deps'],
    installCommand: (m, o) => (o && o.clean ? 'widgetpm sync --frozen' : 'widgetpm sync'),
  };\n`);
  return d;
}

describe('the plan comes from the providers', () => {
  it('a node codeline plans an npm install against node_modules', () => {
    const root = tmp();
    writeFileSync(join(root, 'package.json'), '{"name":"x"}');
    const out = plan(root);
    expect(out).toMatch(/package\.json/);
    expect(out).toMatch(/node_modules/);
    expect(out).toMatch(/npm/);
  });

  it('a python codeline plans pip, with no node branch involved', () => {
    const root = tmp();
    writeFileSync(join(root, 'requirements.txt'), 'requests\n');
    const out = plan(root);
    expect(out).toMatch(/requirements\.txt/);
    expect(out).toMatch(/pip install/);
    expect(out).not.toMatch(/npm/);
  });

  it('a codeline with no manifest plans NOTHING — never a guessed default', () => {
    const root = tmp();
    writeFileSync(join(root, 'README.md'), '# r\n');
    expect(plan(root)).toBe('');
  });

  it('the ecosystems the old if-chain knew all have providers now', () => {
    // pom.xml, build.gradle, Pipfile and composer.json were branches in the engine with no provider
    // at all — so deleting the chain would have silently dropped four ecosystems.
    for (const [manifest, expected] of [
      ['pom.xml', /mvn/], ['build.gradle', /gradle/], ['Pipfile', /pipenv/], ['composer.json', /composer/],
    ] as [string, RegExp][]) {
      const root = tmp();
      writeFileSync(join(root, manifest), manifest === 'composer.json' ? '{}' : 'x\n');
      expect(plan(root), `${manifest} plans nothing`).toMatch(expected);
    }
  });
});

describe('destructive is opt-in, per the 2026-07-28 wipe', () => {
  it('the default plan is the NON-destructive command', () => {
    const root = tmp();
    writeFileSync(join(root, 'package.json'), '{"name":"x"}');
    writeFileSync(join(root, 'package-lock.json'), '{}');
    expect(plan(root, '0'), 'a lockfile alone selected `npm ci`, which deletes node_modules').not.toMatch(/\bci\b/);
  });

  it('and the clean command is planned only when explicitly asked', () => {
    const root = tmp();
    writeFileSync(join(root, 'package.json'), '{"name":"x"}');
    writeFileSync(join(root, 'package-lock.json'), '{}');
    expect(plan(root, '1')).toMatch(/\bci\b/);
  });
});

describe('a stack that has never existed installs with no engine change', () => {
  it('is planned from its own provider', () => {
    const root = tmp();
    writeFileSync(join(root, 'widget.manifest'), 'name: w\n');
    const out = plan(root, '0', { EPAM_ECOSYSTEM_PROVIDERS: fabricatedProvider() });
    expect(out).toMatch(/widgetpm sync/);
    expect(out).toMatch(/widget_deps/);
  });

  it('and honours the clean opt-in the same way', () => {
    const root = tmp();
    writeFileSync(join(root, 'widget.manifest'), 'name: w\n');
    expect(plan(root, '1', { EPAM_ECOSYSTEM_PROVIDERS: fabricatedProvider() })).toMatch(/--frozen/);
  });
});

describe('the engine runs the plan and judges the result', () => {
  /** Run the installer with a stubbed command on PATH, so no real package manager is invoked. */
  function install(root: string, stub: string): { out: string; status: number } {
    const bin = tmp();
    writeFileSync(join(bin, 'widgetpm'), `#!/usr/bin/env bash\n${stub}\n`, { mode: 0o755 });
    const providers = fabricatedProvider();
    const r = spawnSync('bash', ['-c',
      `set -uo pipefail
       export PATH=${JSON.stringify(bin)}:$PATH
       export EPAM_ECOSYSTEM_PROVIDERS=${JSON.stringify(providers)}
       SCRIPT_DIR=${JSON.stringify(SCRIPTS)}
       warning() { echo "WARN: $*"; }; error() { echo "ERROR: $*"; }
       success() { echo "OK: $*"; }; info() { echo "INFO: $*"; }
       source ${JSON.stringify(LIB)}
       detect_and_install_dependencies ${JSON.stringify(root)} ${JSON.stringify(NODE)}
       echo "RC=$?"`,
    ], { encoding: 'utf8' });
    return { out: (r.stdout || '') + (r.stderr || ''), status: r.status ?? -1 };
  }

  it('runs the planned command', () => {
    const root = tmp();
    writeFileSync(join(root, 'widget.manifest'), 'name: w\n');
    mkdirSync(join(root, 'widget_deps'), { recursive: true });
    writeFileSync(join(root, 'widget_deps', 'a'), 'x');
    const r = install(root, 'mkdir -p widget_deps/b; exit 0');
    expect(r.out).toMatch(/OK:/);
    expect(r.out).toMatch(/RC=0/);
  });

  it('reports a FAILED install rather than passing it on', () => {
    const root = tmp();
    writeFileSync(join(root, 'widget.manifest'), 'name: w\n');
    const r = install(root, 'echo "auth wall" >&2; exit 1');
    expect(r.out).toMatch(/WARN:.*FAILED|ERROR:/);
    expect(r.out).not.toMatch(/RC=0/);
  });

  it('reports a repair that left LESS than it found — the 2026-07-28 wipe', () => {
    const root = tmp();
    writeFileSync(join(root, 'widget.manifest'), 'name: w\n');
    mkdirSync(join(root, 'widget_deps'), { recursive: true });
    for (const n of ['a', 'b', 'c']) writeFileSync(join(root, 'widget_deps', n), 'x');
    const r = install(root, 'rm -rf widget_deps; mkdir -p widget_deps; exit 0');
    expect(r.out, 'a repair emptied the tree and was reported as success').toMatch(/DESTROYED WHAT IT FOUND/);
    expect(r.out).not.toMatch(/RC=0/);
  });
});

describe('the engine names no ecosystem', () => {
  it('the installer library contains no manifest filename or package-manager name', () => {
    expect(existsSync(LIB), 'the installer still lives inline in the 11k-line engine file').toBe(true);
    const src = readFileSync(LIB, 'utf8')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    for (const name of ['package.json', 'Pipfile', 'requirements.txt', 'pyproject.toml', 'Cargo.toml',
      'go.mod', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json',
      'npm', 'pipenv', 'cargo', 'mvn', 'gradle', 'bundle', 'composer']) {
      expect(src, `the installer still names ${name}`).not.toMatch(new RegExp(`\\b${name.replace('.', '\\.')}\\b`));
    }
  });

  it('and the engine sources the library rather than defining its own', () => {
    const eng = readFileSync(join(SCRIPTS, 'run-agent-orchestration.sh'), 'utf8');
    expect(eng).toMatch(/deps-install\.sh/);
    const defs = eng.split('\n').filter((l) => /^detect_and_install_dependencies\(\)/.test(l));
    expect(defs, 'the inline nine-branch copy is still in the engine').toEqual([]);
  });
});
