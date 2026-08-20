// THE ENGINE CARRIED A TABLE OF "THE ECOSYSTEMS THIS ENGINE KNOWS".
//
// lib/ecosystems.js listed six stacks in engine source. Every guard that consulted it was generic
// only across those six: onboarding a seventh meant editing the pipeline. A table of stacks inside
// the engine is the same defect as a literal inside a guard, one level up — the fact belongs to the
// codeline and arrives at run time, or it is a second definition that drifts.
//
// It is now a REGISTRY that discovers providers by listing directories, and a provider per
// ecosystem carrying its own parsers. Adding a stack is a new file. The engine names none.
//
// THE DECISIVE TEST IS THE FABRICATED STACK. Node and Python fixtures cannot prove genericity —
// passing them is consistent with a two-entry lookup table. An ecosystem that has never existed,
// with invented manifest, invented lockfile and an invented dependency syntax, can only work if
// nothing in the pipeline knows any stack at all.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const LIB = join(ROOT, 'orchestrations/scripts/lib');
const REGISTRY = join(LIB, 'ecosystem-registry.js');
const PROVIDERS = join(ROOT, 'orchestrations/ecosystems');
const NODE = process.execPath;
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** Run an expression against the registry, optionally with injected provider dirs. */
function inRegistry(expr: string, env: NodeJS.ProcessEnv = {}): string {
  const r = spawnSync(NODE, ['-e',
    `const r=require(${JSON.stringify(REGISTRY)}); process.stdout.write(String(${expr}));`,
  ], { encoding: 'utf8', env: { ...process.env, ...env } });
  return (r.stdout || '') + (r.stderr || '');
}

/** A provider directory for a stack that does not exist. */
function fabricatedStack(precedence?: number): string {
  const d = mkdtempSync(join(tmpdir(), 'eco-')); made.push(d);
  writeFileSync(join(d, 'widget.js'), `module.exports = {
    file: 'widget.manifest',
    stack: 'widget',
    ${precedence === undefined ? '' : `precedence: ${precedence},`}
    installDir: 'widget_deps',
    protectedFiles: ['widget.manifest'],
    artifactDirs: ['widget_deps', '.widget-cache'],
    lockfiles: { 'widget.lock': 'widgetpm' },
    installCommand: () => 'widgetpm sync',
    selfName: (t) => (t.match(/^name:\\s*(\\S+)/m) || [])[1] || '',
    deps: (t) => [...t.matchAll(/^use\\s+(\\S+)/gm)].map((m) => m[1]),
  };\n`);
  return d;
}

describe('the table is gone', () => {
  it('lib/ecosystems.js no longer exists', () => {
    expect(existsSync(join(LIB, 'ecosystems.js')),
      'the engine still carries a table of the stacks it knows').toBe(false);
  });

  it('the registry source names no manifest file of its own', () => {
    const src = readFileSync(REGISTRY, 'utf8')
      .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    for (const m of ['package.json', 'pyproject.toml', 'Cargo.toml', 'Gemfile', 'go.mod', 'requirements.txt']) {
      expect(src, `the registry names ${m} — it is a table again`).not.toContain(m);
    }
  });

  it('every file that CONSUMES the registry names no manifest of its own', () => {
    // Scoped by who requires the registry, not by a list kept here: those are exactly the files
    // that resolve an ecosystem, and any manifest filename in one of them is a second table.
    const bad: string[] = [];
    for (const dir of [LIB, join(LIB, 'handlers')]) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
        if (f === 'ecosystem-registry.js') continue;
        const p = join(dir, f);
        const src = readFileSync(p, 'utf8');
        if (!/require\(['"][^'"]*ecosystem-registry\.js['"]\)/.test(src)) continue;
        src.split('\n').forEach((l, i) => {
          if (/^\s*(\*|\/\/|\/\*)/.test(l)) return;
          for (const m of ['package.json', 'pyproject.toml', 'Cargo.toml', 'Gemfile', 'go.mod']) {
            if (l.includes(m)) bad.push(`${f}:${i + 1}  ${m}`);
          }
        });
      }
    }
    expect(bad, `a registry consumer carries its own manifest name:\n${bad.join('\n')}`).toEqual([]);
  });

  it('and the scan is real — it found files that do consume the registry', () => {
    const consumers = [LIB, join(LIB, 'handlers')].flatMap((dir) =>
      readdirSync(dir).filter((f) => f.endsWith('.js'))
        .filter((f) => /ecosystem-registry\.js/.test(readFileSync(join(dir, f), 'utf8'))));
    expect(consumers.length, 'nothing consumes the registry, so the assertion above is vacuous')
      .toBeGreaterThan(1);
  });
});

