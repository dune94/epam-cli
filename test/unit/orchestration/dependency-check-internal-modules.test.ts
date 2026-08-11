/**
 * An import that resolves to a file in THIS repo is not a package.
 *
 * Live metrolinx 2026-07-29. All three lanes timed out; the story-recovery
 * analyst found why and was ignored because its verdict only feeds the
 * restructure decision:
 *
 *   "the agent entered a 'dependency-check' loop, attempting to install
 *    hundreds of missing project imports (services, utils, components) that
 *    are entirely unrelated to the targeted fix"
 *
 * Counts in the implementation logs: gotransit 346, upexpress 553,
 * metrolinx 506. The phantom "packages" were the codelines' own directories:
 *
 *   [dependency-check] Installing missing import: components (from 'components/contentstack/…')
 *   [dependency-check] Installing missing import: api        (from 'api/interfaces/logger')
 *   [dependency-check] Installing missing import: interface  (from 'interface/content/contentCard')
 *
 * All three exist as src/components, src/api, src/interface. The tsconfig says
 * `baseUrl: "./src"` with `paths: null`, so `components/x` means `src/components/x`.
 * The scanner already handles `compilerOptions.paths` (added 2026-07-21 for
 * azure.commerce.cdts's @alias/* imports) but NOT baseUrl, so with paths null it
 * found no aliases and classified every internal import as a missing package.
 *
 * The same defect very likely caused the other failure that day — "REPAIR
 * DESTROYED WHAT IT FOUND in next.gotransit.com: 1134 entries -> 1011" — since
 * installing non-existent packages makes npm rewrite and prune the tree. Two
 * problems diagnosed separately, one cause.
 *
 * WHY THE CHECK IS A FILESYSTEM QUESTION, NOT A TSCONFIG ONE. Reading baseUrl
 * would fix TypeScript and leave the next stack broken; it also puts stack
 * knowledge in a loop that runs once per import. The rule here asks only:
 * "does this specifier name a file inside the repo?" Roots are DISCOVERED (the
 * repo's own directories), extensions come from the manifest's
 * scanFileExtensions, which the project already declares. No tsconfig, no
 * baseUrl, no TypeScript, no package names.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

const PREAMBLE = [
  // The extracted function is a reporter now: it calls
  // orchestrations/plugins/dependency-scan-plugin.js and reads the project's declaration through
  // helpers. Without these it emits nothing, which is indistinguishable from "found nothing".
  `AUTOMATION_DIR=${JSON.stringify(join(__dirname, '../../../orchestrations'))}`,
  `NODE_CMD=${JSON.stringify(process.execPath)}`,
  'warning() { echo "$*"; }',
  'info()    { echo "$*"; }',
  ...['_project_dep_config_value', '_project_manifest_file', '_project_install_command'].map((n) => {
    const s = claudeSrc.indexOf(`${n}()`);
    return s < 0 ? '' : claudeSrc.slice(s, claudeSrc.indexOf('\n}', s) + 2);
  }),
].join('\n');

function extractFunctionBody(src: string, name: string): string {
  const start = src.indexOf(`${name}()`);
  const end = src.indexOf('\n}', start) + 2;
  return src.slice(start, end);
}

const CONFIG = {
  manifestFile: 'package.json',
  manifestKeys: ['dependencies', 'devDependencies'],
  scanFileExtensions: ['.ts', '.tsx', '.js', '.jsx'],
  importPattern:
    "from\\s+['\"]([^./][^'\"]*)['\"]|require\\(\\s*['\"]([^./][^'\"]*)['\"]\\s*\\)",
  installCommand: 'echo WOULD_INSTALL:{package}',
  // The engine no longer installs on its own verdict — acting unbidden on a regex match is what
  // put an unrelated public package into a client manifest. A project that wants installs says so.
  autoInstall: true,
  // REQUIRED. Without it the scan refuses rather than guessing — the legacy ran with its
  // declaration absent, kept working on hardcoded literals, and installed a public package
  // named after one of the repo's own directories.
  vendorDirs: ['node_modules'],
  ignorePackages: ['fs', 'path'],
};

function run(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dep-internal-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    mkdirSync(join(dir, '.epam'), { recursive: true });
    writeFileSync(join(dir, '.epam/dependency-check.json'), JSON.stringify(CONFIG));
    const script = join(dir, 'run.sh');
    writeFileSync(script,
      `${PREAMBLE}\n${extractFunctionBody(claudeSrc, 'run_dependency_check')}\nrun_dependency_check "${dir}"\n`);
    return execFileSync('bash', [script], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PKG = JSON.stringify({ name: 'fixture', dependencies: {}, devDependencies: {} });

describe('an import that names a file in this repo is internal', () => {
  it('does not install a baseUrl-style internal import — the live metrolinx loop', () => {
    const out = run({
      'package.json': PKG,
      'src/components/contentstack/Link.tsx': 'export const Link = 1;\n',
      'src/index.ts': "import { Link } from 'components/contentstack/Link';\n",
    });
    expect(out, `tried to npm-install the repo's own src/components:\n${out}`)
      .not.toMatch(/WOULD_INSTALL:components/);
  });

  it('works for a root that is not called src — nothing is hardcoded', () => {
    // If this passes only for `src`, the fix is metrolinx-shaped and the next
    // client breaks exactly the same way.
    const out = run({
      'package.json': PKG,
      'lib/widgets/Button.ts': 'export const B = 1;\n',
      'lib/main.ts': "import { B } from 'widgets/Button';\n",
    });
    expect(out, `did not resolve an internal import under lib/:\n${out}`)
      .not.toMatch(/WOULD_INSTALL:widgets/);
  });

  it('resolves a directory module through its index file', () => {
    const out = run({
      'package.json': PKG,
      'src/hooks/useContent/index.ts': 'export const useContent = 1;\n',
      'src/app.ts': "import { useContent } from 'hooks/useContent';\n",
    });
    expect(out).not.toMatch(/WOULD_INSTALL:hooks/);
  });

  it('uses the manifest\'s declared extensions, not a built-in list', () => {
    // scanFileExtensions is config; a repo whose sources are .jsx must work
    // without the engine knowing anything about JSX.
    const out = run({
      'package.json': PKG,
      'app/parts/Card.jsx': 'export const C = 1;\n',
      'app/main.jsx': "import { C } from 'parts/Card';\n",
    });
    expect(out).not.toMatch(/WOULD_INSTALL:parts/);
  });
});

describe('a real missing package is still installed', () => {
  it('installs an import that names no file in the repo', () => {
    // The fix must not become a blanket "never install anything".
    const out = run({
      'package.json': PKG,
      'src/app.ts': "import x from 'left-pad';\n",
    });
    expect(out, `a genuinely missing dependency was skipped:\n${out}`)
      .toMatch(/WOULD_INSTALL:left-pad/);
  });

  it('installs a scoped package that merely looks path-like', () => {
    const out = run({
      'package.json': PKG,
      'src/app.ts': "import x from '@scope/thing';\n",
    });
    expect(out).toMatch(/WOULD_INSTALL:@scope\/thing/);
  });

  it('still skips a package that is installed but undeclared', () => {
    // Pre-existing behaviour worth guarding: present in node_modules means
    // satisfiable at runtime, so do not rewrite a brownfield package.json for
    // it. The first draft of this test asserted toBeTruthy() on the output,
    // which fails on the CORRECT result — no install means no output. Asserting
    // "something was printed" is not the same as asserting the right thing.
    const out = run({
      'package.json': PKG,
      'node_modules/ghost/index.js': 'module.exports = 1;\n',
      'src/app.ts': "import g from 'ghost';\n",
    });
    expect(out, `an already-installed package was reinstalled:\n${out}`)
      .not.toMatch(/WOULD_INSTALL:ghost/);
  });

  it('does not use vendor dirs as module roots', () => {
    // If node_modules counted as a root, a genuinely missing package whose name
    // matches a vendored path would be silently skipped — the fix turning into
    // a blanket "never install".
    const out = run({
      'package.json': PKG,
      'node_modules/other/deep/thing.ts': 'export const t = 1;\n',
      'src/app.ts': "import { t } from 'deep/thing';\n",
    });
    expect(out, `resolved an import through node_modules — vendor dirs are not source:\n${out}`)
      .toMatch(/WOULD_INSTALL:deep/);
  });
});
