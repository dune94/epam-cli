/**
 * EVERY STAGE ASKS, AND A STAGE THAT IS TOLD "NO" DOES NOT RUN.
 *
 * The gate exists because untested code is the most expensive thing this pipeline executes: the
 * 2026-08-31 metrolinx run paid for Jira ingest, codeline discovery, an estate survey and an agent
 * mint before dying at the roster step on a branch no test had ever executed. The money was spent
 * before the defect was reachable.
 *
 * A gate nobody calls stops nothing, and a gate whose verdict nobody reads is worse than none — it
 * reports a refusal into a log while the stage runs anyway. So this asserts both halves, and it
 * asserts them by EXECUTING the real scripts rather than by reading them:
 *
 *   every declared stage has a caller          — no stage can be entered unguarded
 *   the shortfall halts the real script        — the receiver acts on the verdict, exit non-zero
 *   the blocker off lets it past               — the boolean is a boolean, not decoration
 *   no measurement is not a pass                — unmeasured is the state before anyone ran the suite
 *   pre-flight covers the whole map            — including stages nothing ever "enters"
 */
import { describe, it, expect } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../..');
const SCRIPTS = join(REPO, 'orchestrations/scripts');
const NODE = process.execPath;

const STAGES: string[] = Object.keys(
  JSON.parse(readFileSync(join(REPO, 'orchestrations/config/stage-coverage.json'), 'utf8')).stages,
);

