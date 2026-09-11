/**
 * THE THIRD SITE. "Nothing the pipeline spawns is unbounded" (c24d501d) bounded the writer's
 * verification suite in claude.sh and the regression guard in run-agent-orchestration.sh, and its
 * test scanned the guard for `sh -c "$_x_test_cmd"` lines. update-invalidated-tests.sh runs the
 * client suite too — `node_modules/.bin/jest` directly, in its own file — and was never in view.
 *
 * Live 2026-09-11, resume of 20260910T222155Z on openrouter, inside a 5621MB memory scope: the
 * writer and the repro-test gate had both committed; this step then spawned jest with one worker
 * per core — 29 processes, 6068MB — and the cgroup OOM-killed the run. Every earlier brownfield run
 * did the same thing uncapped and the HOST absorbed it (the 9.7GB / 988MB-free incident in
 * bounded-exec.sh's header is this step's sibling).
 *
 * This EXECUTES the real run_suite with a stand-in jest that reports the CPU set it actually got.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const UIT = join(SCRIPTS, 'update-invalidated-tests.sh');

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** The real run_suite(), lifted from the script, with any helper defined immediately before it. */
function extractRunSuite(): string {
  const lines = readFileSync(UIT, 'utf8').split('\n');
  const rs = lines.findIndex((l) => /^run_suite\(\)\s*\{/.test(l));
  if (rs < 0) throw new Error('run_suite() not found in update-invalidated-tests.sh');
  const end = lines.findIndex((l, i) => i > rs && /^\}/.test(l));
  if (end < 0) throw new Error('run_suite() has no closing brace');
  // The whole "Run the suite" section, from the script's own marker: run_suite and whatever it
  // depends on live under it together.
  let start = rs;
  for (let i = rs - 1; i >= 0; i--) {
    if (/^# ── Run the suite/.test(lines[i])) { start = i; break; }
  }
  if (start === rs) throw new Error('the "Run the suite" section marker was not found above run_suite()');
  const body = lines.slice(start, end + 1).join('\n');
  if (!/jest|vitest/.test(body)) throw new Error('extracted the wrong block');
  return body;
}

function cpusAllowedCount(list: string): number {
  // "0-3" -> 4, "0,2" -> 2, "0" -> 1
  return list.trim().split(',').reduce((n, part) => {
    const m = /^(\d+)-(\d+)$/.exec(part);
    return n + (m ? Number(m[2]) - Number(m[1]) + 1 : 1);
  }, 0);
}

const hostCpus = Number(execFileSync('nproc', { encoding: 'utf8' }).trim());
const affinityWorks = spawnSync('taskset', ['-c', '0', 'true']).status === 0;

describe('the invalidated-tests step is bounded too', () => {
  it('this host can even show the difference — otherwise the case below proves nothing', () => {
    expect(hostCpus, 'a single-core host cannot distinguish bounded from unbounded').toBeGreaterThan(1);
    expect(affinityWorks, 'taskset is unavailable here; the bound cannot be observed').toBe(true);
  });

  it('the client suite it spawns sees a reduced CPU set when memory is tight — executed, not inspected', () => {
    const d = mkdtempSync(join(tmpdir(), 'uit-bound-')); dirs.push(d);
    const proj = join(d, 'project'); mkdirSync(join(proj, 'node_modules/.bin'), { recursive: true });
    const seen = join(d, 'cpus.txt');
    // A stand-in jest that records the CPU set it was actually given, then passes.
    writeFileSync(join(proj, 'node_modules/.bin/jest'),
      `#!/bin/bash\ngrep Cpus_allowed_list /proc/self/status | awk '{print $2}' > ${JSON.stringify(seen)}\nexit 0\n`);
    chmodSync(join(proj, 'node_modules/.bin/jest'), 0o755);

    const harness = join(d, 'h.sh');
    writeFileSync(harness, [
      '#!/bin/bash',
      `SCRIPT_DIR=${JSON.stringify(SCRIPTS)}`,
      `PROJECT_ROOT=${JSON.stringify(proj)}`,
      'log(){ echo "[t] $*" >&2; }',
      // The library is what the other two sites use; loading it here is the script's job, but
      // the harness must not fail for want of it if the script does not load it — that IS the RED.
      `[ -f "$SCRIPT_DIR/lib/bounded-exec.sh" ] && . "$SCRIPT_DIR/lib/bounded-exec.sh"`,
      extractRunSuite(),
      'run_suite; echo "rc=$?"',
    ].join('\n'));

    // 2000MB available -> the resolver allows 1 worker (60% / 700MB per worker).
    const r = spawnSync('bash', [harness], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, EPAM_TEST_AVAIL_MB_OVERRIDE: '2000' },
    });
    expect(existsSync(seen), `the stand-in jest never ran:\n${r.stdout}${r.stderr}`).toBe(true);
    const got = cpusAllowedCount(readFileSync(seen, 'utf8'));
    expect(got, [
      `update-invalidated-tests.sh spawned the client suite on ${got} of ${hostCpus} CPUs with 2000MB`,
      'available — jest will size a worker per CPU it can see. Live this was 29 processes and 6068MB',
      'in one step. Route it through run_test_bounded "$(resolve_test_workers)" like the other sites.',
    ].join('\n')).toBe(1);
  });
});
