// THE ENGINE WROTE A TYPESCRIPT DECLARATION INTO EVERY CLIENT CODELINE THAT LACKED ONE.
//
// run-agent-orchestration.sh:3196 wrote three .epam/ manifests into each codeline worktree from
// heredocs — 80 lines asserting, of a repository it had never looked at:
//
//   dependency-check.json   manifestFile "package.json", scanFileExtensions [.ts .tsx .js ...],
//                           installCommand "npm install --save-dev {package}",
//                           requiredDevDependencies ["typescript","@types/node","vitest","tsx"],
//                           vendorDirs ["node_modules"]
//   contract-generation.json  language "typescript", TS interface/class/ctor regexes, vi.mock templates
//   known-fixes.json          a vitest passWithNoTests fix targeting vitest.config.ts
//
// THIS IS WORSE THAN ASSUMING A STACK. Seventeen scripts read dependency-check.json as the
// codeline's own declaration — it is the ground truth every generic component consults. Fabricating
// it defeats that genericity at the source: a Python repository is handed a document saying it is
// TypeScript with vitest, and everything downstream then behaves "generically" against a lie.
//
// It also wrote into client-repo space with facts nobody detected.
//
// The ecosystem facts belong to the provider that owns the ecosystem. A codeline no provider
// recognises now gets NOTHING, and the engine says so — an undeclared codeline is a state to
// report, never one to invent a declaration for.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const HANDLER = join(SCRIPTS, 'lib/handlers/codeline-manifests.js');
const ENGINE = join(SCRIPTS, 'run-agent-orchestration.sh');
const NODE = process.execPath;
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'clm-')); made.push(d); return d; }

function manifests(root: string, env: NodeJS.ProcessEnv = {}): { out: string; status: number } {
  const r = spawnSync(NODE, [HANDLER, root], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { out: (r.stdout || '').trim(), status: r.status ?? -1 };
}

describe('a codeline no provider recognises', () => {
  it('gets NOTHING — never a fabricated declaration', () => {
    const root = tmp();
    writeFileSync(join(root, 'README.md'), '# a repository of unknown ecosystem\n');
    const r = manifests(root);
    expect(r.out, 'a declaration was invented for a codeline nobody looked at').toBe('');
    expect(r.status, 'silence must be distinguishable from success').not.toBe(0);
  });
});

describe('a node codeline', () => {
  const nodeRoot = () => {
    const root = tmp();
    writeFileSync(join(root, 'package.json'), '{"name":"x"}');
    return root;
  };

  it('gets its manifest file and vendor dir from the provider', () => {
    const j = JSON.parse(manifests(nodeRoot()).out);
    expect(j['dependency-check.json'].manifestFile).toBe('package.json');
    expect(j['dependency-check.json'].vendorDirs).toContain('node_modules');
  });

  it('gets the ADD command, not a duplicated literal', () => {
    // `npm install --save-dev {package}` was written out by hand beside the provider's own
    // addCommand — two spellings of one fact, and the copy is the one that drifts.
    const j = JSON.parse(manifests(nodeRoot()).out);
    expect(j['dependency-check.json'].installCommand).toContain('{package}');
  });

  it('is NOT told which dev dependencies it must have', () => {
    // requiredDevDependencies: ["typescript","@types/node","vitest","tsx"] is not a fact about a
    // client repository. It is this pipeline requiring a toolchain of somebody else's codebase.
    const j = JSON.parse(manifests(nodeRoot()).out);
    expect(j['dependency-check.json'].requiredDevDependencies ?? [],
      'the pipeline still imposes a toolchain on the client repo').toEqual([]);
  });

  it('still gets the contract-generation and known-fixes it actually needs', () => {
    const j = JSON.parse(manifests(nodeRoot()).out);
    expect(j['contract-generation.json'].language).toBe('typescript');
    expect(JSON.stringify(j['known-fixes.json'])).toMatch(/passWithNoTests/);
  });
});

describe('a python codeline', () => {
  it('is never described as typescript', () => {
    const root = tmp();
    writeFileSync(join(root, 'requirements.txt'), 'requests\n');
    const r = manifests(root);
    expect(r.out).not.toMatch(/typescript/i);
    expect(r.out).not.toMatch(/node_modules/);
    expect(r.out).not.toMatch(/vitest/);
  });

  it('and gets its own manifest file if its provider declares the facts', () => {
    const root = tmp();
    writeFileSync(join(root, 'requirements.txt'), 'requests\n');
    const out = manifests(root).out;
    if (out) expect(JSON.parse(out)['dependency-check.json'].manifestFile).toBe('requirements.txt');
  });
});

describe('a stack that has never existed', () => {
  it('is described by its own provider, with no engine change', () => {
    const providers = tmp();
    writeFileSync(join(providers, 'widget.js'), `module.exports = {
      file: 'widget.manifest', stack: 'widget', precedence: 1,
      installDir: 'widget_deps', artifactDirs: ['widget_deps'],
      addCommand: () => 'widgetpm add {package}',
      // Declared the way the shipped providers declare it: a provider that supplies only its own
      // identity has not said how the codeline is checked, and the handler writes nothing.
      codelineManifests: {
        dependencyCheck: { manifestKeys: ['uses'], importPattern: '^use\\\\s+(\\\\S+)' },
      },
    };\n`);
    const root = tmp();
    writeFileSync(join(root, 'widget.manifest'), 'name: w\n');
    const j = JSON.parse(manifests(root, { EPAM_ECOSYSTEM_PROVIDERS: providers }).out);
    expect(j['dependency-check.json'].manifestFile).toBe('widget.manifest');
    expect(j['dependency-check.json'].vendorDirs).toContain('widget_deps');
    expect(j['dependency-check.json'].installCommand).toBe('widgetpm add {package}');
  });
});

describe('the engine no longer authors the declaration', () => {
  const src = () => readFileSync(ENGINE, 'utf8');

  it('the heredocs are gone', () => {
    expect(src(), 'the engine still writes a declaration from a heredoc')
      .not.toMatch(/DEPCHECK_EOF|CONTRACTGEN_EOF|KNOWNFIXES_EOF/);
  });

  it('and it names no TypeScript or Node fact where it writes codeline manifests', () => {
    const i = src().indexOf('.epam/dependency-check.json');
    expect(i, 'the write site is gone entirely — check this test still points at something')
      .toBeGreaterThan(-1);
    const block = src().slice(Math.max(0, i - 500), i + 2500)
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    for (const fact of ['typescript', 'vitest', 'node_modules', '@types/node', 'npm install']) {
      expect(block, `the engine still asserts ${fact} of a codeline it never inspected`)
        .not.toMatch(new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    }
  });

  it('and it calls the handler', () => {
    expect(src()).toMatch(/codeline-manifests\.js/);
  });
});
