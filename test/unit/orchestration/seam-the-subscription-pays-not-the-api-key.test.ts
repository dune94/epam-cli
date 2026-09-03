/**
 * THE SUBSCRIPTION PAYS. That is the entire reason this pipeline shells out to the Claude CLI
 * instead of calling the SDK.
 *
 * Found live, 2026-08-26: run 11 died on its first call with
 *   "No JSON in LLM response: Credit balance is too low"
 * A subscription has no credit balance. An API account does. The repo `.env` declares
 * ANTHROPIC_API_KEY, run-agent-orchestration.sh loads `.env`, and Claude Code PREFERS
 * ANTHROPIC_API_KEY over the OAuth credentials at ~/.claude/.credentials.json — so every run on
 * this stack had been billing API credits. Seven of them. It surfaced only when the credits ran
 * out and the vendor said so out loud; nothing in the pipeline was watching, because nobody
 * expected the key to be present at all. The free-run guard scrubs credentials only when a run
 * is declared FREE; a PAID run on the claude stack had no equivalent.
 *
 * The fix is a DECLARATION, not engine code: the claude runner declares `unsetEnv`, and the
 * existing apply_runner_settings — already called by both spawn seams (claude.sh's
 * implement_story and the hub's vendor arm) before the CLI is launched — takes those variables
 * away.
 *
 * WHY PER-RUNNER AND NOT A GLOBAL SCRUB, which is the trap this test exists to hold shut:
 *   - openrouter NEEDS its key. Scrub globally and that stack stops working.
 *   - a MOCK run needs its FAKE key (ANTHROPIC_API_KEY=sk-mock-not-real). Take that away and
 *     Claude Code falls back to the OAuth credentials on disk and spends REAL money — the exact
 *     inversion of the bug being fixed, and a failure mode already recorded on 2026-08-25 when a
 *     run labelled `mockserver` reached a real vendor endpoint.
 *
 * Tested at the RECEIVER: the real shell function is executed and the CHILD process environment
 * is read back, because "did we call unset" is not the question — "can the runner still see the
 * credential" is.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const RUNNER_SETTINGS = join(REPO_ROOT, 'orchestrations/scripts/lib/runner-settings.sh');

/**
 * Runs the REAL apply_runner_settings under the given provider set with the given variables
 * present, then reports what a CHILD process — which is what the runner is — can still read.
 */
function childEnvAfterApply(providerSet: string, preset: Record<string, string>): Record<string, string> {
  const sets = Object.entries(preset)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join('\n');
  const names = Object.keys(preset);
  const script = `
    set -u
    . ${JSON.stringify(RUNNER_SETTINGS)}
    export EPAM_PROVIDER_SET=${JSON.stringify(providerSet)}
    ${sets}
    RUNNER_FLAGS=()
    apply_runner_settings claude ""
    # A CHILD, not this shell: the runner is a separate process, so what it inherits is the
    # only thing that decides who gets billed.
    ${names.map((n) => `printenv ${n} >/dev/null 2>&1 && echo "${n}=$(printenv ${n})" || echo "${n}=<absent>"`).join('\n')}
  `;
  const out = execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, NODE_BIN: process.execPath },
  });
  return Object.fromEntries(
    out.trim().split('\n').filter(Boolean).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
  );
}

describe('the claude stack bills the subscription, not an API key', () => {
  it('the runner DECLARES the credentials it must not see (config, not engine code)', () => {
    const defaults = JSON.parse(
      readFileSync(join(REPO_ROOT, 'orchestrations/config/llm-defaults.claude.json'), 'utf8'),
    );
    expect(defaults.runners?.claude?.unsetEnv).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']),
    );
  });

  it('REPRODUCES run 11: with the key present, the runner no longer inherits it', () => {
    const child = childEnvAfterApply('claude', {
      ANTHROPIC_API_KEY: 'sk-ant-REAL-BILLING-KEY',
      ANTHROPIC_AUTH_TOKEN: 'tok-real',
    });
    expect(child.ANTHROPIC_API_KEY, 'the API key still reaches the runner — the API account pays')
      .toBe('<absent>');
    expect(child.ANTHROPIC_AUTH_TOKEN).toBe('<absent>');
  });

  it('leaves the openrouter stack untouched — that stack needs its key', () => {
    const child = childEnvAfterApply('openrouter', { ANTHROPIC_API_KEY: 'sk-ant-REAL-BILLING-KEY' });
    expect(child.ANTHROPIC_API_KEY).toBe('sk-ant-REAL-BILLING-KEY');
  });

  it('leaves a MOCK run its fake key — removing it would fall back to OAuth and spend real money', () => {
    const child = childEnvAfterApply('mockserver', { ANTHROPIC_API_KEY: 'sk-mock-not-real' });
    expect(
      child.ANTHROPIC_API_KEY,
      'the mock key was scrubbed: Claude Code will now use ~/.claude/.credentials.json and bill for real',
    ).toBe('sk-mock-not-real');
  });

  it('does not scrub indiscriminately — an unrelated variable survives on the claude stack', () => {
    // Guards against "fix" by blanket-wiping the environment, which would take the run's own
    // budget and routing settings with it.
    const child = childEnvAfterApply('claude', {
      ANTHROPIC_API_KEY: 'sk-ant-REAL-BILLING-KEY',
      EPAM_MAX_TOOL_CALLS: '40',
    });
    expect(child.ANTHROPIC_API_KEY).toBe('<absent>');
    expect(child.EPAM_MAX_TOOL_CALLS).toBe('40');
  });

  it('both spawn seams take the credential away BEFORE launching the CLI', () => {
    // The declaration is only worth anything if it is applied on every path that starts the
    // runner. Asserted as ordering, since a call placed after the spawn would read as wired.
    const hub = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/llm-handler.sh'), 'utf8');
    expect(hub.indexOf('apply_runner_settings'))
      .toBeLessThan(hub.indexOf('"$CLAUDE_CMD" --print'));

    const claudeSh = readFileSync(join(REPO_ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
    const applyAt = claudeSh.indexOf('apply_runner_settings "$(basename "${CLAUDE_CMD:-}")"');
    expect(applyAt, 'implement_story no longer applies the runner declaration').toBeGreaterThan(0);
    expect(applyAt).toBeLessThan(claudeSh.indexOf('"$CLAUDE_CMD" --print --output-format json'));
  });
});
