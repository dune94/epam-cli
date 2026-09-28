/**
 * A DECLARED CHECK THAT FAILS IS A FAILURE — NEVER "NOT DECLARED".
 *
 * _run_project_verification (lib/tsc-baseline-gate.sh) answers 2 for "the project declares no check"
 * and passed any other failure through with the check's OWN exit code. tsc exits 2 when it reports
 * errors, so on every TypeScript codeline a real type error came back as 2 — and run_tsc_verification
 * (lib/story-attempt.sh) told the writer "the verification manifest does not declare [a type check]
 * … nothing was checked", with the errors hidden under that. Found at £0 on 2026-09-28 (hello-dolly on
 * codemie-web): eight attempts told to declare a check that was declared, HealingBroken on the
 * repeated diagnosis, the story failed.
 *
 * Executed: the real lib/tsc-baseline-gate.sh sourced whole, and run_tsc_verification taken from
 * lib/story-attempt.sh as written, on a codeline whose manifest declares a check. Asserted at both
 * ends: the exit code the function returns, and the message the writer's retry receives.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const GATE = join(SCRIPTS, 'lib/tsc-baseline-gate.sh');
const RUN_TSC = shellFunction(join(SCRIPTS, 'lib/story-attempt.sh'), 'run_tsc_verification');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A codeline whose manifest declares `typecheck` as a command that prints `out` and exits `code`. */
function codeline(code: number | null, out = 'src/a.ts(2,10): error TS2305: Module has no exported member x.'): string {
  const d = mkdtempSync(join(tmpdir(), 'undeclared-')); dirs.push(d);
  if (code !== null) {
    mkdirSync(join(d, '.epam'));
    writeFileSync(join(d, 'check.sh'), `printf '%s\\n' ${JSON.stringify(out)}\nexit ${code}\n`);
    writeFileSync(join(d, '.epam/verification.json'), JSON.stringify({ typecheck: { command: `sh ${join(d, 'check.sh')}` } }));
  }
  return d;
}

const bash = (script: string, root: string) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PROJECT_ROOT: root, NODE_BIN: process.execPath, NODE_CMD: process.execPath, AUTOMATION_DIR: join(ROOT, 'orchestrations'), LOG_DIR: root } });

function verify(root: string) {
  const r = bash(`. ${JSON.stringify(GATE)}; _run_project_verification "$PROJECT_ROOT"; echo "RC=$?"`, root);
  return { rc: Number((/RC=(\d+)/.exec(r.stdout) || [])[1]), out: r.stdout };
}

/** What the writer's retry is told after the story's type check. */
function writerIsTold(root: string) {
  const script = [
    'log(){ :; }; warning(){ echo "W: $*" >&2; }; success(){ :; }; error(){ :; }; info(){ :; }',
    '_epam_write_verification_manifest(){ :; }',
    `. ${JSON.stringify(GATE)}`,
    'baseline_new_failures(){ cat "$5"; return 1; }   # the story introduced every error: nothing pre-existing to subtract',
    RUN_TSC,
    'VERIFICATION_FAILURE=""; story_id=S-1; run_tsc_verification S-1; echo "RC=$?"; printf "%s" "$VERIFICATION_FAILURE"',
  ].join('\n');
  const r = bash(script, root);
  return { rc: Number((/RC=(\d+)/.exec(r.stdout) || [])[1]), told: r.stdout.replace(/^RC=\d+\n?/m, ''), err: r.stderr };
}

describe('the verification function', () => {
  it('a declared check that fails with its own exit code 2 (tsc on a type error) is a FAILURE, not "not declared"', () => {
    const v = verify(codeline(2));
    expect(v.out).toContain('error TS2305');
    expect(v.rc).not.toBe(2);
    expect(v.rc).not.toBe(0);
  });

  it('a check that is genuinely not declared is still 2', () => {
    const v = verify(codeline(null));
    expect(v.rc).toBe(2);
    expect(v.out).toMatch(/verification not declared/);
  });

  it('a declared check that passes is 0, and one failing with another code keeps it', () => {
    expect(verify(codeline(0, 'ok')).rc).toBe(0);
    expect(verify(codeline(3)).rc).toBe(3);
  });
});

describe('what the writer is told', () => {
  it('a type error reaches the writer as the errors — never as "declare a type check"', () => {
    const w = writerIsTold(codeline(2));
    expect(w.rc).not.toBe(0);
    expect(w.told.length, `nothing was told: ${w.err}`).toBeGreaterThan(0);
    expect(w.told).toContain('error TS2305');
    expect(w.told).not.toMatch(/does not declare one/);
  });

  it('an undeclared check still asks the writer to declare it', () => {
    const w = writerIsTold(codeline(null));
    expect(w.told).toMatch(/does not declare one/);
  });
});
