/**
 * mock1-paused — the SAME real end-to-end pipeline as brownfield-mock-e2e.test.ts
 * (mock1), driven through the pause/restart cycle instead of straight through.
 *
 * It proves the thing that cannot be proven by unit tests: that a REAL run stops after
 * its spec pass with every artefact on disk, and that a LATER, SEPARATE invocation picks
 * up at implementation instead of re-deriving the spec pass.
 *
 * WHY THIS EXISTS. The spec pass is the expensive half of a run (~12 agent calls, ~50 min
 * observed). Before the checkpoint it could not be reused: it mutates the runtime PRD in
 * place, and pre-run-reset.sh clears the log tree at the start of every launch. A run that
 * failed in implementation had to pay for the whole spec pass again — and re-roll the dice
 * on a stage that had already succeeded.
 *
 * STANDING RULE it enforces: anything generated and not written to disc violates the
 * project. Pass 1 asserts the PRD, the manifest (technicalNotes, incl. any per-codeline
 * resolution) and the VCs (testCriteria) are all durably persisted.
 *
 * SAME RULES AS MOCK1 (see its header): the ENTIRE real pipeline runs — real Jira ingest
 * against a local stub server, real AC gate, real codeline discovery, real PRD synthesis,
 * real spec/CPA/skill passes, real agent edits, real gates. No hand-authored PRD content.
 * The only stub is the Jira HTTP server.
 *
 * COST/TIME WARNING — gated behind RUN_REAL_PIPELINE_MOCK=1, skipped by default, never
 * part of the mandatory pre-PR sweep. To run:
 *   RUN_REAL_PIPELINE_MOCK=1 ~/.nvm/versions/node/v20.20.0/bin/node \
 *     ./node_modules/.bin/vitest run test/unit/orchestration/brownfield-mock-e2e-paused.test.ts
 *
 * Must not run concurrently with any other pipeline launch — same LOG_DIR.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, existsSync, chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const TIER3_MOCK_RUN = join(REPO_ROOT, 'orchestrations/scripts/tier3-mock-run.sh');
const MOCK_JIRA_SERVER = join(REPO_ROOT, 'test/fixtures/mock-pipeline/mock-jira-server.js');
const AGENT_PROFILES_FILE = join(REPO_ROOT, 'orchestrations/agents/profiles.json');
const PROJECT_CONFIG_DIR = join(REPO_ROOT, 'orchestrations/projects/hello-dolly');
const NODE20 = '/home/bradleyjerome/.nvm/versions/node/v20.20.0/bin/node';

const RUN_REAL = process.env.RUN_REAL_PIPELINE_MOCK === '1';
const PHASE = 'core';
const STORY_ID = 'MOCK-HW-1';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Identical seed project to mock1: a real git repo with a real failing expectation. */
function makeMockCodeline(): { clone: string; codelineRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'mock1-paused-'));
  cleanupDirs.push(root);
  chmodSync(root, 0o755); // nginx bind-mount reads this; 0700 silently 403s

  const bareOrigin = join(root, 'origin.git');
  mkdirSync(bareOrigin, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet'], { cwd: bareOrigin });

  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: seed });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seed });

  writeFileSync(join(seed, '.gitignore'), 'node_modules\n');
  writeFileSync(
    join(seed, 'package.json'),
    JSON.stringify(
      { name: 'mock-hello-world', version: '1.0.0', private: true, devDependencies: { typescript: '5.9.3' } },
      null, 2),
  );
  writeFileSync(
    join(seed, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'CommonJS', moduleResolution: 'node', target: 'ES2020', strict: true,
        esModuleInterop: true, skipLibCheck: true, noEmit: true, types: ['vitest/globals', 'node'],
      },
      include: ['src/**/*.ts'],
    }, null, 2),
  );
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

  const codelineRoot = join(root, 'codelines');
  mkdirSync(codelineRoot, { recursive: true });
  const clone = join(codelineRoot, 'mock-hello-world');
  execFileSync('git', ['clone', '--quiet', bareOrigin, clone]);
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: clone });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: clone });
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(clone, 'node_modules'));

  return { clone, codelineRoot };
}

function startMockJiraServer(issueKey: string, summary: string, description: string) {
  return new Promise<{ port: number; stop: () => void }>((resolve, reject) => {
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
    proc.stderr.on('data', (d) => { buf += d.toString(); });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== null && code !== 0) reject(new Error(`mock-jira-server exited ${code}: ${buf}`));
    });
  });
}

/** Production agent routing, identical to mock1 — a mock that exercises a provider path
 *  production does not use proves nothing (enforced by mock-metrolinx-flow-parity). */
function pipelineEnv(port: number, codelineRoot: string, synthPrdPath: string) {
  return {
    JIRA_PIPELINE: '1',
    JIRA_URL: `http://127.0.0.1:${port}`,
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
    ORCH_GATE_PROVIDER: 'openrouter',
    SPEC_MODE_PROVIDER: 'openrouter',
    SPEC_MODE_OPENSPEC_MODEL: 'z-ai/glm-5.2',
    SPEC_MODE_SPECKIT_MODEL: 'z-ai/glm-5.1',
    SPEC_MODE_MODEL: 'z-ai/glm-5.2',
    ORCH_GATE_MODEL: 'z-ai/glm-5.1',
  };
}

