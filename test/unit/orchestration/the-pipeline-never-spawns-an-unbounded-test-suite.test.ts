/**
 * THE PIPELINE MUST NOT SPAWN AN UNBOUNDED TEST SUITE.
 *
 * THIS IS WHAT KILLED THE 2026-09-04 RUN, and the damage was not merely resource damage.
 *
 * Step 5's regression guard runs the CLIENT's own test command — `npm test`, deliberately, so the
 * engine names no runner. On next.gotransit.com that is jest over 3,389 tests, and jest sizes its
 * pool from `os.availableParallelism()`: 16 workers, 9.7GB, the box down to 988MB free and 4GB of
 * swap.
 *
 * The correctness consequence is the point. Under that pressure, WHICH interaction tests exceeded
 * their 5s timeout varied per attempt (`StarWidgetContainer (20.577 s)` — four times its budget).
 * The guard runs three attempts precisely to tell a flake from a regression, and RG-DELTA then
 * takes the INTERSECTION of the failing sets to tolerate a pre-existing baseline. Attempt 1 failed
 * one suite; attempts 2 and 3 failed two. The sets DISAGREED, so RG-DELTA correctly refused to
 * trust them, and the run hard-failed on three timeouts unrelated to the story. ~2.5h, ~$17.
 *
 * So an unbounded suite does not just risk the host: IT MANUFACTURES THE INSTABILITY THAT DEFEATS
 * THE PIPELINE'S OWN TOLERANCE LOGIC. Bounding it is a correctness fix.
 *
 * THE BOUND MUST NOT TOUCH THE COMMAND. `--maxWorkers` would mean the engine knowing a runner's
 * flags, and several metrolinx codelines declare chained scripts
 * (`npm --prefix a run test && npm --prefix b run test`) where an appended argument reaches only
 * the last link and may not be accepted at all. CPU AFFINITY is the runner-agnostic lever:
 * `availableParallelism()` honours it (measured: `taskset -c 0-3` -> 4), so the pool shrinks with
 * no argument injection. The per-process heap cap is a stack fact and belongs to the ecosystem
 * provider, not here.
 *
 * PROBED, NEVER ASSUMED. `command -v taskset` answers "is it installed", which is not the
 * question — run-bounded.sh already shipped a bound that reported success and never applied, by
 * testing for the systemd binary rather than the bus. Every case below EXECUTES the bound and
 * measures the result.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../../../');
const LIB = join(REPO, 'orchestrations/scripts/lib/bounded-exec.sh');
const GUARD = join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh');

/** Run a snippet with the library sourced, and return its stdout. */
function withLib(snippet: string, env: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-exec-'));
  try {
    const s = join(dir, 's.sh');
    writeFileSync(s, `#!/bin/bash\nset -uo pipefail\n. ${JSON.stringify(LIB)}\n${snippet}\n`);
    const r = spawnSync('bash', [s], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, ...env },
    });
    if (r.status !== 0) throw new Error(`snippet exited ${r.status}\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('the bound exists and is derived, not typed', () => {
  it('the library is there', () => {
    expect(existsSync(LIB),
      'orchestrations/scripts/lib/bounded-exec.sh does not exist — nothing bounds what the pipeline spawns')
      .toBe(true);
  });

  it('fewer workers are allowed when less memory is available — the bound reads the machine', () => {
    // The SAME function, twice, with only the reported free memory differing. A literal worker
    // count would answer identically both times.
    const roomy = Number(withLib('resolve_test_workers', { EPAM_TEST_AVAIL_MB_OVERRIDE: '32000' }).trim());
    const tight = Number(withLib('resolve_test_workers', { EPAM_TEST_AVAIL_MB_OVERRIDE: '2000' }).trim());
    expect(Number.isFinite(roomy) && Number.isFinite(tight),
      'resolve_test_workers did not print a number').toBe(true);
    expect(tight,
      'the worker count ignores available memory — it is a literal, not a derivation')
      .toBeLessThan(roomy);
  });

  it('never returns zero, however little memory there is', () => {
    const n = Number(withLib('resolve_test_workers', { EPAM_TEST_AVAIL_MB_OVERRIDE: '1' }).trim());
    expect(n, 'a zero worker count would mean the suite never runs at all').toBeGreaterThanOrEqual(1);
  });

  it('never exceeds the machine it is running on', () => {
    const cpus = Number(execFileSync(process.execPath,
      ['-e', 'process.stdout.write(String(require("os").availableParallelism()))'], { encoding: 'utf8' }));
    const n = Number(withLib('resolve_test_workers', { EPAM_TEST_AVAIL_MB_OVERRIDE: '999999' }).trim());
    expect(n).toBeLessThanOrEqual(cpus);
  });
});

describe('THE BOUND ACTUALLY BINDS — measured in a real child process', () => {
  it('a command run through it sees the reduced parallelism jest would size its pool from', () => {
    // This is the assertion that matters. Not "the prefix mentions taskset" — what the spawned
    // process actually observes, which is exactly what jest-config/getMaxWorkers.js reads.
    const seen = Number(withLib(
      `run_test_bounded 2 ${JSON.stringify(process.execPath)} -e ` +
      `'process.stdout.write(String(require("os").availableParallelism()))'`).trim());
    expect(seen,
      'the test command still saw every core — the bound did not reach the process that spawns the workers')
      .toBe(2);
  });

  it('the bounded command still reports its own exit status — a guard cannot be blinded', () => {
    // If the wrapper swallowed the status, a red suite would read as green: worse than no bound.
    const out = withLib('run_test_bounded 2 false >/dev/null 2>&1; echo "rc=$?"');
    expect(out).toContain('rc=1');
    const ok = withLib('run_test_bounded 2 true >/dev/null 2>&1; echo "rc=$?"');
    expect(ok).toContain('rc=0');
  });

  it('and its output, so the failing-test identities RG-DELTA parses still arrive', () => {
    const out = withLib(`run_test_bounded 2 printf 'FAIL src/a.spec.ts\\n'`);
    expect(out,
      'RG-DELTA extracts failing-test identity from this output; a wrapper that eats it disables tolerance')
      .toContain('FAIL src/a.spec.ts');
  });

  it('when affinity cannot be applied it runs ANYWAY and says so — never silently unbounded', () => {
    // A bound that cannot be applied is a fact the operator must see. Silence here is how
    // run-bounded.sh printed "MemoryMax=..." for months while applying nothing.
    const dir = mkdtempSync(join(tmpdir(), 'no-taskset-'));
    try {
      writeFileSync(join(dir, 'taskset'), '#!/bin/bash\nexit 127\n');
      execFileSync('chmod', ['+x', join(dir, 'taskset')]);
      const s = join(dir, 's.sh');
      writeFileSync(s, [
        '#!/bin/bash', 'set -uo pipefail', `. ${JSON.stringify(LIB)}`,
        'run_test_bounded 2 echo ran', 'echo "rc=$?"',
      ].join('\n'));
      const r = spawnSync('bash', [s], {
        encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      });
      expect(r.stdout, 'the command did not run when the bound was unavailable').toContain('ran');
      expect(r.stdout).toContain('rc=0');
      expect(`${r.stdout}${r.stderr}`.toLowerCase(),
        'the bound could not be applied and nothing said so — the operator believes it is bounded')
        .toMatch(/unbounded|could not|cannot|no bound|not bounded/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/**
 * FIX THE CLASS, NOT THE SITE.
 *
 * Step 5 is where it cost a run, but it is one of SIX places the pipeline hands a client's own
 * test command to a shell — the regression guard, the RG-DELTA delta re-run, the lockfile probe,
 * the plan-review check and the unit-test gate (twice). Bounding only the one that happened to
 * hurt leaves five loaded guns and guarantees this returns under a different step number.
 *
 * The sites are DISCOVERED by scanning for the shape, so one added tomorrow is caught tomorrow.
 */
describe('EVERY site that spawns a client test command is bounded', () => {
  const src = readFileSync(GUARD, 'utf8');

  /** Every line that runs a resolved client test command through a shell. */
  const sites = src.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /sh -c "\$_[a-z]+_test_cmd"/.test(line))
    .filter(({ line }) => !/^\s*#/.test(line));

  it('the guard sources the library', () => {
    expect(src, 'run-agent-orchestration.sh never loads bounded-exec.sh').toMatch(/bounded-exec\.sh/);
  });

  it('the scan found the invocation sites — otherwise every case below is vacuous', () => {
    expect(sites.length,
      'no client-test-command invocation found; the scan pattern has drifted from the script')
      .toBeGreaterThan(3);
  });

  it.each(sites.map((s) => ({ n: s.n, line: s.line.trim() })))(
    'line $n is bounded', ({ line }) => {
      expect(line, [
        'This spawns the CLIENT\'s test suite with no bound. Unbounded, that suite took 16 workers',
        'and 9.7GB, and the timeouts it produced differed between attempts — which made RG-DELTA\'s',
        'intersection unstable and aborted the 2026-09-04 run over three failures unrelated to the',
        'story. Route it through run_test_bounded "$(resolve_test_workers)".',
        '',
        line,
      ].join('\n')).toMatch(/run_test_bounded/);
    });
});
