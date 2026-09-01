/**
 * Full mock brownfield pipeline — REAL end-to-end run of the actual
 * production launch sequence, not a hand-rolled approximation of it.
 *
 * STANDING RULE (see memory: feedback_mock_tests_full_pipeline_no_shortcuts,
 * stated by the user 50+ times): a mock pipeline test always means the
 * ENTIRE real pipeline, start to finish. That specifically includes:
 *   - A real Jira ticket pull: `orchestrations/scripts/lib/jira-client.js`
 *     hits a real HTTP endpoint — only the JIRA SERVER is a local stub
 *     (`test/fixtures/mock-pipeline/mock-jira-server.js`, implementing the
 *     exact 2 REST endpoints jira-client.js calls); the client code, the
 *     real AC-gate (`lib/ac-gate.js`), real codeline discovery
 *     (`lib/codeline-discovery.js`, a real LLM call matching the ticket to
 *     the mock git repo), and real PRD synthesis
 *     (`synthesize-prd-from-jira.js`) all run unmodified.
 *   - The exact real launch sequence every tier3-*-run.sh uses:
 *     `pre-run-reset.sh` then `run-agent-orchestration.sh` with self-heal
 *     retry on exit 2 — via `orchestrations/scripts/tier3-mock-run.sh`
 *     (a real, parameterized wrapper of that same sequence), never a
 *     hand-rolled spawn() call.
 *   - Every real gate: spec pass, CPA, skill assessment, story execution,
 *     TC-writer gate, team-lead review, all 6 QA testing gates (SAST
 *     sentinel, spec-validator, review-ranger, mutant-hunter, fuzz-weaver,
 *     perf-sentinel). Real LLM calls throughout via OpenRouter's `openrouter`
 *     provider with the cheapest models already proven real+working in
 *     `test/integration/real-cost-live.test.ts`.
 *
 * The ONLY two permanent exclusions, per explicit user instruction from the
 * very start of this work: documentation-generation agents (dormant) and
 * the UI/design-review phase (off) — neither exists as a built-in engine
 * concept anyway, so nothing needs to actively skip them.
 *
 * No hand-authored PRD content anywhere (see memory:
 * feedback_no_hand_authored_mock_fixtures) — the mock Jira ticket has a bare
 * title/description only, exactly like a real freshly-filed ticket; every
 * other field (technicalNotes.files, locationHint, testCriteria, cost
 * estimates, etc.) is produced by the real pipeline.
 *
 * COST/TIME WARNING — gated behind RUN_REAL_PIPELINE_MOCK=1, skipped by
 * default. Never part of the mandatory pre-PR `vitest run` sweep and never
 * run in a loop. To run:
 *   RUN_REAL_PIPELINE_MOCK=1 ~/.nvm/versions/node/v20.20.0/bin/node \
 *     ./node_modules/.bin/vitest run test/unit/orchestration/brownfield-mock-e2e.test.ts
 *
 * ISOLATION: `pre-run-reset.sh` archives (never deletes) whatever was in
 * orchestrations/logs/ before this run starts, exactly like a real launch —
 * no custom backup/restore hack needed. Must not run concurrently with a
 * real pipeline launch (same constraint as any two real runs sharing the
 * same log directory).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const TIER3_MOCK_RUN = join(REPO_ROOT, 'orchestrations/scripts/tier3-mock-run.sh');
const MOCK_JIRA_SERVER = join(REPO_ROOT, 'test/fixtures/mock-pipeline/mock-jira-server.js');
const LOG_DIR = join(REPO_ROOT, 'orchestrations/logs');
const AGENT_PROFILES_FILE = join(REPO_ROOT, 'orchestrations/agents/profiles.json');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';

const RUN_REAL = process.env.RUN_REAL_PIPELINE_MOCK === '1';
const PHASE = 'core';
const STORY_ID = 'MOCK-HW-1';

const cleanupDirs: string[] = [];

// B29 opt-out. The suite-wide guard (test/setup/compose-override-guard.ts) points
// COMPOSE_OVERRIDE at a throwaway file so no unit test can rewrite the repo's live
// dashboard mounts. This test is the exception: it IS a real 45-minute run, and
// watching it on the dashboard while it executes is the point. So it opts back in
// to the real repo override — and, unlike before, restores the previous contents
// afterwards, so it stops leaving the dashboard mounted on a temp dir that this
// file's own cleanup has just deleted.
const REPO_COMPOSE_OVERRIDE = join(REPO_ROOT, 'docker-compose.observability.override.yml');
const composeOverrideBefore = existsSync(REPO_COMPOSE_OVERRIDE)
  ? readFileSync(REPO_COMPOSE_OVERRIDE, 'utf8')
  : null;
process.env.COMPOSE_OVERRIDE = REPO_COMPOSE_OVERRIDE;
// Same opt-out for the dashboard pointer files: a real run must aim the live
// dashboard at itself, and restores them below.
const DASHBOARD_DIR = join(REPO_ROOT, 'orchestrations/dashboards');
const dashStateBefore = ['.active-prd-path', '.active-output-dir'].map(f => ({
  f, v: existsSync(join(DASHBOARD_DIR, f)) ? readFileSync(join(DASHBOARD_DIR, f), 'utf8') : null,
}));
process.env.DASHBOARD_STATE_DIR = DASHBOARD_DIR;

afterAll(() => {
  if (composeOverrideBefore !== null) writeFileSync(REPO_COMPOSE_OVERRIDE, composeOverrideBefore);
  for (const { f, v } of dashStateBefore) if (v !== null) writeFileSync(join(DASHBOARD_DIR, f), v);
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Real, minimal, working TypeScript "hello world" project: bare origin +
 *  working clone, real node_modules via symlink (same pattern used by
 *  tsc-gate-baseline-diff.test.ts), real git history pushed to origin. */