function runPipeline(opts: { prdPath: string; projectRoot: string; env: NodeJS.ProcessEnv }) {
  const r = spawnSync(
    'bash',
    [TIER3_MOCK_RUN, '--prd', opts.prdPath, '--project-root', opts.projectRoot, '--phase', PHASE],
    { cwd: REPO_ROOT, encoding: 'utf8', timeout: 45 * 60 * 1000, env: { ...process.env, ...opts.env } },
  );
  return { stdout: `${r.stdout || ''}${r.stderr || ''}`, exitCode: r.status ?? -1 };
}

const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, '');
const greeting = (clone: string) => readFileSync(join(clone, 'src/hello.ts'), 'utf8');

describe.skipIf(!RUN_REAL)('mock1-paused — real pipeline pauses after spec, resumes at implementation', () => {
  it(
    'pauses with every artefact persisted, then a SEPARATE invocation completes the work without re-running the spec pass',
    async () => {
      const { clone, codelineRoot } = makeMockCodeline();
      const jira = await startMockJiraServer(
        STORY_ID,
        'getGreeting should return hello dolly',
        "The getGreeting() function in this codebase currently returns the string 'hello world'. " +
          'It should instead return \'hello dolly\'. Update any test that asserts the old value to match the new one. ' +
          'The change is a one-line edit in src/hello.ts plus its test.',
      );

      try {
        const synthPrdPath = join(codelineRoot, '..', 'synthesized-prd.json');
        const env = pipelineEnv(jira.port, codelineRoot, synthPrdPath);

        // ── PASS 1: run to the pause point ────────────────────────────────────
        const pass1 = runPipeline({
          prdPath: synthPrdPath,
          projectRoot: clone,
          env: { ...env, EPAM_PAUSE_AFTER_SPEC: '1' },
        });
        const out1 = stripAnsi(pass1.stdout);

        expect(pass1.exitCode, `pause run failed:\n${out1.slice(-4000)}`).toBe(0);
        expect(out1, 'the run did not report that it paused').toMatch(/PAUSED/);

        // The operator needs the run number to resume — this is the contract.
        const m = out1.match(/RUN NUMBER:\s*(\S+)/);
        expect(m, `no RUN NUMBER printed:\n${out1.slice(-3000)}`).toBeTruthy();
        const runId = (m as RegExpMatchArray)[1];
        expect(runId).toMatch(/^\d{8}T\d{6}Z$/);

        // ── The artefacts must be on disk, outside teardown's reach ───────────
        const ckpt = join(PROJECT_CONFIG_DIR, 'runs', runId, 'checkpoint');
        expect(existsSync(join(ckpt, 'prd.json')), `no checkpoint PRD at ${ckpt}`).toBe(true);
        expect(existsSync(join(ckpt, 'checkpoint.json'))).toBe(true);

        const saved = JSON.parse(readFileSync(join(ckpt, 'prd.json'), 'utf8'));
        const savedStories = (saved.stories || []).filter(
          (s: any) => (s.id === STORY_ID || String(s.id).startsWith(`${STORY_ID}-`)) && s.status !== 'deprecated',
        );
        expect(savedStories.length, 'the checkpoint PRD carries no live story').toBeGreaterThan(0);

        // The spec pass's real output — the manifest and the VCs — must have survived.
        const withManifest = savedStories.filter((s: any) => (s.technicalNotes?.files || []).length > 0);
        expect(
          withManifest.length,
          'the checkpoint has no manifest (technicalNotes.files) — the expensive part of the ' +
            'spec pass was not persisted, so a resume would have nothing to work from',
        ).toBeGreaterThan(0);

        const meta = JSON.parse(readFileSync(join(ckpt, 'checkpoint.json'), 'utf8'));
        expect(meta.stage).toBe('post-spec');
        expect(meta.runId).toBe(runId);

        // ── Implementation must NOT have happened ────────────────────────────
        expect(
          greeting(clone),
          'the pause did not stop before implementation — the source file was already edited',
        ).toContain('hello world');

        // ── PASS 2: a separate invocation, resuming ──────────────────────────
        const pass2 = runPipeline({
          prdPath: synthPrdPath,
          projectRoot: clone,
          env: { ...env, EPAM_RESUME_RUN: runId },
        });
        const out2 = stripAnsi(pass2.stdout);

        expect(pass2.exitCode, `resume run failed:\n${out2.slice(-6000)}`).toBe(0);
        expect(out2, 'the run did not report resuming').toMatch(new RegExp(`RESUMED run ${runId}`));

        // The whole point: the expensive stage was NOT redone.
        expect(
          out2,
          'the spec pass ran again on resume — the checkpoint bought nothing',
        ).toMatch(/Specification pass (disabled|skipped)/i);

        // ── And the work actually got done ───────────────────────────────────
        expect(
          greeting(clone),
          `resume did not complete the implementation:\n${out2.slice(-4000)}`,
        ).toContain('hello dolly');
      } finally {
        jira.stop();
      }
    },
    50 * 60 * 1000,
  );
});
