/**
 * update-invalidated-tests.sh's own `git commit` MUST lead its message with
 * the ticket ID — same defect class as
 * repro-test-writer-commit-message-format.test.ts, found the same day
 * (2026-08-02, AMSD-2041 Writer Retest) in the sibling `git commit` call in
 * brownfield-repro-test-writer.sh: a bare "test: ..." subject is rejected
 * outright by a client repo's commitlint (commitlint-plugin-jira-rules),
 * which requires the ticket ID as the FIRST token. This script had the
 * identical hardcoded "test: ..." shape and would fail identically the
 * first time it actually ran against such a repo — not yet observed live,
 * but reproduced directly here before it could recur.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../orchestrations/scripts/update-invalidated-tests.sh');
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (repo: string, a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });

function installJiraCommitMsgHook(repo: string) {
  const hooksDir = join(repo, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(
    join(hooksDir, 'commit-msg'),
    `#!/usr/bin/env bash
subject="$(head -1 "$1")"
if ! [[ "$subject" =~ ^[A-Z]+-[0-9]+: ]]; then
  echo "✖ taskId must be the first token, e.g. AMSD-1234: ..." >&2
  exit 1
fi
exit 0
`,
  );
  chmodSync(join(hooksDir, 'commit-msg'), 0o755);
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'invalidated-commitlint-'));
  dirs.push(repo);
  git(repo, ['init', '-q', '-b', 'develop']);
  git(repo, ['config', 'user.email', 't@t.t']);
  git(repo, ['config', 'user.name', 't']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'hello.ts'), "export const getGreeting = () => 'hello world';\n");
  writeFileSync(
    join(repo, 'src', 'hello.test.ts'),
    "import { it, expect } from 'vitest';\nimport { getGreeting } from './hello';\nit('greets', () => expect(getGreeting()).toBe('hello world'));\n",
  );
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'baseline']);
  git(repo, ['checkout', '-q', '-b', 'AI-AMSD-2041']);
  writeFileSync(join(repo, 'src', 'hello.ts'), "export const getGreeting = () => 'hello dolly';\n");
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'fix']);
  installJiraCommitMsgHook(repo);
  return repo;
}

function installFakeVitest(repo: string) {
  const bin = join(repo, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'vitest'),
    `#!/usr/bin/env bash
fail=0
for f in $(find "$PWD/src" -name '*.test.ts' 2>/dev/null); do
  want=$(grep -oE "toBe\\('[^']*'\\)" "$f" | head -1 | sed -E "s/toBe\\('(.*)'\\)/\\1/")
  [ -z "$want" ] && continue
  if ! grep -q "'$want'" "$PWD/src/hello.ts" 2>/dev/null; then
    echo " FAIL $f"; fail=1
  fi
done
[ "$fail" = 1 ] && { echo " Test Files  1 failed"; exit 1; }
echo " Test Files  1 passed"; echo "      Tests  1 passed"; exit 0
`,
  );
  chmodSync(join(bin, 'vitest'), 0o755);
}

function stubAgent(repo: string): string {
  const p = join(repo, 'stub-agent.sh');
  writeFileSync(p, `#!/usr/bin/env bash\nsed -i "s/'hello world'/'hello dolly'/" "$PROJECT_ROOT/src/hello.test.ts"; echo "UPDATED"\n`);
  chmodSync(p, 0o755);
  return p;
}

function run(repo: string) {
  installFakeVitest(repo);
  const agent = stubAgent(repo);
  let out = '';
  try {
    out = execFileSync('bash', ['-c', `bash ${JSON.stringify(SCRIPT)} AMSD-2041 2>&1`], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PROJECT_ROOT: repo,
        JIRA_BASELINE_BRANCH: 'develop',
        EPAM_BROWNFIELD: '1',
        AI_RUNNER_CMD: agent,
        STORY_VERIFICATION_CRITERIA: 'The greeting reads "hello dolly".',
      },
    });
  } catch (e: any) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  const committed = git(repo, ['log', '--oneline', 'develop..HEAD']);
  const status = git(repo, ['status', '--porcelain']);
  return { out, committed, status };
}

describe('update-invalidated-tests.sh — commit message must satisfy a real ticket-ID-first commit-msg hook', () => {
  it('the commit succeeds against a Jira-style commit-msg hook and leads with the ticket ID', () => {
    const repo = makeRepo();
    const { out, committed, status } = run(repo);
    expect(out).not.toMatch(/commit failed \(non-fatal\)/);
    expect(committed).toMatch(/^\w+ AMSD-2041: update tests invalidated by the fix/m);
    expect(status).not.toMatch(/hello\.test\.ts/);
  });
});

/**
 * Same generic-surfacing guarantee as
 * repro-test-writer-commit-message-format.test.ts's sibling describe block:
 * ANY hook rejection reason (not hardcoded to the Jira case) must have its
 * real output logged, not swallowed as a generic "(non-fatal)".
 */
describe('update-invalidated-tests.sh — surfaces the REAL hook output on ANY commit rejection', () => {
  it('a hook that rejects for a completely unrelated, made-up reason still has its real message logged', () => {
    const repo = makeRepo();
    const hooksDir = join(repo, '.git', 'hooks');
    writeFileSync(
      join(hooksDir, 'commit-msg'),
      `#!/usr/bin/env bash\necho "ARBITRARY_REJECTION_MARKER_2b71: needs a linked PR number" >&2\nexit 1\n`,
    );
    chmodSync(join(hooksDir, 'commit-msg'), 0o755);
    const { out, committed, status } = run(repo);
    expect(out).toMatch(/ARBITRARY_REJECTION_MARKER_2b71/);
    expect(out).not.toMatch(/commit failed \(non-fatal\)$/m);
    expect(committed).not.toMatch(/update tests invalidated/);
    expect(status).toMatch(/hello\.test\.ts/); // still uncommitted, but not lost
  });
});
