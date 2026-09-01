/**
 * THE LAUNCH STAGE, MADE TESTABLE ONE FUNCTION AT A TIME.
 *
 * run-agent-orchestration.sh is 10,946 lines and 12.9% covered, and it cannot be improved by
 * writing more tests against it as it stands: 4,786 of its uncovered lines are INLINE — statements
 * at the top level of the file, interleaved with its 87 function definitions. Inline code executes
 * only when the script runs, so no unit test can reach it, and a full pipeline run is the only
 * thing that ever does. That is why the stage sat at 12.9% while every other stage climbed.
 *
 * The fix is structural, and it is the ordinary one: move the inline blocks into named functions in
 * sourceable libraries, and have the script call them. A function can be called with fixtures and
 * asserted on; a top-level `while` loop cannot.
 *
 * THIS IS THE FIRST EXTRACTION, chosen because it is the cleanest unit in the file: argument
 * parsing is input in, state out, with no I/O of its own beyond refusing bad input. 88 lines that
 * decide what every run does — the phase, the mode, whether stories reset, whether the sandbox is
 * used — and not one of them had ever been executed by a test.
 *
 * The extraction is pure code movement. Assignments inside a bash function without `local` are
 * global, so the variables the loop sets reach the rest of the script exactly as before; `exit`
 * still exits; `$0` is unchanged inside a function, so the usage text still names the script.
 * The one difference that matters is the one wanted: it can now be called.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const LIB = join(REPO, 'orchestrations/scripts/lib/orchestration-args.sh');
const ORCH = join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh');

/**
 * Parse a command line with the real function, and report what it set.
 *
 * `error` is supplied the way the orchestrator supplies it — the library is a part of that script,
 * not a standalone program, and a stub here is what lets the refusal messages be asserted.
 */
function parse(args: string[]) {
  const script = `
    set +e
    error()   { echo "ERROR: $*" >&2; }
    warning() { echo "WARN: $*" >&2; }
    log()     { :; }
    # The defaults the orchestrator sets before parsing.
    PHASE="finops"; RESET_STORIES=false; DRY_RUN=false; SKIP_CLEANUP=false; ORCH_MODE="bash"
    EPAM_SANDBOX=false; EPAM_SANDBOX_ALLOW_NETWORK=false
    . ${JSON.stringify(LIB)}
    parse_orchestration_args ${args.map((a) => JSON.stringify(a)).join(' ')}
    _rc=$?
    echo "RC=$_rc"
    echo "PHASE=$PHASE"
    echo "RESET_STORIES=$RESET_STORIES"
    echo "DRY_RUN=$DRY_RUN"
    echo "SKIP_CLEANUP=$SKIP_CLEANUP"
    echo "ORCH_MODE=$ORCH_MODE"
    echo "EPAM_SANDBOX=$EPAM_SANDBOX"
    echo "EPAM_SANDBOX_ALLOW_NETWORK=$EPAM_SANDBOX_ALLOW_NETWORK"
  `;
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8', timeout: 60000, cwd: REPO,
    // Inherit, so the shell coverage collector's BASH_ENV instrumentation survives.
    env: { ...process.env },
  });
  const out = (r.stdout || '');
  const val = (k: string) => (new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1] ?? null);
  return { out, err: r.stderr || '', status: r.status, val, exited: val('RC') === null };
}

