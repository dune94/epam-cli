/**
 * THE ANALYST'S RULING ON A DETERMINISTIC CHECK STANDS.
 *
 * AMSD-2974 run 9, resume 4 (2026-10-11): the dependency scan flagged `react` in a file outside the story's diff (a
 * peer dependency of the library). The failure analyst ruled it exactly — "Target=environment — the flagged file and
 * claimed missing dependency are both unrelated to this story's diff and already satisfied" — and the pipeline aborted
 * the writer at max rung anyway: the repeat detector had already set HealingBroken, nothing read the ruling, and the
 * same finding failed every next attempt. Operator: agents judge; no gates.
 *
 * EXECUTED: analyst_ruled_environmental (lib/failure-healing.sh) with the real same_root_cause_diagnoses, and the
 * verification decision block lifted from lib/story-attempt.sh, with run 9's actual finding as the violation.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shellFunction } from '../../lib/engine-source';

const S = join(__dirname, '../../../orchestrations/scripts');
const SA = readFileSync(join(S, 'lib/story-attempt.sh'), 'utf8');

/** A whole shell function, its end found by parsing (lib/engine-source) — some carry heredocs with `}` lines. */
const fn = (file: string, name: string) => shellFunction(join(S, file), name);
/** same_root_cause_diagnoses embeds a Python block whose own `}` lines end any brace/parse-based cut early; it ends
 *  at the `}` after its PYEOF terminator. */
const sameRootCause = (() => {
  const src = readFileSync(join(S, 'lib/failure-healing.sh'), 'utf8');
  const start = src.indexOf('same_root_cause_diagnoses() {');
  const term = src.indexOf('\nPYEOF\n', start);
  if (start < 0 || term < 0) throw new Error('same_root_cause_diagnoses not found — the harness is stale');
  return src.slice(start, src.indexOf('\n}', term) + 2);
})();
const DECISION = (() => {
  const start = SA.indexOf('        if [ "$invoke_success" = true ] && ! run_external_verification "$story_id" "$output_file"; then');
  const end = SA.indexOf('\n        fi\n', start) + '\n        fi\n'.length;
  if (start < 0) throw new Error('the verification decision block was not found — the harness is stale');
  return SA.slice(start, end);
})();

const finding = (detail: string) => `\n## Verification Failure\n\nThe dependency scan failed:\n\n${detail}`;
const RUN9 = finding('imported but NOT DECLARED (present in a vendor dir only): react\tsrc/components/AboutPresto/AboutPresto.tsx');
const OTHER = finding('imported but NOT DECLARED (present in a vendor dir only): lodash-es\tsrc/components/ToastNotification/Toast.tsx');

function decide(opts: { ruled?: string; current: string; deterministic?: boolean }) {
  const script = [
    'set -uo pipefail',
    'log(){ :; }; warning(){ printf "WARN %s\\n" "$*"; }',
    sameRootCause,
    fn('lib/failure-healing.sh', 'analyst_ruled_environmental'),
    // The verification itself, standing in: it fails with the given finding, as a deterministic check does.
    `run_external_verification(){ VERIFICATION_FAILURE=${JSON.stringify(opts.current)}; DETERMINISTIC_CHECK_FAILURE=${opts.deterministic === false ? 0 : 1}; export VERIFICATION_FAILURE DETERMINISTIC_CHECK_FAILURE; return 1; }`,
    opts.ruled ? `export ANALYST_RULED_ENVIRONMENTAL=${JSON.stringify(opts.ruled)}` : 'unset ANALYST_RULED_ENVIRONMENTAL',
    'invoke_success=true; story_id=S-1; output_file=/dev/null; story_cli=writer',
    'attempt(){', DECISION, '}', 'attempt',
    'printf "SUCCESS=%s\\n" "$invoke_success"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  return { success: (out.match(/SUCCESS=(\w+)/) || [])[1], out };
}

describe('the analyst\'s ruling on a deterministic check stands', () => {
  it('the same finding the analyst ruled environmental does not fail the writer again', () => {
    const r = decide({ ruled: RUN9, current: RUN9 });
    expect(r.success, r.out).toBe('true');
    expect(r.out).toMatch(/overruled by the failure analyst's ruling/);
  });

  it('a DIFFERENT finding is not covered by the ruling — it fails as before', () => {
    expect(decide({ ruled: RUN9, current: OTHER }).success).toBe('false');
  });

  it('with no ruling, a deterministic failure fails as before', () => {
    expect(decide({ current: RUN9 }).success).toBe('false');
  });

  it('a ruling on a deterministic check does not excuse a failure that is not deterministic (a real test failure)', () => {
    expect(decide({ ruled: RUN9, current: RUN9, deterministic: false }).success).toBe('false');
  });
});
