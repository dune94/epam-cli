/**
 * ONE DEFINITION PER FUNCTION, IN THE PROCESS THAT RUNS IT.
 *
 * _run_project_verification was defined six times. The section-aware one (tsc-baseline-gate.sh)
 * was overwritten, in every real process, by copies that drop the section — so the "test" baseline
 * ran the TYPECHECK command, came back empty, and every pre-existing codeline failure was charged to
 * whichever story ran (regintel 2026-09-24: `suite exit=0 ... 0 bytes`). verification-plugin.js was
 * fixed for exactly this on 2026-09-02 (AMSD-1919) and the fix was dead ever since: the shell copy
 * that wins never passed the section. Tests that sourced tsc-baseline-gate.sh alone saw the good
 * copy and passed.
 *
 * So both halves are asserted where it matters:
 *  - BEHAVIOUR, in the real claude.sh process (claude.sh is sourced — it defines and stops): asked
 *    for the `test` section, verification runs the test command.
 *  - STRUCTURE, for both entry points: the source graph each one loads defines no function twice.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const dirs: string[] = []; afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('in the real claude.sh process, verification runs the section it is asked for', () => {
  function codeline() {
    const d = mkdtempSync(join(tmpdir(), 'one-def-')); dirs.push(d);
    mkdirSync(join(d, '.epam'), { recursive: true });
    // Typecheck is clean; the test suite has a pre-existing failure — the regintel shape.
    writeFileSync(join(d, '.epam/verification.json'), JSON.stringify({
      typecheck: { command: 'echo typecheck-clean' },
      test: { command: 'echo "FAILED tests/test_pre.py::test_old - AssertionError"; exit 1' },
    }));
    return d;
  }
  function inClaudeSh(root: string, call: string) {
    const r = spawnSync('bash', ['-c', `export PRD_FILE=/dev/null PROJECT_ROOT=${JSON.stringify(root)}
. ${JSON.stringify(join(SCRIPTS, 'claude.sh'))} >/dev/null 2>&1
# claude.sh runs under set -e; the engine calls this as \`… || rc=$?\`, and so does this harness.
rc=0; ${call} || rc=$?; echo "rc=$rc"`], { encoding: 'utf8', timeout: 90_000 });
    return (r.stdout || '') + (r.stderr || '');
  }

  it('asked for "test", it runs the test command — not the typecheck', () => {
    const d = codeline();
    const out = inClaudeSh(d, `_run_project_verification ${JSON.stringify(d)} test`);
    expect(out).toContain('FAILED tests/test_pre.py::test_old');
    expect(out).not.toContain('typecheck-clean');
    expect(out).toMatch(/rc=[1-9]/);
  });

  it('asked for nothing, it still runs the typecheck — every existing caller keeps its behaviour', () => {
    const d = codeline();
    const out = inClaudeSh(d, `_run_project_verification ${JSON.stringify(d)}`);
    expect(out).toContain('typecheck-clean');
    expect(out).toMatch(/rc=0/);
  });
});

/** Every function each file defines at column 0, and every lib it sources, in order. */
function sourceGraph(entry: string) {
  const seen = new Set<string>(); const defs = new Map<string, string[]>();
  const walk = (file: string) => {
    if (seen.has(file) || !existsSync(file)) return; seen.add(file);
    const dir = dirname(file);
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const d = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{/);
      if (d) { const l = defs.get(d[1]) || []; l.push(file.replace(SCRIPTS + '/', '')); defs.set(d[1], l); }
      const s = line.match(/^\s*(?:source|\.)\s+"?(?:\$SCRIPT_DIR|\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)|\$_?LIB(?:_DIR)?)\/([A-Za-z0-9_./-]+\.sh)"?/);
      if (s) walk(resolve(s[0].includes('BASH_SOURCE') ? dir : SCRIPTS, s[1]));
    }
  };
  walk(join(SCRIPTS, entry));
  return { files: seen.size, dup: [...defs].filter(([, f]) => new Set(f).size > 1).map(([n, f]) => `${n}: ${f.join(', ')}`) };
}

describe('the source graph each entry point loads defines no function twice', () => {
  for (const entry of ['claude.sh', 'run-agent-orchestration.sh']) {
    it(entry, () => {
      const g = sourceGraph(entry);
      expect(g.files, 'the walk found no libraries — nothing below is tested').toBeGreaterThan(10);
      expect(g.dup).toEqual([]);
    });
  }
});
