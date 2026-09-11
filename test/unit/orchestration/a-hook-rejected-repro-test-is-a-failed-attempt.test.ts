/**
 * A REPRO TEST THE CLIENT'S HOOK REJECTS IS A FAILED ATTEMPT, NOT A FINISHED ONE.
 *
 * brownfield-repro-test-writer.sh validates a written test (it parses, runs, typechecks) and
 * then commits it. The commit is the last thing that happens, outside the attempt loop, and a
 * client repo's commit hook can reject it for any reason the hook enforces. The script already
 * says so in its own comments and surfaces the hook's output — and then does nothing with it:
 * the test stays uncommitted, the repro gate finds no test on the branch and blocks, the phase
 * exits 2, the self-heal retry resets the branch to the baseline, and the WRITER re-implements
 * the story from scratch.
 *
 * Live 2026-09-11 14:46Z on AMSD-1919: lint-staged rejected the test for one `export` on line
 * 397 (jest/no-export). The fix was correct. ~$0.70 and 25 minutes were spent re-doing it.
 *
 * The hook's output is a rejection reason like any other the loop already feeds back (compiler
 * errors, failing assertions). This runs the REAL script against a fixture codeline whose hook
 * rejects the first test, with a stub model that writes a rejected test on attempt 1 and a
 * clean one on attempt 2, and asserts: the second attempt was told WHY, the test was committed,
 * and the story's own commit was never touched.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SCRIPTS = join(ROOT, 'orchestrations/scripts');
const WRITER = join(SCRIPTS, 'brownfield-repro-test-writer.sh');
const NODE = process.execPath;

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });
}

function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'repro-hook-')); dirs.push(d);
  const proj = join(d, 'proj');
  mkdirSync(join(proj, 'src/__tests__'), { recursive: true });
  mkdirSync(join(proj, 'node_modules/.bin'), { recursive: true });
  writeFileSync(join(proj, 'package.json'), JSON.stringify({
    name: 'fx', devDependencies: { jest: '29.0.0', typescript: '5.0.0' }, scripts: { test: 'jest' },
  }));
  writeFileSync(join(proj, 'src/thing.ts'), 'export const thing = (a: string) => a;\n');
  writeFileSync(join(proj, 'src/__tests__/other.spec.ts'),
    'import { thing } from "../thing";\ndescribe("other", () => { it("works", () => { expect(thing("A")).toBe("A"); }); });\n');
  // A stand-in jest that reports one passing test in the JSON shape the validator reads.
  writeFileSync(join(proj, 'node_modules/.bin/jest'), '#!/bin/bash\necho \'{"numTotalTests":1,"numFailedTests":0}\'\n');
  chmodSync(join(proj, 'node_modules/.bin/jest'), 0o755);

  git(proj, 'init', '-q', '-b', 'develop');
  git(proj, 'add', '.'); git(proj, 'commit', '-q', '-m', 'baseline');
  // The story branch with the fix committed, the way the pipeline leaves it before this step.
  git(proj, 'checkout', '-q', '-b', 'bugfix/AI-FX-1');
  writeFileSync(join(proj, 'src/thing.ts'), 'export const thing = (a: string) => a.toLowerCase();\n');
  git(proj, 'add', '.'); git(proj, 'commit', '-q', '-m', 'FX-1: story complete');
  const storySha = git(proj, 'rev-parse', 'HEAD').trim();

  // THE CLIENT'S HOOK: rejects a test file that exports anything. Its message is the evidence.
  writeFileSync(join(proj, '.git/hooks/pre-commit'), [
    '#!/bin/bash',
    'for f in $(git diff --cached --name-only); do',
    '  case "$f" in *.spec.ts) if grep -q "^export" "$f"; then',
    '    echo "✖ eslint $f"; echo "  1:1  error  Do not export from a test file  jest/no-export"; exit 1; fi ;;',
    '  esac',
    'done',
  ].join('\n') + '\n');
  chmodSync(join(proj, '.git/hooks/pre-commit'), 0o755);

  // THE STUB MODEL: attempt 1 writes a test with an export (the hook rejects it); attempt 2 writes
  // a clean one. It records the prompt it received each time, so the test can assert what the
  // second attempt was told.
  const counter = join(d, 'attempt');
  const prompts = join(d, 'prompts');
  mkdirSync(prompts);
  const stub = join(d, 'stub-runner.sh');
  writeFileSync(stub, [
    '#!/bin/bash',
    // Only a write attempt counts: the writer names the file it may write.
    '[ -n "$EPAM_ALLOWED_WRITE_PATHS" ] || { cat >/dev/null; echo "src/thing.ts"; exit 0; }',
    `n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${JSON.stringify(counter)}`,
    `cat > ${JSON.stringify(prompts)}/attempt-$n.txt`,
    'target="$EPAM_ALLOWED_WRITE_PATHS"',
    `if [ "$n" = 1 ]; then printf 'import { thing } from "../thing";\\nexport const helper = 1;\\ndescribe("repro", () => { it("lowercases", () => { expect(thing("A")).toBe("a"); }); });\\n' > "${JSON.stringify(proj)}/$target";`,
    `else printf 'import { thing } from "../thing";\\ndescribe("repro", () => { it("lowercases", () => { expect(thing("A")).toBe("a"); }); });\\n' > "${JSON.stringify(proj)}/$target"; fi`,
    'echo "{\\"result\\":\\"written\\"}"',
  ].join('\n') + '\n');
  chmodSync(stub, 0o755);

  const prd = join(d, 'prd.json');
  writeFileSync(prd, JSON.stringify({
    project: { name: 'fixture' },
    stories: [{ id: 'FX-1', jiraKey: 'FX-1', title: 'lowercase the thing', description: 'thing() must lowercase',
      kind: 'defect', status: 'pending', verificationCriteria: ['thing("A") returns "a"'], technicalNotes: { files: ['src/thing.ts'] } }],
  }));
  return { d, proj, prd, stub, prompts, counter, storySha };
}

describe('a hook-rejected repro test is a failed attempt', () => {
  const fx = fixture();
  const r = spawnSync('bash', [WRITER, 'FX-1'], {
    encoding: 'utf8', timeout: 180_000, cwd: ROOT,
    env: {
      ...process.env,
      EPAM_BROWNFIELD: '1', PROJECT_ROOT: fx.proj, PRD_FILE: fx.prd, AI_RUNNER_CMD: fx.stub,
      JIRA_BASELINE_BRANCH: 'develop', LOG_DIR: join(fx.d, 'logs'), NODE_BIN: NODE,
      EPAM_PROJECT_CONFIG_DIR: join(ROOT, 'orchestrations/projects/metrolinx'),
      REPRO_TEST_WRITER_MAX_ATTEMPTS: '3',
      // Skip the target micro-question: only write attempts should reach the stub.
      EPAM_TEST_TARGET_ASK: '0',
    },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const attempts = existsSync(fx.counter) ? Number(readFileSync(fx.counter, 'utf8').trim()) : 0;

  it('the hook really rejected the first attempt — otherwise nothing below is tested', () => {
    expect(out, `expected the hook\'s own rejection in the output:\n${out.slice(-2000)}`).toMatch(/jest\/no-export/);
  });

  it('the writer tried again, and the second attempt was told what the hook said', () => {
    expect(attempts, `the writer stopped after ${attempts} attempt(s); a rejected commit must be retried:\n${out.slice(-1500)}`)
      .toBeGreaterThanOrEqual(2);
    const second = readFileSync(join(fx.prompts, 'attempt-2.txt'), 'utf8');
    expect(second, 'the retry prompt does not carry the hook\'s rejection — the model is asked the same question again')
      .toMatch(/jest\/no-export/);
  });

  it('the clean test is committed on the story branch, on top of the untouched story commit', () => {
    const log = git(fx.proj, 'log', '--format=%H %s', 'develop..bugfix/AI-FX-1').trim().split('\n');
    expect(log.some((l) => l.startsWith(fx.storySha)), `the story commit was lost:\n${log.join('\n')}`).toBe(true);
    expect(log.length, `expected the story commit plus the repro-test commit:\n${log.join('\n')}\n${out.slice(-1200)}`).toBe(2);
    expect(git(fx.proj, 'show', '--stat', '--format=', 'HEAD')).toMatch(/src\/__tests__\/thing\.spec\.ts/);
    expect(readFileSync(join(fx.proj, 'src/__tests__/thing.spec.ts'), 'utf8')).not.toMatch(/^export/m);
  });
});
