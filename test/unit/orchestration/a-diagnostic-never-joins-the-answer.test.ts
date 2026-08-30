/**
 * A DIAGNOSTIC MUST NOT BE ABLE TO CORRUPT THE THING IT IS DIAGNOSING.
 *
 * resolve_primary_provider announces when the environment names a provider the active set cannot
 * route. It printed that announcement to STDOUT — the same stream carrying its return value — so
 * the notice travelled with the answer.
 *
 * On the metrolinx run of 2026-08-30 the roster reviewer's reply came back as:
 *
 *     {"verdict":"defects_found","findings":[...]}
 *
 *       [provider] 'qwen' is not routable by the 'claude' set — using 'claude'.
 *
 * The extractor then saw two values instead of one, element [1] was not an object, and the run
 * died reporting "ROSTER_REVIEW[1]: expected an object, got object". Three specialiser attempts,
 * all three corrupted the same way, and the mint's own earlier failure — "no proposedAgents array"
 * on a payload that visibly had one — is the same class.
 *
 * The function's stdout is its answer. Everything else goes to stderr.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const HANDLER = path.join(__dirname, '../../../orchestrations/scripts/llm-handler.sh');

function resolve(env: Record<string, string>) {
  // llm-handler.sh is a SCRIPT, not a library: sourcing it runs it and it exits. So the function
  // is extracted and evaluated on its own, which is the pattern the rest of test/unit/orchestration
  // uses for shell functions.
  const script = `
    set -uo pipefail
    SCRIPT_DIR=${path.dirname(HANDLER)}
    eval "$(sed -n '/^resolve_primary_provider()/,/^}/p' "${HANDLER}")"
    resolve_primary_provider
  `;
  const r = spawnSync('bash', ['-c', script],
    { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30000 });
  return { out: r.stdout || '', err: r.stderr || '' };
}

describe('a diagnostic never joins the answer', () => {
  it('stdout carries the provider and nothing else, even when it substitutes', () => {
    // The exact condition from the run: the environment names a provider the set cannot route.
    const { out } = resolve({ EPAM_PROVIDER_SET: 'claude', EPAM_ORCHESTRATION_PROVIDER: 'qwen' });
    expect(out, 'the answer must not be empty; that would prove nothing').not.toBe('');
    expect(out, 'the notice must not travel with the answer').not.toContain('[provider]');
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(out.trim()).toMatch(/^[a-z0-9-]+$/);
  });

  it('still SAYS it substituted — on stderr, where it cannot corrupt a reply', () => {
    const { err } = resolve({ EPAM_PROVIDER_SET: 'claude', EPAM_ORCHESTRATION_PROVIDER: 'qwen' });
    expect(err, 'silently substituting a provider would be worse than the corruption').toContain('[provider]');
  });

  it('says nothing at all when no substitution is needed', () => {
    const { out, err } = resolve({ EPAM_PROVIDER_SET: 'claude', EPAM_ORCHESTRATION_PROVIDER: '' });
    expect(out).not.toContain('[provider]');
    expect(err).not.toContain('[provider]');
  });
});