function makeMockCodeline(): { clone: string; codelineRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'brownfield-mock-e2e-'));
  cleanupDirs.push(root);
  // mkdtempSync always creates its dir as 0700 (owner-only) — this directory
  // (or one of its subdirs) later becomes the nginx dashboard container's
  // /prd-dir bind-mount source (pre-run-reset.sh mounts the synthesized
  // PRD's PARENT directory). A 0700 root silently 403s every /prd.json
  // request from nginx's non-root worker — found live 2026-07-23, same
  // class of bug as the earlier orchestrations/logs 0700 issue, this time
  // hitting the mock project's own directory instead.
  chmodSync(root, 0o755);

  const bareOrigin = join(root, 'origin.git');
  mkdirSync(bareOrigin, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet'], { cwd: bareOrigin });

  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: seed });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seed });

  // Every real project .gitignores node_modules — omitting this let the
  // pipeline's own "commit completed work" step (`git add -A`) sweep this
  // repo's ENTIRE real, symlinked node_modules (~1400 files) into the mock's
  // "story complete" commit, burying the real 2-line diff in unrelated
  // noise. Found live 2026-07-23.
  writeFileSync(join(seed, '.gitignore'), 'node_modules\n');
  // Pin typescript to match epam-cli's own installed version. Several real
  // fallback paths in claude.sh/run-agent-orchestration.sh run a plain
  // `npm install` when node_modules is briefly absent during worktree setup
  // (the normal path just symlinks node_modules below and never installs
  // anything). Without a pin, that fallback pulls whatever's newest on the
  // registry — TypeScript 7.x removed the "node" moduleResolution alias
  // entirely (hard TS5108), which made this tsconfig.json fail nondeterministically
  // depending on which node_modules ended up on disk, not on its own content.
  // Found live 2026-07-23.
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

  // codeline-discovery.js scans JIRA_CODELINE_ROOT one level deep for
  // directories containing .git — the clone's PARENT directory is the root,
  // "clone" (its basename) is the sole candidate repo name.
  const codelineRoot = join(root, 'codelines');
  mkdirSync(codelineRoot, { recursive: true });
  const clone = join(codelineRoot, 'mock-hello-world');
  execFileSync('git', ['clone', '--quiet', bareOrigin, clone]);
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: clone });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: clone });
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(clone, 'node_modules'));

  return { clone, codelineRoot };
}

