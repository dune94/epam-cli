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
 *     perf-sentinel). Real LLM calls throughout via OpenRouter's `qwen`
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
afterAll(() => {
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

/** Real invocation of the real launch sequence — tier3-mock-run.sh, unmodified. */
function runFullPipeline(opts: { prdPath: string; projectRoot: string; env: NodeJS.ProcessEnv }): { stdout: string; exitCode: number } {
  const result = spawnSync('bash', [
    TIER3_MOCK_RUN,
    '--prd', opts.prdPath,
    '--project-root', opts.projectRoot,
    '--phase', PHASE,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 20 * 60 * 1000,
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
          EPAM_BROWNFIELD: '1',
          JIRA_CODELINE_ROOT: codelineRoot,
          JIRA_BASELINE_BRANCH: 'main',
          AGENT_PROFILES_FILE,
          EPAM_DANGEROUS_SKIP_APPROVAL: '1',
          ORCH_GATE_PROVIDER: 'qwen',
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
          // Real launchers (tier3-*-run.sh) always set a genuinely different
          // escalation-tier model (see orchestrations/projects/metrolinx/config.env:
          // primary z-ai/glm-5.2, ESCALATION_MODEL_HIGH z-ai/glm-5.1) so a retry
          // actually gets a different model, not a pointless repeat. Missing here,
          // this mock's retry-on-stall (Step 24 phase assessment) silently retried
          // with the IDENTICAL model. Found live 2026-07-23.
          ESCALATION_MODEL_HIGH: 'moonshotai/kimi-k2',
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
      const branches = execFileSync('git', ['branch', '--list', `AI-${STORY_ID}`], { cwd: clone, encoding: 'utf8' });
      expect(branches).toContain(`AI-${STORY_ID}`);
      const diff = execFileSync('git', ['diff', 'origin/main', `AI-${STORY_ID}`, '--', 'src/hello.ts'], { cwd: clone, encoding: 'utf8' });
      expect(diff).toMatch(/hello dolly/);

      // ── Real, pipeline-synthesized PRD (never hand-authored) shows real completion ──
      const prd = readPrd(synthPrdPath);
      const story = findStory(prd, STORY_ID);
      expect(story, JSON.stringify(story)).toBeTruthy();
      expect(story.status, stdout.slice(-4000)).toBe('completed');
      expect(story.completed).toBe(true);
      expect(story.completedAt).toBeTruthy();

      // ── Real spec pass discovered the fix site itself — no hand-supplied files ──
      expect(Array.isArray(story.technicalNotes?.files), JSON.stringify(story.technicalNotes)).toBe(true);
      expect(story.technicalNotes.files.length).toBeGreaterThan(0);

      // ── Real TC-writer gate populated testCriteria.facts ──
      expect(Array.isArray(story.testCriteria?.facts), JSON.stringify(story.testCriteria)).toBe(true);
      expect(story.testCriteria.facts.length).toBeGreaterThan(0);

      // ── Real team-lead review ran (Step 3.6) — non-empty per-story log + a
      // code-reviews.jsonl entry for this phase ──
      const reviewLog = join(LOG_DIR, `review-agent-${STORY_ID}.log`);
      expect(existsSync(reviewLog), reviewLog).toBe(true);
      expect(readFileSync(reviewLog, 'utf8').trim().length).toBeGreaterThan(0);
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
