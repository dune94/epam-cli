/**
 * THE FOURTH SITE: the spec validator's test oracle.
 *
 * Seven places in run-agent-orchestration.sh run the client's own test command. Six go through
 * run_test_bounded "$(resolve_test_workers)". Step 22b's "Test Oracle" — the hard evidence
 * injected before the spec validator is asked anything — runs
 *
 *     sh -c "$(_codeline_test_command "$PROJECT_ROOT")"
 *
 * bare. The guard test scanned for `sh -c "$_x_test_cmd"` and this shape is not that, so the
 * guard stayed green. Live 2026-09-11 13:45:50Z, resume of 20260910T222155Z on openrouter,
 * inside a 4623MB scope: Step 19 (bounded, 3 processes) and Step 20 passed, Steps 22a and 22b
 * started in parallel, jest went from 3 processes to 18, the cgroup hit its limit and the run
 * was killed. Same class as this morning's invalidated-tests kill, one site further along.
 *
 * Two assertions, both executed:
 *   1. the real oracle block, lifted from the orchestrator, spawns the runner on a reduced CPU
 *      set when memory is tight — a stand-in jest reports the set it was actually given;
 *   2. the scan in the-pipeline-never-spawns-an-unbounded-test-suite covers this shape.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const ORCH = join(SCRIPTS, 'run-agent-orchestration.sh');
const GUARD_TEST = join(__dirname, 'the-pipeline-never-spawns-an-unbounded-test-suite.test.ts');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A top-level function by name, lifted from the orchestrator. */
function liftFn(name: string): string {
  const lines = readFileSync(ORCH, 'utf8').split('\n');
  const s = lines.findIndex((l) => new RegExp(`^${name}\\(\\)\\s*\\{`).test(l));
  if (s < 0) throw new Error(`${name}() not found`);
  const e = lines.findIndex((l, i) => i > s && /^\}/.test(l));
  return lines.slice(s, e + 1).join('\n');
}

/** The oracle block: from its section comment to the line that stores the exit code. */
function liftOracleBlock(): string {
  const lines = readFileSync(ORCH, 'utf8').split('\n');
  const s = lines.findIndex((l) => /Test Oracle: inject hard vitest evidence/.test(l));
  if (s < 0) throw new Error('the Test Oracle block was not found in the orchestrator');
  const skipped = lines.findIndex((l, i) => i > s && /vitest oracle skipped/.test(l));
  if (skipped < 0) throw new Error('the Test Oracle block has no "oracle skipped" branch');
  const e = lines.findIndex((l, i) => i > skipped && /^\s*fi\s*$/.test(l));
  if (e < 0) throw new Error('the Test Oracle block has no closing fi');
  // `local` outside a function is an error under bash; the block is run inside one below.
  return lines.slice(s, e + 1).join('\n');
}

function cpusAllowedCount(list: string): number {
  return list.trim().split(',').reduce((n, part) => {
    const m = /^(\d+)-(\d+)$/.exec(part);
    return n + (m ? Number(m[2]) - Number(m[1]) + 1 : 1);
  }, 0);
}

const hostCpus = Number(execFileSync('nproc', { encoding: 'utf8' }).trim());
const affinityWorks = spawnSync('taskset', ['-c', '0', 'true']).status === 0;

describe('the spec validator oracle is bounded too', () => {
  it('this host can show the difference — otherwise the case below proves nothing', () => {
    expect(hostCpus).toBeGreaterThan(1);
    expect(affinityWorks).toBe(true);
  });

  it('the oracle spawns the client suite on a reduced CPU set when memory is tight — executed', () => {
    const d = mkdtempSync(join(tmpdir(), 'oracle-bound-')); dirs.push(d);
    const proj = join(d, 'project'); mkdirSync(join(proj, 'node_modules/.bin'), { recursive: true });
    const seen = join(d, 'cpus.txt');
    // A jest codeline: package.json with a test script, no vitest binary, a stand-in jest that
    // records the CPU set it was given.
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'fx', scripts: { test: 'jest' } }));
    writeFileSync(join(proj, 'node_modules/.bin/jest'),
      `#!/bin/bash\ngrep Cpus_allowed_list /proc/self/status | awk '{print $2}' > ${JSON.stringify(seen)}\nexit 0\n`);
    chmodSync(join(proj, 'node_modules/.bin/jest'), 0o755);
    const logDir = join(d, 'logs'); mkdirSync(logDir);

    const harness = join(d, 'h.sh');
    writeFileSync(harness, [
      '#!/bin/bash',
      `SCRIPT_DIR=${JSON.stringify(SCRIPTS)}`,
      `PROJECT_ROOT=${JSON.stringify(proj)}`,
      `LOG_DIR=${JSON.stringify(logDir)}`,
      'phase_id=core',
      `export PATH="${join(proj, 'node_modules/.bin')}:$PATH"`,
      `[ -f "$SCRIPT_DIR/lib/bounded-exec.sh" ] && . "$SCRIPT_DIR/lib/bounded-exec.sh"`,
      liftFn('_codeline_test_command'),
      liftFn('detect_node'),
      'oracle() {',
      liftOracleBlock(),
      '  echo "oracle_rc=$_oracle_rc"',
      '}',
      'oracle',
    ].join('\n'));

    const r = spawnSync('bash', [harness], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, EPAM_TEST_AVAIL_MB_OVERRIDE: '2000' },
    });
    expect(existsSync(seen), `the stand-in jest never ran:\n${r.stdout}${r.stderr}`).toBe(true);
    const got = cpusAllowedCount(readFileSync(seen, 'utf8'));
    expect(got, [
      `the spec validator oracle spawned the client suite on ${got} of ${hostCpus} CPUs with 2000MB`,
      'available. Live this was 18 jest processes and an OOM kill at Step 22b. Route it through',
      'run_test_bounded "$(resolve_test_workers)" like the other six sites.',
    ].join('\n')).toBe(1);
  });

  it('the guard scan would have caught this shape', () => {
    const guard = readFileSync(GUARD_TEST, 'utf8');
    // The scan must recognise `sh -c "$(_codeline_test_command ...)"` as a client test spawn.
    expect(guard, 'the-pipeline-never-spawns-an-unbounded-test-suite does not scan for the $(_codeline_test_command …) shape')
      .toMatch(/_codeline_test_command/);
  });
});
