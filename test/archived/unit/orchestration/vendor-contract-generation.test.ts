/**
 * A third-party API's shape must be ground-truthed, not guessed — generically,
 * for whatever package and whatever stack, never hardcoded to one SDK.
 *
 * Live AMSD-2041 2026-07-30, run 6. The failure-analyst diagnosed the SAME
 * defect three times running — "Config object passed to Contentstack SDK
 * doesn't match the SDK's Config type" — and never patched anything
 * (patches_applied: 0 every time). Root cause traced deeper than the
 * analyst's own classification: NEITHER the implementer NOR the analyst ever
 * had any way to see the SDK's real Config type. dependency_contracts (the
 * existing ground-truth mechanism) covers only the story's declared INTERNAL
 * dependencies — a third-party npm package gets none of it, so every attempt
 * reconstructs the type from training memory and repeats the same wrong guess.
 *
 * THE CONSTRAINT THAT MATTERS: this must not become a second hardcoded thing
 * bolted on top of the first. It reuses TWO manifests that already exist and
 * are already fully generic:
 *
 *   - .epam/dependency-check.json's importPattern + vendorDirs + ignorePackages
 *     (already proven, already used by run_dependency_check — a Python project
 *     declares its own importPattern/vendorDirs and nothing here changes)
 *   - .epam/contract-generation.json's interfacePattern/classPattern/
 *     sourceExtensions (already proven by generate_story_contract for the
 *     story's OWN files — the exact same regex machinery, pointed at a vendor
 *     directory instead)
 *
 * No new manifest field. No project name, package name, or file extension
 * appears anywhere in the engine logic below — only in this comment, which
 * documents the incident that motivated it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const SRC = readFileSync(CLAUDE_SH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fnText(name: string): string {
  const start = SRC.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name}() not found in claude.sh`);
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end + 2);
}

/** A JS/TS-shaped project fixture — but the mechanism under test is stack-agnostic. */
function jsProject() {
  const root = mkdtempSync(join(tmpdir(), 'vendorc-'));
  dirs.push(root);
  mkdirSync(join(root, '.epam'), { recursive: true });
  writeFileSync(join(root, '.epam', 'dependency-check.json'), JSON.stringify({
    manifestFile: 'package.json',
    scanFileExtensions: ['.ts', '.tsx', '.js'],
    importPattern: "from\\s+['\"]([^./][^'\"]*)['\"]|require\\(\\s*['\"]([^./][^'\"]*)['\"]\\s*\\)",
    ignorePackages: ['fs', 'path'],
    vendorDirs: ['node_modules'],
  }));
  // Full schema, matching the real .epam/contract-generation.json (metrolinx,
  // 2026-07-30) — an earlier draft of this fixture only carried a subset and
  // failed with KeyError: 'interfaceRenderTemplate' at parse time.
  writeFileSync(join(root, '.epam', 'contract-generation.json'), JSON.stringify({
    language: 'typescript',
    sourceExtensions: ['.ts'],
    excludePattern: '\\.(test|spec)\\.ts$',
    interfacePattern: 'export\\s+interface\\s+(\\w+)\\s*\\{([^}]*)\\}',
    classPattern: 'export\\s+class\\s+(\\w+)\\s*(?:extends\\s+\\w+\\s*)?\\{',
    ctorPattern: 'constructor\\s*\\(([^)]*)\\)',
    methodPattern: '^\\s*(?:public\\s+|private\\s+|protected\\s+)?(async\\s+)?(\\w+)\\s*\\(([^)]*)\\)\\s*(?::\\s*([^{;]+))?\\s*\\{',
    interfaceRenderTemplate: 'export interface {{name}} {{{body}}}',
    classDeclarationTemplate: 'export class {{className}} {\n  constructor({{ctorParams}});\n{{methodSignatures}}\n}',
    methodSignatureTemplate: '  {{asyncPrefix}}{{methodName}}({{params}}){{returnAnnotation}};',
    asyncPrefixKeyword: 'async ',
    returnAnnotationPrefix: ': ',
    mockFactoryTemplate: "vi.mock('<import-path-to-{{className}}>', () => ({\n  {{className}}: vi.fn().mockImplementation(() => ({\n{{methodMocks}}\n  })),\n}));",
    mockMethodTemplateSync: '    {{methodName}}: vi.fn(),',
    mockMethodTemplateAsync: '    {{methodName}}: vi.fn().mockResolvedValue(undefined),',
    testFileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    testFilePattern: '\\.(test|spec)\\.[a-zA-Z0-9]+$',
    mockFactoryStartPattern: "vi\\.mock\\(\\s*['\"](\\.[^'\"]+)['\"]\\s*,\\s*\\(\\)\\s*=>\\s*\\(\\{",
    mockClassPattern: '(\\w+)\\s*:\\s*vi\\.fn\\(\\)\\.mockImplementation\\(\\(\\)\\s*=>\\s*\\(\\{',
    mockedMethodPattern: '^\\s*(\\w+)\\s*:',
    testFileAgentRole: 'test-engineer',
  }));
  return root;
}

