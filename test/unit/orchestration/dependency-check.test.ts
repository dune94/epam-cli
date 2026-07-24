/**
 * Deterministic (non-LLM) dependency check — replaces "hope the agent
 * remembers to install what it imports" for the exact recurring failure
 * class this session kept hitting (supertest imported, never added to
 * devDependencies, burning full retry cycles on the same mistake).
 *
 * Design constraint: fully generic. claude.sh's run_dependency_check()
 * contains no npm/pip/language assumption — everything stack-specific
 * (manifest file, its keys, the import regex, the install command) comes
 * from a dependency-check.json authored per-orchestration (tier3-travel-app-
 * run.sh supplies the npm/TS one). No manifest = no-op.
 *
 * Config location: EPAM_PROJECT_CONFIG_DIR (set by the project's own
 * tier3-*-run.sh) is checked first — for brownfield, this config lives
 * inside epam-cli's own orchestrations/projects/<name>/, never inside the
 * client's own repo. <project_root>/.epam/dependency-check.json is only a
 * fallback, legitimate for greenfield projects the pipeline scaffolds and
 * therefore owns.
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
// ── Nested package.json boundary (live bug, 2026-07-22) ────────────────────
// Root cause: Metrolinx azure.commerce.cdts is a monorepo containing an
// independent sub-project (scripts/integration-subscription-generator/) with
// its OWN package.json declaring react/@mui/@vitejs deps. run_dependency_check
// walked the whole project_root with no awareness of nested manifest
// boundaries, found the sub-project's imports, checked them against the ROOT
// package.json (where they are correctly absent — they belong to a different
// manifest), and tried to `npm install` them at project_root. This surfaced
// live as the pipeline attempting `npm install eslint-plugin-react-refresh`,
// `@vitejs/plugin-react`, `react-dom` etc. for an Azure Functions backend
// story that has nothing to do with React.
// Fix: os.walk's dirs[:] pruning now also excludes any subdirectory that
// itself contains a file matching manifestFile — that subtree manages its
// own dependencies independently and must not be scanned into.
describe('run_dependency_check — nested package.json boundary (live bug, 2026-07-22)', () => {
  it('does NOT descend into a subdirectory with its own package.json', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: { express: '^4.0.0' } }),
        'src/server.ts': "import express from 'express';",
        // Independent nested sub-project — its own manifest, own deps
        'tools/widget-app/package.json': JSON.stringify({
          dependencies: { react: '^18.0.0' },
        }),
        'tools/widget-app/src/App.tsx': "import React from 'react';\nimport ReactDOM from 'react-dom';",
      },
      NPM_CONFIG
    );
    // Neither react nor react-dom should ever be flagged — they belong to
    // the nested sub-project's own manifest, not the root's.
    expect(output).not.toContain('WOULD_INSTALL:react');
    expect(output).not.toContain('WOULD_INSTALL:react-dom');
  });

  it('still scans a sibling directory that does NOT contain its own package.json', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        // No nested package.json here — must still be scanned normally
        'src/utils/helper.ts': "import lodash from 'lodash';",
      },
      NPM_CONFIG
    );
    expect(output).toContain('WOULD_INSTALL:lodash');
  });

  it('correctly flags a MISSING import at the root level even when a nested sub-project exists elsewhere', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'src/server.ts': "import express from 'express';", // missing at root — must still be caught
        'tools/widget-app/package.json': JSON.stringify({ dependencies: { react: '^18.0.0' } }),
        'tools/widget-app/src/App.tsx': "import React from 'react';",
      },
      NPM_CONFIG
    );
    expect(output).toContain('WOULD_INSTALL:express'); // real root-level gap still caught
    expect(output).not.toContain('WOULD_INSTALL:react'); // nested sub-project's dep not leaked
  });

  it('handles multiple independent nested sub-projects, each excluded from the root scan', () => {
    const output = runDependencyCheck(
      {
        'package.json': JSON.stringify({ dependencies: {} }),
        'apps/frontend/package.json': JSON.stringify({ dependencies: { vue: '^3.0.0' } }),
        'apps/frontend/src/main.ts': "import Vue from 'vue';",
        'apps/backend-service/package.json': JSON.stringify({ dependencies: { fastify: '^4.0.0' } }),
        'apps/backend-service/src/index.ts': "import fastify from 'fastify';",
      },
      NPM_CONFIG
    );
    expect(output).not.toContain('WOULD_INSTALL:vue');
    expect(output).not.toContain('WOULD_INSTALL:fastify');
  });
});

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


describe('run_dependency_check — config lives in epam-cli, never in a client repo (2026-07-22 redesign)', () => {
  // Prior design deployed setup-deps.sh / lib-strip-private-scope.sh /
  // npm-install-wrapper.sh / dependency-check.json into every brownfield
  // codeline's own .epam/ directory, and its preInstallHook stripped a
  // private-scope dependency out of package.json to dodge a registry auth
  // wall. Both are rejected: (1) a client repo is not epam-cli's to write
  // into, even for our own tooling; (2) mutating a manifest to route around
  // a missing credential is a hack, not a fix. See
  // feedback_no_client_repo_writes_or_hardcoding memory.
  //
  // The fix: EPAM_PROJECT_CONFIG_DIR (set by the project's own
  // tier3-*-run.sh) points run_dependency_check at a dependency-check.json
  // living inside epam-cli's own orchestrations/projects/<name>/ directory
  // — the same place config.env already lives. No preInstallHook at all:
  // dropping --no-package-lock from installCommand means npm respects the
  // existing lockfile/node_modules state instead of force-re-resolving the
  // whole manifest (and hitting the private dependency) on every unrelated
  // single-package install — npm's own standard behavior, not a bash hack.

  it('EPAM_PROJECT_CONFIG_DIR/dependency-check.json is preferred over <project_root>/.epam/dependency-check.json', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dep-check-project-'));
    const configDir = mkdtempSync(join(tmpdir(), 'dep-check-config-'));
    try {
      writeFileSync(
        join(projectRoot, 'package.json'),
        JSON.stringify({ dependencies: {} })
      );
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      writeFileSync(join(projectRoot, 'src/app.ts'), "import fromconfigdir from 'fromconfigdir';");
      writeFileSync(
        join(configDir, 'dependency-check.json'),
        JSON.stringify({ ...NPM_CONFIG })
      );
      // Also write a DIFFERENT, decoy config inside the project root's own
      // .epam/ — if the epam-cli-side config isn't actually preferred, this
      // decoy (which ignores everything) would silently swallow the import.
      mkdirSync(join(projectRoot, '.epam'), { recursive: true });
      writeFileSync(
        join(projectRoot, '.epam/dependency-check.json'),
        JSON.stringify({ ...NPM_CONFIG, ignorePackages: ['fromconfigdir'] })
      );

      const fnBody = extractFunctionBody(claudeSrc, 'run_dependency_check');
      const scriptPath = join(projectRoot, 'run.sh');
      writeFileSync(scriptPath, `${fnBody}\nrun_dependency_check "${projectRoot}"\n`);
      const output = execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: configDir },
      });
      expect(output).toContain('Installing missing import: fromconfigdir');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('falls back to <project_root>/.epam/dependency-check.json when EPAM_PROJECT_CONFIG_DIR is unset (greenfield, pipeline owns the repo)', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dep-check-greenfield-'));
    try {
      writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ dependencies: {} }));
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      writeFileSync(join(projectRoot, 'src/app.ts'), "import express from 'express';");
      mkdirSync(join(projectRoot, '.epam'), { recursive: true });
      writeFileSync(join(projectRoot, '.epam/dependency-check.json'), JSON.stringify(NPM_CONFIG));

      const fnBody = extractFunctionBody(claudeSrc, 'run_dependency_check');
      const scriptPath = join(projectRoot, 'run.sh');
      writeFileSync(scriptPath, `${fnBody}\nrun_dependency_check "${projectRoot}"\n`);
      const output = execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: '' },
      });
      expect(output).toContain('Installing missing import: express');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('falls back to <project_root>/.epam/dependency-check.json when the EPAM_PROJECT_CONFIG_DIR copy does not exist', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'dep-check-missing-config-dir-'));
    try {
      writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ dependencies: {} }));
      mkdirSync(join(projectRoot, 'src'), { recursive: true });
      writeFileSync(join(projectRoot, 'src/app.ts'), "import express from 'express';");
      mkdirSync(join(projectRoot, '.epam'), { recursive: true });
      writeFileSync(join(projectRoot, '.epam/dependency-check.json'), JSON.stringify(NPM_CONFIG));

      const fnBody = extractFunctionBody(claudeSrc, 'run_dependency_check');
      const scriptPath = join(projectRoot, 'run.sh');
      writeFileSync(scriptPath, `${fnBody}\nrun_dependency_check "${projectRoot}"\n`);
      const output = execFileSync('bash', [scriptPath], {
        encoding: 'utf8',
        env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: '/nonexistent/path/does-not-exist' },
      });
      expect(output).toContain('Installing missing import: express');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('Metrolinx dependency-check.json — no client-repo tooling, no manifest-mutation hack (2026-07-22)', () => {
  const metrolinxConfigPath = join(
    REPO_ROOT,
    'orchestrations/projects/metrolinx/dependency-check.json'
  );
  const metrolinxConfig = JSON.parse(readFileSync(metrolinxConfigPath, 'utf8'));

  it('lives inside epam-cli, not inside any client codeline', () => {
    expect(metrolinxConfigPath).toContain('/epam-cli/orchestrations/projects/metrolinx/');
  });

  it('has no preInstallHook — no full-manifest reconciliation script, no private-scope-strip hack', () => {
    expect(metrolinxConfig.preInstallHook).toBeUndefined();
  });

  it('installCommand has no hardcoded package/scope names', () => {
    expect(metrolinxConfig.installCommand).not.toMatch(/@metrolinx/);
    expect(metrolinxConfig.installCommand).not.toMatch(/cx-shared/);
  });

  it('installCommand does not force --no-package-lock — npm should respect the existing lockfile/node_modules state instead of re-resolving the whole manifest (incl. private deps) on every install', () => {
    expect(metrolinxConfig.installCommand).not.toMatch(/--no-package-lock/);
  });
});
