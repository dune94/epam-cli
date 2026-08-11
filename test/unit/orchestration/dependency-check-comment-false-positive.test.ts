/**
 * A time string in a comment is not an import — but the scanner can't tell.
 *
 * Live metrolinx 2026-07-30. gotransit's real source contains:
 *
 *   /**
 *    * @description
 *    * Convert time from "11:30" to "11-30" format
 *    *\/
 *   export const convertTimeToRequestFormat = (time: string) => ...
 *
 * The comment literally contains the substring `from "11:30"`, which matches
 * importPattern (`from\s+['"]([^./][^'"]*)['"]|...`) exactly, because the
 * regex runs against the file's RAW TEXT — it has no concept of comments or
 * string literals, only of the word "from" followed by a quoted string.
 * dependency-check then tried to `npm install` a package literally named
 * "11:30": `npm error Invalid tag name "11:30"`.
 *
 * THIS IS THE SAME DEFECT CLASS, RECURRING. The code already documents an
 * earlier live occurrence (2026-07-06): a coordinator's free-text notes
 * containing "mapping from 'from/to' to 'origin/destination'" was parsed as
 * an import of a package named "from/to", which then hung retrying against
 * the npm registry indefinitely. That incident was "fixed" by restricting
 * WHICH FILES get scanned (source extensions only) — it never addressed
 * WHERE WITHIN a file the pattern is allowed to match. Real source files
 * have real comments; restricting file scope was necessary but not
 * sufficient.
 *
 * THE FIX MUST STAY GENERIC. commentPatterns is a new, OPTIONAL manifest key
 * (default: none configured = current behaviour, unchanged) — a project
 * declares what ITS language's comment syntax looks like, the engine has no
 * built-in knowledge of `//`, `/* *\/`, `#`, or any other syntax. A Python
 * project's own dependency-check.json would declare its own comment pattern,
 * or none at all, and nothing here would need to change.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
  const lines = src.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === `${name}() {`);
  if (startIdx === -1) throw new Error(`Could not find start of function ${name}`);
  let inHeredoc = false;
  let heredocDelim = '';
  const body: string[] = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    body.push(line);
    if (!inHeredoc) {
      const m = line.match(/<<-?\s*'?(\w+)'?/);
      if (m) { inHeredoc = true; heredocDelim = m[1]; continue; }
      if (line === '}') return body.join('\n');
    } else if (line.trim() === heredocDelim) {
      inHeredoc = false;
    }
  }
  throw new Error(`Could not find end of function ${name}`);
}

const NPM_CONFIG_BASE = {
  manifestFile: 'package.json',
  manifestKeys: ['dependencies', 'devDependencies'],
  scanFileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  importPattern:
    "from\\s+['\"]([^./][^'\"]*)['\"]|require\\(\\s*['\"]([^./][^'\"]*)['\"]\\s*\\)",
  installCommand: 'echo WOULD_INSTALL:{package} >> installed.log',
  // The engine no longer installs on its own verdict — acting unbidden on a regex match is what
  // put an unrelated public package into a client manifest. A project that wants installs says so.
  autoInstall: true,
  // REQUIRED. Without it the scan refuses rather than guessing — the legacy ran with its
  // declaration absent, kept working on hardcoded literals, and installed a public package
  // named after one of the repo's own directories.
  vendorDirs: ['node_modules'],
  ignorePackages: ['url', 'path', 'fs', 'http', 'node:url', 'node:path'],
};

const LIVE_FILE_CONTENT = `/**
 * @description
 * Convert time from "11:30" to "11-30" format
 */
export const convertTimeToRequestFormat = (time: string) => time.replace(':', '-');

import { realPackage } from 'a-genuine-dependency';
realPackage();
`;

function runDependencyCheck(configExtra: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'dep-check-comment-'));
  try {
    mkdirSync(join(dir, '.epam'), { recursive: true });
    mkdirSync(join(dir, 'src', 'utils', 'dates'), { recursive: true });
    writeFileSync(
      join(dir, '.epam', 'dependency-check.json'),
      JSON.stringify({ ...NPM_CONFIG_BASE, ...configExtra }),
    );
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: {}, devDependencies: {} }));
    writeFileSync(join(dir, 'src', 'utils', 'dates', 'convertTimeToRequestFormat.ts'), LIVE_FILE_CONTENT);

    const fnBody = extractFunctionBody(claudeSrc, 'run_dependency_check');
    const scriptPath = join(dir, 'run.sh');
    writeFileSync(scriptPath, `cd ${JSON.stringify(dir)}\n${PREAMBLE}\n${fnBody}\nrun_dependency_check ${JSON.stringify(dir)}\n`);
    execFileSync('bash', [scriptPath], { encoding: 'utf8', timeout: 15000 });

    const logPath = join(dir, 'installed.log');
    const installed = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    return installed;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a comment containing "from \\"TIME\\"" is not an import', () => {
  it('REPRODUCES the live false positive when no comment pattern is configured', () => {
    const installed = runDependencyCheck({});
    expect(installed, 'dependency-check tried to npm install a package named after a ' +
      'time string found inside a JSDoc comment — the exact live failure').toMatch(/11:30/);
  });

  it('does not install the phantom package once commentPatterns is configured', () => {
    const installed = runDependencyCheck({
      commentPatterns: ['/\\*[\\s\\S]*?\\*/', '//[^\\n]*'],
    });
    expect(installed, 'the comment was stripped but the phantom package was still ' +
      'attempted').not.toMatch(/11:30/);
  });

  it('still installs a GENUINE missing import from the same file', () => {
    // The fix must not make the scanner blind to real imports that happen to
    // sit near a comment — only the comment's own text should be excluded.
    const installed = runDependencyCheck({
      commentPatterns: ['/\\*[\\s\\S]*?\\*/', '//[^\\n]*'],
    });
    expect(installed, 'stripping comments also hid the real import').toMatch(/a-genuine-dependency/);
  });

  it('is a no-op when commentPatterns is not configured — opt-in, no engine assumption', () => {
    // Backward compatible: a project that never declares commentPatterns
    // behaves exactly as before this fix (still buggy for that project until
    // it opts in, but nothing breaks or changes silently).
    const withoutConfig = runDependencyCheck({});
    const withEmptyConfig = runDependencyCheck({ commentPatterns: [] });
    expect(withoutConfig).toMatch(/11:30/);
    expect(withEmptyConfig).toMatch(/11:30/);
  });
});
