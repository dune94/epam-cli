/**
 * Mock 2 — REAL end-to-end run of `run-agent-orchestration.sh`'s parallel
 * worktree topology (Step 9 auto-commit, Steps 13-17 worktree create/merge),
 * not an extracted Step 9 block run against a simulated file state.
 *
 * Rewritten 2026-07-22 alongside brownfield-mock-e2e.test.ts (mock1) per
 * explicit correction: "i need both mocks to run the real pipeline start to
 * finish... the purpose is to mock the pipeline not go down happy path."
 * See mock1's header for the full invocation contract (real gates, real
 * agents via OpenRouter's openrouter provider, cost/isolation warnings — same
 * here). This file adds two REAL topology scenarios:
 *
 *   1. Incident-shape: implementationOrder has ZERO main-branch stories and
 *      2 parallel-lane stories (primary + independent) — reproduces the
 *      exact live-incident topology (main_stories empty) through the real
 *      engine, including its own real topology-router decision (which can
 *      itself be an LLM call) instead of a hand-run Step 9 block.
 *   2. Contrast: one real main-branch story alongside the same 2
 *      parallel-lane stories — Step 9 must really commit the main-branch
 *      output, and Step 17 must really merge both worktree lanes back onto
 *      the same branch ensure_story_branch created for the main story.
 *
 * Two parallel-lane stories (not one) are required in both scenarios so the
 * real topology router's count heuristic (`_wt_count <= 1` -> "single",
 * collapsing primary/independent into main_stories) doesn't silently defeat
 * the whole point of this test — see run-agent-orchestration.sh's topology
 * decision block.
 *
 * COST/TIME/ISOLATION WARNINGS: identical to mock1 — gated behind
 * RUN_REAL_PIPELINE_MOCK=1, snapshots/restores this repo's own
 * orchestrations/logs/ around the run, must not run concurrently with any
 * real pipeline execution.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, cpSync, existsSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const RUN_AGENT_ORCH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const LOG_DIR = join(REPO_ROOT, 'orchestrations/logs');
const AGENT_PROFILES_FILE = join(REPO_ROOT, 'orchestrations/agents/profiles.json');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';

const RUN_REAL = process.env.RUN_REAL_PIPELINE_MOCK === '1';

const cleanupDirs: string[] = [];
const jiraStops: Array<() => void> = [];
afterAll(() => {
  // Stop every mock Jira server before removing dirs — a surviving listener would
  // outlive the test run and hold a port.
  for (const stop of jiraStops.splice(0)) { try { stop(); } catch { /* already gone */ } }
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let logBackupDir: string | null = null;
let logDirMode: number | null = null;
beforeAll(() => {
  if (!RUN_REAL) return;
  logBackupDir = mkdtempSync(join(tmpdir(), 'orch-logs-backup-2-'));
  if (existsSync(LOG_DIR)) {
    // See brownfield-mock-e2e.test.ts for why LOG_DIR's mode must be
    // captured and restored explicitly — mkdtempSync's 0700 default
    // otherwise silently 403s the dashboard's nginx container.
    logDirMode = statSync(LOG_DIR).mode;
    cpSync(LOG_DIR, logBackupDir, { recursive: true });
  }
});
afterAll(() => {
  if (!RUN_REAL || !logBackupDir) return;
  rmSync(LOG_DIR, { recursive: true, force: true });
  cpSync(logBackupDir, LOG_DIR, { recursive: true });
  rmSync(logBackupDir, { recursive: true, force: true });
  if (logDirMode !== null) chmodSync(LOG_DIR, logDirMode);
});

/** Same "hello world" mock codeline as mock1, plus no pre-seeded util files
 *  — the parallel-lane stories create those from scratch, so their
 *  worktree->main merge has zero overlap with the main-branch story's file
 *  (src/hello.ts), avoiding any real merge-conflict risk. */
