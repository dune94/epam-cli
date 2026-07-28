/**
 * Mock 3 — REAL end-to-end run of the multi-codeline lane loop, two codelines.
 *
 * WHY THIS EXISTS. mock1 and mock2 each run against ONE codeline, so the entire
 * multi-codeline path — `_run_codeline_loop`, per-lane filtered PRDs, the
 * cross-codeline contract, the perCodeline merge back into canonical, the
 * spanning-story completeness check, and the halt-on-lane-failure — has never
 * been executed end-to-end by any test. That path is exactly what the metrolinx
 * work depends on: AMSD-2041 is one story across three codelines.
 *
 * It is also the part of the pipeline with the least evidence behind it. Two
 * live metrolinx runs (2026-07-28) died at Step 1 and Step 5, so steps 6-24 have
 * never run against a real multi-codeline PRD at all. Every defect found so far
 * in that region was found by spending a live client run to find it. This test
 * spends cents on a disposable repo instead.
 *
 * WHAT IS REAL HERE. The real `run-agent-orchestration.sh` entrypoint, the real
 * lane loop (entered automatically because project.outputDirs has 2 entries),
 * real git clones with real origins, real agent calls on cheap models, and the
 * full gate chain — no SKIP_* flags. Two things are mocked and only two: the
 * codelines themselves (disposable, outside this repo, per the PROJECT_ROOT
 * guard) and the Jira server.
 *
 * COST. Real, small, billed per run. Opt-in via RUN_REAL_PIPELINE_MOCK=1 so the
 * mandatory pre-PR `vitest run` sweep stays free — same gate as mock1/mock2.
 *
 * NO HAND-AUTHORED FIXTURE CONTENT. The PRD comes from the checked-in canonical
 * file and is copied fresh per run, never mutated in place. The ONLY runtime
 * injection is project.outputDirs, because the two codeline paths are temporary
 * directories whose names cannot be known ahead of time.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const RUN_AGENT_ORCH = join(REPO_ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
const CANONICAL_PRD = join(REPO_ROOT, 'test/fixtures/mock-pipeline/hello-dolly-multicodeline.canonical.json');
const PROFILES = join(REPO_ROOT, 'orchestrations/agents/profiles.json');
const RUN_REAL = process.env.RUN_REAL_PIPELINE_MOCK === '1';

const cleanupDirs: string[] = [];
afterAll(() => { for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A disposable codeline: bare origin + clone, seeded with the hello-world baseline. */
function makeMockCodeline(name: string): { clone: string } {
  const root = mkdtempSync(join(tmpdir(), `brownfield-mock3-${name}-`));
  cleanupDirs.push(root);

  const bareOrigin = join(root, 'origin.git');
  mkdirSync(bareOrigin, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet'], { cwd: bareOrigin });

  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: seed });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seed });
  // Without this the pipeline's own commit step sweeps the symlinked
  // node_modules into the mock's commits (see mock1 for the full story).
  writeFileSync(join(seed, '.gitignore'), 'node_modules\n');
  // TypeScript is pinned to this repo's version: an unpinned devDependency lets
  // a fallback `npm install` pull a release that dropped the "node"
  // moduleResolution alias, producing a nondeterministic TS5108.
  writeFileSync(join(seed, 'package.json'), JSON.stringify({
    name: `mock-${name}`, version: '1.0.0', private: true,
    devDependencies: { typescript: '5.9.3' },
  }, null, 2));
  writeFileSync(join(seed, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'CommonJS', moduleResolution: 'node', target: 'ES2020', strict: true,
      esModuleInterop: true, skipLibCheck: true, noEmit: true, types: ['vitest/globals', 'node'],
    },
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

/**
 * The runtime PRD: canonical content, plus the two codeline paths. Written to a
 * temp dir — never over the canonical fixture.
 */
function makeRuntimePrd(laneA: string, laneB: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mock3-prd-'));
  cleanupDirs.push(dir);
  const prd = JSON.parse(readFileSync(CANONICAL_PRD, 'utf8'));
  prd.project.outputDirs = [
    { codeline: 'mock-a', path: laneA },
    { codeline: 'mock-b', path: laneB },
  ];
  const out = join(dir, 'prd.json');
  writeFileSync(out, JSON.stringify(prd, null, 2));
  return out;
}

function runPipeline(prdPath: string, phase: string): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [RUN_AGENT_ORCH, '--phase', phase, '--reset'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PRD_FILE: prdPath,
        AGENT_PROFILES_FILE: PROFILES,
        EPAM_BROWNFIELD: '1',
        JIRA_BASELINE_BRANCH: 'main',
        EPAM_DANGEROUS_SKIP_APPROVAL: '1',
        EPAM_ORCHESTRATION_PROVIDER: 'qwen',
        ORCH_GATE_PROVIDER: 'qwen',
        ORCH_GATE_MODEL: 'z-ai/glm-5.1',
        EPAM_STORY_TIMEOUT_SECS: '600',
        TZ: 'UTC',
      },
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stdout += d.toString(); });
    child.on('close', (code) => resolve({ stdout, exitCode: code ?? -1 }));
  });
}

