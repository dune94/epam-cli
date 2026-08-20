// THE GATE DETECTED, DELIVERED, AND NEVER GATED.
//
// Live metrolinx AMSD-2041, 2026-08-19 13:55–18:53. lockfile-sync blocked FOUR times, correctly
// every time, and the story completed anyway — `✓ [completed]`, reviewer APPROVED, with
// package.json carrying a dependency package-lock.json does not resolve. `npm ci` still fails on
// that branch.
//
// The cause is one missing character. Every sibling deterministic check on this code path is:
//
//     if ! run_relative_import_check ...; then
//         VERIFICATION_FAILURE="..."; DETERMINISTIC_CHECK_FAILURE=1; return 1
//     fi
//
// but ten lines earlier, run_dependency_check and run_lockfile_sync_check are called BARE. Their
// `return 1` is discarded, run_external_verification carries on to the test suite and can return
// 0, and the attempt is recorded as a success.
//
// The three-part contract still worked as far as it went: the globals those checks set reach the
// retry prompt, which is why the amendment carried the lockfile text. What never happened is the
// FAILING. Detection without enforcement.
//
// AND THE EXISTING TESTS COULD NOT SEE IT: they lift the check function with awk and assert it
// returns 1. The function was always right. This asserts the RECEIVER — that
// run_external_verification itself fails when a check it calls fails.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

/**
 * Run the REAL run_external_verification with every collaborator stubbed to succeed EXCEPT the
 * one under test, which fails. The question is only ever: does the caller propagate?
 */
function verificationRc(failing: string): number {
  const script = `
set +e
log() { :; }; info() { :; }; warning() { echo "WARN $*" >&2; }; error() { echo "ERR $*" >&2; }
success() { :; }; step_emit() { :; }; is_truthy() { case "\${1:-}" in 1|true|TRUE|yes) return 0;; *) return 1;; esac; }
SCRIPT_DIR="${join(ROOT, 'orchestrations/scripts')}"
AUTOMATION_DIR="${join(ROOT, 'orchestrations')}"
PROJECT_ROOT="/tmp"
VERIFICATION_FAILURE=""; DETERMINISTIC_CHECK_FAILURE=0

# Every collaborator succeeds by default; the one under test fails.
for _f in run_vendor_integrity_check _vendor_unlock run_dynamic_tools_in_unlocked_window \\
          run_dependency_check run_lockfile_sync_check run_relative_import_check \\
          run_named_import_check run_anti_pattern_check run_mock_completeness_check \\
          record_story_outputs verify_client_env_boundary; do
  eval "\${_f}() { return 0; }"
done
_project_repo_has_tests() { echo "true"; }
_project_test_command() { echo "true"; }   # a test command that trivially passes
_project_scoped_test_command() { echo "true"; }
_project_owned_test_files() { :; }
_project_dep_config_value() { echo ""; }
_project_install_command() { echo ""; }
_resolved_baseline_ref() { echo "HEAD"; }

${failing}() { VERIFICATION_FAILURE="the check under test failed"; DETERMINISTIC_CHECK_FAILURE=1; return 1; }

eval "\$(awk '/^run_external_verification\\(\\) \\{/,/^\\}/' "${CLAUDE_SH}")"
run_external_verification "STORY-1" /dev/null
echo "RC=\$?"
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const m = (r.stdout || '').match(/^RC=(\d+)$/m);
  if (!m) throw new Error(`harness produced no RC: ${r.stdout}\n${r.stderr}`);
  return Number(m[1]);
}

describe('run_external_verification propagates the checks it calls', () => {
  // These already propagate — they prove the harness can tell pass from fail.
  it.each([
    'run_relative_import_check',
    'run_named_import_check',
    'run_anti_pattern_check',
    'run_mock_completeness_check',
  ])('fails when %s fails', (fn) => {
    expect(verificationRc(fn), `${fn} is gated — if this is 0 the harness is broken`).not.toBe(0);
  });

  // These are the bare call sites.
  it('fails when run_lockfile_sync_check fails', () => {
    expect(verificationRc('run_lockfile_sync_check'),
      'the lockfile gate detected, delivered its message, and let the story complete').not.toBe(0);
  });

  it('fails when run_dependency_check fails', () => {
    expect(verificationRc('run_dependency_check'),
      'an undeclared import was reported six times live and never failed an attempt').not.toBe(0);
  });
});

describe('no deterministic check is invoked bare', () => {
  // The class, not the two sites: any check called for its verdict must have that verdict read.
  it('every run_*_check call inside run_external_verification is guarded', () => {
    const src = readFileSync(CLAUDE_SH, 'utf8');
    const fn = src.slice(src.indexOf('run_external_verification() {'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    const bare = body.split('\n')
      .map((l, i) => ({ l: l.trim(), n: i + 1 }))
      .filter(({ l }) => /^run_[a-z_]+_check "/.test(l))       // a call, not a definition
      .filter(({ l }) => !/^if ! /.test(l) && !/\|\||&&/.test(l));
    expect(bare.map((b) => b.l), 'called for a verdict nobody reads').toEqual([]);
  });
});