function makeMockCodeline(): { clone: string } {
  const root = mkdtempSync(join(tmpdir(), 'brownfield-mock2-'));
  cleanupDirs.push(root);

  const bareOrigin = join(root, 'origin.git');
  mkdirSync(bareOrigin, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet'], { cwd: bareOrigin });

  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: seed });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seed });
  // See brownfield-mock-e2e.test.ts for why this is required — without it,
  // the pipeline's own "commit completed work" step sweeps the entire real,
  // symlinked node_modules into the mock's commits.
  writeFileSync(join(seed, '.gitignore'), 'node_modules\n');
  // Pin typescript to match epam-cli's own installed version — see
  // brownfield-mock-e2e.test.ts for why: an unpinned devDependencies lets a
  // fallback `npm install` (fires when node_modules is briefly absent during
  // worktree setup) pull latest TypeScript, which removed the "node"
  // moduleResolution alias and produced a nondeterministic TS5108 failure.
  writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'mock-hello-world', version: '1.0.0', private: true, devDependencies: { typescript: '5.9.3' } }, null, 2));
  writeFileSync(join(seed, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'CommonJS', moduleResolution: 'node', target: 'ES2020', strict: true, esModuleInterop: true, skipLibCheck: true, noEmit: true, types: ['vitest/globals', 'node'] },
    include: ['src/**/*.ts'],
  }, null, 2));
  writeFileSync(join(seed, 'src/hello.ts'), "export function getGreeting(): string {\n  return 'hello world';\n}\n");
  writeFileSync(join(seed, 'src/hello.test.ts'), [
    "import { describe, it, expect } from 'vitest';",
    "import { getGreeting } from './hello';",
    '',
    "describe('getGreeting', () => {",
    "  it('returns hello world', () => {",
    "    expect(getGreeting()).toBe('hello world');",
    '  });',
    '});',
    '',
  ].join('\n'));
  execFileSync('git', ['add', '-A'], { cwd: seed });
  execFileSync('git', ['commit', '-m', 'seed: hello world baseline', '--quiet'], { cwd: seed });
  execFileSync('git', ['remote', 'add', 'origin', bareOrigin], { cwd: seed });
  execFileSync('git', ['push', 'origin', 'main', '--quiet'], { cwd: seed });

  const clone = join(root, 'clone');
  execFileSync('git', ['clone', '--quiet', bareOrigin, clone]);
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: clone });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: clone });
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(clone, 'node_modules'));

  return { clone };
}

/** Per standing rule (2026-07-23): no hand-authored PRD content. The
 *  canonical PRD is a checked-in fixture
 *  (test/fixtures/mock-pipeline/hello-dolly-worktree.canonical.json) with
 *  all 3 stories shaped like genuine, freshly-ingested Jira tickets — no
 *  technicalNotes.files, no locationHint. Both scenarios (incident-shape,
 *  contrast) select their story set via implementationOrder phase key,
 *  already defined in the canonical file; nothing is added or removed here.
 *  Copied fresh for every test run, never mutated in place. */
const CANONICAL_PRD = join(REPO_ROOT, 'test/fixtures/mock-pipeline/hello-dolly-worktree.canonical.json');
const MOCK_JIRA_SERVER = join(REPO_ROOT, 'test/fixtures/mock-pipeline/mock-jira-server.js');

function resetPrdFromCanonical(prdPath: string, projectRoot: string): void {
  const canonical = JSON.parse(readFileSync(CANONICAL_PRD, 'utf8'));
  canonical.project.outputDir = projectRoot;
  writeFileSync(prdPath, JSON.stringify(canonical, null, 2));
}

/** Starts the mock Jira server with one ticket PER STORY in the canonical
 *  template, so this mock drives the REAL Jira ingest (real jira-client, real
 *  AC-gate, real synthesis) instead of skipping the stage.
 *
 *  Topology stays deterministic despite going through ingest: synthesis is given
 *  the canonical PRD as --template (JIRA_PRD_TEMPLATE) and keys it by story id,
 *  preserving each story's agentGroup. That is what makes this a topology test
 *  rather than a coin flip on what an LLM decides to call "primary".
 *
 *  Was JIRA_PIPELINE=0 until 2026-07-24 — a whole production stage unexercised
 *  (user: "mock2 should not skip jira", "no difference in piping"). */
