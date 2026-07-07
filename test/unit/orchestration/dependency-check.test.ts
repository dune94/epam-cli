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
import { execFileSync } from 'node:child_process';
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
