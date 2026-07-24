/**
 * B12 — a fix legitimately invalidates pre-existing tests, and nobody updated them.
 *
 * Caught by mock1 (2026-07-24): the story changes getGreeting() 'hello world' ->
 * 'hello dolly'; the seeded src/hello.test.ts asserts 'hello world'. After the fix
 * that test fails. impl may no longer edit tests (B1) and the repro-test-writer only
 * AUTHORS A NEW co-located test — so nothing updates the stale one. Step 5's
 * regression guard then blocks on it, the phase fails, and the self-heal retry fails
 * identically. Same shape as the metrolinx deadlock: the pipeline breaks on an
 * artifact it produced itself. For a brownfield DEFECT the old test encodes the BUG,
 * so it MUST change — B1 removed the only actor that could.
 *
 * THE DANGEROUS NAIVE FIX, explicitly guarded against here: "make failing tests
 * pass". A failing pre-existing test means EITHER (a) it asserted the buggy
 * behaviour the fix corrects, or (b) the fix broke something real. Updating tests to
 * green in case (b) lets a wrong fix rewrite its own oracle — strictly worse than
 * the deadlock. So this step may only touch tests whose failure the intended
 * behaviour change explains, and must BLOCK otherwise.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/update-invalidated-tests.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const git = (repo: string, a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

/** Repo where the fix has ALREADY landed and a pre-existing test now fails. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'invalidated-'));
  dirs.push(repo);
  git(repo, ['init', '-q', '-b', 'develop']);
  git(repo, ['config', 'user.email', 't@t.t']); git(repo, ['config', 'user.name', 't']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'hello.ts'), "export const getGreeting = () => 'hello world';\n");
  writeFileSync(join(repo, 'src', 'hello.test.ts'),
    "import { it, expect } from 'vitest';\nimport { getGreeting } from './hello';\nit('greets', () => expect(getGreeting()).toBe('hello world'));\n");
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'baseline']);
  git(repo, ['checkout', '-q', '-b', 'AI-MOCK-1']);
  // the fix: behaviour deliberately changes, invalidating the pre-existing test
  writeFileSync(join(repo, 'src', 'hello.ts'), "export const getGreeting = () => 'hello dolly';\n");
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'fix']);
  return repo;
}

/** Fake runner: fails any test file whose expected string is not in the source. */
function installFakeVitest(repo: string) {
  const bin = join(repo, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'vitest'), `#!/usr/bin/env bash
fail=0
for f in $(find "$PWD/src" -name '*.test.ts' 2>/dev/null); do
  want=$(grep -oE "toBe\\('[^']*'\\)" "$f" | head -1 | sed -E "s/toBe\\('(.*)'\\)/\\1/")
  [ -z "$want" ] && continue
  if ! grep -q "'$want'" "$PWD/src/hello.ts" 2>/dev/null; then
    echo " FAIL $f"; echo "   expected '$want'"; fail=1
  fi
done
[ "$fail" = 1 ] && { echo " Test Files  1 failed"; exit 1; }
echo " Test Files  1 passed"; echo "      Tests  1 passed"; exit 0
`);
  chmodSync(join(bin, 'vitest'), 0o755);
}

/** Stub agent: applies the minimal expectation update, or refuses. */
function stubAgent(repo: string, mode: 'updates' | 'reports-regression' | 'writes-nothing'): string {
  const p = join(repo, 'stub-agent.sh');
  const bodies: Record<string, string> = {
    updates: `sed -i "s/'hello world'/'hello dolly'/" "$PROJECT_ROOT/src/hello.test.ts"; echo "UPDATED"`,
    'reports-regression': `echo "REGRESSION: the failure is not explained by the intended behaviour change"`,
    'writes-nothing': `echo ""`,
  };
  writeFileSync(p, `#!/usr/bin/env bash\n${bodies[mode]}\n`);
  chmodSync(p, 0o755);
  return p;
}

