/**
 * A MOCK RUN MUST BE PROCESS-IDENTICAL TO A REAL RUN.
 *
 * This is the drift guard for the failure that cost an entire session. A mock (or
 * retest) harness that skips steps the real launcher performs cannot fail in the ways
 * the real run fails — so it goes green while the real pipeline is broken, and the
 * green is read as evidence. That is precisely what happened with the writer-retest
 * harness (2026-08-03): it skipped spec-pass, so it never exercised the code path that
 * was actually broken, and "3/3 success" meant nothing.
 *
 * Found again the same day: `tier3-mock-run.sh` was 117 lines against the real
 * launcher's 406, and mock3 bypassed the launcher entirely by invoking
 * run-agent-orchestration.sh directly. Neither mock ever set EPAM_PROJECT_CONFIG_DIR —
 * the single gateway to plugins.json, codeline-facts.json, env-vars.json and
 * llm-settings.json — so no mock could exercise plugin provisioning, project tool
 * advertisement, or per-model iteration budgets. Every one of those had just been
 * changed.
 *
 * THE REFERENCE IS DERIVED, NOT NAMED. The brownfield production launcher is found by
 * looking for the tier launcher that sets EPAM_BROWNFIELD=1 and is not itself a mock.
 * Add a step to the real launcher and the mocks must gain it too — the requirement
 * updates itself rather than rotting in a hand-written list here.
 *
 * The CAPABILITY PROBES below are deliberately about pipeline machinery (script names,
 * env var names), never client facts — a mock is expected to differ in WHICH project
 * config it points at, and identical in THAT it points at one.
 */
import { gatedRunEnv } from '../../helpers/gated-run-env';
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const SCRIPTS = join(REPO_ROOT, 'orchestrations/scripts');

/** Pipeline machinery every real brownfield launch performs. */
const CAPABILITIES: Array<{ id: string; why: string; re: RegExp }> = [
  { id: 'setsid-isolation', why: 'process-group isolation so kill-tier3-run.sh can stop the whole tree', re: /exec setsid bash/ },
  { id: 'pid-file', why: 'writes a PID file so the tested killer can find this run', re: /TIER3_PID_FILE/ },
  { id: 'project-config-dir', why: 'EPAM_PROJECT_CONFIG_DIR — gateway to plugins/codeline-facts/env-vars/llm-settings', re: /export\s+EPAM_PROJECT_CONFIG_DIR=/ },
  { id: 'profiles-restore', why: 'restores profiles.json from canonical so a run starts from a known base state', re: /profiles\.json\.original|profiles\.canonical\.json/ },
  { id: 'codeline-teardown', why: 'brownfield-preflight-reset.sh — predictable teardown to baseline', re: /brownfield-preflight-reset\.sh/ },
  { id: 'pre-run-reset', why: 'pre-run-reset.sh — dashboard/log wiring for this run', re: /pre-run-reset\.sh/ },
  { id: 'codegraph-preflight', why: 'every codeline indexed before the detective needs it', re: /codegraph-preflight-index\.sh|CodeGraph preflight/ },
  { id: 'run-orchestration', why: 'invokes the real orchestration entrypoint', re: /run-agent-orchestration\.sh/ },
  { id: 'self-heal-retry', why: 'retries the phase on exit 2 after gate remediation', re: /-eq 2|== 2/ },
  { id: 'run-artifacts', why: 'archives run artefacts on EVERY outcome, not just success', re: /archive-run-artifacts\.sh/ },
];

function launchers(): string[] {
  return readdirSync(SCRIPTS)
    .filter(f => /^tier[0-9]+-.+-run\.sh$/.test(f))
    .map(f => join(SCRIPTS, f));
}

/**
 * Scope exemptions — RECORDED, never silent. An exemption with a reason is a decision;
 * an exemption without one is a blind spot that reads as coverage.
 *   tier1-mock-run.sh: tier-1 is a cheap smoke harness for a greenfield hello-world, not
 *     a rehearsal of the brownfield client flow. Backlogged, not in this pass's scope.
 *   brownfield-mock-e2e-2: mock2 was out of scope for the 2026-08-03 parity pass
 *     (mock1 + mock3 only). Backlogged.
 */
const EXEMPT_LAUNCHERS = ['tier1-mock-run.sh'];
const EXEMPT_TESTS = ['brownfield-mock-e2e-2-worktree-topology.test.ts'];

const isMock = (p: string) => /-mock-/.test(p) && !EXEMPT_LAUNCHERS.includes(p.split('/').pop()!);
const read = (p: string) => readFileSync(p, 'utf8');
const has = (src: string, cap: (typeof CAPABILITIES)[number]) => cap.re.test(src);

/** The real brownfield launcher: sets EPAM_BROWNFIELD=1 and is not a mock. */
function referenceLauncher(): string {
  const found = launchers().filter(p => !isMock(p) && /EPAM_BROWNFIELD=1/.test(read(p)));
  return found[0];
}

/** Mock launchers must mirror it. */
function mockLaunchers(): string[] {
  return launchers().filter(isMock);
}

