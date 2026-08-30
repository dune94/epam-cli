/**
 * REPRODUCTION FIRST — THIS TEST EXISTS TO PROVE A DIAGNOSIS BEFORE ANY FIX IS WRITTEN.
 *
 * Claim under test: llm-handler.sh resolves the provider from the active set at line 68, and then
 * parses `--provider` at line 132, so a flag built from a stale environment OVERWRITES the set's
 * decision. The substitution notice is printed and the routing is unchanged.
 *
 * If that is true, a call under EPAM_PROVIDER_SET=claude carrying `--provider openrouter` ends up on
 * openrouter. That is what the roster specialiser log shows, three paid runs running:
 *
 *   [provider] 'openrouter' is not routable by the 'claude' set — using 'claude'.
 *   [ai-run] provider 'openrouter' returned NO completion record — treating as FAILURE
 *   [ai-run] 'roster-specialiser' failed after 3 attempt(s)
 *
 * The notice says claude; the failure names openrouter. If this test does not reproduce that, the
 * diagnosis is wrong and no fix should be written on the strength of it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const HANDLER = join(__dirname, '../../orchestrations/scripts/llm-handler.sh');
const SCRIPTS = join(__dirname, '../../orchestrations/scripts');

/**
 * Reproduce the handler's own sequence: resolve from the set, then parse args exactly as the
 * script does, and report which provider the call would actually use.
 */
function effectiveProvider(args: string[], env: Record<string, string>) {
  const script = `
    set -uo pipefail
    SCRIPT_DIR=${JSON.stringify(SCRIPTS)}
    eval "$(sed -n '/^resolve_primary_provider()/,/^}/p' ${JSON.stringify(HANDLER)})"
    PRIMARY_PROVIDER="$(resolve_primary_provider 2>/dev/null)"
    # THE SCRIPT'S OWN LINES, not a re-implementation of them. Re-implementing the argument loop
    # here is how the first version of this test could never have validated any fix: it exercised a
    # copy. Everything from the argument loop to the end of the set-authority block is taken from
    # llm-handler.sh itself, so what runs is what ships.
    eval "$(sed -n '/^while \[\[ \$# -gt 0 \]\]; do/,/^fi$/p' ${JSON.stringify(HANDLER)})"
    printf '%s' "$PRIMARY_PROVIDER"
  `;
  const r = spawnSync('bash', ['-c', script, '--', ...args],
    { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000 });
  return (r.stdout || '').trim();
}

describe('the set outranks the provider flag', () => {
  it('the harness resolves something at all — otherwise nothing below means anything', () => {
    const p = effectiveProvider([], { EPAM_PROVIDER_SET: 'claude', EPAM_ORCHESTRATION_PROVIDER: '' });
    expect(p).not.toBe('');
  });

  it('REPRODUCES: a --provider flag from a stale env survives the claude set', () => {
    // This is the assertion that proves the diagnosis. It is written to FAIL once the set is made
    // to outrank the flag — at which point it becomes the regression guard.
    const used = effectiveProvider(['--provider', 'openrouter'],
      { EPAM_PROVIDER_SET: 'claude', EPAM_ORCHESTRATION_PROVIDER: 'openrouter' });
    expect(used, 'the set was honoured after all — the diagnosis is wrong, do not fix on it')
      .toBe('claude');
  });

  it('with no flag, the set already wins — so the flag is the whole difference', () => {
    const used = effectiveProvider([],
      { EPAM_PROVIDER_SET: 'claude', EPAM_ORCHESTRATION_PROVIDER: 'openrouter' });
    expect(used).toBe('claude');
  });
});
