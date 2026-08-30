/**
 * "Code writer" test — REAL, single-story invocation of claude.sh directly
 * (`claude.sh STORY_ID`), bypassing run-agent-orchestration.sh's full
 * 23-step wrapper (CPA, ingest, regression guard, TC-writer, team-lead
 * review, QA gates) entirely. This exercises the exact same real
 * per-story mechanism the full pipeline uses for Step 8 (ensure_story_branch,
 * the real agent invocation via ai-run.sh, scope-guard, verify_story_
 * deliverables, update_story_status, post-story commit) — just without the
 * other ~20 steps around it, so a real LLM story-execution round-trip takes
 * ~1-3 minutes instead of 10+.
 *
 * Built 2026-07-23 specifically to answer: does the real agent mutate
 * tsconfig.json (or any file outside its declared scope) while implementing
 * a simple story? mock1's full pipeline run hit a mystery Step 19 tsc
 * failure (`moduleResolution=node10`) twice that could NOT be reproduced by
 * controlling tsconfig.json content alone (see pre-review-gate-step19.test.ts)
 * — this test captures the ACTUAL file-level effect of a real story-writing
 * agent, in isolation, fast.
 *
 * COST/TIME WARNING — gated behind RUN_REAL_PIPELINE_MOCK=1, skipped by
 * default, real small billed cost. Not part of the mandatory pre-PR
 * `vitest run` sweep.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const AGENT_PROFILES_FILE = join(REPO_ROOT, 'orchestrations/agents/profiles.json');

const RUN_REAL = process.env.RUN_REAL_PIPELINE_MOCK === '1';
const STORY_ID = 'MOCK-HW-1';

const cleanupDirs: string[] = [];
afterEach(() => {
  for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeMockCodeline(): { clone: string } {
  const root = mkdtempSync(join(tmpdir(), 'code-writer-'));
  cleanupDirs.push(root);
  chmodSync(root, 0o755);

  const bareOrigin = join(root, 'origin.git');
  mkdirSync(bareOrigin, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=main', '--quiet'], { cwd: bareOrigin });

  const seed = join(root, 'seed');
  mkdirSync(join(seed, 'src'), { recursive: true });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: seed });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seed });
  writeFileSync(join(seed, '.gitignore'), 'node_modules\n');
  writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'code-writer-fixture', version: '1.0.0', private: true }, null, 2));
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

/** Bare-shape PRD, matching a real freshly-ingested-and-spec-passed story —
 *  technicalNotes.files IS set here (unlike mock1's Jira-ingest test) since
 *  this test targets ONLY claude.sh's own per-story mechanism, not the spec
 *  pass that would normally populate it — the file target is a precondition
 *  for this narrower test, not something being proven here. */
function writePrd(prdPath: string, projectRoot: string): void {
  writeFileSync(prdPath, JSON.stringify({
    id: 'code-writer-test',
    project: { outputDir: projectRoot },
    implementationOrder: { core: [STORY_ID] },
    stories: [{
      id: STORY_ID,
      title: 'Change greeting from hello world to hello dolly',
      description: "In src/hello.ts, change the string returned by getGreeting() from 'hello world' to 'hello dolly'. Update src/hello.test.ts's expectation to match. Do not modify package.json or tsconfig.json.",
      status: 'pending',
      completed: false,
      agentGroup: 'main',
      agentRole: 'typescript-engineer',
      technicalNotes: { files: ['src/hello.ts', 'src/hello.test.ts'] },
      storyType: 'implementation',
      aiProvider: 'openrouter',
      model: 'z-ai/glm-5.1',
      effort: 'low',
    }],
  }, null, 2));
}

describe.skipIf(!RUN_REAL)('Code writer — REAL single-story claude.sh invocation, no full pipeline', () => {
  it('captures exactly which files a real agent touches: the declared files change, tsconfig.json/package.json do NOT', () => {
    const { clone } = makeMockCodeline();
    const prdPath = join(clone, '..', 'prd.json');
    writePrd(prdPath, clone);

    const tsconfigBefore = readFileSync(join(clone, 'tsconfig.json'), 'utf8');
    const packageJsonBefore = readFileSync(join(clone, 'package.json'), 'utf8');

    const result = spawnSync('bash', [CLAUDE_SH, STORY_ID], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
      env: {
        ...process.env,
        PRD_FILE: prdPath,
        PROJECT_ROOT: clone,
        AGENT_PROFILES_FILE,
        EPAM_BROWNFIELD: '1',
        JIRA_BASELINE_BRANCH: 'main',
        EPAM_DANGEROUS_SKIP_APPROVAL: '1',
        ORCH_GATE_PROVIDER: 'openrouter',
        ORCH_GATE_MODEL: 'z-ai/glm-5.1',
        STORY_TIMEOUT_SECS: '240',
      },
    });
    const output = (result.stdout || '') + (result.stderr || '');
    console.log('[code-writer] claude.sh output tail:\n' + output.slice(-4000));

    const tsconfigAfter = readFileSync(join(clone, 'tsconfig.json'), 'utf8');
    const packageJsonAfter = readFileSync(join(clone, 'package.json'), 'utf8');

    // The actual finding this test is FOR — printed unconditionally so it's
    // visible even if the assertions below fail.
    console.log('[code-writer] tsconfig.json UNCHANGED:', tsconfigBefore === tsconfigAfter);
    console.log('[code-writer] package.json UNCHANGED:', packageJsonBefore === packageJsonAfter);
    if (tsconfigBefore !== tsconfigAfter) {
      console.log('[code-writer] tsconfig.json BEFORE:\n' + tsconfigBefore);
      console.log('[code-writer] tsconfig.json AFTER:\n' + tsconfigAfter);
    }

    // mock1's full pipeline run committed 7 files for the same story (vs 3
    // here) — capture exactly what a real agent commits, every run, to see
    // whether it ever creates EXTRA files beyond the 2 declared ones that
    // could affect tsc's include-glob resolution (a new tsconfig-adjacent
    // file, a stray directory, etc.).
    try {
      const committedFiles = execFileSync('git', ['show', '--stat', '--format=', 'HEAD'], { cwd: clone, encoding: 'utf8' });
      console.log('[code-writer] files committed by the real agent:\n' + committedFiles);
      const allTracked = execFileSync('git', ['ls-files'], { cwd: clone, encoding: 'utf8' });
      console.log('[code-writer] all tracked files after the run:\n' + allTracked);
    } catch (e) {
      console.log('[code-writer] could not capture commit stat:', e);
    }

    expect(result.status, output.slice(-4000)).toBe(0);
    expect(tsconfigAfter, 'agent mutated tsconfig.json despite being told not to').toBe(tsconfigBefore);
    expect(packageJsonAfter, 'agent mutated package.json despite being told not to').toBe(packageJsonBefore);

    const hello = readFileSync(join(clone, 'src/hello.ts'), 'utf8');
    expect(hello).toMatch(/hello dolly/);
  }, 5 * 60 * 1000);
});
