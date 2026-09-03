// _provider_for_model() USED TO FALL BACK TO "claude" ON BOTH EXITS.
//
// TIER 2 in change-log/SEAM-CONSISTENCY-ANALYSIS.md: its result feeds invoke_agent
// --provider "$_provider", and invoke_agent's OWN arg parsing already omits the flag when the
// value is empty (`[ -n "$_provider" ] && _args+=(--provider "$_provider")`, agent-invoke.sh) —
// so an empty return here is safe, not a "worse than omitting" risk. Fixed to stop forcing a
// vendor literal that ignores the active set entirely.
//
// This test EXECUTES the real function extracted from the script.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/team-lead-review.sh'), 'utf8');

function fnText(name: string): string {
  const start = SRC.indexOf(`${name}() {`);
  if (start === -1) throw new Error(`${name}() not found`);
  const end = SRC.indexOf('\n}', start);
  return SRC.slice(start, end + 2);
}

function call(model: string, env: Record<string, string>) {
  const r = spawnSync('bash', ['-c', `${fnText('_provider_for_model')}\n_provider_for_model ${JSON.stringify(model)}`], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, EPAM_MODEL_PROVIDER_MAP: '', EPAM_ORCHESTRATION_PROVIDER: '', ...env },
  });
  return (r.stdout || '').trim();
}

describe('_provider_for_model — no vendor guess', () => {
  it('returns EMPTY when no map is declared and no override is set — not "claude"', () => {
    expect(call('any-model', {})).toBe('');
  });

  it('returns EMPTY when the map has no matching pattern — not "claude"', () => {
    expect(call('unmatched-model', { EPAM_MODEL_PROVIDER_MAP: 'MiniMax-*=minimax' })).toBe('');
  });

  it('respects an explicit EPAM_ORCHESTRATION_PROVIDER override when the map is empty', () => {
    expect(call('any-model', { EPAM_ORCHESTRATION_PROVIDER: 'openrouter' })).toBe('openrouter');
  });

  it('the map still wins when it has a real match', () => {
    expect(call('MiniMax-M3', { EPAM_MODEL_PROVIDER_MAP: 'MiniMax-*=minimax' })).toBe('minimax');
  });
});
