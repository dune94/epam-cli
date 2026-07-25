/**
 * brownfield-repro-test-writer.sh MUST validate the test it wrote BEFORE committing it.
 *
 * ESCAPED DEFECT (live, AMSD-1820 run 2026-07-24 14:07) — the writer treated
 * "the target file exists" as success:
 *
 *     [ -f "$PROJECT_ROOT/$_target_rel" ] && { log "test produced on attempt N"; break; }
 *
 * The agent produced a test with a SYNTAX ERROR (`} as any,` then `prices: [` —
 * esbuild: `Expected ";" but found ":"`). Because the file existed, the writer
 * declared success, skipped its own retry/ladder/self-heal path entirely, and
 * COMMITTED the unparseable file. Consequences chained:
 *   - repro-gate reported "the new test(s) FAIL with the fix in place — the fix is
 *     incomplete or the test is wrong", which is a misdiagnosis: the test never ran.
 *   - the committed broken file then failed Step 5's regression guard
 *     (`Test Files 1 failed | 34 passed`, `Tests 161 passed` — zero real failures),
 *     DEADLOCKING the run on the pipeline's own artifact.
 *
 * The 2026-07-24 rebuild fixed "produces nothing". It did NOT fix "produces garbage".
 * These tests close that: a test that cannot be parsed/executed is a FAILED ATTEMPT.
 *
 * Critical distinction under test: a test that PARSES but FAILS its assertions is
 * NOT a writer failure — that verdict belongs to the repro-gate. The writer must
 * only reject tests that cannot RUN.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WRITER = join(__dirname, '../../../orchestrations/scripts/brownfield-repro-test-writer.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const git = (repo: string, a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

/** Fixture repo: develop baseline + a fix commit on a story branch, no test yet. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'repro-validate-'));
  dirs.push(repo);
  git(repo, ['init', '-q', '-b', 'develop']);
  git(repo, ['config', 'user.email', 't@t.t']); git(repo, ['config', 'user.name', 't']);
  mkdirSync(join(repo, 'src', 'svc'), { recursive: true });
  writeFileSync(join(repo, 'src', 'svc', 'discount.ts'), 'export const match = (a:string,b:string)=>a===b;\n');
  writeFileSync(join(repo, 'src', 'svc', `other.spec.ts`),
    `import { it, expect } from 'vitest';\nit('x', () => expect(1).toBe(1));\n`);
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'baseline']);
  git(repo, ['checkout', '-q', '-b', 'AI-AMSD-1820']);
  writeFileSync(join(repo, 'src', 'svc', 'discount.ts'), 'export const match=(a:string,b:string)=>a.split("#")[0]===b;\n');
  git(repo, ['add', '-A']); git(repo, ['commit', '-qm', 'fix']);
  return repo;
}

/**
 * Fake project test runner at node_modules/.bin/vitest.
 * Emits REALISTIC vitest output: a transform/parse error for a file containing the
 * INVALID marker (mirroring the real esbuild failure), otherwise a normal run.
 */
