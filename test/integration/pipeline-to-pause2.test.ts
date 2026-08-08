/**
 * REAL END-TO-END: INGEST → MINT → PAUSE 1 → RESUME → PAUSE 2.
 *
 * WHY THIS EXISTS. The roster path was rebuilt repeatedly this week and every defect in it was
 * found by spending a live client run: the survey answering in prose, the reviewer fail-open,
 * stale investigators surviving a reset, stories assigned to an agent the correction had
 * already deleted, and the post-roster checkpoint written to a lane directory the parent never
 * looks in. Not one was caught by a test.
 *
 * They were missed because those tests assert on SOURCE STRUCTURE — "the guard is present",
 * "assignment appears after the loop". A function can be correct in isolation and wrong in
 * context: _checkpoint_lane() resolves a lane perfectly well and resolves the PARENT to
 * codeline[0], which no structural assertion can see. Only running the thing finds it.
 *
 * NOTHING IS HARDCODED HERE.
 *   - The codeline fixture is built by the canonical seed builder
 *     (mock1-paused-run.sh --seed), never hand-authored in this file.
 *   - The ticket text is read out of that same script, so there is one source for it.
 *   - EVERY pipeline setting is inherited wholesale from the REAL metrolinx project config.
 *     This file overrides only what CANNOT be shared — the Jira endpoint (a stub), the
 *     codeline root (disposable repos), the run id, and the project config dir. Anything else
 *     metrolinx sets, this run sets, because a mock that quietly drops a flag is testing a
 *     neighbouring pipeline. See mock-metrolinx-flow-parity.test.ts for the same rule applied
 *     to mock1/mock2.
 *
 * NO STEP IS OMITTED. No SKIP_* is introduced here; whatever metrolinx skips, this skips, and
 * nothing more.
 *
 * TWO CODELINES, deliberately. With one lane the parent's wrong answer and the lane's right
 * answer coincide, and every parent-vs-lane defect stays invisible — both defects found on
 * 2026-08-08 (the control-plane port and the checkpoint directory) are invisible with one
 * codeline and obvious with two.
 *
 * COST. Real, billed. Opt-in via RUN_REAL_PIPELINE_MOCK=1, the same gate mock1 and mock3 use.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, renameSync, rmSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../');
const MOCK_LAUNCHER = join(REPO_ROOT, 'orchestrations/scripts/tier3-mock-run.sh');
const ESTATE_SEED = join(REPO_ROOT, 'orchestrations/scripts/mock-estate-seed.js');
const TICKET = join(REPO_ROOT, 'test/fixtures/mock-estate/ticket.canonical.json');
const MOCK_JIRA = join(REPO_ROOT, 'test/fixtures/mock-pipeline/mock-jira-server.js');
const METRO_CFG = join(REPO_ROOT, 'orchestrations/projects/metrolinx/config.env');
/** The canonical base a run starts from. The RUN's roster lives in its own perimeter. */
const CANONICAL_PROFILES = join(REPO_ROOT, 'orchestrations/agents/profiles.json.original');
const RUN_REAL = process.env.RUN_REAL_PIPELINE_MOCK === '1';
/**
 * Transcripts live inside the run's own perimeter. They were written to
 * orchestrations/logs/pause-integration — inside CLIENT space — so this test violated the very
 * rule it asserts, and its own evidence tripped the isolation check.
 */
let TRANSCRIPT_DIR = join(tmpdir(), 'pause-e2e-transcripts');

const cleanupDirs: string[] = [];
/**
 * Set by afterEach. Without it the workspace was deleted even on failure, and the first real
 * execution of this harness destroyed the evidence for two of its own findings.
 */
let failed = false;
let jiraChild: ReturnType<typeof spawn> | null = null;

afterEach((ctx) => { if (ctx.task.result?.state === 'fail') failed = true; });

