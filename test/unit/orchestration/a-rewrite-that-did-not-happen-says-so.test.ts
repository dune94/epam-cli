/**
 * A REWRITE THAT DID NOT HAPPEN MUST NOT LOOK LIKE ONE THAT DID.
 *
 * run_prd_change_summarizer rewrites text a reviewer rejected, so the next attempt does not carry
 * the rejected content forward. It began:
 *
 *     local gate_provider="${ORCH_GATE_PROVIDER:-}"
 *     if [ -z "$gate_provider" ]; then
 *         printf '%s' "$rejected_text"
 *         return 0
 *     fi
 *
 * With that variable unset it returns the REJECTED TEXT UNCHANGED, exit 0, silently. The caller
 * takes the result as the rewritten value — `current=$(run_prd_change_summarizer ...)` — so the
 * content that was just rejected flows on as if it had been fixed.
 *
 * It is also the only member of its family resolving a provider that way: ac-gate, discovery and
 * cpa-inference all fall back to EPAM_ORCHESTRATION_PROVIDER before giving up. So a run that sets
 * the orchestration provider but not the gate provider silently loses every rewrite.
 *
 * Skipping is allowed. Skipping SILENTLY is not: the caller cannot tell the two apart, and neither
 * can an operator reading the log.
 *
 * The function is spliced out of claude.sh and executed, so this tests what actually runs.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const CLAUDE_SH = join(REPO, 'orchestrations/scripts/claude.sh');

/** The function as it actually is, taken from the file rather than retyped. */
function functionBody(): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const start = src.indexOf('run_prd_change_summarizer() {');
  expect(start, 'run_prd_change_summarizer is gone — the shape has changed').toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  return src.slice(start, end + 2);
}

/** Run it with no gate provider configured, and report what a caller would see. */
function runWithNoGateProvider(env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', `
    error() { echo "$*" >&2; }
    ${functionBody()}
    run_prd_change_summarizer "S-1" "ac_change" "too vague" "THE REJECTED TEXT"
  `], {
    encoding: 'utf8', timeout: 60000, cwd: REPO,
    env: { ...process.env, ORCH_GATE_PROVIDER: '', ...env },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('a rewrite that did not happen does not look like one that did', () => {
  it('the function is reachable, so the assertions below mean something', () => {
    expect(functionBody(), 'the spliced body is not the summarizer')
      .toContain('run_prd_change_summarizer');
  });

  it('says so when it cannot summarise, instead of returning the rejected text in silence', () => {
    const r = runWithNoGateProvider();
    expect(r.stderr.trim().length,
      'it returned the rejected text with NO diagnostic — the caller records a rewrite that never '
      + 'happened, and the rejected content flows on').toBeGreaterThan(0);
    expect(r.stderr, 'the message does not say the rewrite was skipped')
      .toMatch(/skip|not rewritten|no provider|summaris|summariz/i);
  }, 60_000);

  it('and still returns the original text, so the caller is not left with nothing', () => {
    // Degrading is the right behaviour; the defect was doing it quietly. The value must survive.
    const r = runWithNoGateProvider();
    expect(r.stdout, 'the caller was left with no text at all').toContain('THE REJECTED TEXT');
  }, 60_000);

  it('resolves a provider the way the rest of its family does', () => {
    // ac-gate, codeline-discovery and cpa-inference all consult EPAM_ORCHESTRATION_PROVIDER before
    // giving up. This one did not, so a run setting only that variable lost every rewrite.
    // Asserted positively: with an orchestration provider configured it must get PAST the
    // give-up branch entirely. The earlier form only checked that one phrase was absent, which
    // passed while the function was still short-circuiting.
    const r = runWithNoGateProvider({ EPAM_ORCHESTRATION_PROVIDER: 'claude' });
    expect(r.stderr, 'an orchestration provider was configured and it still skipped the rewrite')
      .not.toMatch(/skipping the rewrite/i);
  }, 60_000);
});
