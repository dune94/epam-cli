// THREE DEFECTS IN THE FILE THAT WRITES BUG-REPRODUCTION TESTS, ALL PROVEN IN LIVE RUNS.
//
// 1. `_is_testable_source` was a hardcoded case statement ending `*.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs)
//    return 0 ;; *) return 1`. A .py, .go, .rs, .java or .rb file falls through to the default, so
//    on any non-Node codeline NO file is ever testable, `_choose_target` finds no candidate, and the
//    writer skips — reported as "nothing sensible to test", which is indistinguishable from a
//    correct decision. Bug-reproduction tests silently never happen.
//
// 2. `render_engine_prompt` is called at 8 sites and the script never sources the library that
//    defines it. 21 occurrences of "render_engine_prompt: command not found" across the run logs;
//    live again in run 4. Every one of those prompt sections rendered EMPTY, so the agent was
//    briefed with holes and the failure was a warning on stderr.
//
// 3. `AUTOMATION_DIR` is used at line 333 and never assigned in this script. Under `set -u` the
//    command substitution dies, `_typecheck_cmd` comes back empty, and the fallback tells the agent
//    "this codeline declares no typecheck command — skip this check" — of the metrolinx codeline,
//    which declares `npm run check-types`. Reproduced: the resolver returns '' with it unset.
//
// The facts all exist already. Source extensions come from the codeline's own declaration; the
// manifests, lockfiles and protected files come from the ecosystem registry. Once "testable" means
// "a declared source extension, and not a manifest/lockfile/protected file", the hardcoded
// exclusion list for .md/.png/.css has nothing left to do — it was compensating for a positive
// rule that was not grounded in anything.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const WRITER = join(SCRIPTS, 'brownfield-repro-test-writer.sh');
const HANDLER = join(SCRIPTS, 'lib/handlers/testable-source.js');
const NODE = process.execPath;
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'repro-')); made.push(d); return d; }

/** A codeline that declares its own source extensions, the way guard 6's handler now writes them. */
function codeline(manifest: string, exts: string[]): string {
  const root = tmp();
  writeFileSync(join(root, manifest), manifest.endsWith('.json') ? '{"name":"x"}' : 'x\n');
  mkdirSync(join(root, '.epam'), { recursive: true });
  writeFileSync(join(root, '.epam', 'dependency-check.json'),
    JSON.stringify({ manifestFile: manifest, scanFileExtensions: exts }));
  return root;
}

