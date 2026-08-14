/**
 * brownfield-repro-test-writer.sh's own `git commit` MUST lead its message
 * with the ticket ID, matching commit_completed_story()'s 2026-08-02 fix
 * (lib/git-ops.sh) — see that file's comment for the general root cause.
 *
 * ESCAPED DEFECT (live, 2026-08-02, AMSD-2041 Writer Retest): gotransit and
 * upexpress BOTH permanently HALTed. Real evidence:
 *   - the writer produced and VALIDATED a real, parseable, passing test
 *     (`[repro-test-writer] test produced and validated on attempt 1`)
 *   - its own commit ("test: add bug-reproducing test for AMSD-2041")
 *     silently failed ("[repro-test-writer] commit failed (non-fatal)")
 *   - the repro-gate then correctly found no committed test and BLOCKED
 *     ("no test file accompanies the change"), HALTing both codelines
 *   - root cause, reproduced directly against the real gotransit repo:
 *     both codelines' commitlint (commitlint-plugin-jira-rules, extends
 *     "jira") requires the ticket ID as the FIRST token of the commit
 *     subject — "test: ..." doesn't qualify and is rejected outright by
 *     the commit-msg hook.
 *
 * This test reproduces that exact hook behavior with a real husky-style
 * commit-msg hook (no mocking of git/commitlint) and proves the fixed
 * message format passes it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintProjectPrompts } from '../../helpers/project-prompts';

const WRITER = join(__dirname, '../../../orchestrations/scripts/brownfield-repro-test-writer.sh');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (repo: string, a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

/**
 * A real commit-msg hook that mimics commitlint-plugin-jira-rules' actual,
 * observed behavior against the real gotransit/upexpress repos: reject any
 * subject whose first token isn't `<PROJECT>-<digits>:`.
 */
function installJiraCommitMsgHook(repo: string) {
  const hooksDir = join(repo, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'commit-msg');
  writeFileSync(
    hookPath,
    `#!/usr/bin/env bash
subject="$(head -1 "$1")"
if ! [[ "$subject" =~ ^[A-Z]+-[0-9]+: ]]; then
  echo "✖ taskId must be the first token, e.g. AMSD-1234: ..." >&2
  exit 1
fi
exit 0
`,
  );
  chmodSync(hookPath, 0o755);
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'repro-commitlint-'));
  dirs.push(repo);
  git(repo, ['init', '-q', '-b', 'develop']);
  git(repo, ['config', 'user.email', 't@t.t']);
  git(repo, ['config', 'user.name', 't']);
  mkdirSync(join(repo, 'src', 'svc'), { recursive: true });
  writeFileSync(join(repo, 'src', 'svc', 'discount.ts'), 'export const match = (a:string,b:string)=>a===b;\n');
  writeFileSync(
    join(repo, 'src', 'svc', 'other.spec.ts'),
    `import { it, expect } from 'vitest';\nit('x', () => expect(1).toBe(1));\n`,
  );
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'baseline']);
  git(repo, ['checkout', '-q', '-b', 'AI-AMSD-2041']);
  writeFileSync(
    join(repo, 'src', 'svc', 'discount.ts'),
    'export const match=(a:string,b:string)=>a.split("#")[0]===b;\n',
  );
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'fix']);
  installJiraCommitMsgHook(repo);
  return repo;
}

