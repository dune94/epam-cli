/**
 * brownfield-repro-test-writer.sh — dedicated reproducing-test pass (2026-07-24).
 *
 * The impl agent kept failing to ship a reproducing test in its own budget
 * (AMSD-1820 run #3). This pass gives test-writing its own agent turn AFTER the
 * fix commits: it detects the repo's test convention, builds a target path, invokes
 * a write-capable agent (here: a stubbed ai-run.sh), and commits the result. The
 * repro-gate then independently validates it. This exercises the REAL script against
 * a real git fixture with a stub runner (no live LLM).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintProjectPrompts } from '../../helpers/project-prompts';

const WRITER = join(__dirname, '../../../orchestrations/scripts/brownfield-repro-test-writer.sh');
const ORCH = readFileSync(join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const git = (repo: string, a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

// A fixture repo: develop baseline, plus a fix commit on top (fix file, NO test).
// existingTestExt controls which convention the repo already uses (.spec.ts / .test.ts).
function makeRepo(opts: { existingTestExt?: 'spec' | 'test'; includeTestInFix?: boolean } = {}): string {
  const repo = mkdtempSync(join(tmpdir(), 'repro-writer-'));
  dirs.push(repo);
  git(repo, ['init', '-q', '-b', 'develop']);
  git(repo, ['config', 'user.email', 't@t.t']); git(repo, ['config', 'user.name', 't']);
  mkdirSync(join(repo, 'src', 'svc'), { recursive: true });
  writeFileSync(join(repo, 'src', 'svc', 'discount.ts'), 'export const match = (a:string,b:string) => a === b;\n');
  // seed an existing test in the repo's convention so detection has a signal + example
  if (opts.existingTestExt) {
    const ext = opts.existingTestExt === 'spec' ? 'spec.ts' : 'test.ts';
    writeFileSync(join(repo, 'src', 'svc', `other.${ext}`), `import { it, expect } from 'vitest';\nit('x', () => expect(1).toBe(1));\n`);
  }
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'baseline']);
  // the fix lands on a story branch (as in the real pipeline) so develop stays at baseline
  git(repo, ['checkout', '-q', '-b', 'AI-AMSD-1820']);
  // fix commit: change the source (the "fix"), no test
  writeFileSync(join(repo, 'src', 'svc', 'discount.ts'), 'export const match = (a:string,b:string) => a.split("#")[0] === b;\n');
  if (opts.includeTestInFix) {
    writeFileSync(join(repo, 'src', 'svc', 'discount.spec.ts'), `import { it, expect } from 'vitest';\nit('repro', () => expect(1).toBe(1));\n`);
  }
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'fix']);
  return repo;
}

// Stub ai-run.sh: simulate the agent writing a test to EPAM_ALLOWED_WRITE_PATHS.
function stubRunner(repo: string, mode: 'writes-test' | 'writes-nothing'): string {
  const stub = join(repo, 'stub-ai-run.sh');
  const body = mode === 'writes-test'
    ? `#!/usr/bin/env bash
# write a minimal test to the scoped path (relative to PROJECT_ROOT), as the real agent would
target="$PROJECT_ROOT/$EPAM_ALLOWED_WRITE_PATHS"
mkdir -p "$(dirname "$target")"
printf "import { it, expect } from 'vitest';\\nit('reproduces', () => expect(true).toBe(true));\\n" > "$target"
`
    : `#!/usr/bin/env bash
exit 0
`;
  writeFileSync(stub, body); chmodSync(stub, 0o755);
  return stub;
}

function runWriter(repo: string, env: Record<string, string>): { code: number; out: string } {
  try {
    // merge stderr → stdout: the script's log() writes to stderr, and we assert on it
    const out = execFileSync('bash', ['-c', `bash ${JSON.stringify(WRITER)} AMSD-1820 2>&1`], {
      encoding: 'utf8',
      env: { ...process.env, EPAM_PROJECT_CONFIG_DIR: mintProjectPrompts(), PROJECT_ROOT: repo, JIRA_BASELINE_BRANCH: 'develop', EPAM_BROWNFIELD: '1', ...env },
    });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}

function writePrd(repo: string): string {
  const prd = join(repo, 'prd.json');
  writeFileSync(prd, JSON.stringify({ stories: [{ id: 'AMSD-1820', verificationCriteria: ['The return-trip discount is displayed.'] }], implementationOrder: { core: ['AMSD-1820'] } }));
  return prd;
}

// Stub that whiffs on writer-attempt 1 (max-iterations) then WRITES on attempt 2.
// The same AI_RUNNER_CMD is also the analyst's runner — distinguish by prompt content.
function stubRetryThenSucceed(repo: string, counterFile: string): string {
  const stub = join(repo, 'stub-retry.sh');
  writeFileSync(stub, `#!/usr/bin/env bash
prompt="$(cat)"
# analyst call → return a corrective directive, do NOT count as a writer attempt.
# Discriminate on a phrase UNIQUE to the analyst prompt ("An AI agent failed"); the writer's
# retry prompt carries "CORRECTIVE GUIDANCE" but never that phrase.
if printf '%s' "$prompt" | grep -qiE 'An AI agent failed'; then
  printf 'COMMIT EARLY: write the test file now as your first action.'
  exit 0
fi
N=$(cat ${JSON.stringify(counterFile)} 2>/dev/null || echo 0); echo $((N+1)) > ${JSON.stringify(counterFile)}
if [ "$N" -eq 0 ]; then
  printf 'Agent reached maximum iterations (15) without completing.\\n'   # attempt 1: whiff
  exit 0
fi
target="$PROJECT_ROOT/$EPAM_ALLOWED_WRITE_PATHS"                          # attempt 2+: write
mkdir -p "$(dirname "$target")"
printf "import { it, expect } from 'vitest';\\nit('r',()=>expect(true).toBe(true));\\n" > "$target"
`);
  chmodSync(stub, 0o755);
  return stub;
}

describe('brownfield-repro-test-writer — retry + ladder + self-heal', () => {
  it('whiffs on attempt 1 (max-iterations) → self-heals → escalates ladder → writes on attempt 2', () => {
    const repo = makeRepo({ existingTestExt: 'spec' });
    const prd = writePrd(repo);
    const counter = join(repo, 'attempts.txt'); writeFileSync(counter, '0');
    const { out } = runWriter(repo, {
      PRD_FILE: prd,
      AI_RUNNER_CMD: stubRetryThenSucceed(repo, counter),
      // The agent-driven target ASK calls the same runner this stub counts, so with it on the
      // stub's attempt-1 whiff is spent choosing a file and never reaches authorship — which is
      // what this test is about. Target selection has its own test
      // (repro-test-writer-target-selection.test.ts); keeping the two separate is the point.
      EPAM_TEST_TARGET_ASK: '0',
      SPEC_MODE_SPECKIT_MODEL: 'z-ai/glm-5.1',
      EPAM_MODEL_LADDER_HIGH: 'z-ai/glm-5.1=moonshotai/kimi-k3',
      EPAM_MODEL_PROVIDER_MAP: 'moonshotai/*=qwen|z-ai/*=qwen',
    });
    // recovered: the test file exists and was committed
    expect(existsSync(join(repo, 'src', 'svc', 'discount.spec.ts'))).toBe(true);
    // self-heal engaged, and the ladder escalated on attempt 2
    expect(out).toMatch(/invoking self-heal analyst/);
    // THE REQUIREMENT IS "IT ESCALATED", NOT "IT ESCALATED TO THIS LITERAL".
    //
    // This used to assert `glm-5.1 → moonshotai/kimi-k3`, a HIGH-tier pair the fixture set by
    // hand. The seam declares tier HIGHEST in invocation-profiles.json, so once it read the
    // project's own ladder declaration it escalated along the HIGHEST chain instead and the
    // literal went stale. Assert the hop is a REAL rung of the tier this seam declares, read
    // from the same file the pipeline reads — so a ladder change updates the test with it.
    const hop = out.match(/ladder escalation \(attempt 2\/3\) — (\S+) → (\S+)/);
    expect(hop, `no ladder escalation line in:\n${out}`).toBeTruthy();
    // The seam declares a POSITION ('top'), not a tier name — the engine holds no tier
    // vocabulary, so the project's own order is what turns one into the other. Indexing
    // .ladders by the raw position reads undefined and the assertion dies before it runs.
    const position = JSON.parse(
      readFileSync(join(__dirname, '../../../orchestrations/agents/invocation-profiles.json'), 'utf8'),
    ).profiles['repro-test-writer'].ladder;
    const settings = JSON.parse(
      readFileSync(join(__dirname, '../../../orchestrations/projects/metrolinx/llm-settings.json'), 'utf8'),
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { resolveTierPosition } = require(join(__dirname, '../../../orchestrations/scripts/lib/seam-invocation.js'));
    const tier = resolveTierPosition(position, {
      EPAM_MODEL_LADDER_TIER_ORDER: (settings.ladderTierOrder || []).join(' '),
    });
    expect(tier, `position '${position}' resolves to no tier this project declares`).toBeTruthy();
    const chain = settings.ladders[tier].modelLadder as Array<{ from: string; to: string }>;
    expect(
      chain.some((r) => r.from === hop![1] && r.to === hop![2]),
      `${hop![1]} → ${hop![2]} is not a rung of the '${tier}' ladder this seam declares`,
    ).toBe(true);
    expect(out).toMatch(/test produced on attempt 2/);
  });
});

describe('brownfield-repro-test-writer — dedicated test pass', () => {
  it('writes + commits a reproducing test at the repo convention (.spec.ts) when none exists', () => {
    const repo = makeRepo({ existingTestExt: 'spec' });
    const prd = writePrd(repo);
    const { out } = runWriter(repo, { PRD_FILE: prd, AI_RUNNER_CMD: stubRunner(repo, 'writes-test') });
    // detected .spec.ts convention, co-located next to the fix
    expect(existsSync(join(repo, 'src', 'svc', 'discount.spec.ts'))).toBe(true);
    expect(out).toMatch(/convention: \.spec\.ts/);
    // committed it
    const files = git(repo, ['diff', 'develop..HEAD', '--name-only']);
    expect(files).toMatch(/src\/svc\/discount\.spec\.ts/);
    expect(git(repo, ['log', '-1', '--pretty=%s'])).toMatch(/bug-reproducing test/);
  });

  it('respects .test.ts convention when the repo uses it', () => {
    const repo = makeRepo({ existingTestExt: 'test' });
    const prd = writePrd(repo);
    runWriter(repo, { PRD_FILE: prd, AI_RUNNER_CMD: stubRunner(repo, 'writes-test') });
    expect(existsSync(join(repo, 'src', 'svc', 'discount.test.ts'))).toBe(true);
  });

  it('NO-OP when a test already accompanies the change (impl wrote one)', () => {
    const repo = makeRepo({ existingTestExt: 'spec', includeTestInFix: true });
    const prd = writePrd(repo);
    const before = git(repo, ['rev-parse', 'HEAD']);
    const { out } = runWriter(repo, { PRD_FILE: prd, AI_RUNNER_CMD: stubRunner(repo, 'writes-test') });
    expect(out).toMatch(/a test already accompanies the change/);
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(before); // no new commit
  });

  it('NO-OP when not brownfield', () => {
    const repo = makeRepo({ existingTestExt: 'spec' });
    const prd = writePrd(repo);
    const before = git(repo, ['rev-parse', 'HEAD']);
    runWriter(repo, { PRD_FILE: prd, EPAM_BROWNFIELD: '0', AI_RUNNER_CMD: stubRunner(repo, 'writes-test') });
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(before);
  });

  it('agent writes nothing → no commit, no crash (repro-gate will BLOCK downstream)', () => {
    const repo = makeRepo({ existingTestExt: 'spec' });
    const prd = writePrd(repo);
    const before = git(repo, ['rev-parse', 'HEAD']);
    const { code, out } = runWriter(repo, { PRD_FILE: prd, AI_RUNNER_CMD: stubRunner(repo, 'writes-nothing') });
    expect(code).toBe(0);                       // best-effort, never aborts
    expect(out).toMatch(/no test file produced/);
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(before);
  });
});

describe('wiring: Step 3.54 runs the writer BEFORE the Step 3.55 gate', () => {
  it('run-agent-orchestration.sh invokes the writer just before the repro-gate', () => {
    expect(ORCH).toMatch(/Step 3\.54: Dedicated reproducing-test writer/);
    expect(ORCH).toMatch(/brownfield-repro-test-writer\.sh/);
    // ordering: 3.54 writer appears before the 3.55 gate
    expect(ORCH.indexOf('brownfield-repro-test-writer.sh')).toBeLessThan(ORCH.indexOf('brownfield-repro-test-gate.sh'));
  });
});