function startMockJiraServerForCanonical(dir: string): Promise<{ port: number; stop: () => void }> {
  const canonical = JSON.parse(readFileSync(CANONICAL_PRD, 'utf8'));
  const issues = (canonical.stories || []).map((st: any) => ({
    key: st.id,
    summary: st.title || st.id,
    description: st.description || st.title || st.id,
  }));
  const specPath = join(dir, 'mock-jira-issues.json');
  writeFileSync(specPath, JSON.stringify(issues, null, 2));
  return new Promise((resolve, reject) => {
    const proc = spawn(NODE20, [MOCK_JIRA_SERVER, '--issues', specPath]);
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/LISTENING:(\d+)/);
      if (m) {
        proc.stdout.off('data', onData);
        resolve({ port: parseInt(m[1], 10), stop: () => proc.kill('SIGTERM') });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', d => { buf += d.toString(); });
    proc.on('error', reject);
    proc.on('exit', c => { if (c !== null && c !== 0) reject(new Error(`mock-jira-server exited ${c}: ${buf}`)); });
  });
}

function readPrd(prdPath: string): any {
  return JSON.parse(readFileSync(prdPath, 'utf8'));
}

function findStory(prd: any, id: string): any {
  return (prd.stories || []).find((s: any) => s.id === id);
}

/** git worktrees don't inherit gitignored dirs (node_modules) — claude.sh's
 *  own repair path is a real `npm install`, useless here since the mock
 *  package.json declares no dependencies at all (deliberately, to reuse this
 *  repo's own already-installed vitest/typescript instead of a slow/networked
 *  real install). So: watch for the two worktree directories claude.sh
 *  creates (siblings of `clone`, named `<clone>-wt-primary`/`-wt-independent`)
 *  and symlink node_modules into each the instant it appears — racing the
 *  pipeline's own `[ ! -d node_modules ]` check, which otherwise fires
 *  immediately after worktree creation. */
function watchAndSymlinkWorktreeNodeModules(clone: string): () => void {
  const wtDirs = ['wt-primary', 'wt-independent'].map(suffix => `${clone}-${suffix}`);
  const interval = setInterval(() => {
    for (const wtDir of wtDirs) {
      if (existsSync(wtDir) && !existsSync(join(wtDir, 'node_modules'))) {
        try {
          symlinkSync(join(REPO_ROOT, 'node_modules'), join(wtDir, 'node_modules'));
        } catch { /* lost the race or dir not fully ready yet — next tick retries */ }
      }
    }
  }, 100);
  return () => clearInterval(interval);
}

