/**
 * EVERY SUITE RUN USES THE DECLARED TEST COMMAND — never the ecosystem's detected one.
 *
 * AMSD-2974 live, 2026-10-04: Step 19 took `_codeline_test_command` — the ecosystem's DETECTED
 * `npm test`, bare jest, a worker per core — and OOM-killed the run (5.2 GB) after review had approved.
 * The lint-fix check, the testing-gates oracle and the unit-test gate read the same detected command;
 * the writer's verification alone used the project's declaration (verification plugin testCommandFor:
 * detected < project-declared < hand-tuned). One definition now: _codeline_test_command answers the
 * declaration. EXECUTED: the real function, on a codeline whose package script is a decoy.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORCH = join(__dirname, '../../../orchestrations');
const SCRIPTS = join(ORCH, 'scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The real function, lifted from the library that defines it once. */
const fnSrc = (() => {
  const s = readFileSync(join(SCRIPTS, 'lib/tsc-baseline-gate.sh'), 'utf8').split('\n');
  const a = s.findIndex((l) => /^_codeline_test_command\(\) \{/.test(l));
  const b = s.findIndex((l, i) => i > a && l === '}');
  return s.slice(a, b + 1).join('\n');
})();

function codeline(declared: boolean) {
  const d = mkdtempSync(join(tmpdir(), 'declared-cmd-')); dirs.push(d);
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'c', scripts: { test: 'jest' }, devDependencies: { jest: '^29' } }));
  if (declared) {
    mkdirSync(join(d, '.epam'), { recursive: true });
    writeFileSync(join(d, '.epam', 'verification.json'), JSON.stringify({ test: { command: 'npm run test -- --maxWorkers=1' } }));
  }
  return d;
}

const run = (root: string) => spawnSync('bash', ['-c', `SCRIPT_DIR=${JSON.stringify(SCRIPTS)}\n${fnSrc}\n_codeline_test_command ${JSON.stringify(root)}`],
  { encoding: 'utf8', env: { ...process.env, NODE_BIN: process.execPath, AUTOMATION_DIR: ORCH } }).stdout.trim();

describe('every suite run uses the declared test command', () => {
  it('the function was found', () => { expect(fnSrc).toMatch(/_codeline_test_command\(\)/); });
  it('a codeline that declares its suite gets the declaration, not the detected script', () => {
    expect(run(codeline(true))).toBe('npm run test -- --maxWorkers=1');
  });
  it('a codeline that declares nothing still gets the detected command', () => {
    expect(run(codeline(false))).not.toBe('');
  });
});
