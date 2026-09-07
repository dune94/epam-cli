/**
 * THE WRITER'S VERIFICATION SUITE IS BOUNDED — CPU *AND* MEMORY.
 *
 * claude.sh runs the CLIENT's own test suite after the writer edits files. It ran it with no bound
 * of any kind: jest defaults to cores-1 workers (15 on a 16-core box) against a 3,385-test jsdom
 * suite, on every writer attempt, up to twelve attempts. That is what took the host down twice on
 * 2026-09-07 and cost a WSL restart.
 *
 * The same suite, minutes earlier, IS bounded — run-agent-orchestration.sh wraps all six of its
 * invocations in run_test_bounded and says why: "an unbounded suite starves the host". Only the
 * writer's copy was left out.
 *
 * TWO DIMENSIONS, AND NEITHER SUBSTITUTES FOR THE OTHER. run_test_bounded uses `taskset`, which is
 * CPU AFFINITY: fewer cores does not cap heap. A memory bound is an explicit ceiling —
 * NODE_OPTIONS=--max-old-space-size. The operator asked for MEMORY bounded, repeatedly; applying
 * only the worker bound would have been the third time of not listening.
 *
 * DECLARED, NOT HARDCODED. How much memory a project's suite may use is the project's fact, so it
 * declares it in verification.json beside its command. A project that declares none behaves
 * exactly as it does today for memory, and still gets the CPU bound.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '../../../orchestrations/scripts');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/**
 * Lifts the real bounding helper from claude.sh and asks it what it would run, with the project's
 * declaration in place. The command is echoed rather than executed: what matters is the wrapper.
 */
function boundedCommand(declared: Record<string, unknown> | null, cmd = 'npm run test'): string {
  const src = readFileSync(join(SCRIPTS, 'claude.sh'), 'utf8');
  const start = src.indexOf('_bounded_test_command() {');
  expect(start, '_bounded_test_command was not found in claude.sh').toBeGreaterThan(0);
  const end = src.indexOf('\n}\n', start) + 3;

  const dir = mkdtempSync(join(tmpdir(), 'bound-'));
  dirs.push(dir);
  const proj = join(dir, 'codeline');
  mkdirSync(join(proj, '.epam'), { recursive: true });
  if (declared) {
    writeFileSync(join(proj, '.epam', 'verification.json'),
      JSON.stringify({ test: declared }, null, 2));
  }
  const drive = join(dir, 'drive.sh');
  writeFileSync(drive, ['#!/usr/bin/env bash', 'set -uo pipefail',
    'warning() { :; }; log() { :; }; info() { :; }',
    `PROJECT_ROOT=${JSON.stringify(proj)}`,
    // claude.sh always has SCRIPT_DIR; the helper finds lib/bounded-exec.sh through it.
    `SCRIPT_DIR=${JSON.stringify(SCRIPTS)}`,
    src.slice(start, end),
    `_bounded_test_command ${JSON.stringify(cmd)}`,
  ].join('\n'));
  try {
    return execFileSync('bash', [drive], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, AUTOMATION_DIR: join(SCRIPTS, '..'), NODE_BIN: process.execPath },
    }).trim();
  } catch (e: any) { return `${e.stdout || ''}${e.stderr || ''}`.trim(); }
}

describe('the writer verification suite', () => {
  it('GUARD: the helper returns a runnable command at all', () => {
    // The command is wrapped and shell-quoted by the bounding helper, so assert the ORIGINAL
    // command survives inside the wrapper rather than expecting it verbatim.
    const c = boundedCommand(null);
    expect(c, 'the helper produced nothing — the suite would run with no command').toBeTruthy();
    expect(c.replace(/\\/g, ''), 'the project command was lost inside the wrapper')
      .toContain('npm run test');
  });

  it('IS CPU-BOUNDED — it does not inherit the host core count', () => {
    // The defect: jest takes cores-1 by default. Step 5 bounds the same suite and says why.
    const c = boundedCommand(null);
    expect(c, 'the writer suite runs unbounded — 15 jest workers on a 16-core box, every attempt')
      .toMatch(/taskset|maxWorkers|run_test_bounded/);
  });

  it('IS MEMORY-BOUNDED when the project declares a ceiling', () => {
    /**
     * The half a CPU bound does not give. taskset caps cores, never heap.
     */
    const c = boundedCommand({ command: 'npm run test', maxOldSpaceMb: 2048 });
    expect(c, 'the declared memory ceiling was not applied — heap is still unbounded')
      .toContain('--max-old-space-size=2048');
  });

  it('a project declaring NO ceiling still gets the CPU bound, and no invented memory limit', () => {
    // Inventing a heap limit for a project that never asked would break suites that legitimately
    // need more. Absent stays absent.
    const c = boundedCommand({ command: 'npm run test' });
    expect(c).toMatch(/taskset|maxWorkers|run_test_bounded/);
    expect(c, 'a memory ceiling was invented for a project that declared none')
      .not.toContain('max-old-space-size');
  });

  it('EXECUTES IN A FRESH SHELL — the caller runs it through `bash -c`, not the sourcing shell', () => {
    /**
     * THE BUG THIS ENCODES. The first version of the bound emitted `run_test_bounded ... sh -c ...`.
     * That is a shell FUNCTION, sourced into claude.sh's own shell. The verification call site runs
     * the command through `bash -c "..."` — a NEW shell, which has never seen that function. Live,
     * it returned exit=127 (command not found) and the suite never ran at all: every story would
     * have failed verification, on a pipeline that must not be damaged.
     *
     * So the assertion is not "is it bounded" but "can a shell that inherited NOTHING run it". We
     * execute the emitted command in a bare `bash -c` with a stub on PATH and require it to reach
     * the stub — 127 means the wrapper named something that does not exist out there.
     */
    const c = boundedCommand(null, 'echo RANFORREAL');
    const stub = mkdtempSync(join(tmpdir(), 'bnd-'));
    let out = '', code = 0;
    try {
      out = execFileSync('bash', ['-c', c], {
        encoding: 'utf8', timeout: 30_000, cwd: stub,
        env: { PATH: process.env.PATH, HOME: stub },   // no functions, no exports from this process
      });
    } catch (e: any) { code = e.status ?? -1; out = `${e.stdout || ''}${e.stderr || ''}`; }

    expect(code, `the bounded command did not execute in a fresh shell (exit ${code}). ` +
      `127 means it calls a shell function the child shell cannot see. Emitted: ${c}`).toBe(0);
    expect(out, 'the wrapper swallowed the project command instead of running it')
      .toContain('RANFORREAL');
  });

  it('a malformed ceiling is ignored rather than passed through', () => {
    const c = boundedCommand({ command: 'npm run test', maxOldSpaceMb: 'lots' });
    expect(c).not.toContain('max-old-space-size=lots');
  });
});
