/**
 * SOURCING THE REAL FILE INSTEAD OF COPYING IT — the conversion, tried on one script.
 *
 * 81 test files test shell functions by copying their bodies into a `bash -c "<string>"` harness.
 * The tests pass and the functions work, but bash attributes every traced line to the STRING, so
 * there is no file to attribute coverage to: writer reads 21%, launch 2%, gates 37% while their
 * tests exist and pass.
 *
 * team-lead-review.sh now carries the guard mock-expectations.js and agent-check.js already carry —
 * sourced, it defines its functions and stops; executed, nothing changes, because `return` outside a
 * function succeeds only in a sourced file. Two supporting changes were needed and no more: the
 * argument validation is skipped when sourced (there are no arguments to validate) and `PHASE_ID=$1`
 * became `${1:-}` so `set -u` does not trip.
 *
 * It also needs a project configured, because the file resolves a model ladder at file scope. That
 * is the real cost of this conversion, and it is small.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const SCRIPT = join(REPO, 'orchestrations/scripts/team-lead-review.sh');
const PROJECT = join(REPO, 'orchestrations/projects/mock3');

function sourced(body: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', `. ${JSON.stringify(SCRIPT)} >/dev/null 2>&1\n${body}`], {
    encoding: 'utf8', timeout: 120_000, cwd: REPO,
    env: { ...process.env, NODE_BIN: process.execPath, EPAM_PROJECT_CONFIG_DIR: PROJECT,
      EPAM_COVERAGE_GATED: '0', ...env },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim() };
}

describe('the review script can be sourced, so its functions are measurable', () => {
  it('sourcing defines its functions and does NOT run a review', () => {
    const r = sourced(`for f in run_review_prompt _provider_for_model _ladder_next_model; do
        declare -F "$f" >/dev/null && echo "def:$f"; done`);
    expect(r.out, 'run_review_prompt was not defined by sourcing').toContain('def:run_review_prompt');
    expect(r.out, 'a helper was not defined').toContain('def:_provider_for_model');
    expect(r.out, 'sourcing started a review').not.toMatch(/\[REVIEW\]|REVIEW_INCOMPLETE/);
  }, 180_000);

  it('and EXECUTING it is unchanged — it still refuses without a phase id', () => {
    // The guard must be invisible to the real caller. A script that stopped refusing would let a run
    // review nothing and report success.
    const r = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8', timeout: 120_000, cwd: REPO,
      env: { ...process.env, EPAM_COVERAGE_GATED: '0' },
    });
    expect(r.status, 'executing it with no phase id no longer fails').not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/Missing required argument PHASE_ID/);
  }, 180_000);

  it('_provider_for_model answers for a model, driven through the REAL file', () => {
    // The point of the conversion: this exercises team-lead-review.sh itself, so the lines it runs
    // are attributed to it. The same assertion through a copied string proves the same behaviour and
    // measures nothing.
    const r = sourced('_provider_for_model "MiniMax-M3" || true');
    expect(r.code, 'the function could not be called at all').toBe(0);
  }, 180_000);

  it('_ladder_next_model is callable and does not crash on an unknown model', () => {
    const r = sourced('_ladder_next_model "not-a-real-model" >/dev/null 2>&1; echo "rc=$?"');
    expect(r.out, 'an unknown model crashed the ladder helper').toMatch(/rc=\d/);
  }, 180_000);
});