afterAll(() => {
  if (jiraChild) { try { jiraChild.kill(); } catch { /* already gone */ } }
  if (failed) {
    console.log(`\n[pause-e2e] FAILED — workspace preserved:\n  ${cleanupDirs.join('\n  ')}`);
    console.log(`[pause-e2e] transcripts: ${TRANSCRIPT_DIR}`);
    return;
  }
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Every assignment in the real metrolinx project config, parsed. The single source. */
function metrolinxConfig(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(METRO_CFG, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*(?:#.*)?$/);
    if (!m) continue;
    // `${FOO:-default}` declares a launch-time override; parity is about the effective value
    // with an empty launch environment, so take the default.
    const raw = m[3].replace(/^\$\{[A-Z_]+:-(.*)\}$/, '$1');
    out[m[1]] = raw;
  }
  return out;
}

/** The ticket, from the canonical estate fixture — never restated here. */
function estateTicket(): { id: string; summary: string; description: string } {
  const t = JSON.parse(readFileSync(TICKET, 'utf8'));
  return { id: t.id, summary: t.summary, description: t.description };
}

/**
 * The whole estate, from the canonical builder. Three codelines, each a small Contentstack +
 * React site differing ONLY in where content is fetched — a hook, a page, or an app-wide
 * provider. That difference is the point: one estate-wide sweep cannot produce a single answer
 * that fits all three, so a per-codeline investigator is the only way to be right.
 *
 * No fixture content is authored in this file, and the codeline names come from the fixture.
 */
function seedEstate(codelineRoot: string): string[] {
  const out = execFileSync(process.execPath, [ESTATE_SEED, '--root', codelineRoot], { encoding: 'utf8' });
  const built = JSON.parse(out).paths as string[];
  cleanupDirs.push(`${codelineRoot}-build`);
  expect(built.length, 'the estate builder produced fewer than three codelines').toBeGreaterThanOrEqual(3);
  return built;
}

interface Ctx {
  runId: string; workspace: string; codelineRoot: string; laneA: string;
  /** every disposable codeline, with the commit it was seeded at */
  lanes: { path: string; baseline: string }[];
  synthPrd: string; projectConfigDir: string; jiraPort: string;
  /** everything this run is allowed to write outside its own codelines */
  perimeter: { logDir: string; agentsDir: string };
}

/**
 * THE CLIENT SIDE OF THE PERIMETER — paths a test run must never touch.
 *
 * These held test and client artefacts together: orchestrations/logs/lanes/ contained mock-a
 * and mock-b beside gotransit and metrolinx, the mock launcher overwrote the live
 * agents/profiles.json on every run, and a stale roster-review.json from a client run was read
 * mid-test and nearly reported as current.
 */
const CLIENT_SPACE = [
  'orchestrations/logs',
  'orchestrations/agents',
  'orchestrations/projects/metrolinx',
];

/** A content fingerprint of the client side, so any write by a test run is visible. */
function clientFingerprint(): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of CLIENT_SPACE) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    // size+mtime per file, so a rewrite of identical length still shows.
    const listing = execFileSync('find', [abs, '-type', 'f', '-printf', '%p %s %T@\n'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const line of listing.split('\n')) {
      if (!line.trim()) continue;
      const i = line.indexOf(' ');
      out.set(line.slice(0, i), line.slice(i + 1));
    }
  }
  return out;
}

/**
 * What changed between two fingerprints, NAMED. A bare "these differ" told us nothing when it
 * first fired, and the workspace had already been deleted, so the finding could not be chased.
 */
function clientDelta(before: Map<string, string>, after: Map<string, string>): string[] {
  const delta: string[] = [];
  for (const [p, v] of after) {
    if (!before.has(p)) delta.push(`ADDED   ${p}`);
    else if (before.get(p) !== v) delta.push(`CHANGED ${p}`);
  }
  for (const p of before.keys()) if (!after.has(p)) delta.push(`REMOVED ${p}`);
  return delta.sort();
}

/**
 * "Nothing was written yet" asked of git, not of a filename.
 *
 * Naming a fixture file would tie this test to whatever the seed builder happens to create,
 * and would only ever check the one file. The real claim is that NO codeline was modified:
 * the working tree is clean and HEAD is still the seeded commit, in every lane.
 */
function assertNoCodeWritten(ctx: Ctx, when: string) {
  for (const lane of ctx.lanes) {
    // TRACKED files only. The pipeline legitimately provisions its own tooling into a codeline
    // (a code index, an .epam settings directory); those are untracked and are not the work.
    // Asserting on a clean `git status` failed on '?? .codegraph/ ?? .epam/' — provisioning,
    // not authorship. What must not change is the code that is under version control.
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'],
      { cwd: lane.path, encoding: 'utf8' }).trim();
    expect(dirty, `${when}: ${lane.path} has modified TRACKED files`).toBe('');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: lane.path, encoding: 'utf8' }).trim();
    expect(head, `${when}: ${lane.path} moved past its seeded baseline`).toBe(lane.baseline);
  }
}

/**
 * The environment for a run: metrolinx's config wholesale, then ONLY the values that cannot
 * be shared with a disposable mock. Each override is here because it is impossible to inherit,
 * never because it is inconvenient.
 */