/** Starts the mock Jira HTTP server (the ONLY stubbed piece of the whole
 *  chain) and resolves once it reports its assigned port. */
function startMockJiraServer(issueKey: string, summary: string, description: string): Promise<{ port: number; stop: () => void }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(NODE20, [MOCK_JIRA_SERVER, issueKey, summary, description]);
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
    proc.on('exit', code => {
      if (code !== null && code !== 0) reject(new Error(`mock-jira-server exited ${code}: ${buf}`));
    });
  });
}

function readPrd(prdPath: string): any {
  return JSON.parse(readFileSync(prdPath, 'utf8'));
}

function findStory(prd: any, id: string): any {
  return (prd.stories || []).find((s: any) => s.id === id);
}

/**
 * The stories that actually did the work for `id`.
 *
 * The spec pass routinely SPLITS a story — MOCK-HW-1 becomes MOCK-HW-1-impl and
 * MOCK-HW-1-test, and the parent is marked deprecated. Looking up the parent by
 * exact id then finds a deprecated shell whose status is not "completed", so a
 * correct run reads as a failure. Assert against whatever actually ran: the
 * children if it split, the story itself if it did not.
 */
function workedStories(prd: any, id: string): any[] {
  const all = (prd.stories || []) as any[];
  const live = all.filter(
    (st) => (st.id === id || String(st.id).startsWith(`${id}-`)) && st.status !== 'deprecated');
  return live.length ? live : all.filter((st) => st.id === id);
}

/** Real invocation of the real launch sequence — tier3-mock-run.sh, unmodified. */
function runFullPipeline(opts: { prdPath: string; projectRoot: string; env: NodeJS.ProcessEnv }): { stdout: string; exitCode: number } {
  const result = spawnSync('bash', [
    TIER3_MOCK_RUN,
    '--prd', opts.prdPath,
    // The PRD at that path does not exist yet: this run's ingest synthesizes it there. So the
    // project is DECLARED, exactly as production declares it by pointing at a project's own
    // canonical prd.json.
    //
    // mock3, on the evidence of the run itself rather than on the launcher history: this test
    // ingests two stories, resolves codelines mocka and mockb, and mock3 is the project declaring
    // exactly those two with a prd.json carrying two stories. The cassettes replayed for it are
    // mock3-20260818T101809Z. hello-dolly declares the same codelines but ships no prd.json at
    // all, so a mock loaded for it has no stories to stand in for.
    '--project', 'mock3',
    '--project-root', opts.projectRoot,
    '--phase', PHASE,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // 45min, not 20: the observed first pass alone takes ~19 minutes, and this
    // mock deliberately runs the FULL chain including the exit-2 gate-remediation
    // retry — which restarts from Step 1. A 20-minute budget could not fit pass +
    // retry, so the run was being killed mid-retry and reported as a failure.
    timeout: 45 * 60 * 1000,
    env: { ...process.env, ...opts.env },
  });
  const stdout = (result.stdout || '') + (result.stderr || '');
  return { stdout, exitCode: result.status ?? -1 };
}

const GATE_LOG_NAMES = [
  'sast-sentinel', 'spec-validator', 'review-ranger', 'mutant-hunter', 'fuzz-weaver', 'perf-sentinel',
];