/** What a lane's clone actually contains on disk, via git — not via stdout. */
function laneState(clone: string) {
  const branches = execFileSync('git', ['branch', '--list'], { cwd: clone, encoding: 'utf8' });
  let greeting = '';
  try { greeting = readFileSync(join(clone, 'src/hello.ts'), 'utf8'); } catch { /* absent */ }
  return { branches, greeting };
}

describe.skipIf(!RUN_REAL)('Mock 3 — REAL multi-codeline lane loop, two codelines, full gate chain', () => {
  it('delivers the spanning story in BOTH codelines', async () => {
    const a = makeMockCodeline('a');
    const b = makeMockCodeline('b');
    const prd = makeRuntimePrd(a.clone, b.clone);

    const { stdout, exitCode } = await runPipeline(prd, 'mock3_core');

    // Both lanes must have been entered — the loop is the thing under test.
    expect(stdout, `lane 'mock-a' never ran:\n${stdout.slice(-4000)}`)
      .toMatch(/codeline 'mock-a'/);
    expect(stdout, `lane 'mock-b' never ran — the loop stopped after the first lane:\n${stdout.slice(-4000)}`)
      .toMatch(/codeline 'mock-b'/);

    // The real effect, read from git rather than from the log.
    for (const [name, lane] of [['mock-a', a], ['mock-b', b]] as const) {
      const st = laneState(lane.clone);
      expect(st.greeting, `${name}: the greeting was never changed`).toMatch(/hello dolly/);
    }

    expect(exitCode, `pipeline exited ${exitCode}:\n${stdout.slice(-4000)}`).toBe(0);
  }, 45 * 60 * 1000);

  it('records a per-codeline result for every declared lane', async () => {
    // The spanning-story completeness check: a story is complete only when NO
    // lane is outstanding. A run that silently delivered one lane and reported
    // success is the failure this guards — the shape of live run 9, where
    // discovery collapsed a 3-lane ticket to 1 and nothing complained.
    const a = makeMockCodeline('a2');
    const b = makeMockCodeline('b2');
    const prd = makeRuntimePrd(a.clone, b.clone);

    await runPipeline(prd, 'mock3_core');

    const after = JSON.parse(readFileSync(prd, 'utf8'));
    const story = after.stories.find((s: { id: string }) => s.id === 'SPAN-1');
    expect(story, 'SPAN-1 vanished from the PRD').toBeTruthy();
    expect(story.perCodeline, 'no per-lane state was merged back into canonical').toBeTruthy();
    expect(Object.keys(story.perCodeline).sort(),
      'a declared codeline produced no result — partial coverage reported as success')
      .toEqual(['mock-a', 'mock-b']);
    expect(story.completed, 'story not marked complete though both lanes finished').toBe(true);
  }, 45 * 60 * 1000);
});

describe('mock3 wiring is valid without spending anything', () => {
  // These run in the FREE sweep: a fixture that has drifted out of shape should
  // fail loudly in CI, not silently skip until someone opts into a paid run.
  it('the canonical fixture declares one story spanning two codelines', () => {
    const prd = JSON.parse(readFileSync(CANONICAL_PRD, 'utf8'));
    expect(prd.stories).toHaveLength(1);
    expect(prd.stories[0].codelines).toEqual(['mock-a', 'mock-b']);
  });

  it('the runtime PRD injects exactly two outputDirs, and nothing else', () => {
    const prd = JSON.parse(readFileSync(makeRuntimePrd('/tmp/a', '/tmp/b'), 'utf8'));
    const canonical = JSON.parse(readFileSync(CANONICAL_PRD, 'utf8'));
    expect(prd.project.outputDirs).toHaveLength(2);
    // Everything except outputDirs must be byte-identical to canonical.
    delete prd.project.outputDirs;
    expect(prd).toEqual(canonical);
  });

  it('two outputDirs is what routes the run into the lane loop', () => {
    // The entry condition is `_cl_count > 1`; a fixture with one entry would
    // silently exercise the single-codeline path and prove nothing.
    const prd = JSON.parse(readFileSync(makeRuntimePrd('/tmp/a', '/tmp/b'), 'utf8'));
    expect(prd.project.outputDirs.length).toBeGreaterThan(1);
  });

  it('the codelines land outside this repo, as the PROJECT_ROOT guard demands', () => {
    const { clone } = makeMockCodeline('guard');
    expect(clone.startsWith(tmpdir()), `mock codeline inside the repo: ${clone}`).toBe(true);
    expect(existsSync(join(clone, 'src/hello.ts'))).toBe(true);
  });
});