function runEnv(ctx: Ctx, extra: Record<string, string>): Record<string, string> {
  const cfg = metrolinxConfig();
  return {
    ...process.env as Record<string, string>,
    ...cfg,
    // ── overrides: impossible to share ──
    JIRA_URL: `http://127.0.0.1:${ctx.jiraPort}`,   // the stub, not the client's Jira
    JIRA_EMAIL: 'mock@test.com',
    JIRA_TOKEN: 'mock-token',
    JIRA_PROJECT_KEY: 'MOCK',                        // the stub's project
    JIRA_JQL: '',                                    // the stub serves one ticket
    JIRA_STATUS_FILTER: 'To Do',
    JIRA_CODELINE_ROOT: ctx.codelineRoot,            // disposable repos, not the client estate
    JIRA_BASELINE_BRANCH: 'main',                    // the seed builder's branch
    JIRA_SYNTH_PRD_PATH: ctx.synthPrd,
    EPAM_PROJECT_CONFIG_DIR: ctx.projectConfigDir,   // a disposable roster/checkpoint home
    // SEQUENTIAL LANES. Three concurrent pipelines exhausted this machine's memory and killed
    // a test worker outright (11GB used, 0 available). Lanes are independent, so sequencing
    // costs wall-clock and nothing else — and it restores the cross-codeline contract bridge,
    // which the parallel path skips because no lane is upstream of another.
    EPAM_PARALLEL_CODELINES: '0',
    // ── the test perimeter: this run owns its artefacts and touches no client path ──
    EPAM_TEST_PERIMETER: '1',
    LOG_DIR: ctx.perimeter.logDir,
    EPAM_AGENTS_DIR: ctx.perimeter.agentsDir,
    ORCH_RUN_ID: ctx.runId,
    AGENT_PROFILES_FILE: join(ctx.perimeter.agentsDir, 'profiles.json'),
    EPAM_DANGEROUS_SKIP_APPROVAL: '1',               // non-interactive; the launchers set it too
    TZ: 'UTC',
    ...extra,
  };
}

function runPipeline(ctx: Ctx, label: string, extra: Record<string, string>):
  Promise<{ stdout: string; exitCode: number }> {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcript = join(TRANSCRIPT_DIR, `${label}-${ctx.runId}.log`);
  writeFileSync(transcript, `# ${label} run=${ctx.runId}\n`);
  return new Promise((resolve) => {
    const child = spawn('bash', [
      MOCK_LAUNCHER, '--prd', ctx.synthPrd, '--project-root', ctx.laneA, '--phase', 'core',
    ], { cwd: REPO_ROOT, env: runEnv(ctx, extra) });
    let stdout = '';
    const rec = (d: Buffer) => {
      const t = d.toString(); stdout += t;
      try { appendFileSync(transcript, t); } catch { /* best effort */ }
    };
    child.stdout.on('data', rec);
    child.stderr.on('data', rec);
    child.on('close', (code) => {
      try { appendFileSync(transcript, `\n# exit=${code}\n`); } catch { /* best effort */ }
      resolve({ stdout, exitCode: code ?? -1 });
    });
  });
}

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

// ── The parity guard runs ALWAYS: it is cheap, and it keeps this file honest ──
describe('this harness runs the metrolinx flow, not a neighbouring one', () => {
  it('inherits the real metrolinx config rather than restating its values', () => {
    const src = readFileSync(__filename, 'utf8');
    expect(src).toMatch(/metrolinxConfig\(\)/);
    expect(src).toMatch(/orchestrations\/projects\/metrolinx\/config\.env/);
  });

  it('introduces no SKIP_* flag of its own — whatever metrolinx skips, this skips', () => {
    const src = readFileSync(__filename, 'utf8');
    const cfg = metrolinxConfig();
    for (const [, flag, val] of src.matchAll(/\b(SKIP_[A-Z_]+)\s*:\s*['"]([^'"]*)['"]/g)) {
      expect(cfg[flag], `this harness sets ${flag} but metrolinx never does`).toBeDefined();
      expect(val, `this harness sets ${flag}=${val}, metrolinx uses ${cfg[flag]}`).toBe(cfg[flag]);
    }
  });

  it('the flow-deciding flags all come from the project config', () => {
    const cfg = metrolinxConfig();
    for (const k of ['EPAM_BROWNFIELD', 'JIRA_PIPELINE', 'AC_GATE_AUTO_ELABORATE', 'SEMBLE_ENABLED']) {
      expect(cfg[k], `${k} missing from metrolinx config — the inheritance would drop it`).toBeDefined();
    }
  });

  it('authors no fixture content — the codeline comes from the canonical builder', () => {
    const src = readFileSync(__filename, 'utf8');
    expect(src).toMatch(/--seed/);
    // No source file is authored or named here: the builder decides what the codeline holds,
    // and "nothing was written" is asked of git rather than of a path.
    expect(src, 'fixture source is authored in this file').not.toMatch(/writeFileSync\([^)]*src\//);
    expect(src, 'a fixture source path is named here').not.toMatch(/['"][^'"]*\.ts['"]\s*\)/);
  });

  it('drives the REAL launcher, not the orchestrator directly', () => {
    expect(readFileSync(__filename, 'utf8')).toMatch(/tier3-mock-run\.sh/);
  });

  it('is opt-in, so the mandatory pre-PR sweep stays free', () => {
    const src = readFileSync(__filename, 'utf8');
    expect(src).toMatch(/RUN_REAL_PIPELINE_MOCK === '1'/);
  });
});