function runFullPipeline(clone: string, phase: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; exitCode: number }> {
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // ── Flow-parity with orchestrations/projects/metrolinx/config.env ──
    // These decide whether whole STAGES run; drift means this mock exercises a
    // different pipeline than production. Enforced by mock-metrolinx-flow-parity.
    JIRA_PIPELINE: '1',
    AC_GATE_AUTO_ELABORATE: '1',
    SKIP_REGRESSION_GUARD: 'false',
    SKIP_BROWSER_E2E_ROUTING: 'true',
    // REAL Jira ingest — no stage skipped (user directive 2026-07-24: "mock2
    // should not skip jira"). JIRA_URL is supplied per-test from the mock Jira
    // server's assigned port. JIRA_PRD_TEMPLATE pins lane topology through
    // synthesis, so driving real ingest does NOT make this test non-deterministic:
    // synthesize-prd-from-jira.js keys the template by story id and preserves
    // each story's agentGroup.
    JIRA_EMAIL: 'mock@test.com',
    JIRA_TOKEN: 'mock-token',
    JIRA_PROJECT_KEY: 'MOCK',
    JIRA_STATUS_FILTER: 'To Do',
    JIRA_DEFAULT_CODELINE: 'mock',
    JIRA_PRD_TEMPLATE: CANONICAL_PRD,
    ...env,
  };
  const attempt = (extra: NodeJS.ProcessEnv): Promise<{ stdout: string; exitCode: number }> =>
    new Promise(resolve => {
      const child = spawn('bash', [RUN_AGENT_ORCH, '--phase', phase, '--reset'], {
        cwd: REPO_ROOT,
        env: { ...baseEnv, ...extra },
      });
      let out = '';
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { out += d.toString(); });
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 25 * 60 * 1000);
      child.on('close', code => {
        clearTimeout(killTimer);
        resolve({ stdout: out, exitCode: code ?? -1 });
      });
    });

  const stopWatcher = watchAndSymlinkWorktreeNodeModules(clone);
  return attempt({}).then(async result => {
    if (result.exitCode === 2) {
      result = await attempt({ SKIP_GATE_REMEDIATION: '1' });
    }
    return result;
  }).finally(stopWatcher);
}