describe('the orchestrator parses its arguments', () => {
  it('the library exists and defines the function', () => {
    expect(existsSync(LIB), 'the argument parser has not been extracted yet').toBe(true);
    const r = spawnSync('bash', ['-c', `. ${JSON.stringify(LIB)}; type -t parse_orchestration_args`],
      { encoding: 'utf8', timeout: 30000 });
    expect((r.stdout || '').trim()).toBe('function');
  }, 40_000);

  it('no arguments leaves every default untouched', () => {
    const r = parse([]);
    expect(r.val('RC')).toBe('0');
    expect(r.val('PHASE')).toBe('finops');
    expect(r.val('DRY_RUN')).toBe('false');
    expect(r.val('ORCH_MODE')).toBe('bash');
  }, 70_000);

  it('--phase takes the next argument', () => {
    expect(parse(['--phase', 'core']).val('PHASE')).toBe('core');
  }, 70_000);

  it('--phase with no value is refused, and says so', () => {
    // The failure this prevents: consuming the next FLAG as a phase name, so the run executes a
    // phase called "--dry-run" and reports it found no stories.
    const r = parse(['--phase']);
    expect(r.status, 'a phase with no name was accepted').not.toBe(0);
    expect(r.err).toMatch(/--phase requires a phase name/);
  }, 70_000);

  it('--phase followed by another flag is refused, not swallowed', () => {
    const r = parse(['--phase', '--dry-run']);
    expect(r.status, '"--dry-run" was accepted as a phase name').not.toBe(0);
    expect(r.err).toMatch(/--phase requires a phase name/);
  }, 70_000);

  it.each([
    ['--reset', 'RESET_STORIES'],
    ['--dry-run', 'DRY_RUN'],
    ['--skip-cleanup', 'SKIP_CLEANUP'],
    ['--sandbox', 'EPAM_SANDBOX'],
    ['--allow-network', 'EPAM_SANDBOX_ALLOW_NETWORK'],
  ])('%s sets %s', (flag, variable) => {
    const r = parse([flag]);
    expect(r.val('RC')).toBe('0');
    expect(r.val(variable), `${flag} did not set ${variable}`).toBe('true');
  }, 70_000);

  it.each(['bash', 'hybrid'])('--mode %s is accepted', (mode) => {
    expect(parse(['--mode', mode]).val('ORCH_MODE')).toBe(mode);
  }, 70_000);

  it('--mode refuses a value it does not implement', () => {
    // A mode nobody implements would otherwise fall through to whatever the dispatch defaults to,
    // and the run would report the mode it was given while executing another.
    const r = parse(['--mode', 'turbo']);
    expect(r.status, 'an unimplemented mode was accepted').not.toBe(0);
    expect(r.err).toMatch(/Invalid --mode/);
  }, 70_000);

  it('--mode with no value is refused', () => {
    const r = parse(['--mode']);
    expect(r.status).not.toBe(0);
    expect(r.err).toMatch(/--mode requires a value/);
  }, 70_000);

  it('an unknown option is refused rather than ignored', () => {
    const r = parse(['--phaze', 'core']);
    expect(r.status, 'an unknown option was ignored, so a typo runs the default phase silently')
      .not.toBe(0);
    expect(r.err).toMatch(/Unknown option: --phaze/);
  }, 70_000);

  it('--help prints usage naming the real options and exits 0', () => {
    const r = parse(['--help']);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Usage:/);
    for (const flag of ['--phase', '--mode', '--reset', '--dry-run', '--sandbox']) {
      expect(r.out, `help does not document ${flag}`).toContain(flag);
    }
  }, 70_000);

  it('flags combine, in any order', () => {
    const r = parse(['--dry-run', '--phase', 'core', '--mode', 'hybrid', '--reset']);
    expect(r.val('RC')).toBe('0');
    expect(r.val('PHASE')).toBe('core');
    expect(r.val('ORCH_MODE')).toBe('hybrid');
    expect(r.val('DRY_RUN')).toBe('true');
    expect(r.val('RESET_STORIES')).toBe('true');
  }, 70_000);

  it('THE ORCHESTRATOR USES IT — an extraction nothing calls is dead code', () => {
    // The half that makes this real. A library with a test and no caller looks covered and changes
    // nothing about the run.
    const { readFileSync } = require('node:fs');
    const src = readFileSync(ORCH, 'utf8');
    expect(src, 'the orchestrator does not source the extracted parser')
      .toMatch(/lib\/orchestration-args\.sh/);
    expect(src, 'the orchestrator does not call the extracted parser')
      .toMatch(/parse_orchestration_args\s+"\$@"/);
    expect(src, 'the inline parsing loop is still there, so the extraction changed nothing')
      .not.toMatch(/^\s*--skip-cleanup\)\s*$/m);
  }, 40_000);
});