describe('discovering which vendor packages a real file imports', () => {
  it('finds an external package import, ignoring built-ins and relative imports', () => {
    const root = jsProject();
    mkdirSync(join(root, 'src', 'services'), { recursive: true });
    writeFileSync(join(root, 'src', 'services', 'contentstack.ts'),
      "import fs from 'fs';\nimport { Widget } from './widget';\nimport contentstack from 'contentstack';\n");
    const script = join(root, '_probe.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
PROJECT_ROOT=${JSON.stringify(root)}
warning(){ :; }; log(){ :; }
${fnText('_discover_vendor_packages')}
_discover_vendor_packages "$PROJECT_ROOT/src/services/contentstack.ts"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    const packages = (r.stdout || '').split('\n').filter(Boolean);
    expect(packages, `stdout: ${r.stdout} stderr: ${r.stderr}`).toEqual(['contentstack']);
  });

  it('returns nothing when no manifest is configured — opt-in, no engine assumption', () => {
    const root = mkdtempSync(join(tmpdir(), 'vendorc-nomanifest-'));
    dirs.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), "import x from 'somepkg';\n");
    const script = join(root, '_probe.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
PROJECT_ROOT=${JSON.stringify(root)}
warning(){ :; }; log(){ :; }
${fnText('_discover_vendor_packages')}
_discover_vendor_packages "$PROJECT_ROOT/src/a.ts"
echo "RC=$?"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    expect((r.stdout || '').trim()).toBe('RC=0');
  });

  it('ignores a package declared in ignorePackages', () => {
    const root = jsProject();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), "import x from 'fs';\nimport y from 'contentstack';\n");
    const script = join(root, '_probe.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
PROJECT_ROOT=${JSON.stringify(root)}
warning(){ :; }; log(){ :; }
${fnText('_discover_vendor_packages')}
_discover_vendor_packages "$PROJECT_ROOT/src/a.ts"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    expect((r.stdout || '').split('\n').filter(Boolean)).toEqual(['contentstack']);
  });

  it('deduplicates repeated imports of the same package', () => {
    const root = jsProject();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'),
      "import x from 'contentstack';\nimport { Y } from 'contentstack';\n");
    const script = join(root, '_probe.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
PROJECT_ROOT=${JSON.stringify(root)}
warning(){ :; }; log(){ :; }
${fnText('_discover_vendor_packages')}
_discover_vendor_packages "$PROJECT_ROOT/src/a.ts"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    expect((r.stdout || '').split('\n').filter(Boolean)).toEqual(['contentstack']);
  });

  it('does nothing for a file with only internal/relative imports', () => {
    const root = jsProject();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), "import { x } from './b';\nimport { y } from '../c';\n");
    const script = join(root, '_probe.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
PROJECT_ROOT=${JSON.stringify(root)}
warning(){ :; }; log(){ :; }
${fnText('_discover_vendor_packages')}
_discover_vendor_packages "$PROJECT_ROOT/src/a.ts"
echo "RC=$?"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    expect(r.stdout || '').toMatch(/RC=0/);
    expect((r.stdout || '').split('\n').filter((l) => l && l !== 'RC=0')).toEqual([]);
  });
});

describe('generating a vendor contract from a real installed package', () => {
  it('extracts an exported interface from the vendored source using the SAME regex config-generation already trusts', () => {
    const root = jsProject();
    mkdirSync(join(root, 'node_modules', 'contentstack', 'types'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'contentstack', 'types', 'index.ts'), `
export interface Config {
  api_key: string;
  delivery_token: string;
  environment: string;
  live_preview?: { enable: boolean; host: string };
}
`);
    const script = join(root, '_probe.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
PROJECT_ROOT=${JSON.stringify(root)}
warning(){ :; }; log(){ :; }
${fnText('_generate_contract_from_files')}
${fnText('_generate_vendor_contract')}
_generate_vendor_contract "$PROJECT_ROOT" contentstack
cat "$PROJECT_ROOT/.contracts/vendor-contentstack.md"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    expect(r.stdout, `stderr: ${r.stderr}`).toMatch(/Config/);
    expect(r.stdout).toMatch(/live_preview/);
  });

  it('does nothing when the package is not actually installed', () => {
    const root = jsProject();
    const script = join(root, '_probe.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
PROJECT_ROOT=${JSON.stringify(root)}
warning(){ :; }; log(){ :; }
${fnText('_generate_contract_from_files')}
${fnText('_generate_vendor_contract')}
_generate_vendor_contract "$PROJECT_ROOT" not-installed
echo "RC=$?"
[ -f "$PROJECT_ROOT/.contracts/vendor-not-installed.md" ] && echo "FILE_EXISTS" || echo "NO_FILE"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    expect(r.stdout).toMatch(/RC=0/);
    expect(r.stdout).toMatch(/NO_FILE/);
  });

  it('does nothing when contract-generation.json is not configured — no engine assumption', () => {
    const root = mkdtempSync(join(tmpdir(), 'vendorc-noconfig-'));
    dirs.push(root);
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.ts'), 'export class Foo { constructor(x: string) {} }');
    const script = join(root, '_probe.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
PROJECT_ROOT=${JSON.stringify(root)}
warning(){ :; }; log(){ :; }
${fnText('_generate_contract_from_files')}
${fnText('_generate_vendor_contract')}
_generate_vendor_contract "$PROJECT_ROOT" pkg
echo "RC=$?"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30000 });
    expect(r.stdout).toMatch(/RC=0/);
  });
});

describe('wiring: the implementation prompt and the failure-analyst both consume it', () => {
  it('build_implementation_prompt discovers and injects vendor contracts', () => {
    expect(SRC, 'build_implementation_prompt never calls the vendor-contract discovery — ' +
      'third-party SDK shapes stay ungrounded for the ORIGINAL attempt')
      .toMatch(/_discover_vendor_packages/);
  });

  it('run_failure_analyst discovers and injects vendor contracts', () => {
    const start = SRC.indexOf('run_failure_analyst() {');
    const end = SRC.indexOf('\nrun_healing_recorder', start);
    const block = SRC.slice(start, end === -1 ? start + 8000 : end);
    expect(block, 'the failure-analyst still classifies without ever seeing the real ' +
      "SDK type — self-heal is diagnosing blind, which is exactly what let " +
      "'Config object doesn't match the SDK's Config type' repeat 3 times with target=none")
      .toMatch(/_discover_vendor_packages|_generate_vendor_contract/);
  });
});
