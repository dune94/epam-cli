/**
 * SEV 1 — lib/tc-writer-gate.sh line 200: analyst called via "$SCRIPT_DIR/../agent-attempt-analyst.sh".
 *
 * SCRIPT_DIR is INHERITED from the caller (run-agent-orchestration.sh), which always
 * sets it to orchestrations/scripts/. With that value:
 *   $SCRIPT_DIR/../agent-attempt-analyst.sh
 *   = orchestrations/scripts/../agent-attempt-analyst.sh
 *   = orchestrations/agent-attempt-analyst.sh   ← does not exist
 *
 * The analyst lives at orchestrations/scripts/agent-attempt-analyst.sh.
 * Fix: "$SCRIPT_DIR/agent-attempt-analyst.sh" (remove the /../).
 *
 * Failure mode: every TC writer retry ran WITHOUT corrective guidance.
 * The analyst exit 2 path (caller logs "FAILED") was also unreachable.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { engineSource } from '../../lib/engine-source';

const REPO_ROOT = join(__dirname, '../../../');
// SCRIPT_DIR as run-agent-orchestration.sh sets it — the CALLER's value, not lib/'s.
const CALLER_SCRIPT_DIR = join(REPO_ROOT, 'orchestrations/scripts');
const GATE_LIB = join(CALLER_SCRIPT_DIR, 'lib/tc-writer-gate.sh');
const gate = engineSource(GATE_LIB);

/** Extract the first analyst bash invocation path expression (non-comment lines only). */
function analystPathExpr(): string {
  for (const line of gate.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/bash\s+"(\$SCRIPT_DIR[^"]*agent-attempt-analyst\.sh)"/);
    if (m) return m[1];
  }
  throw new Error('no analyst bash invocation found in tc-writer-gate.sh — was the call removed?');
}

describe('tc-writer-gate: analyst is reachable when SCRIPT_DIR = caller runtime value', () => {
  it('has an analyst invocation in the retry loop', () => {
    expect(() => analystPathExpr()).not.toThrow();
  });

  it('the analyst path resolves to an executable when SCRIPT_DIR is orchestrations/scripts/', () => {
    // At runtime SCRIPT_DIR = orchestrations/scripts/ (set by the caller).
    // The path expression must reach the analyst at that SCRIPT_DIR, not at lib/.
    const pathExpr = analystPathExpr();
    const { stdout } = spawnSync('bash', ['-c',
      `SCRIPT_DIR=${JSON.stringify(CALLER_SCRIPT_DIR)}\ntest -x "${pathExpr}" && echo FOUND || echo MISSING`
    ], { encoding: 'utf8' });
    expect(stdout.trim(),
      `analyst path expression "${pathExpr}" with SCRIPT_DIR="${CALLER_SCRIPT_DIR}" ` +
      `resolves to a non-executable path — the analyst never runs between retries`
    ).toBe('FOUND');
  });
});
