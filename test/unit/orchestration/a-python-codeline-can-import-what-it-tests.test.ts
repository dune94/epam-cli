/**
 * THE DECLARED TEST COMMAND MUST BE ABLE TO IMPORT THE CODE IT TESTS.
 *
 * Live, regintel 2026-09-22/23: every external verification in the project exited 2 with ZERO
 * tests collected, and it was invisible because an empty failure set read as "only pre-existing
 * baseline failures" (fixed in fd3929c5). The analyst diagnosed the cause three times:
 *
 *   [FailureAnalyst] Verification ran bare `pytest`, which omits the codeline root from sys.path;
 *                    `python -m pytest` does, deterministically.  — Target=tool
 *
 * Measured in the codeline itself, same venv, same directory:
 *
 *   pytest                     -> ModuleNotFoundError: No module named 'regintel' (10 errors, exit 2)
 *   .venv/bin/python -m pytest -> 7 failed, 97 passed, 1 skipped
 *
 * The ecosystem scaffolds a pytest.ini carrying `pythonpath = .` (requirements-txt.js), which is
 * what made bare `pytest` work — until a story rewrote that file as `[pytest]\ntestpaths = tests`
 * and the requirement silently vanished. A declared command must not depend on a file any story
 * may overwrite.
 *
 * This EXECUTES both commands against a real python package whose pytest.ini has no pythonpath.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ecosystem = require(join(ROOT, 'orchestrations/ecosystems/requirements-txt.js'));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A codeline as the writer leaves it: a package, a test that imports it, and a pytest.ini
 *  that a story has rewritten without the ecosystem's pythonpath line. */
function codeline() {
  const dir = mkdtempSync(join(tmpdir(), 'py-codeline-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'widgets'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'widgets', '__init__.py'), '');
  writeFileSync(join(dir, 'widgets', 'core.py'), 'def add(a, b):\n    return a + b\n');
  writeFileSync(join(dir, 'tests', 'test_core.py'), 'from widgets.core import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n');
  writeFileSync(join(dir, 'pytest.ini'), '[pytest]\ntestpaths = tests\n');   // the line is gone
  writeFileSync(join(dir, 'requirements.txt'), 'pytest\n');
  return dir;
}

function run(dir: string, command: string) {
  const r = spawnSync('bash', ['-lc', command], { cwd: dir, encoding: 'utf8', timeout: 60000 });
  return { out: (r.stdout || '') + (r.stderr || ''), status: r.status ?? -1 };
}

describe('a python codeline can import what it tests', () => {
  it('REPRODUCES the live failure: the bare console script cannot import the package', () => {
    const dir = codeline();
    const { out, status } = run(dir, 'pytest -q');
    expect(status, 'bare pytest collected and passed — the reproduction no longer holds').not.toBe(0);
    expect(out).toMatch(/ModuleNotFoundError|ImportError/);
  });

  it('the command the ecosystem DECLARES collects and passes the same suite', () => {
    const dir = codeline();
    const declared = ecosystem.testCommand('pytest\n');
    expect(declared, 'the ecosystem declares no test command for a requirements.txt project').toBeTruthy();
    const { out, status } = run(dir, `${declared} -q`);
    expect(status, `the declared command "${declared}" could not run the suite:\n${out.slice(-500)}`).toBe(0);
    expect(out).toMatch(/1 passed/);
  });

  it('the scoped form runs a named file the same way', () => {
    const dir = codeline();
    // the scoped form is derived from the base command by the ecosystem's own testFileCommand,
    // which is how verification-plugin.js builds .epam/verification.json's scopedCommand
    const base = ecosystem.testCommand('pytest\n');
    const scoped = String(ecosystem.testFileCommand(base, ['{files}']) || `${base} {files}`);
    const { status, out } = run(dir, scoped.replace('{files}', 'tests/test_core.py') + ' -q');
    expect(status, out.slice(-400)).toBe(0);
  });
});
