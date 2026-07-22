/**
 * Deterministic (non-LLM) dependency check — replaces "hope the agent
 * remembers to install what it imports" for the exact recurring failure
 * class this session kept hitting (supertest imported, never added to
 * devDependencies, burning full retry cycles on the same mistake).
 *
 * Design constraint: fully generic. claude.sh's run_dependency_check()
 * contains no npm/pip/language assumption — everything stack-specific
 * (manifest file, its keys, the import regex, the install command) comes
 * from <project_root>/.epam/dependency-check.json, authored per-orchestration
 * (tier3-travel-app-run.sh supplies the npm/TS one). No manifest = no-op.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const TIER3_SH = join(REPO_ROOT, 'orchestrations/scripts/tier3-travel-app-run.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const tier3Src = readFileSync(TIER3_SH, 'utf8');

function extractFunctionBody(src: string, name: string): string {
  const start = src.indexOf(`${name}()`);
  const end = src.indexOf('\n}', start) + 2;
  return src.slice(start, end);
}

function runDependencyCheck(fixtureFiles: Record<string, string>, config: object | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'dep-check-test-'));
  try {
    for (const [relPath, content] of Object.entries(fixtureFiles)) {
      const fullPath = join(dir, relPath);
      mkdirSync(join(fullPath, '..'), { recursive: true });
      writeFileSync(fullPath, content);
    }
    if (config) {
      mkdirSync(join(dir, '.epam'), { recursive: true });
      writeFileSync(join(dir, '.epam/dependency-check.json'), JSON.stringify(config));
    }
    const fnBody = extractFunctionBody(claudeSrc, 'run_dependency_check');
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, `${fnBody}\nrun_dependency_check "${dir}"\n`);
    return execFileSync('bash', [scriptPath], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NPM_CONFIG = {
  manifestFile: 'package.json',
  manifestKeys: ['dependencies', 'devDependencies'],
  scanFileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  importPattern:
    "from\\s+['\"]([^./][^'\"]*)['\"]|require\\(\\s*['\"]([^./][^'\"]*)['\"]\\s*\\)",
  installCommand: 'echo WOULD_INSTALL:{package}',
  ignorePackages: ['url', 'path', 'fs', 'http', 'node:url', 'node:path'],
};

describe('claude.sh — run_dependency_check() design constraints (static)', () => {
  const body = extractFunctionBody(claudeSrc, 'run_dependency_check');

  it('the executable python body contains no package-manager command (npm/pip/cargo invocation)', () => {
    const pyStart = body.indexOf("<< 'PYEOF'");
    const pyBody = body.slice(pyStart);
    expect(pyBody).not.toMatch(/\bnpm install\b|\bpip install\b|\bcargo add\b/);
  });

  it('reads everything stack-specific from .epam/dependency-check.json', () => {
    expect(body).toMatch(/\.epam\/dependency-check\.json/);
    expect(body).toMatch(/manifestFile/);
    expect(body).toMatch(/manifestKeys/);
    expect(body).toMatch(/importPattern/);
    expect(body).toMatch(/installCommand/);
  });

  it('no-ops (returns 0) when the manifest config file is absent', () => {
    expect(body).toMatch(/\[ -f "\$config_file" \] \|\| return 0/);
  });

  it('is wired into run_external_verification before the test command runs', () => {
    const verifyIdx = claudeSrc.indexOf('run_external_verification()');
    const depCheckIdx = claudeSrc.indexOf('run_dependency_check "$PROJECT_ROOT"');
    const testCmdIdx = claudeSrc.indexOf('Running external verification: $test_cmd');
    expect(depCheckIdx).toBeGreaterThan(verifyIdx);
    expect(testCmdIdx).toBeGreaterThan(depCheckIdx);
  });
});

describe('run_dependency_check — REAL execution', () => {
  it('no-ops silently when no manifest config exists (feature is opt-in)', () => {
    const output = runDependencyCheck(
      { 'src/server.test.ts': "import request from 'supertest';" },
      null
    );
    expect(output).toBe('');
  });

  it('REPRODUCES the exact live defect: detects a missing supertest import and installs it', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: { express: '^4.0.0' } }),
        'src/server.test.ts': "import request from 'supertest';\nimport { app } from './server';",
      },
      NPM_CONFIG
    );
    expect(output).toContain('WOULD_INSTALL:supertest');
    // The relative import ('./server') must NOT be treated as a package
    expect(output).not.toContain('WOULD_INSTALL:./server');
  });

  it('does nothing when the import is already declared in devDependencies', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({
          dependencies: {},
          devDependencies: { supertest: '^7.0.0' },
        }),
        'src/server.test.ts': "import request from 'supertest';",
      },
      NPM_CONFIG
    );
    expect(output).toBe('');
  });

  it('handles require() imports, not just ES import statements', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'src/legacy.test.js': "const nock = require('nock');",
      },
      NPM_CONFIG
    );
    expect(output).toContain('WOULD_INSTALL:nock');
  });

  it('treats a scoped-package subpath import as satisfied by the scope root (generic prefix match, no npm-specific scoping logic)', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: { '@scope/pkg': '^1.0.0' } }),
        'src/x.test.ts': "import foo from '@scope/pkg/sub/path';",
      },
      NPM_CONFIG
    );
    expect(output).toBe('');
  });

  it('REPRODUCES a live-run false positive: does not flag Node builtin modules (e.g. "url") when ignorePackages is configured', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'src/cli.test.ts': "import { parse } from 'url';\nimport path from 'path';",
      },
      NPM_CONFIG
    );
    expect(output).toBe('');
  });

  it('REGRESSION (live, 2026-07-06): does not flag a Node builtin SUBPATH import (e.g. "fs/promises") as a missing third-party package — previously only the exact string in ignorePackages matched, so "fs" being listed did not cover "fs/promises", and `npm install fs/promises` was attempted (which fails trying to git-clone a nonexistent GitHub repo)', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'src/util.ts': "import { readFile } from 'fs/promises';",
      },
      NPM_CONFIG
    );
    expect(output).toBe('');
  });

  it('still flags a real missing package alongside an ignored builtin subpath in the same file', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'src/util.ts': "import { readFile } from 'fs/promises';\nimport request from 'supertest';",
      },
      NPM_CONFIG
    );
    expect(output).toContain('WOULD_INSTALL:supertest');
    expect(output).not.toContain('WOULD_INSTALL:fs/promises');
  });

  it('still flags a real missing package alongside ignored builtins in the same file', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'src/cli.test.ts': "import { parse } from 'url';\nimport request from 'supertest';",
      },
      NPM_CONFIG
    );
    expect(output).toContain('WOULD_INSTALL:supertest');
    expect(output).not.toContain('WOULD_INSTALL:url');
  });

  it('excludes node_modules from the scan (does not flag deps\' own internal imports)', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'node_modules/somepkg/index.js': "require('unrelated-internal-dep');",
      },
      NPM_CONFIG
    );
    expect(output).toBe('');
  });

  it('REGRESSION (live, 2026-07-06): does not scan non-source files (e.g. spec-summary.json) — an LLM coordinator note containing prose like "mapping from \'from/to\' to \'origin/destination\'" was previously misparsed as an import statement, producing a fake package "from/to" and hanging `npm install` on it indefinitely', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'spec-summary.json': JSON.stringify({
          notes:
            "URL query param mapping from 'from/to' to 'origin/destination' is not specified or tested.",
        }),
      },
      NPM_CONFIG
    );
    expect(output).toBe('');
  });

  it('scanFileExtensions is opt-in — omitting it preserves old (scan-everything) behavior for callers that have not adopted the fix yet', () => {
    const { scanFileExtensions, ...configWithoutExtensions } = NPM_CONFIG;
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'notes.json': "from 'from/to' to 'origin/destination'",
      },
      configWithoutExtensions
    );
    // The misparsed "package" is still scanned (scanFileExtensions opt-out
    // preserved), but the subpath-stripping fix (added 2026-07-06, see the
    // "subpath stripping + bounded timeout" describe block below) now
    // correctly installs just the top-level segment "from", not the literal
    // (invalid) package name "from/to" — this is a strict improvement, not a
    // regression: the underlying scanFileExtensions behavior under test here
    // is unchanged.
    expect(output).toContain('WOULD_INSTALL:from');
    expect(output).not.toContain('WOULD_INSTALL:from/to');
  });
});

describe('tier3-travel-app-run.sh — supplies its own npm/TS manifest (per-orchestration, not baked into claude.sh)', () => {
  it('writes .epam/dependency-check.json for the output project', () => {
    expect(tier3Src).toMatch(/\.epam\/dependency-check\.json/);
  });

  it('declares package.json as the manifest file', () => {
    expect(tier3Src).toMatch(/"manifestFile":\s*"package\.json"/);
  });

  it('declares both dependencies and devDependencies as manifest keys', () => {
    expect(tier3Src).toMatch(/"manifestKeys":\s*\["dependencies",\s*"devDependencies"\]/);
  });

  it('installCommand uses npm install --save-dev with a {package} placeholder', () => {
    expect(tier3Src).toMatch(/"installCommand":\s*"npm install --save-dev \{package\}"/);
  });

  it('declares ignorePackages covering Node builtins (fixes a live false-positive on "url")', () => {
    expect(tier3Src).toMatch(/"ignorePackages":\s*\[/);
    const idx = tier3Src.indexOf('"ignorePackages"');
    const line = tier3Src.slice(idx, tier3Src.indexOf('\n', idx));
    expect(line).toMatch(/"url"/);
    expect(line).toMatch(/"fs"/);
    expect(line).toMatch(/"path"/);
  });

  it('declares scanFileExtensions so the scan is restricted to source files (fixes a live hang installing a fake package parsed from spec-summary.json prose)', () => {
    const depCheckIdx = tier3Src.indexOf("<< 'DEPCHECK_EOF'") + "<< 'DEPCHECK_EOF'".length;
    const depCheckBlockEnd = tier3Src.indexOf('DEPCHECK_EOF', depCheckIdx);
    const block = tier3Src.slice(depCheckIdx, depCheckBlockEnd);
    expect(block).toMatch(/"scanFileExtensions":\s*\[.*"\.ts"/);
  });
});

// ── Subpath-import install fix + bounded timeout (found live, 2026-07-06) ────
// Root cause this fixes: a scaffold story's package.json genuinely omitted
// devDependencies entirely for one attempt, making 'vitest' (imported as
// 'vitest/config' in vitest.config.ts) look undeclared. The existing prefix-
// match logic correctly flagged it as missing (working as designed given no
// devDependencies were declared at all), but the install command was then
// built from the FULL matched string 'vitest/config' — not a real npm
// package name — so npm hung retrying against the registry indefinitely.
// This subprocess.run() call also had no timeout at all, the fourth
// unbounded external command found this session (after the test command,
// git operations, and npm install for missing node_modules).
describe('run_dependency_check — subpath stripping + bounded timeout on the install subprocess', () => {
  it('REPRODUCES the exact live defect: installs the top-level package (vitest), not the full subpath (vitest/config)', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {}, devDependencies: {} }),
        'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({});",
      },
      NPM_CONFIG
    );
    expect(output).toContain("WOULD_INSTALL:vitest");
    expect(output).not.toContain('WOULD_INSTALL:vitest/config');
  });

  it('keeps both segments of a scoped package (@scope/name), not just the first', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {}, devDependencies: {} }),
        'src/foo.ts': "import { thing } from '@scope/pkg/subpath';",
      },
      NPM_CONFIG
    );
    expect(output).toContain('WOULD_INSTALL:@scope/pkg');
    expect(output).not.toContain('WOULD_INSTALL:@scope/pkg/subpath');
  });

  it('does not alter an already-top-level (non-subpath) package name', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {}, devDependencies: {} }),
        'src/foo.ts': "import request from 'supertest';",
      },
      NPM_CONFIG
    );
    expect(output).toContain('WOULD_INSTALL:supertest');
  });

  it('REPRODUCES the exact live hang: a fake install command (simulating a hanging npm) is killed by the subprocess timeout instead of blocking indefinitely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dep-check-hang-test-'));
    try {
      mkdirSync(join(dir, '.epam'), { recursive: true });
      const hangConfig = {
        ...NPM_CONFIG,
        installCommand: 'sleep 300 #{package}', // simulates a hanging install command
      };
      writeFileSync(join(dir, '.epam/dependency-check.json'), JSON.stringify(hangConfig));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: {}, devDependencies: {} }));
      writeFileSync(join(dir, 'vitest.config.ts'), "import { defineConfig } from 'vitest/config';");

      const fnBody = extractFunctionBody(claudeSrc, 'run_dependency_check');
      const scriptPath = join(dir, 'run.sh');
      // EPAM_DEPENDENCY_INSTALL_TIMEOUT_SECS makes the 120s production default
      // configurable — set it to 1s so this test can observe the timeout
      // actually firing without waiting the full 2 minutes.
      writeFileSync(scriptPath, `export EPAM_DEPENDENCY_INSTALL_TIMEOUT_SECS=1\n${fnBody}\nrun_dependency_check "${dir}"\n`);

      const start = Date.now();
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });
      const durationMs = Date.now() - start;

      expect(output).toMatch(/TIMED OUT after 1s/);
      // Must return well within this test's own 15s ceiling — proves the
      // subprocess-level timeout actually bounds the hang rather than
      // running to the full simulated 300s sleep.
      expect(durationMs).toBeLessThan(10000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── requiredDevDependencies — tooling packages never imported ────────────────
// Root cause this fixes (found live, 2026-07-07, tier3-full-run-19): the
// scaffold story's package.json genuinely omitted 'typescript' entirely, and
// nothing caught it — the import-scanning logic above can only detect a
// missing package if something `import`s or `require()`s it, but 'typescript'
// is invoked as a CLI binary (`tsc`), never imported in source code. The gap
// went undetected until the phase-level pre-review gate's `tsc --noEmit` call
// failed with "Cannot find module '.../node_modules/.bin/tsc'" — a whole
// phase deep into the pipeline, far past where a deterministic check should
// have caught it. requiredDevDependencies is a config-supplied (not engine-
// hardcoded) list of packages that must always be present regardless of
// whether anything imports them.
describe('run_dependency_check — requiredDevDependencies (tooling packages never imported)', () => {
  it('REPRODUCES the exact live defect: installs typescript even though nothing imports it', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {}, devDependencies: { vitest: '^4.0.0' } }),
        'src/index.ts': "export const x = 1;",
      },
      { ...NPM_CONFIG, requiredDevDependencies: ['typescript', '@types/node'] }
    );
    expect(output).toContain('WOULD_INSTALL:typescript');
    expect(output).toContain('WOULD_INSTALL:@types/node');
  });

  it('does not reinstall a requiredDevDependency that is already declared', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {}, devDependencies: { typescript: '^5.0.0' } }),
        'src/index.ts': "export const x = 1;",
      },
      { ...NPM_CONFIG, requiredDevDependencies: ['typescript'] }
    );
    expect(output).not.toContain('WOULD_INSTALL:typescript');
  });

  it('is opt-in — omitting requiredDevDependencies changes nothing (no engine-side default list)', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {}, devDependencies: {} }),
        'src/index.ts': "export const x = 1;",
      },
      NPM_CONFIG
    );
    expect(output).toBe('');
  });

  it('does not duplicate an entry already flagged by import-scanning', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {}, devDependencies: {} }),
        'src/index.ts': "import ts from 'typescript';",
      },
      { ...NPM_CONFIG, requiredDevDependencies: ['typescript'] }
    );
    const occurrences = (output.match(/WOULD_INSTALL:typescript/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('is fully generic — a Python project could require "black"/"mypy" via the same config key, no npm-specific assumption', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {}, devDependencies: {} }),
        'src/index.ts': "export const x = 1;",
      },
      { ...NPM_CONFIG, requiredDevDependencies: ['black', 'mypy'] }
    );
    expect(output).toContain('WOULD_INSTALL:black');
    expect(output).toContain('WOULD_INSTALL:mypy');
  });
});

describe('tier3-travel-app-run.sh — declares requiredDevDependencies for this project\'s tooling', () => {
  it('lists typescript (the exact live-missing package)', () => {
    const idx = tier3Src.indexOf("<< 'DEPCHECK_EOF'") + "<< 'DEPCHECK_EOF'".length;
    const end = tier3Src.indexOf('DEPCHECK_EOF', idx);
    const block = tier3Src.slice(idx, end);
    expect(block).toMatch(/"requiredDevDependencies":\s*\[[^\]]*"typescript"/);
  });
});

// ── Tsconfig path alias + template literal filters (live bug, 2026-07-21) ───
// Root cause: Metrolinx azure.commerce.cdts uses tsconfig path aliases like
// @background/* and @commerce/* (mapped to local src dirs, not npm packages).
// The dep-check scanned src files, found these alias imports, could not find
// them in node_modules, and tried to `npm install` each one — 15+ packages,
// most 404 immediately, @metrolinx/cx-shared taking 20s each (GitHub packages
// 401 error), burning 20+ minutes per attempt before the MiniMax agent ran.
// Fix: read all tsconfig*.json under project_root, extract compilerOptions.paths
// keys as alias prefixes, and skip any import matching those aliases.
// Template literal fix: the scanner also picked up `${currentPayment.state.value}`
// as an "import path" — any import string containing `${` is dynamic code, not
// an installable package.
describe('run_dependency_check — tsconfig path alias filter (live bug, 2026-07-21)', () => {
  it('REPRODUCES the live defect: does not try to install a tsconfig path alias (@background/core)', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            paths: { '@background/*': ['apps/background/src/*'] },
          },
        }),
        'apps/background/src/main.ts': "import { foo } from '@background/core/health';",
      },
      NPM_CONFIG
    );
    expect(output).not.toContain('WOULD_INSTALL:@background');
    expect(output).toBe('');
  });

  it('does not install any alias defined under compilerOptions.paths, including scoped ones (@commerce/*)', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            paths: {
              '@background/*': ['apps/background/src/*'],
              '@commerce/*': ['src/*'],
            },
          },
        }),
        'src/service.ts': [
          "import { X } from '@background/core';",
          "import { Y } from '@background/features/data-lake';",
          "import { Z } from '@commerce/clients/redis';",
          "import { W } from '@commerce/types/context';",
        ].join('\n'),
      },
      NPM_CONFIG
    );
    expect(output).toBe('');
  });

  it('reads tsconfig.json from sub-directories (not just project root)', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'apps/background/tsconfig.json': JSON.stringify({
          compilerOptions: {
            paths: { '@background/*': ['src/*'], '@commerce/*': ['../../src/*'] },
          },
        }),
        'apps/background/src/handler.ts': "import { bus } from '@background/shared/service-bus';",
      },
      NPM_CONFIG
    );
    expect(output).toBe('');
  });

  it('still flags a real missing npm package alongside tsconfig aliases in the same file', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'tsconfig.json': JSON.stringify({
          compilerOptions: { paths: { '@background/*': ['apps/background/src/*'] } },
        }),
        'src/handler.ts': [
          "import { foo } from '@background/core';",
          "import request from 'supertest';",
        ].join('\n'),
      },
      NPM_CONFIG
    );
    expect(output).toContain('WOULD_INSTALL:supertest');
    expect(output).not.toContain('WOULD_INSTALL:@background');
  });

  it('is a no-op when tsconfig.json has no compilerOptions.paths (greenfield projects unaffected)', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'tsconfig.json': JSON.stringify({
          compilerOptions: { target: 'ES2022', module: 'commonjs' },
        }),
        'src/index.ts': "import request from 'supertest';",
      },
      NPM_CONFIG
    );
    expect(output).toContain('WOULD_INSTALL:supertest');
  });

  it('REPRODUCES the live defect: does not try to install a template literal string (`${...}`) as a package', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        // The import scanner finds the raw string before interpolation
        'src/payment.ts': "import something from '${currentPayment.state.value}';",
      },
      NPM_CONFIG
    );
    expect(output).not.toContain('WOULD_INSTALL:${');
    expect(output).toBe('');
  });

  it('template literal filter applies even when the interpolation appears mid-path', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'src/dynamic.ts': "const mod = await import(`@scope/${dynamicName}/utils`);",
      },
      NPM_CONFIG
    );
    expect(output).not.toContain('WOULD_INSTALL:@scope');
    expect(output).toBe('');
  });
});

describe('run_dependency_check — preInstallHook (brownfield full-install before scanning)', () => {
  // preInstallHook runs ONCE before per-package scanning. Intended for brownfield
  // repos that need a full package-manager reconciliation (e.g. stripping a
  // private-registry dep, running npm install --prefer-offline, restoring).
  // Live bug (2026-07-21): Metrolinx azure.commerce.cdts — cx-shared (GitHub
  // Packages) caused every per-package npm install to 401; cp-rn workarounds
  // left truncated files (tsc.js 435KB). One full install with cx-shared stripped
  // fixes everything instead of fighting it package-by-package.

  it('runs the hook once before scanning and logs completion', () => {
    const output = runDependencyCheck(
      { 'package.json': JSON.stringify({ dependencies: {} }) },
      { ...NPM_CONFIG, preInstallHook: 'echo HOOK_RAN' }
    );
    expect(output).toContain('[dependency-check] Running preInstallHook');
    expect(output).toContain('HOOK_RAN');
    expect(output).toContain('[dependency-check] preInstallHook complete');
  });

  it('is a no-op when preInstallHook is absent — greenfield projects unaffected', () => {
    const output = runDependencyCheck(
      { 'package.json': JSON.stringify({ dependencies: {} }) },
      NPM_CONFIG
    );
    expect(output).not.toContain('preInstallHook');
  });

  it('hook failure is non-fatal — dep-check continues', () => {
    const output = runDependencyCheck(
      { 'package.json': JSON.stringify({ dependencies: {} }) },
      { ...NPM_CONFIG, preInstallHook: 'exit 1' }
    );
    expect(output).toContain('preInstallHook exited 1 (non-fatal');
  });

  it('hook timeout is non-fatal — dep-check continues', () => {
    // EPAM_DEP_HOOK_TIMEOUT_SECS=1 so the sleep is killed after 1 second.
    const dir = mkdtempSync(join(tmpdir(), 'dep-check-hook-timeout-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));
      mkdirSync(join(dir, '.epam'), { recursive: true });
      writeFileSync(
        join(dir, '.epam/dependency-check.json'),
        JSON.stringify({ ...NPM_CONFIG, preInstallHook: 'sleep 999' })
      );
      const fnBody = extractFunctionBody(claudeSrc, 'run_dependency_check');
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, `${fnBody}\nrun_dependency_check "${dir}"\n`);
      const output = execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, EPAM_DEP_HOOK_TIMEOUT_SECS: '1' },
      });
      expect(output).toContain('preInstallHook TIMED OUT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hook runs in project_root cwd so it can read package.json without an absolute path', () => {
    const output = runDependencyCheck(
      { 'package.json': JSON.stringify({ name: 'testpkg' }) },
      { ...NPM_CONFIG, preInstallHook: 'python3 -c "import json; p=json.load(open(\'package.json\')); print(\'NAME:\'+p[\'name\'])"' }
    );
    expect(output).toContain('NAME:testpkg');
  });

  it('hook runs before scanning — packages installed by hook are visible to the missing-import check', () => {
    // Hook creates a fake node_modules entry; dep-check should then see it as
    // "already installed" and not emit an install line for it.
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'src/app.ts': "import express from 'express';",
      },
      {
        ...NPM_CONFIG,
        preInstallHook: 'mkdir -p node_modules/express && echo "{}" > node_modules/express/package.json',
      }
    );
    expect(output).not.toContain('WOULD_INSTALL:express');
  });
});

// ── setup-deps.sh — generic stack-detecting installer ─────────────────────────
// setup-deps.sh is scaffold-generated: lives in <project>/.epam/setup-deps.sh.
// Called via preInstallHook="bash .epam/setup-deps.sh" in dependency-check.json.
// Design constraint: zero hardcoded package names (no '@metrolinx/cx-shared').
// Stack detected from project files; private npm scopes detected from .npmrc.
function runSetupDeps(
  projectFiles: Record<string, string>,
  fakeBinaries: Record<string, string> = {}
): string {
  const dir = mkdtempSync(join(tmpdir(), 'setup-deps-test-'));
  try {
    // Write project files
    for (const [rel, content] of Object.entries(projectFiles)) {
      const full = join(dir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    // Write .epam/setup-deps.sh — copy from the canonical source in the codeline
    mkdirSync(join(dir, '.epam'), { recursive: true });
    const scriptPath = join(dir, '.epam', 'setup-deps.sh');
    writeFileSync(
      scriptPath,
      readFileSync('/home/bradleyjerome/projects/metrolinx/azure.commerce.cdts/.epam/setup-deps.sh', 'utf8')
    );
    execFileSync('chmod', ['+x', scriptPath]);

    // Write fake binaries into a bin/ dir and prepend to PATH
    const binDir = join(dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    for (const [name, body] of Object.entries(fakeBinaries)) {
      const binPath = join(binDir, name);
      writeFileSync(binPath, `#!/usr/bin/env bash\n${body}\n`);
      execFileSync('chmod', ['+x', binPath]);
    }

    const wrapperPath = join(dir, 'run.sh');
    writeFileSync(wrapperPath, [
      '#!/usr/bin/env bash',
      `export PATH="${binDir}:$PATH"`,
      `cd "${dir}"`,
      // Exit 0 always — the preInstallHook is non-fatal in production so test
      // output is what matters, not the wrapper exit code.
      `bash .epam/setup-deps.sh 2>&1; exit 0`,
    ].join('\n'));

    const result = spawnSync('bash', [wrapperPath], { encoding: 'utf8' });
    return (result.stdout ?? '') + (result.stderr ?? '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('setup-deps.sh — generic stack-detecting installer', () => {
  it('detects npm stack from package.json and logs it', () => {
    const output = runSetupDeps(
      { 'package.json': JSON.stringify({ name: 'test' }) },
      { npm: 'echo FAKE_NPM_RAN' }
    );
    expect(output).toContain('Detected stack: npm');
    expect(output).toContain('FAKE_NPM_RAN');
  });

  it('detects yarn when yarn.lock is present alongside package.json', () => {
    const output = runSetupDeps(
      {
        'package.json': JSON.stringify({ name: 'test' }),
        'yarn.lock': '',
      },
      { yarn: 'echo FAKE_YARN_RAN' }
    );
    expect(output).toContain('Detected stack: yarn');
    expect(output).toContain('FAKE_YARN_RAN');
    // Must NOT also run npm (yarn takes precedence)
    expect(output).not.toContain('Detected stack: npm');
  });

  it('detects pnpm when pnpm-lock.yaml is present alongside package.json', () => {
    const output = runSetupDeps(
      {
        'package.json': JSON.stringify({ name: 'test' }),
        'pnpm-lock.yaml': '',
      },
      { pnpm: 'echo FAKE_PNPM_RAN' }
    );
    expect(output).toContain('Detected stack: pnpm');
    expect(output).toContain('FAKE_PNPM_RAN');
    expect(output).not.toContain('Detected stack: npm');
  });

  it('detects pip stack from requirements.txt', () => {
    const output = runSetupDeps(
      { 'requirements.txt': 'requests==2.31.0\n' },
      { pip3: 'echo FAKE_PIP_RAN' }
    );
    expect(output).toContain('Detected stack: pip');
    expect(output).toContain('FAKE_PIP_RAN');
  });

  it('detects cargo stack from Cargo.toml', () => {
    const output = runSetupDeps(
      { 'Cargo.toml': '[package]\nname = "test"\n' },
      { cargo: 'echo FAKE_CARGO_RAN' }
    );
    expect(output).toContain('Detected stack: cargo');
    expect(output).toContain('FAKE_CARGO_RAN');
  });

  it('detects dotnet stack from a .csproj file', () => {
    const output = runSetupDeps(
      { 'MyApp.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>' },
      { dotnet: 'echo FAKE_DOTNET_RAN' }
    );
    expect(output).toContain('Detected stack: dotnet');
    expect(output).toContain('FAKE_DOTNET_RAN');
  });

  it('detects dotnet stack from a nested .csproj (not just project root)', () => {
    const output = runSetupDeps(
      { 'src/Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>' },
      { dotnet: 'echo FAKE_DOTNET_NESTED_RAN' }
    );
    expect(output).toContain('Detected stack: dotnet');
    expect(output).toContain('FAKE_DOTNET_NESTED_RAN');
  });

  it('MULTI-STACK: runs BOTH npm and cargo for a monorepo with both manifests', () => {
    // e.g. a Rust server with a React frontend — both stacks must fire
    const output = runSetupDeps(
      {
        'package.json': JSON.stringify({ name: 'frontend' }),
        'Cargo.toml': '[package]\nname = "backend"\n',
      },
      {
        npm: 'echo NPM_HANDLER_RAN',
        cargo: 'echo CARGO_HANDLER_RAN',
      }
    );
    expect(output).toContain('NPM_HANDLER_RAN');
    expect(output).toContain('CARGO_HANDLER_RAN');
  });

  it('MULTI-STACK: runs BOTH npm and dotnet for a React + .NET monorepo', () => {
    const output = runSetupDeps(
      {
        'package.json': JSON.stringify({ name: 'frontend' }),
        'Backend/Backend.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
      },
      {
        npm: 'echo NPM_HANDLER_RAN',
        dotnet: 'echo DOTNET_HANDLER_RAN',
      }
    );
    expect(output).toContain('NPM_HANDLER_RAN');
    expect(output).toContain('DOTNET_HANDLER_RAN');
  });

  it('one handler failing does not prevent the others from running', () => {
    // npm fails (auth error), but cargo must still run
    const output = runSetupDeps(
      {
        'package.json': JSON.stringify({ name: 'frontend' }),
        'Cargo.toml': '[package]\nname = "backend"\n',
      },
      {
        npm: 'exit 1', // simulate npm auth failure
        cargo: 'echo CARGO_STILL_RAN',
      }
    );
    expect(output).toContain('CARGO_STILL_RAN');
  });

  it('logs a no-stack-found message and exits cleanly when nothing matches', () => {
    const output = runSetupDeps({});
    expect(output).toMatch(/No recognised stack marker found/);
  });

  it('npm: reads .npmrc to detect private registry scopes — NOT hardcoded scope names', () => {
    // .npmrc declares @acme (not @metrolinx — verifying no hardcoding)
    const output = runSetupDeps(
      {
        'package.json': JSON.stringify({
          devDependencies: {
            '@acme/internal': '^1.0.0',
            lodash: '^4.0.0',
          },
        }),
        '.npmrc': '@acme:registry=https://npm.internal.acme.com\n//npm.internal.acme.com/:_authToken=${ACME_TOKEN}\n',
      },
      { npm: 'python3 -c "import json; p=json.load(open(\'package.json\')); print(\'DURING_NPM:\' + str(list(p.get(\'devDependencies\',{}).keys())))"' }
    );
    // @acme/internal must be stripped (private scope) before npm runs
    expect(output).toContain('Detected stack: npm');
    expect(output).toContain('Private scope detected: @acme');
    // DURING_NPM prints the list of devDependency keys visible to npm at install time.
    // @acme/internal must be absent (stripped); lodash must still be present.
    expect(output).toContain('DURING_NPM:');
    expect(output).not.toContain('@acme/internal');
    expect(output).toContain('lodash');
  });

  it('npm: strips ALL packages matching private scopes, not just one hardcoded name', () => {
    // @metrolinx has cx-shared AND cx-api AND cx-tokens — all must be stripped
    const output = runSetupDeps(
      {
        'package.json': JSON.stringify({
          devDependencies: {
            '@metrolinx/cx-shared': '^7.2.1',
            '@metrolinx/cx-api': '^2.0.0',
            '@metrolinx/cx-tokens': '^1.5.0',
            typescript: '^5.0.0',
          },
        }),
        '.npmrc': '@metrolinx:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GH_TOKEN}\n',
      },
      {
        npm: [
          "python3 -c \"import json; p=json.load(open('package.json')); devdeps=list(p.get('devDependencies',{}).keys()); [print('DURING_INSTALL:' + k) for k in devdeps]\"",
        ].join(''),
      }
    );
    expect(output).not.toContain('DURING_INSTALL:@metrolinx/cx-shared');
    expect(output).not.toContain('DURING_INSTALL:@metrolinx/cx-api');
    expect(output).not.toContain('DURING_INSTALL:@metrolinx/cx-tokens');
    expect(output).toContain('DURING_INSTALL:typescript'); // public dep untouched
  });

  it('npm: strips packages from MULTIPLE private scopes simultaneously', () => {
    const output = runSetupDeps(
      {
        'package.json': JSON.stringify({
          devDependencies: {
            '@corp/ui': '^1.0.0',
            '@internal/auth': '^2.0.0',
            react: '^18.0.0',
          },
        }),
        '.npmrc': [
          '@corp:registry=https://registry.corp.example.com',
          '@internal:registry=https://artifacts.internal.example.net',
        ].join('\n'),
      },
      {
        npm: "python3 -c \"import json; p=json.load(open('package.json')); devdeps=list(p.get('devDependencies',{}).keys()); [print('DURING:' + k) for k in devdeps]\"",
      }
    );
    expect(output).toContain('Private scope detected: @corp');
    expect(output).toContain('Private scope detected: @internal');
    expect(output).not.toContain('DURING:@corp/ui');
    expect(output).not.toContain('DURING:@internal/auth');
    expect(output).toContain('DURING:react');
  });

  it('npm: does NOT strip public-registry scopes (only private ones are filtered)', () => {
    // @scope pointing to registry.npmjs.org must not be treated as private
    const output = runSetupDeps(
      {
        'package.json': JSON.stringify({
          devDependencies: {
            '@types/node': '^20.0.0',
            '@types/express': '^4.0.0',
          },
        }),
        '.npmrc': '@types:registry=https://registry.npmjs.org\n',
      },
      {
        npm: "python3 -c \"import json; p=json.load(open('package.json')); devdeps=list(p.get('devDependencies',{}).keys()); [print('DURING:' + k) for k in devdeps]\"",
      }
    );
    // @types is pointing to npmjs.org — should NOT be stripped
    expect(output).toContain('DURING:@types/node');
    expect(output).toContain('DURING:@types/express');
  });

  it('npm: install failure is non-fatal — WARN logged, script continues', () => {
    // Use a second handler (pip via requirements.txt) to prove execution continues.
    const output = runSetupDeps(
      {
        'package.json': JSON.stringify({ devDependencies: { '@metrolinx/cx-shared': '^7.2.1' } }),
        '.npmrc': '@metrolinx:registry=https://npm.pkg.github.com\n',
        'requirements.txt': 'requests==2.31.0\n',
      },
      {
        npm: 'exit 1',             // simulate auth failure
        pip3: 'echo PIP_STILL_RAN', // must still fire after npm fails
      }
    );
    expect(output).toContain('Detected stack: npm');
    expect(output).toMatch(/WARN.*npm install exited/);
    expect(output).toContain('PIP_STILL_RAN'); // execution continued past npm failure
  });

  it('npm: works with no .npmrc — no scope detection, no stripping, plain npm install', () => {
    const output = runSetupDeps(
      { 'package.json': JSON.stringify({ dependencies: { lodash: '^4.0.0' } }) },
      { npm: 'echo PLAIN_NPM_RAN; exit 0' }
    );
    expect(output).toContain('Detected stack: npm');
    expect(output).toContain('PLAIN_NPM_RAN');
    expect(output).not.toContain('Private scope detected');
    expect(output).not.toContain('Stripping');
  });

  it('the preInstallHook in the Metrolinx dependency-check.json now delegates to setup-deps.sh, not inline commands', () => {
    const depCheckJson = JSON.parse(
      readFileSync(
        '/home/bradleyjerome/projects/metrolinx/azure.commerce.cdts/.epam/dependency-check.json',
        'utf8'
      )
    );
    expect(depCheckJson.preInstallHook).toBe('bash .epam/setup-deps.sh');
    // Must not contain any hardcoded package names or scope names
    expect(depCheckJson.preInstallHook).not.toMatch(/@metrolinx/);
    expect(depCheckJson.preInstallHook).not.toMatch(/cx-shared/);
    expect(depCheckJson.preInstallHook).not.toMatch(/npm install/);
  });
});

describe('run_dependency_check — cx-shared package.json swap installCommand (live bug, 2026-07-21)', () => {
  // The Metrolinx codeline has @metrolinx/cx-shared in devDependencies pointing to
  // GitHub Packages. Every `npm install <other-pkg>` reads package.json, sees cx-shared,
  // hits the private registry → 401. The fix: the installCommand temporarily removes
  // cx-shared from package.json, installs the target, then restores the original.
  // This also ensures npm creates proper .bin symlinks (unlike the earlier cp approach).

  it('installCommand uses {{}} brace-escaping so Python .format() does not KeyError on {name} or {version}', () => {
    // The installCommand stored in .epam/dependency-check.json is processed by
    // Python's str.format(package=...) inside run_dependency_check(). Any literal
    // { or } in the command must be escaped as {{ or }} or format() will crash
    // with KeyError (live defect: attempt 3/8 crashed with KeyError: '"name"').
    const metrolinxConfig = {
      manifestFile: 'package.json',
      manifestKeys: ['dependencies', 'devDependencies'],
      scanFileExtensions: ['.ts'],
      importPattern: "from\\s+['\"]([^./][^'\"]*)['\"]",
      installCommand:
        "EPAM_BAK=$(mktemp) && cp package.json \"$EPAM_BAK\" && python3 -c \"import json; p=json.load(open('package.json')); [p.get(k,{{}}).pop('@metrolinx/cx-shared',None) for k in ['dependencies','devDependencies','peerDependencies','optionalDependencies']]; json.dump(p,open('package.json','w'))\" && npm install --no-save --no-package-lock {package}; mv \"$EPAM_BAK\" package.json",
      ignorePackages: ['url', 'path', 'fs'],
    };
    // If format() crashes on the installCommand, runDependencyCheck throws.
    // A missing package that triggers the install is needed to exercise the path.
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({
          devDependencies: { '@metrolinx/cx-shared': '^7.2.1' },
        }),
        'src/app.ts': "import express from 'express';",
      },
      metrolinxConfig
    );
    // express is missing → install attempted. The command will fail (no npm in test)
    // but the important thing is no KeyError / Python format crash.
    expect(output).toContain('[dependency-check] Installing missing import: express');
  });

  it('package.json swap: cx-shared is removed before install and restored after (verified via echo log)', () => {
    // Uses a custom installCommand that logs the package.json state at install time.
    // If the swap works, cx-shared must NOT appear in package.json during install.
    const swapLoggingCmd =
      "EPAM_BAK=$(mktemp) && cp package.json \"$EPAM_BAK\" && python3 -c \"import json; p=json.load(open('package.json')); [p.get(k,{{}}).pop('@metrolinx/cx-shared',None) for k in ['dependencies','devDependencies']]; json.dump(p,open('package.json','w'))\" && echo DURING_INSTALL:$(python3 -c \"import json; p=json.load(open('package.json')); print('has-cx' if '@metrolinx/cx-shared' in p.get('devDependencies',{{}}) else 'no-cx')\"); mv \"$EPAM_BAK\" package.json";
    const config = {
      manifestFile: 'package.json',
      manifestKeys: ['dependencies', 'devDependencies'],
      scanFileExtensions: ['.ts'],
      importPattern: "from\\s+['\"]([^./][^'\"]*)['\"]",
      installCommand: swapLoggingCmd,
      ignorePackages: ['path'],
    };
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({
          devDependencies: { '@metrolinx/cx-shared': '^7.2.1' },
        }),
        'src/app.ts': "import express from 'express';",
      },
      config
    );
    expect(output).toContain('DURING_INSTALL:no-cx');
  });

  it('package.json is always restored even when npm install fails', () => {
    // The mv at the end uses ; (not &&) so it runs regardless of npm exit code.
    const swapWithFailCmd =
      "EPAM_BAK=$(mktemp) && cp package.json \"$EPAM_BAK\" && python3 -c \"import json; p=json.load(open('package.json')); [p.get(k,{{}}).pop('@metrolinx/cx-shared',None) for k in ['dependencies','devDependencies']]; json.dump(p,open('package.json','w'))\" && false; mv \"$EPAM_BAK\" package.json && echo RESTORED:$(python3 -c \"import json; p=json.load(open('package.json')); print('has-cx' if '@metrolinx/cx-shared' in p.get('devDependencies',{{}}) else 'no-cx')\")";
    const config = {
      manifestFile: 'package.json',
      manifestKeys: ['dependencies', 'devDependencies'],
      scanFileExtensions: ['.ts'],
      importPattern: "from\\s+['\"]([^./][^'\"]*)['\"]",
      installCommand: swapWithFailCmd,
      ignorePackages: ['path'],
    };
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({
          devDependencies: { '@metrolinx/cx-shared': '^7.2.1' },
        }),
        'src/app.ts': "import express from 'express';",
      },
      config
    );
    expect(output).toContain('RESTORED:has-cx');
  });
});
