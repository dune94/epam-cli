// TC GENERATION WAS SILENTLY DISABLED BY AN EMPTY PHASE, AND REPORTED SUCCESS.
//
// Live metrolinx AMSD-2041, 2026-08-18, on every invocation:
//   [tc-writer] Generating TCs for phase 'unknown' (post-impl, pre-test)...
//   [tc-writer] No test stories need TCs in phase 'unknown' — skipping
//   [tc-writer] TC generation complete — test stories have testCriteria
//
// The story's testCriteria was 0. No phase is named 'unknown', so the writer matched no story,
// skipped, and the caller logged completion.
//
// CURRENT_PHASE is a claude.sh-internal global, declared empty at line 340 and assigned in exactly
// one place (line 11304) — the phase-filter path. The orchestrator exports PHASE (line 384) and
// passes PHASE="$_phase" per invocation. The tc-writer call read CURRENT_PHASE and fell back
// straight to the literal 'unknown', never consulting the variable that actually carries the phase.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

/** Executes the REAL phase-resolution helper with the given environment. */
function resolvePhase(env: Record<string, string>): string {
  const assigns = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n');
  const script = `
set +e
${assigns}
eval "$(awk '/^_tc_writer_phase\\(\\) \\{/,/^\\}/' "${CLAUDE_SH}")"
if ! declare -F _tc_writer_phase >/dev/null 2>&1; then echo "NOFUNC"; exit 0; fi
_tc_writer_phase
`;
  return (spawnSync('bash', ['-c', script], { encoding: 'utf8' }).stdout || '').trim();
}

describe('the TC writer is told which phase it is in', () => {
  it('uses CURRENT_PHASE when the phase-filter path set it', () => {
    expect(resolvePhase({ CURRENT_PHASE: 'core', PHASE: '' })).toBe('core');
  });

  it('THE DEFECT: falls back to PHASE, which the orchestrator actually exports', () => {
    // Live shape: CURRENT_PHASE empty (never assigned outside the phase-filter path),
    // PHASE='core' exported by run-agent-orchestration.sh.
    expect(resolvePhase({ CURRENT_PHASE: '', PHASE: 'core' })).toBe('core');
  });

  it('never silently yields a phase no story can match', () => {
    // 'unknown' matches nothing, so the writer skips and the caller reports completion.
    // With neither variable set the answer must be empty — an absent phase the caller can
    // detect — not a literal that looks like an answer.
    const out = resolvePhase({ CURRENT_PHASE: '', PHASE: '' });
    expect(out, 'a phase literal no story can match is worse than no phase at all')
      .not.toBe('unknown');
  });
});