function installFakeVitest(repo: string) {
  const bin = join(repo, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const p = join(bin, 'vitest');
  writeFileSync(p, `#!/usr/bin/env bash
# args: run <file...>
for f in "$@"; do
  [ "$f" = "run" ] && continue
  [ -f "$PWD/$f" ] || continue
  if grep -q 'SYNTAX_BROKEN' "$PWD/$f" 2>/dev/null; then
    echo "Error: Transform failed with 1 error:"
    echo "$PWD/$f:36:10: ERROR: Expected \\";\\" but found \\":\\""
    echo " Test Files  1 failed (1)"
    echo "      Tests  no tests"
    exit 1
  fi
  if grep -q 'ASSERTION_FAILS' "$PWD/$f" 2>/dev/null; then
    # RULE 6: this output is COPIED from a real vitest run, not written from memory.
    # The AssertionError line was previously OMITTED, and that omission hid the bug
    # that deleted every working test live: the validator's \`ERROR: Expected\`
    # regex matched \`AssertionError: expected\` case-insensitively. A fixture that
    # prints only the summary lines cannot catch it.
    echo " ❯ reproduces the bug"
    echo "AssertionError: expected undefined to deeply equal { name: '' }"
    echo " Test Files  1 failed (1)"
    echo "      Tests  1 failed (1)"
    exit 1
  fi
done
echo " Test Files  1 passed (1)"
echo "      Tests  1 passed (1)"
exit 0
`);
  chmodSync(p, 0o755);
}

type Mode = 'valid' | 'syntax-broken' | 'assertion-fails' | 'broken-then-valid' | 'nothing';

/** Stub agent: writes a test of the requested shape to the scoped path. */
function stubRunner(repo: string, mode: Mode): string {
  const stub = join(repo, 'stub-ai-run.sh');
  const counter = join(repo, '.attempts');
  const bodies: Record<string, string> = {
    valid: `printf "import { it, expect } from 'vitest';\\nit('repro', () => expect(1).toBe(1));\\n" > "$target"`,
    'syntax-broken': `printf "// SYNTAX_BROKEN\\nconst x = { a: 1 } as any,\\n  prices: [\\n" > "$target"`,
    'assertion-fails': `printf "// ASSERTION_FAILS\\nimport { it, expect } from 'vitest';\\nit('repro', () => expect(1).toBe(2));\\n" > "$target"`,
    'broken-then-valid': `n=$(cat ${JSON.stringify(counter)} 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > ${JSON.stringify(counter)}
if [ "$n" -le 1 ]; then printf "// SYNTAX_BROKEN\\nconst x = { a: 1 } as any,\\n  prices: [\\n" > "$target"
else printf "import { it, expect } from 'vitest';\\nit('repro', () => expect(1).toBe(1));\\n" > "$target"; fi`,
    nothing: `exit 0`,
  };
  writeFileSync(stub, `#!/usr/bin/env bash
# The analyst reuses this same runner; only the writer passes EPAM_ALLOWED_WRITE_PATHS.
if [ -z "\${EPAM_ALLOWED_WRITE_PATHS:-}" ]; then echo "corrective: write valid parseable TypeScript"; exit 0; fi
target="$PROJECT_ROOT/$EPAM_ALLOWED_WRITE_PATHS"
mkdir -p "$(dirname "$target")"
${bodies[mode]}
`);
  chmodSync(stub, 0o755);
  return stub;
}

function runWriter(repo: string, mode: Mode, env: Record<string, string> = {}) {
  installFakeVitest(repo);
  const runner = stubRunner(repo, mode);
  let out = '';
  try {
    out = execFileSync('bash', ['-c', `bash ${JSON.stringify(WRITER)} AMSD-1820 2>&1`], {
      encoding: 'utf8',
      env: {
        ...process.env, PROJECT_ROOT: repo, JIRA_BASELINE_BRANCH: 'develop',
        EPAM_BROWNFIELD: '1', AI_RUNNER_CMD: runner, REPRO_TEST_WRITER_MAX_ATTEMPTS: '2', ...env,
      },
    });
  } catch (e: any) { out = (e.stdout || '') + (e.stderr || ''); }
  const committed = git(repo, ['log', '--oneline', '--name-only', 'develop..HEAD']);
  const staged = git(repo, ['diff', '--cached', '--name-only']);
  return { out, committed, staged };
}

describe('repro-test-writer — validates the test before committing', () => {
  it('does NOT commit a test that cannot be parsed (the live escaped defect)', () => {
    const repo = makeRepo();
    const { committed } = runWriter(repo, 'syntax-broken');
    expect(committed).not.toMatch(/add bug-reproducing test/);
    expect(committed).not.toMatch(/discount\.spec\.ts/);
  });

  it('does NOT declare success on a non-parsing test just because the file exists', () => {
    const repo = makeRepo();
    const { out } = runWriter(repo, 'syntax-broken');
    expect(out).not.toMatch(/test produced on attempt 1/);
  });

  it('treats a non-parsing test as a failed attempt and engages the self-heal analyst', () => {
    const repo = makeRepo();
    const { out } = runWriter(repo, 'syntax-broken');
    expect(out).toMatch(/self-heal analyst|invalid/i);
  });

  it('retries after an invalid test and commits the valid one from the next attempt', () => {
    const repo = makeRepo();
    const { out, committed } = runWriter(repo, 'broken-then-valid');
    expect(out).toMatch(/attempt 2/);
    expect(committed).toMatch(/add bug-reproducing test/);
  });

  it('leaves NO invalid test staged in the git index (would poison later gates)', () => {
    const repo = makeRepo();
    const { staged } = runWriter(repo, 'syntax-broken');
    expect(staged).not.toMatch(/discount\.spec\.ts/);
  });

  it('commits a test that PARSES but FAILS its assertions — that verdict is the repro-gate\'s, not the writer\'s', () => {
    const repo = makeRepo();
    const { committed } = runWriter(repo, 'assertion-fails');
    expect(committed).toMatch(/add bug-reproducing test/);
  });

  it('commits a valid passing test', () => {
    const repo = makeRepo();
    const { committed } = runWriter(repo, 'valid');
    expect(committed).toMatch(/add bug-reproducing test/);
  });

  it('emits a failure and commits nothing when every attempt is invalid', () => {
    const repo = makeRepo();
    const { out, committed } = runWriter(repo, 'syntax-broken');
    expect(committed).not.toMatch(/add bug-reproducing test/);
    expect(out).toMatch(/repro-gate will BLOCK|NO test/i);
  });

  it('does not block when the project has no usable test runner (cannot validate => do not reject)', () => {
    const repo = makeRepo();
    const runner = stubRunner(repo, 'valid');           // note: no fake vitest installed
    let out = '';
    try {
      out = execFileSync('bash', ['-c', `bash ${JSON.stringify(WRITER)} AMSD-1820 2>&1`], {
        encoding: 'utf8',
        env: { ...process.env, PROJECT_ROOT: repo, JIRA_BASELINE_BRANCH: 'develop',
               EPAM_BROWNFIELD: '1', AI_RUNNER_CMD: runner, REPRO_TEST_WRITER_MAX_ATTEMPTS: '1' },
      });
    } catch (e: any) { out = (e.stdout || '') + (e.stderr || ''); }
    expect(git(repo, ['log', '--oneline', 'develop..HEAD'])).toMatch(/add bug-reproducing test/);
  });
});