function run(repo: string, mode: 'updates' | 'reports-regression' | 'writes-nothing') {
  installFakeVitest(repo);
  const agent = stubAgent(repo, mode);
  let out = '', code = 0;
  try {
    out = execFileSync('bash', ['-c', `bash ${JSON.stringify(SCRIPT)} MOCK-1 2>&1`], {
      encoding: 'utf8',
      env: {
        ...process.env, PROJECT_ROOT: repo, JIRA_BASELINE_BRANCH: 'develop',
        EPAM_BROWNFIELD: '1', AI_RUNNER_CMD: agent,
        STORY_VERIFICATION_CRITERIA: 'The greeting reads "hello dolly".',
      },
    });
  } catch (e: any) { out = (e.stdout || '') + (e.stderr || ''); code = e.status ?? 1; }
  return { out, code, testSrc: readFileSync(join(repo, 'src', 'hello.test.ts'), 'utf8') };
}

describe('B12 — updating tests the fix legitimately invalidated', () => {
  it('updates a pre-existing test that asserted the OLD behaviour, leaving the suite green', () => {
    const { testSrc, code } = run(makeRepo(), 'updates');
    expect(testSrc).toContain('hello dolly');
    expect(code).toBe(0);
  });

  it('commits the update so the regression guard sees a clean tree', () => {
    const repo = makeRepo();
    run(repo, 'updates');
    expect(git(repo, ['status', '--porcelain'])).not.toMatch(/hello\.test\.ts/);
    expect(git(repo, ['log', '--oneline', '-1'])).toMatch(/test|invalidated/i);
  });

  it('BLOCKS instead of editing when the failure is a real regression', () => {
    // The cardinal sin: rewriting the oracle so a broken fix passes.
    const { out, code, testSrc } = run(makeRepo(), 'reports-regression');
    expect(testSrc).toContain('hello world');   // untouched
    expect(code).not.toBe(0);
    expect(out).toMatch(/regression/i);
  });

  it('BLOCKS when the agent produces no usable edit (suite still red)', () => {
    const { code } = run(makeRepo(), 'writes-nothing');
    expect(code).not.toBe(0);
  });

  it('is a NO-OP when the suite is already green (never edits tests speculatively)', () => {
    const repo = makeRepo();
    // revert the fix so nothing is invalidated
    writeFileSync(join(repo, 'src', 'hello.ts'), "export const getGreeting = () => 'hello world';\n");
    const { out, code, testSrc } = run(repo, 'updates');
    expect(testSrc).toContain('hello world');
    expect(code).toBe(0);
    expect(out).toMatch(/no invalidated tests|already green|nothing to do/i);
  });

  it('never edits non-test source files', () => {
    const repo = makeRepo();
    // Compare against HEAD *before* the script ran — HEAD~1 would include the fix
    // commit itself (src/hello.ts), which this step is not responsible for.
    const before = git(repo, ['rev-parse', 'HEAD']).trim();
    run(repo, 'updates');
    expect(readFileSync(join(repo, 'src', 'hello.ts'), 'utf8')).toContain('hello dolly');
    const changed = git(repo, ['diff', '--name-only', before, 'HEAD']);
    for (const f of changed.split('\n').filter(Boolean)) {
      expect(f, `edited a non-test file: ${f}`).toMatch(/\.(test|spec)\.[tj]sx?$|__tests__/);
    }
  });
});

describe('B12 — pipeline wiring', () => {
  const ORCH = readFileSync(
    join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh'), 'utf8');

  it('runs AFTER the test-writer and BEFORE the repro-gate', () => {
    const writer = ORCH.indexOf('brownfield-repro-test-writer.sh');
    const updater = ORCH.indexOf('update-invalidated-tests.sh');
    const gate = ORCH.indexOf('brownfield-repro-test-gate.sh');
    expect(updater).toBeGreaterThan(writer);
    expect(updater).toBeLessThan(gate);
  });

  it('passes the story Verification Criteria — the authority on what SHOULD change', () => {
    expect(ORCH).toMatch(/STORY_VERIFICATION_CRITERIA=/);
  });

  it('blocks the phase when the updater reports a regression', () => {
    const i = ORCH.indexOf('update-invalidated-tests.sh');
    const near = ORCH.slice(i, i + 1400);
    expect(near).toMatch(/PIPESTATUS\[0\]/);   // set -e only, no pipefail here
    expect(near).toMatch(/exit 1/);
  });
});