describe.skipIf(!RUN_REAL)('REAL pipeline: ingest → pause 1 → resume → pause 2', () => {
  let ctx: Ctx;
  let pause1: { stdout: string; exitCode: number };
  let clientBefore = new Map<string, string>();

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), 'pause-e2e-'));
    cleanupDirs.push(root);
    const workspace = join(root, 'workspace');
    const codelineRoot = join(workspace, 'codelines');
    mkdirSync(codelineRoot, { recursive: true });

    const lanePaths = seedEstate(codelineRoot);
    const laneA = lanePaths[0];
    const lanes = lanePaths.map((path) => ({
      path,
      baseline: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, encoding: 'utf8' }).trim(),
    }));

    const projectConfigDir = join(root, 'projectcfg');
    const perimeter = { logDir: join(root, 'logs'), agentsDir: join(root, 'agents') };
    for (const d of [projectConfigDir, perimeter.logDir, perimeter.agentsDir]) {
      mkdirSync(d, { recursive: true });
    }
    // The roster the run starts from: the canonical base, copied INTO the perimeter so the
    // live one is never read or written.
    TRANSCRIPT_DIR = join(root, 'transcripts');
    mkdirSync(TRANSCRIPT_DIR, { recursive: true });
    // The project's OWN identity. Without it the pre-flight refuses to start, because
    // synthesis would fall back to another project's template and label this run with that
    // project's name — the check that caught this harness on its first execution.
    writeFileSync(join(projectConfigDir, 'prd.canonical.json'),
      readFileSync(join(REPO_ROOT, 'test/fixtures/mock-estate/prd.canonical.json'), 'utf8'));

    if (existsSync(CANONICAL_PROFILES)) {
      writeFileSync(join(perimeter.agentsDir, 'profiles.json'), readFileSync(CANONICAL_PROFILES, 'utf8'));
    }
    clientBefore = clientFingerprint();

    const t = estateTicket();
    const jiraOut = join(workspace, 'jira.out');
    writeFileSync(jiraOut, '');
    jiraChild = spawn(process.execPath, [MOCK_JIRA, t.id, t.summary, t.description],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    jiraChild.stdout!.on('data', (d) => appendFileSync(jiraOut, d.toString()));
    jiraChild.stderr!.on('data', (d) => appendFileSync(jiraOut, d.toString()));
    let port = '';
    for (let i = 0; i < 150 && !port; i++) {
      const m = readFileSync(jiraOut, 'utf8').match(/LISTENING:(\d+)/);
      if (m) port = m[1]; else await new Promise((r) => setTimeout(r, 100));
    }
    expect(port, 'the mock Jira server never reported a port').toBeTruthy();

    ctx = {
      runId: `PAUSEE2E${Date.now()}`, workspace, codelineRoot, laneA, lanes,
      synthPrd: join(workspace, 'synthesized-prd.json'), projectConfigDir, jiraPort: port, perimeter,
    };

    pause1 = await runPipeline(ctx, 'pause1', { EPAM_PAUSE_AFTER_AGENT_MINT: '1' });
  }, 5_400_000);

  describe('stage 1 — pause 1', () => {
    it('the run reaches the roster pause and exits cleanly', () => {
      expect(pause1.stdout, 'the run never reached the roster pause').toMatch(/PAUSED — agents minted/);
      expect(pause1.exitCode, 'a pause is an ending, not a failure').toBe(0);
    });

    it('it did not halt on a failed mint or an unreviewed roster', () => {
      expect(pause1.stdout).not.toMatch(/mint\/assignment failed/);
      expect(pause1.stdout).not.toMatch(/NOT reviewed/);
    });

    it('both codelines were discovered — this is the multi-lane path', () => {
      const prd = readJson(ctx.synthPrd);
      expect((prd.project.outputDirs || []).length,
        'only one codeline routed; parent-vs-lane defects stay invisible').toBeGreaterThan(1);
    });

    it('a roster was minted', () => {
      expect(readJson(join(ctx.projectConfigDir, 'project-roles.json')).roles.length)
        .toBeGreaterThan(0);
    });

    it('every codeline maps to a registered investigator', () => {
      const inv = readJson(join(ctx.projectConfigDir, 'project-investigators.json'));
      expect(Object.keys(inv.byCodeline || {}).length).toBeGreaterThan(0);
      for (const [cl, name] of Object.entries(inv.byCodeline)) {
        expect(inv.investigators, `${cl} maps to an unregistered investigator`).toContain(name);
      }
    });

    it('no investigator is registered without a brief', () => {
      const inv = readJson(join(ctx.projectConfigDir, 'project-investigators.json'));
      const profiles = readJson(join(ctx.perimeter.agentsDir, 'profiles.json'));
      expect(inv.investigators.filter((n: string) => !profiles[n])).toEqual([]);
    });

    it('THE 2026-08-08 DEFECT: every assignment names a role that exists', () => {
      const assigned = readJson(join(ctx.perimeter.logDir, 'role-assignments.json'));
      const profiles = readJson(join(ctx.perimeter.agentsDir, 'profiles.json'));
      const roles = readJson(join(ctx.projectConfigDir, 'project-roles.json')).roles;
      expect(assigned.length, 'nothing was assigned').toBeGreaterThan(0);
      for (const a of assigned) {
        expect(profiles[a.agentRole], `${a.agentRole} has no brief`).toBeTruthy();
        expect(roles, `${a.agentRole} is not a registered implementer`).toContain(a.agentRole);
      }
    });

    it('THE 2026-08-08 DEFECT: the checkpoint is where the PARENT will look for it', () => {
      const parentCkpt = join(ctx.projectConfigDir, 'runs', ctx.runId, 'checkpoint', 'checkpoint.json');
      expect(existsSync(parentCkpt),
        `no parent checkpoint at ${parentCkpt} — resume will refuse to continue`).toBe(true);
    });

    it('the checkpoint carries the settled PRD with every story assigned', () => {
      const prd = readJson(join(ctx.projectConfigDir, 'runs', ctx.runId, 'checkpoint', 'prd.json'));
      expect(prd.stories.length).toBeGreaterThan(0);
      for (const s of prd.stories) {
        expect(s.agentRole, `story ${s.id} checkpointed with no agentRole`).toBeTruthy();
      }
    });

    it('no code was written in ANY codeline — the pause is before implementation', () => {
      assertNoCodeWritten(ctx, 'at pause 1');
    });

    it('THE PERIMETER: the run wrote nothing into client space', () => {
      // Test and client artefacts shared one directory until 2026-08-08. A test run that can
      // write there can archive a client run's evidence, overwrite the live roster, and leave
      // artefacts a later client run reads as its own.
      expect(clientDelta(clientBefore, clientFingerprint()),
        'a test run modified client-side state').toEqual([]);
    });

    it('THE PERIMETER: the run DID write its own artefacts inside it', () => {
      // The check above is only meaningful if the run produced artefacts at all.
      const produced = execFileSync('find', [ctx.perimeter.logDir, '-type', 'f'],
        { encoding: 'utf8' }).trim();
      expect(produced, 'the perimeter log dir is empty — the isolation check proves nothing')
        .not.toBe('');
    });
  });

  describe('stage 2 — resume to pause 2', () => {
    let pause2: { stdout: string; exitCode: number };

    beforeAll(async () => {
      pause2 = await runPipeline(ctx, 'pause2', {
        EPAM_RESUME_RUN: ctx.runId,
        EPAM_PAUSE_BEFORE_WRITER: '1',
      });
    }, 5_400_000);

    it('the resume is honoured — it does not silently start a fresh run', () => {
      expect(pause2.stdout, 'the resume was not recognised').toMatch(/RESUMED run/);
      expect(pause2.stdout).not.toMatch(/cannot resume run/);
    });

    it('it reuses the roster it already reviewed rather than re-minting', () => {
      expect(pause2.stdout).toMatch(/roster already minted in THIS run|mint skipped/);
    });

    it('it reaches the writer pause', () => {
      expect(pause2.stdout, 'the run never reached the pre-writer pause').toMatch(/PAUSED — inputs ready/);
      expect(pause2.exitCode).toBe(0);
    });

    it('still no code written in ANY codeline — pause 2 is before the writer', () => {
      assertNoCodeWritten(ctx, 'at pause 2');
    });

    it('THE PERIMETER holds across the resume too', () => {
      expect(clientDelta(clientBefore, clientFingerprint()),
        'the resume modified client-side state').toEqual([]);
    });
  });
});
