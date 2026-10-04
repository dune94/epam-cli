/**
 * THE AGENT'S REPRODUCING TEST IS ACCEPTED WHERE THE REPOSITORY KEEPS ITS TESTS.
 *
 * AMSD-2974 writer run, 2026-10-03: cx-shared keeps most component specs in __tests__/ (84 against
 * 54 beside the source). The stage named the sibling path (ToastNotification.spec.tsx, because that
 * component had no __tests__ yet) and looked ONLY there; the agent followed the repository and wrote
 * __tests__/ToastNotification.spec.tsx — a valid test, passing with the fix — and all three attempts
 * were recorded as class=no_file, so the repro gate would block a correct change.
 *
 * A test the agent writes at one of the plugin's conventional locations for the fixed source
 * (candidateTestPaths), and that the baseline does not already have, is the stage's test: validated
 * and committed like any other. No location is newly allowed that the plugin does not name.
 *
 * EXECUTED: the real brownfield-repro-test-writer.sh with a stub agent, on a real git fixture.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintProjectPrompts } from '../../helpers/project-prompts';

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
        ...process.env, EPAM_PROJECT_CONFIG_DIR: mintProjectPrompts(), PROJECT_ROOT: repo, JIRA_BASELINE_BRANCH: 'develop',
        EPAM_BROWNFIELD: '1', AI_RUNNER_CMD: runner, REPRO_TEST_WRITER_MAX_ATTEMPTS: '2', ...env,
      },
    });
  } catch (e: any) { out = (e.stdout || '') + (e.stderr || ''); }
  const committed = git(repo, ['log', '--oneline', '--name-only', 'develop..HEAD']);
  const staged = git(repo, ['diff', '--cached', '--name-only']);
  return { out, committed, staged };
}

/** A stub agent that follows the repository's __tests__/ convention instead of the named path. */
function conventionalRunner(repo: string): string {
  const stub = join(repo, 'stub-conventional.sh');
  writeFileSync(stub, `#!/usr/bin/env bash
if [ -z "\${EPAM_ALLOWED_WRITE_PATHS:-}" ]; then echo "corrective"; exit 0; fi
named="$EPAM_ALLOWED_WRITE_PATHS"
target="$PROJECT_ROOT/$(dirname "$named")/__tests__/$(basename "$named")"
mkdir -p "$(dirname "$target")"
printf "import { it, expect } from 'vitest';\\nit('repro', () => expect(1).toBe(1));\\n" > "$target"
`);
  chmodSync(stub, 0o755);
  return stub;
}

describe('the agent\'s reproducing test is accepted where the repository keeps its tests', () => {
  it('a test written in __tests__/ beside the fixed source is validated and committed', () => {
    const repo = makeRepo();
    installFakeVitest(repo);
    let out = '';
    try {
      out = execFileSync('bash', ['-c', `bash ${JSON.stringify(WRITER)} AMSD-1820 2>&1`], { encoding: 'utf8', env: {
        ...process.env, EPAM_PROJECT_CONFIG_DIR: mintProjectPrompts(), PROJECT_ROOT: repo, JIRA_BASELINE_BRANCH: 'develop',
        EPAM_BROWNFIELD: '1', AI_RUNNER_CMD: conventionalRunner(repo), REPRO_TEST_WRITER_MAX_ATTEMPTS: '2' } });
    } catch (e: any) { out = (e.stdout || '') + (e.stderr || ''); }
    const committed = git(repo, ['log', '--oneline', '--name-only', 'develop..HEAD']);
    expect(committed, out).toContain('src/svc/__tests__/discount.spec.ts');
    expect(out).not.toMatch(/no valid test after/);
  });
});