describe.skipIf(!RUN_REAL)('Full mock brownfield pipeline — REAL Jira ingest + real launch sequence + full gate chain', () => {
  it('runs the complete real pipeline end to end, starting from a real Jira ticket pull: ingest, AC-gate, codeline discovery, PRD synthesis, spec/CPA/skill passes, real agent edit, TC-writer, team-lead review, all QA gates, tsc/vitest', async () => {
    const { clone, codelineRoot } = makeMockCodeline();
    // Deliberately verbose (matching real ticket density, not a minimal
    // one-liner) — gives the AC-gate/speckit enrichment a realistic chance
    // to produce enough ACs for a live run to also exercise the
    // reviewPrdChange payload-size class of bug (see
    // review-snapshot-technicalNotes-truncation.test.ts for the deterministic,
    // fast-test guarantee — a live run can't reliably hit an exact byte
    // threshold since that depends on how verbose the LLM's own AC output
    // happens to be, so this is defense-in-depth, not the primary coverage).
    const jiraServer = await startMockJiraServer(
      STORY_ID,
      'Hello world greeting should say hello dolly',
      "The getGreeting() function in this codebase currently returns the string 'hello world'. It should instead return 'hello dolly'. Update any test that asserts the old value to match the new one. " +
      "This is a customer-facing greeting shown on first load; the exact casing, spacing, and punctuation of the returned string matter and must match 'hello dolly' precisely — no trailing punctuation, no capitalization changes, no extra whitespace. " +
      "Every existing test in src/hello.test.ts that currently asserts the old 'hello world' value must be updated to assert the new value instead — do not leave any stale assertion in place, and do not delete test coverage for this function. " +
      "No other exported function's behavior, signature, or return type in this file may change as a side effect of this fix — the change must be scoped precisely to the string literal returned by getGreeting().",
    );
    try {
      const synthPrdPath = join(codelineRoot, '..', 'synthesized-prd.json');

      // THE REHEARSAL PROVISIONS ITS OWN MOCK.
      //
      // Nothing did. No launcher loads mock-expectations.js, so MockServer served whatever was last
      // registered by hand — which made every seam answered by a stale stand-in look like a
      // pipeline fault three stages downstream.
      //
      // It has to be loaded for THE STORIES THIS RUN CREATES. The loader builds a stand-in per
      // story, and driving it from mock3's canonical prd.json produced stand-ins for MOCK3-1 and
      // MOCK3-2 while this run ingests MOCK-HW-1 from the mock Jira ticket. Every per-story seam
      // then answered for a story that does not exist here, and role assignment ended with
      // "unassigned after the agent's full retry/ladder budget: MOCK-HW-1 @ mocka, MOCK-HW-1 @
      // mockb" — a null agent, from a mock that was answering a different question.
      //
      // The story shape is mock3's own, with this run's id: invented fields would be a fixture
      // asserting my assumptions rather than the producer's values.
      const canonicalPrd = JSON.parse(
        readFileSync(join(REPO_ROOT, 'orchestrations/projects/mock3/prd.json'), 'utf8'));
      const mockPrdPath = join(codelineRoot, '..', 'mock-expectations-prd.json');
      writeFileSync(mockPrdPath, JSON.stringify({
        ...canonicalPrd,
        stories: [{
          ...canonicalPrd.stories[0],
          id: STORY_ID,
          jiraKey: STORY_ID,
          codelines: ['mocka', 'mockb'],
        }],
      }, null, 2));
      const provisioned = spawnSync(NODE20, [
        join(REPO_ROOT, 'orchestrations/scripts/mock-expectations.js')], {
        encoding: 'utf8', timeout: 560000, cwd: REPO_ROOT,
        env: {
          ...process.env,
          PRD_FILE: mockPrdPath,
          EPAM_PROJECT_CONFIG_DIR: join(REPO_ROOT, 'orchestrations/projects/mock3'),
        },
      });
      expect(provisioned.status,
        `the mock could not be provisioned, so this run would rehearse against stale expectations:\n${
          (provisioned.stdout || '') + (provisioned.stderr || '')}`).toBe(0);

      const { stdout, exitCode } = runFullPipeline({
        prdPath: synthPrdPath,
        projectRoot: clone,
        env: {
          JIRA_PIPELINE: '1',
          JIRA_URL: `http://127.0.0.1:${jiraServer.port}`,
          JIRA_EMAIL: 'mock@test.com',
          JIRA_TOKEN: 'mock-token',
          JIRA_PROJECT_KEY: 'MOCK',
          JIRA_STATUS_FILTER: 'To Do',
          JIRA_SYNTH_PRD_PATH: synthPrdPath,
          // NOBODY IS WATCHING THIS RUN, SO THE REVIEW PAUSES MUST NOT FIRE.
          //
          // mock3's config.env declares EPAM_PAUSE_AFTER_AGENT_MINT=1 and EPAM_PAUSE_BEFORE_WRITER=1,
          // which is right for an operator driving the mock by hand: pause 1 after the roster is
          // minted, pause 2 before the writer touches anything. This test drives it unattended and
          // asserts the whole chain through to a branch, so both would stop the run at mint — which
          // they did, cleanly and with exit 0, leaving "no branch was created" as the only symptom.
          //
          // Overridden here rather than in the project's config, because which review points a
          // project wants is the project's declaration to make, not this test's.
          EPAM_PAUSE_AFTER_AGENT_MINT: '0',
          EPAM_PAUSE_BEFORE_WRITER: '0',
          EPAM_BROWNFIELD: '1',
          JIRA_CODELINE_ROOT: codelineRoot,
          JIRA_BASELINE_BRANCH: 'main',
          AGENT_PROFILES_FILE,
          EPAM_DANGEROUS_SKIP_APPROVAL: '1',
          ORCH_GATE_PROVIDER: 'openrouter',
          // ── Agent routing parity with production ──────────────────────────
          // Without SPEC_MODE_PROVIDER the spec pass does NOT take the fast path
          // and falls through to callMiniMaxWithTool, which throws instantly
          // when no MiniMax key is present: four attempts, eighteen seconds,
          // "openspec returned null", dead at Step 1 (live 2026-07-27).
          //
          // Worse than the failure: every green run before it exercised a
          // provider path production does not use. metrolinx runs the spec pass
          // on openrouter/glm; this mock was routing through MiniMax and calling that
          // a passing pipeline test. Enforced by mock-metrolinx-flow-parity.
          SPEC_MODE_PROVIDER: 'openrouter',
          SPEC_MODE_OPENSPEC_MODEL: 'z-ai/glm-5.2',
          SPEC_MODE_SPECKIT_MODEL: 'z-ai/glm-5.1',
          SPEC_MODE_MODEL: 'z-ai/glm-5.2',
          ORCH_GATE_MODEL: 'z-ai/glm-5.1',
          // Real Metrolinx production config (orchestrations/projects/metrolinx/
          // config.env) sets SEMBLE_ENABLED=1 — without it, fetchExistingCodeContext()
          // in spec-mode-runner.js always returns empty, so the brownfield
          // archaeology block correctly instructs the model to return
          // locationHint: [] ("no relevant code appears"), and technicalNotes.files
          // never gets populated. Not a pipeline bug — a test-fidelity gap. Found
          // live 2026-07-23; confirmed `semble search` (installed at
          // ~/.local/bin/semble) correctly finds src/hello.ts's getGreeting() for
          // this story's exact title before relying on a full pipeline run to prove it.
          SEMBLE_ENABLED: '1',
          // ── Flow-parity with orchestrations/projects/metrolinx/config.env ──
          // These decide whether whole STAGES run. Missing here, mock1 exercised a
          // DIFFERENT pipeline than production and could never reproduce a
          // production failure. Enforced by mock-metrolinx-flow-parity.test.ts.
          // SKIP_REGRESSION_GUARD in particular: the guard is what DEADLOCKED the
          // 2026-07-24 15:36 live run (on a broken test the pipeline itself had
          // committed) — unset here, mock1 could not have caught it.
          AC_GATE_AUTO_ELABORATE: '1',
          SKIP_REGRESSION_GUARD: 'false',
          SKIP_BROWSER_E2E_ROUTING: 'true',
          // Real launchers (tier3-*-run.sh) always set a genuinely different
          // escalation-tier model (see orchestrations/projects/metrolinx/config.env:
          // primary z-ai/glm-5.2, ESCALATION_MODEL_HIGH z-ai/glm-5.1) so a retry
          // actually gets a different model, not a pointless repeat. Missing here,
          // this mock's retry-on-stall (Step 24 phase assessment) silently retried
          // with the IDENTICAL model. Found live 2026-07-23.
          ESCALATION_MODEL_HIGH: 'moonshotai/kimi-k3',
          STORY_TIMEOUT_SECS: '300',
        },
      });

      // Diagnostic capture, unconditional (printed regardless of pass/fail) —
      // Step 19 (tsc gate) failed twice live with a tsconfig error that could
      // not be reproduced in isolation; this proves what the REAL committed
      // tsconfig.json actually contained at the moment this run finished,
      // rather than requiring the disposable directory to survive cleanup.
      try {
        const tsconfigAtEnd = readFileSync(join(clone, 'tsconfig.json'), 'utf8');
        console.log('[diagnostic] tsconfig.json at end of run:\n' + tsconfigAtEnd);
      } catch (e) {
        console.log('[diagnostic] could not read tsconfig.json at end of run:', e);
      }

      expect(exitCode, stdout.slice(-8000)).toBe(0);

      // ── Real Jira ingest actually ran (not skipped/stubbed downstream) ──
      expect(stdout).toMatch(/\[ingest\]/);
      expect(stdout).toMatch(/codeline-discovery/);
      expect(stdout).toMatch(new RegExp(STORY_ID));

      // ── Real branch + real commit diff vs origin/main ──
      // The story is routinely SPLIT by the spec pass into MOCK-HW-1-impl and
      // MOCK-HW-1-test, so the branches are AI-MOCK-HW-1-impl / -test and an
      // exact --list match on AI-MOCK-HW-1 returns nothing. Splitting is normal
      // pipeline behaviour, and asserting the unsplit shape reported a correct
      // run as a failure.
      const branches = execFileSync(
        'git', ['branch', '--list', `AI-${STORY_ID}*`], { cwd: clone, encoding: 'utf8' })
        .split('\n').map(b => b.replace(/^[*+ ]+/, '').trim()).filter(Boolean);
      expect(branches.length,
        `no AI-${STORY_ID}* branch was created — the pipeline produced no branch to merge`)
        .toBeGreaterThan(0);

      // Existing is not enough: the code must actually have changed. A branch
      // that exists proves the plumbing ran; only the diff proves the work did.
      const diffs = branches.map(b => {
        try {
          return execFileSync('git', ['diff', 'origin/main', b, '--', 'src/hello.ts'],
                              { cwd: clone, encoding: 'utf8' });
        } catch { return ''; }
      });
      expect(diffs.join('\n'),
        `no branch changes src/hello.ts to the new greeting. Branches: ${branches.join(', ')}`)
        .toMatch(/hello dolly/);

      // ── Real, pipeline-synthesized PRD (never hand-authored) shows real completion ──
      const prd = readPrd(synthPrdPath);
      const worked = workedStories(prd, STORY_ID);
      expect(worked.length,
        `no live story for ${STORY_ID}: ${JSON.stringify((prd.stories || []).map((x: any) => [x.id, x.status]))}`)
        .toBeGreaterThan(0);
      for (const st of worked) {
        expect(st.status, `${st.id}: ${stdout.slice(-2000)}`).toBe('completed');
        expect(st.completed, st.id).toBe(true);
        expect(st.completedAt, st.id).toBeTruthy();
      }
      const story = worked[0];

      // ── Real spec pass discovered the fix site itself — no hand-supplied files ──
      // At least one worked story must name real files; a test-only child may
      // legitimately declare none of its own.
      expect(worked.some((st: any) => Array.isArray(st.technicalNotes?.files)
                                      && st.technicalNotes.files.length > 0),
        JSON.stringify(worked.map((st: any) => [st.id, st.technicalNotes?.files]))).toBe(true);

      // ── Brownfield proves a change with VERIFICATION criteria, not test criteria ──
      // This assertion used to require testCriteria.facts. The TC writer is now
      // greenfield-only: brownfield stories are proved by observable VCs plus the
      // bug-reproduction gate, which runs the test against the original code
      // (must fail) and the fix (must pass). Step 10 skips here by design and
      // says so — "brownfield — VCs + bug-reproduction gate instead".
      //
      // The old assertion outlived the contract it described, and mock1 then
      // reported a correct run as a failure. Assert what this flow actually
      // promises, or the test measures a pipeline that no longer exists.
      const vcs = worked.flatMap((st: any) => st.verificationCriteria || []);
      expect(Array.isArray(vcs),
        `brownfield produced no verification criteria: ${JSON.stringify(vcs)}`)
        .toBe(true);
      expect(vcs.length,
        'the TC writer is skipped for brownfield, so VCs are the ONLY statement of ' +
        'what this change must do — an empty list means nothing verifies it')
        .toBeGreaterThan(0);
      // Every VC must be observable prose a tester could act on, not a restated title.
      for (const vc of vcs) {
        expect(typeof vc === 'string' ? vc.length : String(vc?.text ?? '').length,
          `empty verification criterion: ${JSON.stringify(vc)}`).toBeGreaterThan(20);
      }
      // The TC writer must have stood down for the RIGHT reason, not silently.
      expect(stdout, 'Step 10 did not announce why it skipped')
        .toMatch(/Step 10.*(skip|⊘)/i);

      // ── Real team-lead review ran (Step 3.6) — non-empty per-story log + a
      // code-reviews.jsonl entry for this phase ──
      // Split stories are reviewed individually: review-agent-MOCK-HW-1-impl.log
      // and -test.log, never review-agent-MOCK-HW-1.log. Assert a review exists
      // for every story that actually ran, which is stronger than the old check
      // and does not assume the unsplit shape.
      for (const st of worked) {
        const reviewLog = join(LOG_DIR, `review-agent-${st.id}.log`);
        expect(existsSync(reviewLog), `no review log for ${st.id}: ${reviewLog}`).toBe(true);
        expect(readFileSync(reviewLog, 'utf8').trim().length, `${st.id} review log empty`)
          .toBeGreaterThan(0);
      }
      const codeReviews = readFileSync(join(LOG_DIR, 'code-reviews.jsonl'), 'utf8');
      expect(codeReviews).toMatch(new RegExp(PHASE));

      // ── All 6 real QA testing gates ran and produced non-empty output ──
      for (const gate of GATE_LOG_NAMES) {
        const gateLog = join(LOG_DIR, `${gate}-${PHASE}.log`);
        expect(existsSync(gateLog), gateLog).toBe(true);
        expect(readFileSync(gateLog, 'utf8').trim().length, `${gate} log empty`).toBeGreaterThan(0);
      }

      // ── Real cost was actually recorded (not just "exited 0") ──
      const activity = readFileSync(join(LOG_DIR, 'agent-activity.jsonl'), 'utf8');
      const costLines = activity.split('\n').filter(l => l.includes(STORY_ID));
      const totalCost = costLines.reduce((sum, l) => {
        try {
          const rec = JSON.parse(l);
          if (rec.type !== 'cost_snapshot') return sum;
          const costUsd = rec.detail?.costUsd;
          return sum + (typeof costUsd === 'number' ? costUsd : 0);
        } catch { return sum; }
      }, 0);
      expect(totalCost, `no real cost recorded for ${STORY_ID}`).toBeGreaterThan(0);

      // ── Real tsc + vitest gates against what the real pipeline actually committed ──
      execFileSync('git', ['checkout', `AI-${STORY_ID}`], { cwd: clone });
      const tscResult = spawnSync(NODE20, [join(clone, 'node_modules/.bin/tsc'), '--noEmit'], { cwd: clone, encoding: 'utf8', timeout: 30000 });
      expect(tscResult.status, (tscResult.stdout || '') + (tscResult.stderr || '')).toBe(0);
      const vitestResult = spawnSync(NODE20, [join(clone, 'node_modules/.bin/vitest'), 'run'], { cwd: clone, encoding: 'utf8', timeout: 30000 });
      const vitestOutput = (vitestResult.stdout || '') + (vitestResult.stderr || '');
      expect(vitestResult.status, vitestOutput).toBe(0);
    } finally {
      jiraServer.stop();
    }
  }, 20 * 60 * 1000);
});
