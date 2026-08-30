/**
 * A GATE THAT CANNOT JUDGE DOES NOT PASS — INCLUDING WHEN IT NEVER RAN.
 *
 * run_prd_change_reviewer() guards every KB, PRD and profile write. With no gate provider
 * configured it did this:
 *
 *     if [ -z "$gate_provider" ]; then
 *         echo "pass"
 *         return 0
 *     fi
 *
 * It MANUFACTURED a passing verdict. Every persistent write was auto-approved, and the caller read
 * that "pass" as a real judgement — indistinguishable from a review that ran and found nothing
 * wrong. The repository already holds a test named for this exact principle.
 *
 * Two siblings had the softer form of it: assess_model_escalation() returned silently, and
 * run_retry_extension_coordinator() echoed 0 — a plausible "no extension warranted" that nobody
 * had decided. A value arriving where a decision is expected, with no decision behind it.
 *
 * The functions are spliced out of claude.sh and EXECUTED, so this asserts what runs.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../..');
const CLAUDE_SH = join(REPO, 'orchestrations/scripts/claude.sh');
const src = () => readFileSync(CLAUDE_SH, 'utf8');

/** One shell function, taken from the file rather than retyped. */
function fn(name: string): string {
  const s = src();
  const start = s.indexOf(`${name}() {`);
  expect(start, `${name} is gone — the shape has changed`).toBeGreaterThan(-1);
  const end = s.indexOf('\n}', start);
  return s.slice(start, end + 2);
}

/** Run a function with no gate provider, and report what a caller would see. */
function runNoGate(name: string, call: string) {
  const r = spawnSync('bash', ['-c', `
    log() { echo "$*"; }
    error() { echo "$*" >&2; }
    # Helpers the spliced function calls that live elsewhere in claude.sh. Stubbed with a VALID
    # answer, so the function reaches the branch under test instead of returning on a missing
    # dependency — which would make the assertion measure the stub, not the gate.
    compute_retry_extension_evidence() { echo '{"attempts":2,"signals":["tests_failing"]}'; }
    ${fn(name)}
    ${call}
  `], {
    encoding: 'utf8', timeout: 60000, cwd: REPO,
    env: {
      ...process.env, ORCH_GATE_PROVIDER: '', EPAM_MODEL: '',
      // These functions have their own feature switches ahead of the provider check. Without them
      // the function returns before reaching the branch under test — and the assertion would then
      // be measuring a disabled feature, not a silent skip.
      EPAM_MODEL_COORDINATOR_ENABLED: '1',
      EPAM_RETRY_EXTENSION_ENABLED: '1',
    },
  });
  return { stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), code: r.status ?? -1 };
}

describe('a gate that cannot judge does not pass', () => {
  it('the reviewer never returns a verdict it did not reach', () => {
    const r = runNoGate('run_prd_change_reviewer',
      'run_prd_change_reviewer "S-1" "ac_change" "before" "after" 2>/dev/null || true');
    expect(r.stdout, 'the reviewer emitted "pass" without reviewing anything — every KB, PRD and '
      + 'profile write is auto-approved and the caller cannot tell').not.toBe('pass');
  }, 60_000);

  it('and what it does return is a verdict the callers treat as not-approved', () => {
    // reviewOutcomeKeepsChange() accepts only an explicit pass, so this must not be a word that
    // slips through as approval.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const { reviewOutcomeKeepsChange } = require(join(REPO, 'orchestrations/scripts/spec-mode-runner.js'));
    const r = runNoGate('run_prd_change_reviewer',
      'run_prd_change_reviewer "S-1" "ac_change" "before" "after" 2>/dev/null || true');
    expect(reviewOutcomeKeepsChange(r.stdout),
      `the verdict '${r.stdout}' would let an unreviewed change stand`).toBe(false);
  }, 60_000);

  it('it says out loud that it is not reviewing', () => {
    const r = runNoGate('run_prd_change_reviewer',
      'run_prd_change_reviewer "S-1" "ac_change" "before" "after" || true');
    expect(`${r.stdout}\n${r.stderr}`, 'it declined to review and said nothing')
      .toMatch(/NOT reviewing|no gate provider/i);
  }, 60_000);

  it('the escalation assessment announces that it did not run', () => {
    const r = runNoGate('assess_model_escalation', 'assess_model_escalation "S-1" "" "" || true');
    expect(`${r.stdout}\n${r.stderr}`, 'it skipped silently').toMatch(/SKIPPING/i);
  }, 60_000);

  it('and a returned 0 says it was not decided', () => {
    // The subtlest of the three: 0 is a believable answer, so the log has to distinguish "none was
    // warranted" from "nobody looked".
    const r = runNoGate('run_retry_extension_coordinator',
      'run_retry_extension_coordinator "S-1" "1" "" || true');
    expect(`${r.stdout}\n${r.stderr}`, 'it returned 0 with no word that nothing was decided')
      .toMatch(/SKIPPING|not DECIDED|not decided/i);
  }, 60_000);

  it('no gate in this file still hands back a bare "pass" when it cannot run', () => {
    // The class. A fabricated verdict is worse than a refusal, and this is where it hid.
    const offenders: string[] = [];
    const lines = src().split('\n');
    lines.forEach((l, i) => {
      if (!/^\s*echo "pass"\s*$/.test(l)) return;
      const before = lines.slice(Math.max(0, i - 6), i).join('\n');
      if (/-z "\$gate_provider"|-z "\$\{ORCH_GATE_PROVIDER/.test(before)) {
        offenders.push(`claude.sh:${i + 1}`);
      }
    });
    expect(offenders, 'these emit a passing verdict because no provider was configured').toEqual([]);
  });
});
