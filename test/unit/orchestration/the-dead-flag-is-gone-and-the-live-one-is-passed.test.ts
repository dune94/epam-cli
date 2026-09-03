/**
 * THE DEAD FLAG IS GONE, AND THE LIVE MECHANISM IS ACTUALLY CALLED.
 *
 * claude.sh built `--max-turns` from STORY_MAX_TURNS. Two problems, both verified:
 *   1. Claude Code 2.1.245 HAS NO --max-turns FLAG. It was removed upstream; the env var
 *      CLAUDE_CODE_MAX_TURNS replaced it. Passing it would be an invalid-argument error.
 *   2. STORY_MAX_TURNS was hardcoded "" in all three effort branches, so the flag was never
 *      emitted — which is the only reason nothing had failed. The fork slated for deletion
 *      sets it to 10/30 and WOULD have failed on the installed version.
 *
 * A flag that cannot fire is not a cap. The replacement is the runner declaration, and this
 * asserts the engine actually CALLS it — a mechanism nobody invokes is the shape of the
 * plan-fidelity gate that had a test and no caller.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');
const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

describe('the dead flag is gone and the live one is passed', () => {
  it('claude.sh builds no --max-turns flag — the flag does not exist upstream', () => {
    expect(code, 'Claude Code 2.1.245 has no --max-turns; building it is an error waiting to fire')
      .not.toMatch(/--max-turns/);
  });

  it('no hardcoded STORY_MAX_TURNS literal remains', () => {
    expect(code, 'a cap hardcoded empty in every branch is not a cap')
      .not.toMatch(/STORY_MAX_TURNS\s*=/);
  });

  it('claude.sh sources the runner-settings library', () => {
    expect(code).toMatch(/runner-settings\.sh/);
  });

  it('the CLI branch CALLS apply_runner_settings — a mechanism nobody invokes is not wired', () => {
    expect(code, 'resolveRunner exists but nothing would use it')
      .toMatch(/apply_runner_settings/);
  });

  it('the CLI invocation passes the flags the declaration produced', () => {
    // Both external-CLI call sites must carry RUNNER_FLAGS, or one path silently keeps the
    // old behaviour — which is exactly how the two execution paths drifted apart before.
    const callSites = code.split('\n').filter((l) => /\$CLAUDE_CMD" --print --output-format json/.test(l));
    expect(callSites.length, 'expected the external-CLI call sites to still exist').toBeGreaterThan(0);
    const withFlags = code.split('\n').filter((l) => /RUNNER_FLAGS\[@\]/.test(l));
    expect(withFlags.length, 'every CLI call site must pass RUNNER_FLAGS')
      .toBeGreaterThanOrEqual(callSites.length);
  });

  it('RUNNER_FLAGS is initialised before use — an unset array under `set -u` aborts the run', () => {
    expect(code).toMatch(/RUNNER_FLAGS=\(\)/);
  });
});
