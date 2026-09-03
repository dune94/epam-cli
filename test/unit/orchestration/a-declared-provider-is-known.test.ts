/**
 * A PROVIDER THE ENGINE ACCEPTS MUST BE ONE PREFLIGHT KNOWS.
 *
 * `provider_to_cli()` (claude.sh) and `run-agent-orchestration.sh` both accept
 * `codemie-claude`, and its wrapper is installed. `config/providers.json` does NOT list it, so
 * preflight would REJECT a PRD assigning the very provider two call sites are happy to run.
 *
 * A gate that refuses what the engine accepts is not stricter — it is inconsistent, and it
 * fails at the worst moment: after the PRD is written and the run is launched.
 *
 * This asserts the two lists agree, derived from the code rather than hand-listed, so a
 * provider added to one and forgotten in the other fails HERE rather than mid-run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');
const providers = JSON.parse(readFileSync(join(ROOT, 'orchestrations/config/providers.json'), 'utf8'));
const claudeSrc = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');

/**
 * The providers the engine ADVERTISES — read from providers.json's own `cliBinary`, which is
 * now provider_to_cli()'s (claude.sh) single declared source
 * (change-log/SEAM-CONSISTENCY-ANALYSIS.md Section 5 removed the hardcoded `case` statement this
 * used to scrape the error message of).
 *
 * `epam` is deliberately absent from `cliBinary`: it named the RUNNER ($EPAM_CLI), not a vendor,
 * nothing assigns it, and the engine does not advertise it.
 */
function acceptedByEngine(): string[] {
  expect(claudeSrc, 'provider_to_cli is gone — this test would assert nothing').toMatch(/provider_to_cli\(\)\s*{/);
  return Object.keys(providers.cliBinary || {});
}

describe('a declared provider is known', () => {
  it('the engine accepts a non-trivial set — otherwise this passes vacuously', () => {
    expect(acceptedByEngine().length).toBeGreaterThan(3);
  });

  it('known advertises NO provider the engine would reject — no ghosts', () => {
    // The inverse drift, and the more dangerous direction. A ghost entry lets a PRD through the
    // GATE and fails it at RUNTIME — after the PRD is written and the run has started.
    // `anthropic`, `claude` and `gemini` were listed with no case arm at all;
    // brownfield-test-prd.json already assigned "claude" and would have died mid-run.
    const ghosts = providers.known.filter((p: string) => !acceptedByEngine().includes(p));
    expect(ghosts, 'listed in the gate, rejected by the engine').toEqual([]);
  });

  it('every provider the engine ACCEPTS is listed in providers.json known', () => {
    const missing = acceptedByEngine().filter((p) => !providers.known.includes(p));
    expect(missing,
      'preflight would reject a PRD assigning a provider the engine is happy to run')
      .toEqual([]);
  });
});