/** The testable subset of a file list, decided by the handler. */
function testable(root: string, paths: string[]): string[] {
  const r = spawnSync(NODE, [HANDLER, root, ...paths], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

describe('what counts as testable source comes from the codeline', () => {
  it('a node codeline still picks its .ts files', () => {
    const root = codeline('package.json', ['.ts', '.tsx', '.js']);
    expect(testable(root, ['src/a.ts', 'README.md'])).toEqual(['src/a.ts']);
  });

  it('a PYTHON codeline picks its .py files — it could pick nothing at all before', () => {
    const root = codeline('requirements.txt', ['.py']);
    expect(testable(root, ['app/service.py', 'README.md']),
      'no file was testable, so the repro-test-writer skipped and called it a decision')
      .toEqual(['app/service.py']);
  });

  it('a GO codeline picks its .go files', () => {
    const root = codeline('go.mod', ['.go']);
    expect(testable(root, ['pkg/server.go'])).toEqual(['pkg/server.go']);
  });

  it('a stack that has never existed picks its own extension', () => {
    const root = codeline('package.json', ['.widget']);
    expect(testable(root, ['src/a.widget', 'src/a.ts'])).toEqual(['src/a.widget']);
  });
});

describe('manifests and lockfiles are never a test target', () => {
  it('the manifest itself is excluded', () => {
    const root = codeline('package.json', ['.ts', '.json']);
    expect(testable(root, ['package.json', 'src/a.ts'])).toEqual(['src/a.ts']);
  });

  it('a lockfile is excluded even when its extension is declared source', () => {
    const root = codeline('package.json', ['.ts', '.json']);
    writeFileSync(join(root, 'package-lock.json'), '{}');
    expect(testable(root, ['package-lock.json', 'src/a.ts'])).toEqual(['src/a.ts']);
  });

  it('a protected file is excluded', () => {
    const root = codeline('package.json', ['.ts', '.json']);
    expect(testable(root, ['tsconfig.json', 'src/a.ts'])).toEqual(['src/a.ts']);
  });

  it('and the exclusions come from the registry, not from a list in the handler', () => {
    const src = readFileSync(HANDLER, 'utf8')
      .split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    for (const lit of ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'tsconfig']) {
      expect(src, `the handler carries its own copy of ${lit}`).not.toContain(lit);
    }
  });
});

describe('a codeline that has not been given a declaration yet', () => {
  it('falls back to the ecosystem it carries — the NORMAL case, not an error', () => {
    // Caught before shipping, against the real checkout: metrolinx carries .epam/verification.json
    // and .epam/settings.json and NO dependency-check.json. Codeline-only would have found nothing
    // testable there and skipped — replacing a Node-only defect with a nothing-works one.
    const root = tmp();
    writeFileSync(join(root, 'package.json'), '{"name":"x"}');   // no .epam/ at all
    expect(testable(root, ['src/a.ts', 'package.json', 'README.md'])).toEqual(['src/a.ts']);
  });

  it('and the codeline still WINS when it does declare', () => {
    const root = codeline('package.json', ['.widget']);
    expect(testable(root, ['src/a.widget', 'src/a.ts']),
      "the provider's extensions overrode the codeline's own declaration").toEqual(['src/a.widget']);
  });
});

describe('a repository that answers neither', () => {
  it('falls back to what any known ecosystem calls source — the capability must not be lost', () => {
    // This asserted that such a repo yields NOTHING. That was my own stricter rule, and the full
    // regression proved it removed a real capability: a bare checkout with no .epam/ and no
    // recognised manifest — repro-test-writer-commit-message-format.test.ts's fixture is exactly
    // that — had nothing testable, so the writer skipped. The hardcoded `*.ts|*.js` case statement
    // it replaced could still act there.
    //
    // The union of what the PROVIDERS declare is the last resort, after the codeline and after its
    // ecosystem. Still runtime-injected, still no stack named in engine code, and it widens as
    // providers declare their own extensions.
    const root = tmp();
    writeFileSync(join(root, 'README.md'), '# r\n');
    expect(testable(root, ['src/a.ts', 'README.md'])).toEqual(['src/a.ts']);
  });

  it('and a file no ecosystem calls source is still excluded', () => {
    const root = tmp();
    writeFileSync(join(root, 'README.md'), '# r\n');
    expect(testable(root, ['README.md', 'notes.txt', 'logo.png'])).toEqual([]);
  });

  it('the order of authority holds: codeline, then its ecosystem, then the union', () => {
    const declaring = codeline('package.json', ['.widget']);
    expect(testable(declaring, ['a.widget', 'a.ts']),
      'the fallback overrode a codeline that declared its own extensions').toEqual(['a.widget']);
  });
});

describe('the prompt renderer is reachable', () => {
  it('the library really defines render_engine_prompt', () => {
    const r = spawnSync('bash', ['-c',
      `source ${JSON.stringify(join(SCRIPTS, 'lib/render-engine-prompt.sh'))}; declare -F render_engine_prompt`,
    ], { encoding: 'utf8' });
    expect((r.stdout || '').trim(), 'the function this script calls does not exist anywhere')
      .toMatch(/render_engine_prompt/);
  });

  it('and the writer sources it — 8 call sites, 21 "command not found" in the run logs', () => {
    const src = readFileSync(WRITER, 'utf8');
    expect(src.match(/render_engine_prompt\s/g)?.length ?? 0,
      'the call sites are gone — check this test still points at something').toBeGreaterThan(4);
    expect(src, 'the writer calls render_engine_prompt and never sources the library that defines it')
      .toMatch(/(?:source|\.)\s+"\$(?:\{)?SCRIPT_DIR(?:\})?\/lib\/render-engine-prompt\.sh"/);
  });

  it('no engine function is called that this script cannot reach', () => {
    // The general form of the same defect: a name in command position that nothing the script
    // sources defines. The first version of this scan matched only underscore-prefixed names at
    // line start, so it missed render_engine_prompt — which was failing 21 times in production
    // while the scan stayed green.
    const src = readFileSync(WRITER, 'utf8');
    const sourced = new Set<string>([WRITER]);
    // A library is routinely reached through a VARIABLE — `_ml_lib="$SCRIPT_DIR/lib/model-ladders.sh"`
    // then `. "$_ml_lib"` — or through `$(dirname "${BASH_SOURCE[0]}")/lib/x.sh`. A scan that reads
    // only the literal `source "$SCRIPT_DIR/lib/x.sh"` form reports four working call sites as
    // unreachable, which is how a real finding gets buried in noise.
    for (const m of src.matchAll(/\blib\/([a-zA-Z0-9._-]+\.sh)/g)) {
      sourced.add(join(SCRIPTS, 'lib', m[1]));
    }
    const defined = new Set<string>();
    for (const f of sourced) {
      let s = '';
      try { s = readFileSync(f, 'utf8'); } catch { continue; }
      for (const d of s.matchAll(/^\s*(?:function\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\)\s*\{/gm)) defined.add(d[1]);
    }
    // Only names some engine library defines — anything else is an external command.
    const engineNames = new Set<string>();
    for (const dir of ['lib', '.']) {
      const d = join(SCRIPTS, dir);
      for (const f of require('node:fs').readdirSync(d).filter((x: string) => x.endsWith('.sh'))) {
        for (const m of readFileSync(join(d, f), 'utf8').matchAll(/^\s*(?:function\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\)\s*\{/gm)) {
          engineNames.add(m[1]);
        }
      }
    }
    const bad: string[] = [];
    src.split('\n').forEach((l, i) => {
      if (/^\s*#/.test(l)) return;
      for (const m of l.matchAll(/(?:^\s*|\$\(\s*|`\s*|;\s*|&&\s*|\|\|\s*|\|\s*|!\s*)([a-zA-Z_][a-zA-Z0-9_]{3,})(?=\s|\)|$)/g)) {
        const n = m[1];
        if (!engineNames.has(n) || defined.has(n)) continue;
        bad.push(`${i + 1}: ${n}`);
      }
    });
    expect(bad, `calls an engine function this script never sources:\n${bad.join('\n')}`).toEqual([]);
  });
});

describe('the typecheck command is resolved, not defaulted away', () => {
  it('AUTOMATION_DIR is assigned in this script', () => {
    const src = readFileSync(WRITER, 'utf8');
    expect(src, 'AUTOMATION_DIR is read under `set -u` and never assigned')
      .toMatch(/^AUTOMATION_DIR=/m);
  });

  it('and the plugin path it builds actually exists', () => {
    const r = spawnSync('bash', ['-c',
      `set -uo pipefail
       SCRIPT_DIR=${JSON.stringify(SCRIPTS)}
       AUTOMATION_DIR="\${AUTOMATION_DIR:-$(dirname ${JSON.stringify(SCRIPTS)})}"
       test -f "$AUTOMATION_DIR/plugins/verification-plugin.js" && echo FOUND`,
    ], { encoding: 'utf8' });
    expect((r.stdout || '').trim()).toBe('FOUND');
  });

  it('resolves the real command for a codeline that declares one', () => {
    // The live failure: metrolinx declares `npm run check-types`, and the writer told the agent the
    // codeline declares no typecheck command — because resolution died, not because none existed.
    // detectVerification DETECTS from the codeline's manifest — it is the producer of
    // verification.json, not a reader of it. The live shape is metrolinx's own package.json.
    const root = tmp();
    writeFileSync(join(root, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { 'check-types': 'tsc --noEmit' } }));
    const r = spawnSync(NODE, ['-e',
      `const p=require(${JSON.stringify(join(ROOT, 'orchestrations/plugins/verification-plugin.js'))});
       const v=p.detectVerification(process.argv[1])||{};
       process.stdout.write(((v.typecheck||{}).command)||'');`, root,
    ], { encoding: 'utf8' });
    expect((r.stdout || '').trim(), 'a codeline that declares a typecheck was told it declares none')
      .toBe('npm run check-types');
  });
});
