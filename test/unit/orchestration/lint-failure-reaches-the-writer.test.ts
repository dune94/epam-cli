// THE LINT FAILURE NEVER REACHED THE WRITER.
//
// Live metrolinx AMSD-2041, 2026-08-18. Attempt 5 produced type-clean code, then:
//   [ERROR] [repo-lint] the repository's own eslint rejects 4 changed file(s)
//   [FailureAnalyst] Target=kb — Lint-staged reverts on any lint issue; avoiding `any` ...
// and attempt 6 was launched on the strongest model in the ladder with NO information about
// which lint errors to fix. It ran 22 minutes and was killed.
//
// WHY. claude.sh documents the delivery contract at the prescribed-helper check:
//
//   "VERIFICATION_FAILURE alone goes nowhere: the retry loop routes it into
//    COORDINATOR_PROMPT_AMENDMENT — the text the next attempt actually reads — only when
//    DETERMINISTIC_CHECK_FAILURE=1. Setting the variable without the flag is what made
//    attempts 2 and 5 byte-identical live on 2026-08-09: the finding was assigned and
//    dropped, and the writer was never told."
//
// run_repo_lint_verification set VERIFICATION_FAILURE and returned 1 — and never set the flag.
// Delivery therefore fell to the failure-analyst's discretionary `target`, which chose `kb`
// (knowledge base, consumed by FUTURE runs) rather than `skill` (injected into THIS retry).
//
// Lint is deterministic — eslint either passes or it does not — so by the code's own definition
// it belongs in the deterministic class. These tests execute the REAL function against a repo
// with a REAL eslint violation and assert on what the writer would receive.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

let dir: string;

/** A git repo with a pre-commit hook, a stub eslint that FAILS, and one changed file. */
function makeRepo(eslintExit: number, eslintMessage: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'repo-lint-'));
  spawnSync('git', ['init', '-q', repo]);
  spawnSync('git', ['-C', repo, 'config', 'user.email', 't@t']);
  spawnSync('git', ['-C', repo, 'config', 'user.name', 't']);
  mkdirSync(join(repo, '.husky'), { recursive: true });
  writeFileSync(join(repo, '.husky/pre-commit'), '#!/bin/sh\nnpx lint-staged\n');
  mkdirSync(join(repo, 'node_modules/.bin'), { recursive: true });
  // Stub eslint: exits non-zero with a realistic message, and satisfies --print-config.
  const bin = join(repo, 'node_modules/.bin/eslint');
  writeFileSync(bin, `#!/bin/sh
case "$1" in --print-config) exit 0 ;; esac
cat <<'EOF'
${eslintMessage}
EOF
exit ${eslintExit}
`);
  chmodSync(bin, 0o755);
  writeFileSync(join(repo, 'src.ts'), 'export const x: any = 1;\n');
  spawnSync('git', ['-C', repo, 'add', '-A']);
  spawnSync('git', ['-C', repo, 'commit', '-qm', 'base']);
  writeFileSync(join(repo, 'src.ts'), 'export const x: any = 2;\n');
  return repo;
}

/**
 * Execute the REAL run_repo_lint_verification, then report the two things that decide whether
 * the writer is told: the delivery flag and the feedback text.
 */
function runLintGate(repo: string) {
  const script = `
set +e
# Minimal harness: the logging helpers the function calls, then the function itself.
error() { echo "ERROR $*" >&2; }
warning() { echo "WARN $*" >&2; }
log() { echo "LOG $*" >&2; }
info() { echo "INFO $*" >&2; }
is_truthy() { case "\${1:-}" in 1|true|TRUE|yes) return 0 ;; *) return 1 ;; esac; }
# The REAL engine-path filter, sourced from its single definition — not a convenient stub.
. "${join(ROOT, 'orchestrations/scripts/lib/engine-paths.sh')}"
SCRIPT_DIR="${join(ROOT, 'orchestrations/scripts')}"
PROJECT_ROOT="${repo}"
DETERMINISTIC_CHECK_FAILURE=0
VERIFICATION_FAILURE=""
STORY_REJECTION_KEY=""

# The real function, extracted verbatim from claude.sh.
eval "$(awk '/^run_repo_lint_verification\\(\\) \\{/,/^\\}/' "${CLAUDE_SH}")"

run_repo_lint_verification "STORY-1" /dev/null
_rc=$?
echo "RC=$_rc"
echo "FLAG=\${DETERMINISTIC_CHECK_FAILURE:-0}"
echo "KEY=\${STORY_REJECTION_KEY:-}"
echo "VF_LEN=\${#VERIFICATION_FAILURE}"
printf 'VF_START<<%s>>' "$VERIFICATION_FAILURE"
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const out = r.stdout || '';
  return {
    rc: Number((out.match(/RC=(\d+)/) || [])[1] ?? -1),
    flag: Number((out.match(/FLAG=(\d+)/) || [])[1] ?? -1),
    key: (out.match(/KEY=(.*)/) || [])[1] ?? '',
    vfLen: Number((out.match(/VF_LEN=(\d+)/) || [])[1] ?? 0),
    vf: (out.match(/VF_START<<([\s\S]*)>>/) || [])[1] ?? '',
    stderr: r.stderr || '',
  };
}

describe('a repo-lint rejection reaches the next attempt', () => {
  const MESSAGE = "/src.ts\n  1:20  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any";

  beforeAll(() => { dir = makeRepo(1, MESSAGE); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('the gate actually ran and rejected — otherwise every assertion below is vacuous', () => {
    const r = runLintGate(dir);
    expect(r.rc, `gate did not fail; stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/repo-lint/);
  });

  it('it writes the feedback text, naming the actual violation', () => {
    const r = runLintGate(dir);
    expect(r.vfLen, 'VERIFICATION_FAILURE is empty').toBeGreaterThan(0);
    expect(r.vf, 'the eslint rule the writer must fix is not in the feedback')
      .toContain('@typescript-eslint/no-explicit-any');
  });

  it('THE DEFECT: it sets DETERMINISTIC_CHECK_FAILURE, so the text is DELIVERED, not dropped', () => {
    const r = runLintGate(dir);
    // Without this flag the retry loop does not route VERIFICATION_FAILURE into
    // COORDINATOR_PROMPT_AMENDMENT; delivery falls to the analyst's discretionary target, which
    // chose `kb` live — a channel that reaches future runs, never this retry.
    expect(r.flag, 'lint feedback is assigned and dropped — the writer is never told').toBe(1);
  });

  it('it sets a rejection key, so an identical lint failure escalates the ladder', () => {
    const r = runLintGate(dir);
    expect(r.key, 'no rejection key — a lint failure repeating forever looks novel each time')
      .toMatch(/^lint:/);
    // 'lint:' alone would satisfy the prefix while carrying no signal, and every distinct lint
    // failure would then look identical — escalating the ladder on the first repeat forever.
    expect(r.key, 'the key carries no rule id, so every lint failure collides')
      .toContain('@typescript-eslint/no-explicit-any');
  });

  it('a CLEAN lint run neither fails nor sets the flag', () => {
    const clean = makeRepo(0, '');
    try {
      const r = runLintGate(clean);
      expect(r.rc, 'a clean lint run failed the story').toBe(0);
      expect(r.flag, 'a clean run set the failure flag').toBe(0);
    } finally { rmSync(clean, { recursive: true, force: true }); }
  });
});
