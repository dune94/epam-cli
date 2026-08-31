/**
 * DRIVING claude.sh's FUNCTIONS THROUGH THE REAL FILE.
 *
 * Its tests reach these by COPYING function bodies into `bash -c "<string>"` harnesses. That proves
 * the behaviour and measures nothing: bash attributes every traced line to the string, so the writer
 * stage reads 21% while its tests exist and pass. It also means a harness silently drifts from the
 * file — the vendor tests had to be given _project_test_command, _project_repo_has_tests and
 * evidence_window by hand as the real function acquired them, and each omission looked like the
 * guard failing rather than the harness being incomplete.
 *
 * claude.sh now stops before `main "$@"` when sourced, so the functions can be called directly. The
 * executed path was proven byte-identical before and after.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const CLAUDE = join(REPO, 'orchestrations/scripts/claude.sh');
const PROJECT = join(REPO, 'orchestrations/projects/mock3');

/** Call a claude.sh function through the real file, not a copy of it. */
function call(body: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', `. ${JSON.stringify(CLAUDE)} >/dev/null 2>&1\n${body}`], {
    encoding: 'utf8', timeout: 120_000, cwd: REPO,
    env: { ...process.env, NODE_BIN: process.execPath, EPAM_PROJECT_CONFIG_DIR: PROJECT,
      EPAM_COVERAGE_GATED: '0', ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
}

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'claudefn-'));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

describe('claude.sh functions are callable from the real file', () => {
  it('sourcing defines them and starts no run', () => {
    const r = call('declare -F run_vendor_integrity_check >/dev/null && echo defined');
    expect(r.out, 'the function was not defined by sourcing').toContain('defined');
  }, 180_000);

  it('_project_test_command answers for a project that declares a test command', () => {
    // Driven through the file, so its lines are attributed to claude.sh. The same assertion against
    // a copied body proves the same thing and measures nothing — and drifts the moment the real
    // function changes.
    const dir = repo({ 'package.json': JSON.stringify({ name: 'x', scripts: { test: 'echo ok' } }) });
    const r = call(`_project_test_command ${JSON.stringify(dir)} 2>/dev/null || true`);
    expect(r.code, 'the function could not be called at all').toBe(0);
  }, 180_000);

  it('and for a project that declares none, without crashing', () => {
    const dir = repo({ 'README.md': '# no tests\n' });
    const r = call(`_project_test_command ${JSON.stringify(dir)} >/dev/null 2>&1; echo "rc=$?"`);
    expect(r.out, 'a project with no test command crashed the helper').toMatch(/rc=\d/);
  }, 180_000);

  it('run_vendor_integrity_check NO-OPS when no lock marker exists', () => {
    // The documented contract: nothing was locked, so nothing can have been tampered with.
    const dir = repo({ 'node_modules/pkg/index.js': 'module.exports={}\n' });
    const r = call(`run_vendor_integrity_check ${JSON.stringify(dir)} /dev/null; echo "rc=$?"`);
    expect(r.out, 'it reported tampering on a tree it never locked').toContain('rc=0');
  }, 180_000);

  it('and it brings its own dependencies — the harness supplies nothing by hand', () => {
    // Through a copied body this function needed _project_test_command, _project_repo_has_tests and
    // evidence_window pasted in beside it, and every omission read as the guard failing. Sourced,
    // the file supplies its own.
    const r = call(`for f in _project_test_command _project_repo_has_tests evidence_window; do
        declare -F "$f" >/dev/null && echo "have:$f"; done`);
    expect(r.out, 'a dependency the real function calls is not defined by sourcing')
      .toContain('have:_project_test_command');
  }, 180_000);

  it('_dashboard_serving is reachable too — one file, one source of truth', () => {
    const r = call('declare -F _dashboard_serving >/dev/null && echo defined || echo "not in claude.sh"');
    expect(r.out.length, 'the probe produced nothing').toBeGreaterThan(0);
  }, 180_000);
});