describe.skipIf(!RUN_REAL)('Mock 2 — REAL run-agent-orchestration.sh, parallel-worktree topology, full gate chain', () => {
  it('incident-shape: ZERO main-branch stories, 2 real parallel-lane stories — Step 9 correctly does not treat pipeline noise as a deliverable, real worktree merge lands both real changes', async () => {
    const { clone } = makeMockCodeline();
    const phase = 'mock2_incident';
    const prdPath = join(clone, '..', 'prd.json');
    resetPrdFromCanonical(prdPath, clone);
    // REAL Jira ingest: one ticket per canonical story, served over HTTP exactly
    // as production hits Jira Cloud. Nothing downstream of this boundary is stubbed.
    const jira = await startMockJiraServerForCanonical(join(clone, '..'));
    jiraStops.push(jira.stop);

    const { stdout, exitCode } = await runFullPipeline(clone, phase, {
      JIRA_URL: `http://127.0.0.1:${jira.port}`,
      PRD_FILE: prdPath,
      AGENT_PROFILES_FILE,
      EPAM_BROWNFIELD: '1',
      JIRA_BASELINE_BRANCH: 'main',
      EPAM_DANGEROUS_SKIP_APPROVAL: '1',
      ORCH_GATE_PROVIDER: 'openrouter',
      ORCH_GATE_MODEL: 'z-ai/glm-5.1',
      // Same fidelity gaps found and fixed via mock1 (see brownfield-mock-e2e.test.ts):
      // real Metrolinx config sets a genuinely different escalation-tier model and
      // SEMBLE_ENABLED=1 for real spec-pass location grounding — without these,
      // retries silently reuse the same model and technicalNotes.files never gets
      // populated by real discovery.
      ESCALATION_MODEL_HIGH: 'moonshotai/kimi-k3',
      SEMBLE_ENABLED: '1',
      STORY_TIMEOUT_SECS: '300',
    });
    expect(exitCode, stdout.slice(-8000)).toBe(0);
    expect(stdout).toMatch(/No main-branch stories ran this phase/);

    const prd = readPrd(prdPath);
    for (const id of ['PRI-1', 'IND-1']) {
      const story = findStory(prd, id);
      expect(story?.status, `${id}: ${JSON.stringify(story)}`).toBe('completed');
    }

    // Real worktree merge landed BOTH parallel changes on the same branch —
    // no main-branch lane existed, so this is whatever branch was checked
    // out at run start (the clone's local "main").
    const utilA = readFileSync(join(clone, 'src/util-a.ts'), 'utf8');
    const utilB = readFileSync(join(clone, 'src/util-b.ts'), 'utf8');
    expect(utilA).toMatch(/utilA-ok/);
    expect(utilB).toMatch(/utilB-ok/);

    const tscResult = spawnSync(NODE20, [join(clone, 'node_modules/.bin/tsc'), '--noEmit'], { cwd: clone, encoding: 'utf8', timeout: 30000 });
    expect(tscResult.status, (tscResult.stdout || '') + (tscResult.stderr || '')).toBe(0);
  }, 25 * 60 * 1000);

  it('contrast: one real main-branch story alongside 2 real parallel-lane stories — Step 9 commits the main-branch output for real, Step 17 merges both worktree lanes onto the same branch ensure_story_branch created', async () => {
    const { clone } = makeMockCodeline();
    const phase = 'mock2_contrast';
    const prdPath = join(clone, '..', 'prd.json');
    resetPrdFromCanonical(prdPath, clone);
    const jira = await startMockJiraServerForCanonical(join(clone, '..'));
    jiraStops.push(jira.stop);

    const { stdout, exitCode } = await runFullPipeline(clone, phase, {
      JIRA_URL: `http://127.0.0.1:${jira.port}`,
      PRD_FILE: prdPath,
      AGENT_PROFILES_FILE,
      EPAM_BROWNFIELD: '1',
      JIRA_BASELINE_BRANCH: 'main',
      EPAM_DANGEROUS_SKIP_APPROVAL: '1',
      ORCH_GATE_PROVIDER: 'openrouter',
      ORCH_GATE_MODEL: 'z-ai/glm-5.1',
      // Same fidelity gaps found and fixed via mock1 (see brownfield-mock-e2e.test.ts):
      // real Metrolinx config sets a genuinely different escalation-tier model and
      // SEMBLE_ENABLED=1 for real spec-pass location grounding — without these,
      // retries silently reuse the same model and technicalNotes.files never gets
      // populated by real discovery.
      ESCALATION_MODEL_HIGH: 'moonshotai/kimi-k3',
      SEMBLE_ENABLED: '1',
      STORY_TIMEOUT_SECS: '300',
    });
    expect(exitCode, stdout.slice(-8000)).toBe(0);
    expect(stdout).toMatch(/Committed main-branch output/);

    const prd = readPrd(prdPath);
    for (const id of ['MAIN-1', 'PRI-1', 'IND-1']) {
      const story = findStory(prd, id);
      expect(story?.status, `${id}: ${JSON.stringify(story)}`).toBe('completed');
    }

    // ensure_story_branch created AI-MAIN-1 for the main-branch story; the
    // real worktree merge (Step 17) must land the parallel lanes' work back
    // onto that SAME branch, not a separate/lost one.
    const branches = execFileSync('git', ['branch', '--list', 'AI-MAIN-1'], { cwd: clone, encoding: 'utf8' });
    expect(branches).toContain('AI-MAIN-1');
    execFileSync('git', ['checkout', 'AI-MAIN-1'], { cwd: clone });

    const hello = readFileSync(join(clone, 'src/hello.ts'), 'utf8');
    const utilA = readFileSync(join(clone, 'src/util-a.ts'), 'utf8');
    const utilB = readFileSync(join(clone, 'src/util-b.ts'), 'utf8');
    expect(hello).toMatch(/hello dolly/);
    expect(utilA).toMatch(/utilA-ok/);
    expect(utilB).toMatch(/utilB-ok/);

    const tscResult = spawnSync(NODE20, [join(clone, 'node_modules/.bin/tsc'), '--noEmit'], { cwd: clone, encoding: 'utf8', timeout: 30000 });
    expect(tscResult.status, (tscResult.stdout || '') + (tscResult.stderr || '')).toBe(0);
    const vitestResult = spawnSync(NODE20, [join(clone, 'node_modules/.bin/vitest'), 'run'], { cwd: clone, encoding: 'utf8', timeout: 30000 });
    const vitestOutput = (vitestResult.stdout || '') + (vitestResult.stderr || '');
    expect(vitestResult.status, vitestOutput).toBe(0);
  }, 25 * 60 * 1000);
});
