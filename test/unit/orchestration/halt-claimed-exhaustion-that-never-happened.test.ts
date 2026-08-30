// THE HALT CLAIMED RECOVERY WAS EXHAUSTED WHEN 10 OF 12 ATTEMPTS REMAINED.
//
// Live metrolinx AMSD-2041, 2026-08-19. A gate failed one story at attempt 2/12 and the run ended:
//
//   [ERROR] Phase 'core': 1 story/stories failed — aborting phase
//   [ERROR] [orch] HALT: codeline 'metrolinx' failed after its retries and self-heal completed.
//   [ERROR] [orch]   Not starting the remaining codeline(s) — recovery is exhausted, so
//   [ERROR] [orch]   another lane would reproduce the same failure at full ladder price.
//
// None of that was true. Two attempts had been used, the ladder had not advanced past its first
// rung, and the writer was mid-way through addressing the reviewer's findings. The message is not
// cosmetic: it is the evidence an operator reads when deciding whether to retry, and it says the
// opposite of the truth. It convinced me to stop recommending continuation.
//
// HALTING ITSELF IS CORRECT — the standing mandate is let recovery run, then HALT. What must not
// happen is ASSERTING exhaustion without checking. story_ladder_exhausted() already exists and is
// used elsewhere in this same file; the halt simply never asked it.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../..');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');
// _halt_recovery_state now lives in lib/halt-recovery.sh — lifted out of the 11k-line
// orchestrator so the message an operator acts on can be executed by a test. Sourced whole
// rather than sliced out by pattern, which is also more faithful than slicing was.
const HALT_LIB = join(ROOT, 'orchestrations/scripts/lib/halt-recovery.sh');
const RETRY_LIB = join(ROOT, 'orchestrations/scripts/lib/story-retry-state.sh');
const made: string[] = [];

/** Runs the REAL halt-reporting function with a given persisted retry state. */
function haltMessage(opts: { retryCount: number; maxRetries: number }): string {
  const logDir = mkdtempSync(join(tmpdir(), 'halt-')); made.push(logDir);
  mkdirSync(join(logDir, 'story-retry-state'), { recursive: true });
  writeFileSync(join(logDir, 'story-retry-state', 'S-1.count'), String(opts.retryCount));
  const script = `
set +e
error() { echo "ERR: $*"; }
warning() { echo "WARN: $*"; }
LOG_DIR=${JSON.stringify(logDir)}
MAX_RETRIES=${opts.maxRetries}
. ${JSON.stringify(RETRY_LIB)}
    . ${JSON.stringify(HALT_LIB)}
if ! declare -F _halt_recovery_state >/dev/null 2>&1; then echo "NOFUNC"; exit 0; fi
_halt_recovery_state "S-1"
`;
  return (spawnSync('bash', ['-c', script], { encoding: 'utf8' }).stdout || '').trim();
}

describe('the halt reports the recovery state it actually observed', () => {
  it('says retries REMAIN when they do — the live case, 2 of 12 used', () => {
    const out = haltMessage({ retryCount: 2, maxRetries: 11 });
    // The word appears either way — what matters is which CLAIM is made.
    expect(out, 'claimed exhaustion with 10 attempts left; this is what stopped a converging run')
      .toMatch(/NOT exhausted/i);
    expect(out, 'the operator cannot see how much budget was left').toMatch(/2 of 12/);
    expect(out, 'does not say the failure came from a gate rather than from running out')
      .toMatch(/gate verdict/i);
  });

  it('says EXHAUSTED only when the ladder really is', () => {
    const out = haltMessage({ retryCount: 11, maxRetries: 11 });
    expect(out, 'a genuinely exhausted run must say so — halting is the mandate')
      .toMatch(/recovery is exhausted/i);
    expect(out, 'an exhausted run must not read as recoverable').not.toMatch(/NOT exhausted/i);
  });

  it('a fresh story with no retries used never reads as exhausted', () => {
    expect(haltMessage({ retryCount: 0, maxRetries: 11 })).toMatch(/NOT exhausted/i);
  });
});

// The phase abort is the other half. It counts failures and exits, saying nothing about whether
// the budget was spent — so the halt below it had nothing truthful to inherit. Halting on a failed
// story is correct; reporting it as terminal without saying why is what misleads.
describe('the phase abort states what failed and how much budget remained', () => {
  it('names the recovery state rather than only the count', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src: string = require('node:fs').readFileSync(ORCH, 'utf8');
    const i = src.indexOf("story/stories failed — aborting phase");
    expect(i, 'the abort site moved; this test is stale').toBeGreaterThan(0);
    const around = src.slice(Math.max(0, i - 400), i + 400);
    expect(around, 'the abort reports a bare count, so an operator cannot tell a gate verdict from an exhausted ladder')
      .toMatch(/_halt_recovery_state|recovery/i);
  });
});