function installFakeVitest(repo: string) {
  const bin = join(repo, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const p = join(bin, 'vitest');
  writeFileSync(
    p,
    `#!/usr/bin/env bash
echo " Test Files  1 passed (1)"
echo "      Tests  1 passed (1)"
exit 0
`,
  );
  chmodSync(p, 0o755);
}

function stubRunner(repo: string): string {
  const stub = join(repo, 'stub-ai-run.sh');
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
if [ -z "\${EPAM_ALLOWED_WRITE_PATHS:-}" ]; then echo "corrective: write valid parseable TypeScript"; exit 0; fi
target="$PROJECT_ROOT/$EPAM_ALLOWED_WRITE_PATHS"
mkdir -p "$(dirname "$target")"
printf "import { it, expect } from 'vitest';\\nit('repro', () => expect(1).toBe(1));\\n" > "$target"
`,
  );
  chmodSync(stub, 0o755);
  return stub;
}

function runWriter(repo: string) {
  installFakeVitest(repo);
  const runner = stubRunner(repo);
  let out = '';
  try {
    out = execFileSync('bash', ['-c', `bash ${JSON.stringify(WRITER)} AMSD-2041 2>&1`], {
      encoding: 'utf8',
      env: {
        ...process.env, EPAM_PROJECT_CONFIG_DIR: mintProjectPrompts(),
        PROJECT_ROOT: repo,
        JIRA_BASELINE_BRANCH: 'develop',
        EPAM_BROWNFIELD: '1',
        AI_RUNNER_CMD: runner,
        REPRO_TEST_WRITER_MAX_ATTEMPTS: '1',
      },
    });
  } catch (e: any) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  const committed = git(repo, ['log', '--oneline', 'develop..HEAD']);
  const staged = git(repo, ['diff', '--cached', '--name-only']);
  return { out, committed, staged };
}

describe('repro-test-writer — commit message must satisfy a real ticket-ID-first commit-msg hook', () => {
  it('REPRODUCES the exact live defect and proves the fix: the commit succeeds against a Jira-style commit-msg hook', () => {
    const repo = makeRepo();
    const { out, committed, staged } = runWriter(repo);
    // Before the fix, this exact hook rejected "test: add bug-reproducing test
    // for AMSD-2041" and the failure was swallowed as "(non-fatal)" — the file
    // stayed staged forever and the repro-gate blocked with "no test file
    // accompanies the change". After the fix, the leading token is the ticket
    // ID, the hook passes, and the test actually lands in git history.
    expect(out).not.toMatch(/commit failed \(non-fatal\)/);
    expect(committed).toMatch(/^\w+ AMSD-2041: add bug-reproducing test/m);
    expect(staged).toBe('');
  });

  it('the commit subject leads with the ticket ID as the first token', () => {
    const repo = makeRepo();
    const { committed } = runWriter(repo);
    const subject = committed.split('\n')[0].replace(/^\w+\s/, '');
    expect(subject).toMatch(/^AMSD-2041:/);
  });
});

/**
 * The ticket-ID-first message is a best-effort DEFAULT, not a guarantee
 * every possible client repo's commit-msg hook will accept — this pipeline
 * cannot and must not hardcode a specific hook's exact rule set per
 * project (e.g. message length caps, required Co-Authored-By trailers,
 * scope requirements, anything). What it MUST do generically, for ANY
 * hook and ANY rejection reason, is surface the hook's own real output
 * instead of a generic swallowed "(non-fatal)" — that's the only failure
 * mode this pipeline can defend against without hardcoding.
 */
describe('repro-test-writer — surfaces the REAL hook output on ANY commit rejection, not just the Jira case', () => {
  it('a hook that rejects for a completely unrelated, made-up reason still has its real message logged', () => {
    const repo = makeRepo();
    // Deliberately NOT a Jira/ticket-ID rule — proves the fix isn't coupled
    // to that specific hook's rule shape.
    const hooksDir = join(repo, '.git', 'hooks');
    writeFileSync(
      join(hooksDir, 'commit-msg'),
      `#!/usr/bin/env bash\necho "ARBITRARY_REJECTION_MARKER_9f3c: commits must include a work-order number" >&2\nexit 1\n`,
    );
    chmodSync(join(hooksDir, 'commit-msg'), 0o755);
    const { out, committed, staged } = runWriter(repo);
    expect(out).toMatch(/ARBITRARY_REJECTION_MARKER_9f3c/);
    expect(out).not.toMatch(/commit failed \(non-fatal\)$/m); // old generic swallow is gone
    expect(committed).not.toMatch(/add bug-reproducing test/); // the hook blocked it
    expect(staged).not.toBe(''); // the writer's own test still exists, just uncommitted
  });
});