describe('providers are discovered, not enumerated', () => {
  it('the shipped providers load from a directory', () => {
    expect(Number(inRegistry('r.loadProviders().length'))).toBeGreaterThanOrEqual(6);
  });

  it('each shipped provider is one file naming one manifest', () => {
    const files = readdirSync(PROVIDERS).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const mod = require(join(PROVIDERS, f));
      expect(typeof mod.file, `${f} declares no manifest file`).toBe('string');
    }
  });
});

describe('a stack that has never existed', () => {
  const env = () => ({ EPAM_ECOSYSTEM_PROVIDERS: fabricatedStack() });

  it('is resolved with no engine change', () => {
    const e = env();
    expect(inRegistry('r.allManifests().some(x=>x.file==="widget.manifest")', e)).toBe('true');
  });

  it('brings its own dependency parser', () => {
    const e = env();
    expect(inRegistry('JSON.stringify(r.allManifests().find(x=>x.file==="widget.manifest").deps("use alpha\\nuse beta"))', e))
      .toBe('["alpha","beta"]');
  });

  it('contributes its artifact directories to the union', () => {
    const e = env();
    expect(inRegistry('r.allArtifactDirs().includes(".widget-cache")', e)).toBe('true');
  });

  it('resolves its own lockfile and package manager', () => {
    const e = env();
    expect(inRegistry('r.lockfileFor(r.allManifests().find(x=>x.file==="widget.manifest"), f=>f==="widget.lock")', e))
      .toBe('widget.lock');
  });
});

describe('ordering is declared by providers, never by the engine', () => {
  it('a provider that declares a lower precedence resolves first', () => {
    // First-match-wins: four consumers resolve a repository's ecosystem with `.find(exists)`, so
    // load order is behaviour. A repo carrying two manifests must not resolve by directory sort.
    const e = { EPAM_ECOSYSTEM_PROVIDERS: fabricatedStack(1) };
    expect(inRegistry('r.allManifests()[0].file', e)).toBe('widget.manifest');
  });

  it('and one that declares none sorts last, never silently ahead', () => {
    const e = { EPAM_ECOSYSTEM_PROVIDERS: fabricatedStack() };
    expect(inRegistry('r.allManifests()[r.allManifests().length-1].file', e)).toBe('widget.manifest');
  });
});

describe('absence is never a pass', () => {
  it('a provider that fails to load is reported, not silently dropped', () => {
    const d = mkdtempSync(join(tmpdir(), 'eco-bad-')); made.push(d);
    writeFileSync(join(d, 'broken.js'), 'module.exports = { file: ');   // deliberate syntax error
    const out = inRegistry('r.loadProviders().length', { EPAM_ECOSYSTEM_PROVIDERS: d });
    expect(out, 'a provider vanished with nothing said — the repo would present as another stack')
      .toMatch(/did not load/);
  });

  it('a module declaring no manifest file is rejected, not registered as blank', () => {
    const d = mkdtempSync(join(tmpdir(), 'eco-noname-')); made.push(d);
    writeFileSync(join(d, 'nameless.js'), 'module.exports = { stack: "x" };\n');
    const out = inRegistry('r.loadProviders().filter(p=>!p.file).length', { EPAM_ECOSYSTEM_PROVIDERS: d });
    expect(out).toMatch(/declares no manifest file/);
    // stdout first, then the warning on stderr — the count is at the front, not the end.
    expect(out).toMatch(/^0/);
  });
});