describe('mock launchers are process-identical to the real brownfield launcher', () => {
  it('finds a real brownfield launcher to measure against', () => {
    expect(referenceLauncher(), 'no non-mock launcher sets EPAM_BROWNFIELD=1').toBeTruthy();
  });

  it('finds at least one mock launcher', () => {
    expect(mockLaunchers().length).toBeGreaterThan(0);
  });

  it('every capability the real launcher has is also in the mock launcher', () => {
    const refSrc = read(referenceLauncher());
    const required = CAPABILITIES.filter(c => has(refSrc, c));
    expect(required.length, 'the reference launcher matched no capabilities — probes are stale').toBeGreaterThan(3);

    const gaps: string[] = [];
    for (const mock of mockLaunchers()) {
      const mockSrc = read(mock);
      for (const cap of required) {
        if (!has(mockSrc, cap)) {
          gaps.push(`  ${mock.split('/').pop()} is missing [${cap.id}] — ${cap.why}`);
        }
      }
    }
    expect(
      gaps,
      `A mock that skips steps the real launcher performs cannot fail the way the real ` +
        `run fails, so its green result is not evidence. Bring the mock launcher to parity ` +
        `(it may point at DIFFERENT project config — it may not skip having any):\n${gaps.join('\n')}`,
    ).toEqual([]);
  });
});

describe('archiving on failure is proven by EXECUTION, not by a string being present', () => {
  // The static probe above reported [run-artifacts] present while a FAILED run
  // archived nothing: the archive call sat after run_phase, which fail() can never
  // reach because it exits directly. A capability check that a broken implementation
  // passes is worse than no check — it certifies the gap. This runs the real
  // launcher, forces it to fail, and looks for the artefacts on disk.
  it('a failing run still writes its run artefacts', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'parity-archive-'));
    const configDir = join(tmp, 'project-config');
    const lane = join(tmp, 'lane');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(lane, { recursive: true });
    // Minimally VALID rather than empty: the pre-flight rejects a PRD with no
    // project.outputDir, and rightly so — the deliverables check would look in the wrong
    // place. `{}` only ever passed because nothing assessed it.
    writeFileSync(
      join(lane, 'prd.json'),
      JSON.stringify({ project: { name: 'parity', outputDir: lane }, stories: [] }),
    );
    // Every project owns its synthesis template; without one the pre-flight correctly
    // refuses to launch, because the run would inherit another project's identity.
    writeFileSync(join(configDir, 'prd.canonical.json'), JSON.stringify({ project: { name: 'parity' }, stories: [] }));

    const r = spawnSync('bash', [
      join(SCRIPTS, 'tier3-mock-run.sh'),
      '--prd', join(lane, 'prd.json'),
      '--project-root', lane,
      '--phase', '__parity_forced_failure__',
    ], {
      encoding: 'utf8',
      timeout: 120000,
      env: {
        // The paid launcher gates the coverage map before spending; this test is about launcher
        // parity, so the precondition is supplied as a real passing measurement.
        ...gatedRunEnv(),
        ...process.env,
        TIER3_SETSID_DONE: '1',          // stay attached so the assertion can observe it
        EPAM_PROJECT_CONFIG_DIR: configDir,
        ORCH_RUN_ID: 'parity-test-run',
        EPAM_DANGEROUS_SKIP_APPROVAL: '1',
        JIRA_CODELINE_ROOT: '',           // skip teardown; not what this asserts
        // This drives the real launcher into a forced-failure phase to prove a FAILED run
        // still archives its evidence. It is not launching on this machine's behalf, so the
        // machine-environment checks (dashboard up, snapshot watcher alive, Langfuse
        // answering) do not apply — otherwise this assertion would pass or fail with
        // whether a watcher happened to be running. Project readiness still blocks.
        EPAM_PREFLIGHT_ENVIRONMENT: '0',
      },
    });

    expect(r.status, 'the forced-failure phase should make the launcher exit non-zero').not.toBe(0);
    const runDir = join(configDir, 'runs', 'parity-test-run');
    expect(
      existsSync(runDir),
      `a FAILED run archived nothing — the run whose evidence matters most. ` +
        `Expected artefacts at ${runDir}. stdout:\n${(r.stdout || '').slice(-600)}`,
    ).toBe(true);
    expect(existsSync(join(runDir, 'outcome.txt')), 'outcome.txt not written').toBe(true);
    expect(readFileSync(join(runDir, 'outcome.txt'), 'utf8')).toMatch(/FAILED/);

    rmSync(tmp, { recursive: true, force: true });
  }, 130000);
});

describe('mock e2e tests go through a launcher, never straight to the orchestrator', () => {
  const mockTests = readdirSync(join(REPO_ROOT, 'test/unit/orchestration'))
    .filter(f => /^brownfield-mock-e2e.*\.test\.ts$/.test(f))
    .filter(f => !EXEMPT_TESTS.includes(f));

  it('finds the mock e2e tests', () => {
    expect(mockTests.length).toBeGreaterThan(0);
  });

  it.each(mockTests)('%s launches via a tier launcher, not run-agent-orchestration.sh directly', (file) => {
    const src = readFileSync(join(REPO_ROOT, 'test/unit/orchestration', file), 'utf8');
    const usesLauncher = /tier[0-9]+-[a-z0-9-]*-run\.sh/.test(src);
    expect(
      usesLauncher,
      `${file} invokes the orchestrator directly, so it skips the entire launch sequence — ` +
        `teardown, profiles restore, project config, CodeGraph preflight, artefact archiving. ` +
        `A run that starts differently from the real one is not a rehearsal of it.`,
    ).toBe(true);
  });
});