/** Every require_stage_coverage call the shipped scripts make, with the stage it names. */
function callers(): { stage: string; file: string }[] {
  let out = '';
  try {
    out = execFileSync('grep', ['-rn', '--include=*.sh', 'require_stage_coverage ', SCRIPTS],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch { /* grep exits 1 on no match; the emptiness is the finding */ }
  return out.split('\n').filter(Boolean).flatMap((line) => {
    const file = line.slice(0, line.indexOf(':'));
    if (file.endsWith('lib/stage-coverage-gate.sh')) return []; // its own definition and doc
    const m = /require_stage_coverage\s+"?([a-z][a-z0-9-]*)"?/.exec(line);
    return m ? [{ stage: m[1], file }] : [];
  });
}

/** A workspace whose policy and coverage data we control. */
function fixture(opts: { threshold: number; blocker: boolean; lcov: string | null }) {
  const dir = mkdtempSync(join(tmpdir(), 'gatewire-'));
  mkdirSync(join(dir, 'coverage'), { recursive: true });
  writeFileSync(join(dir, 'coverage-policy.json'),
    JSON.stringify({ thresholdPercent: opts.threshold, blocker: opts.blocker }));
  if (opts.lcov !== null) writeFileSync(join(dir, 'coverage/lcov.info'), opts.lcov);
  return dir;
}

/** Run a shipped script under that fixture, and see whether it got past its gate. */
function runScript(script: string, dir: string, extra: Record<string, string> = {}) {
  return spawnSync('bash', [join(SCRIPTS, script)], {
    encoding: 'utf8', timeout: 120_000, cwd: REPO,
    env: {
      ...process.env,
      NODE_BIN: NODE,
      STAGE_COVERAGE_POLICY: join(dir, 'coverage-policy.json'),
      STAGE_COVERAGE_LCOV: join(dir, 'coverage/lcov.info'),
      EPAM_STAGE_COVERAGE_CACHE: join(dir, 'cache'),
      // A gated run: pre-flight has passed, so the launcher's stage gate enforces.
      EPAM_COVERAGE_GATED: '1',
      ...extra,
    },
  });
}

describe('every stage asks the coverage gate', () => {
  it('there are stages to guard, and callers that guard them', () => {
    // Without this both assertions below could pass over an empty set.
    expect(STAGES.length, 'the coverage map declares no stages').toBeGreaterThan(5);
    expect(callers().length, 'nothing in the pipeline calls the gate at all').toBeGreaterThan(5);
  });

  it('every declared stage is guarded — by its own caller, or by pre-flight', () => {
    // cli, shared and reset are real code the pipeline depends on but are never "entered", so
    // nothing would ever gate them. Pre-flight covers the whole map for exactly that reason; a
    // stage guarded by neither is code no gate can reach.
    const named = new Set(callers().map((c) => c.stage));
    const preflightCoversAll = /require_all_stage_coverage/.test(
      readFileSync(join(SCRIPTS, 'preflight-static.sh'), 'utf8'));
    const unguarded = STAGES.filter((s) => !named.has(s) && !preflightCoversAll);
    expect(unguarded, 'these stages can be entered with no coverage gate in front of them')
      .toEqual([]);
  });

  it('and pre-flight asks about every stage in the map, not a list of its own', () => {
    // A hard-coded list in the shell drifts the moment a stage is added.
    const printed = spawnSync(NODE, [join(SCRIPTS, 'lib/handlers/stage-coverage.js'), '--stages'],
      { encoding: 'utf8', timeout: 60_000 });
    expect(printed.status, printed.stderr).toBe(0);
    expect(printed.stdout.split('\n').filter(Boolean)).toEqual(STAGES);
  });

  it('a shortfall HALTS the real launcher — it does not merely log', () => {
    // The receiver half. An empty lcov is 0% against a 95% floor.
    const dir = fixture({ threshold: 95, blocker: true, lcov: '' });
    const r = runScript('tier3-mock-run.sh', dir);
    expect(r.status, 'the launcher ran on past a coverage refusal').not.toBe(0);
    expect(`${r.stderr}`, 'it exited, but not because of the gate').toMatch(/coverage-gate/);
  }, 180_000);

  it('and with the blocker OFF the same shortfall does not halt it', () => {
    // Proves the halt above came from the boolean and not from anything else in the launcher.
    const dir = fixture({ threshold: 95, blocker: false, lcov: '' });
    const r = runScript('tier3-mock-run.sh', dir, { EPAM_GATE_PROBE_EXIT: '1' });
    expect(`${r.stderr}`, 'the gate did not report the waived shortfall').toMatch(/blocker is OFF/);
  }, 180_000);

  it('no coverage data at all is a halt, not a pass — unmeasured is not covered', () => {
    const dir = fixture({ threshold: 95, blocker: true, lcov: null });
    const r = spawnSync('bash', ['-c',
      `. "${join(SCRIPTS, 'lib/stage-coverage-gate.sh')}"; require_stage_coverage writer`], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, NODE_BIN: NODE, EPAM_COVERAGE_GATED: '1',
        STAGE_COVERAGE_POLICY: join(dir, 'coverage-policy.json'),
        STAGE_COVERAGE_LCOV: join(dir, 'coverage/lcov.info'),
        EPAM_STAGE_COVERAGE_CACHE: join(dir, 'cache') },
    });
    expect(r.status, 'missing coverage data was treated as full coverage').not.toBe(0);
  }, 180_000);

  it('a project that declares no policy is refused, not defaulted', () => {
    // How much cover a run demands before spending is the operator's decision, per project. A
    // default here would make that decision for them silently.
    const r = spawnSync('bash', ['-c',
      `. "${join(SCRIPTS, 'lib/stage-coverage-gate.sh')}"; require_stage_coverage writer`], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, NODE_BIN: NODE, EPAM_COVERAGE_GATED: '1',
        STAGE_COVERAGE_POLICY: '/nonexistent/policy.json', EPAM_PROJECT_CONFIG_DIR: '',
        // and no declared default either, or the fallback would legitimately supply one
        STAGE_COVERAGE_DEFAULT_POLICY: '/nonexistent/default-policy.json' },
    });
    expect(r.status, 'a stage ran under a coverage policy nobody declared').not.toBe(0);
  }, 180_000);

  it('the gate refuses a call that names no stage', () => {
    const r = spawnSync('bash', ['-c',
      `. "${join(SCRIPTS, 'lib/stage-coverage-gate.sh')}"; require_stage_coverage`],
      { encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, NODE_BIN: NODE, EPAM_COVERAGE_GATED: '1' } });
    expect(r.status, 'the gate judged a stage it was never told').not.toBe(0);
  }, 120_000);

  it('two runs sharing a temp directory do not inherit each other\'s verdict', () => {
    // REGRESSION. The gate briefly kept its own cache, keyed on the stage name, under $TMPDIR. Two
    // runs asking about the same stage read whichever number was written last, and nothing tied a
    // stored value to the tree it measured — a percentage could outlive the code it described.
    // That is the silence the gate exists to end, reintroduced by the thing meant to make it fast.
    //
    // Exercised through the SHELL function the pipeline actually calls, sharing one TMPDIR, because
    // that is where the defect lived — the handler was correct throughout.
    const shared = mkdtempSync(join(tmpdir(), 'shared-tmp-'));
    const passing = fixture({ threshold: 95, blocker: true, lcov: '' });
    const covered = mkdtempSync(join(tmpdir(), 'covered-'));
    mkdirSync(join(covered, 'coverage'), { recursive: true });
    writeFileSync(join(covered, 'coverage-policy.json'),
      JSON.stringify({ thresholdPercent: 95, blocker: true }));
    // A tree the gate can measure at 100%: the repo's own files, every line hit.
    const lines = ['SF:orchestrations/scripts/ai-run.sh',
      ...Array.from({ length: 20 }, (_, i) => `DA:${i + 1},1`), 'LF:20', 'LH:20', 'end_of_record', ''];
    writeFileSync(join(covered, 'coverage/lcov.info'), lines.join('\n'));

    const ask = (dir: string) => spawnSync('bash', ['-c',
      `. "${join(SCRIPTS, 'lib/stage-coverage-gate.sh')}"; require_stage_coverage writer`], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, NODE_BIN: NODE, TMPDIR: shared, EPAM_COVERAGE_GATED: '1',
        STAGE_COVERAGE_POLICY: join(dir, 'coverage-policy.json'),
        STAGE_COVERAGE_LCOV: join(dir, 'coverage/lcov.info'),
        STAGE_COVERAGE_REPORT: join(dir, 'coverage/stage-coverage.json') },
    });

    // The failing tree first, then the same question from a different tree. If a verdict is being
    // cached by name under the shared TMPDIR, the second answer is the first one.
    const first = ask(passing);
    expect(first.status, 'an empty lcov was not a shortfall').not.toBe(0);
    const second = ask(passing);
    expect(second.status, 'the same tree gave two different verdicts').toBe(first.status);
    expect(`${second.stderr}`, 'the second ask produced no gate output at all — it read a cache')
      .toMatch(/coverage-gate/);
  }, 180_000);

  it('a stage gate STANDS DOWN when no pre-flight has run — it enforces, it does not decide', () => {
    // Pre-flight is what makes a run gated: it measures every stage before anything can spend, and
    // it persists the report. Its absence means this is not a gated run — a unit test executing a
    // launcher, someone running one script by hand.
    //
    // Enforcing there was a false-positive gate: every test that executes a pipeline script started
    // depending on a current coverage report, so the scripts became unrunnable outside a full
    // measurement. A gate nobody can satisfy is worse than no gate — it teaches people to route
    // around it.
    const r = spawnSync('bash', ['-c',
      `. "${join(SCRIPTS, 'lib/stage-coverage-gate.sh')}"; require_stage_coverage writer`], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, NODE_BIN: NODE, EPAM_COVERAGE_GATED: '0' },
    });
    expect(r.status, 'a stage refused outside a gated run, making the script unrunnable').toBe(0);
    expect(r.stderr).toMatch(/no pre-flight has gated this run|standing down/i);
  }, 180_000);

  it('and once pre-flight HAS gated the run, the same stage enforces', () => {
    // The other half: the marker turns enforcement ON. If it did not, nothing would ever be gated.
    const r = spawnSync('bash', ['-c',
      `. "${join(SCRIPTS, 'lib/stage-coverage-gate.sh')}"; require_stage_coverage writer`], {
      encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, NODE_BIN: NODE, EPAM_COVERAGE_GATED: '1',
        STAGE_COVERAGE_LCOV: '/tmp/definitely-no-such-lcov.info',
        STAGE_COVERAGE_REPORT: '/tmp/definitely-no-such-report.json' },
    });
    expect(r.status, 'a gated run proceeded with no coverage measurement at all').not.toBe(0);
    expect(r.stderr).toMatch(/Unmeasured is not covered|HALTING/i);
  }, 180_000);

  it('but PRE-FLIGHT never stands down — it is the one that gates the run', () => {
    // The other half. If pre-flight also stood down on a missing report, nothing would ever gate:
    // the absence it checks for would excuse the check.
    const r = spawnSync('bash', ['-c',
      `. "${join(SCRIPTS, 'lib/stage-coverage-gate.sh')}"; require_all_stage_coverage`], {
      encoding: 'utf8', timeout: 180_000,
      env: { ...process.env, NODE_BIN: NODE,
        STAGE_COVERAGE_REPORT: '/tmp/definitely-no-such-report.json',
        STAGE_COVERAGE_LCOV: '/tmp/definitely-no-such-lcov.info',
        STAGE_COVERAGE_POLICY: '' },
    });
    expect(r.status, 'pre-flight let a run start with no coverage measurement at all').not.toBe(0);
    expect(r.stderr).toMatch(/refusing to start|Unmeasured is not covered/i);
  }, 240_000);

  it('every project the repo ships declares a policy', () => {
    // A project without one cannot launch at all — the refusal above is total.
    const projects = execFileSync('ls', [join(REPO, 'orchestrations/projects')],
      { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) {
      const f = join(REPO, 'orchestrations/projects', p, 'coverage-policy.json');
      const policy = JSON.parse(readFileSync(f, 'utf8'));
      expect(typeof policy.thresholdPercent, `${p} declares no numeric threshold`).toBe('number');
      expect(typeof policy.blocker, `${p} declares no blocker boolean`).toBe('boolean');
    }
  });
});
