/**
 * "FOUND NOTHING TO DO OR FAILED" IS NOT A VERDICT.
 *
 * When the PRD model coordinator assigned nothing, the run logged:
 *
 *     [prd-model-coordinator] No assignments made (agent found nothing to do or failed)
 *
 * and marked the step ✓. That single line covers two opposite outcomes — the agent ran fine and
 * had nothing to assign, or the call failed and the stories kept whatever they had — and the
 * audit record took the same value ("noop") for both.
 *
 * Observed live on 2026-09-10, openrouter run 20260910T222155Z: AMSD-1919 went into the writer
 * queue with aiProvider and model unset, and nothing in the log could say whether that was
 * intended or a swallowed failure.
 *
 * The information to tell them apart was already in hand: `_mc_rc` captures the call's exit status
 * ~60 lines above, and a non-zero status is already warned about separately. The verdict just did
 * not use it. [[fb_gate_verdict_read]] — a gate must have a verdict someone can read.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const ORCH = join(ROOT, 'orchestrations/scripts/run-agent-orchestration.sh');

/** The real decision function, lifted from the script — never a re-typed copy. */
function extractVerdictFn(): string {
  const lines = readFileSync(ORCH, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^_mc_no_assignment_verdict\(\)\s*\{/.test(l));
  if (start < 0) throw new Error('_mc_no_assignment_verdict() not found in run-agent-orchestration.sh');
  const end = lines.findIndex((l, i) => i > start && /^\}/.test(l));
  if (end < 0) throw new Error('_mc_no_assignment_verdict() has no closing brace at column 0');
  return lines.slice(start, end + 1).join('\n');
}

/** Run the real function for a given call exit status; return what it reported and recorded. */
function verdictFor(rc: string) {
  const d = mkdtempSync(join(tmpdir(), 'mcverdict-'));
  const s = join(d, 'h.sh');
  writeFileSync(s, `#!/usr/bin/env bash
set -uo pipefail
info(){ echo "INFO: $*"; }; warning(){ echo "WARN: $*"; }; error(){ echo "ERR: $*"; }
${extractVerdictFn()}
_mc_final_outcome=""
_mc_no_assignment_verdict "${rc}"
echo "OUTCOME=\${_mc_final_outcome}"
`);
  const r = spawnSync('bash', [s], { encoding: 'utf8', timeout: 60_000 });
  rmSync(d, { recursive: true, force: true });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  return { out, outcome: (out.match(/OUTCOME=(\S*)/) ?? [])[1] ?? '' };
}

describe('a coordinator that assigned nothing says WHY', () => {
  it('a FAILED call is reported as a failure, not as "nothing to do"', () => {
    const v = verdictFor('1');
    expect(v.outcome, `outcome was '${v.outcome}'. out: ${v.out.slice(0, 200)}`).toBe('failed');
    expect(v.out.toLowerCase()).toMatch(/fail/);
  });

  it('a SUCCESSFUL call with nothing to assign is reported as exactly that', () => {
    const v = verdictFor('0');
    expect(v.outcome, `outcome was '${v.outcome}'. out: ${v.out.slice(0, 200)}`).toBe('noop');
    expect(v.out.toLowerCase(), 'a clean no-op must not read as a possible failure')
      .not.toMatch(/or failed/);
  });

  it('the two outcomes are distinguishable in the audit record', () => {
    expect(verdictFor('1').outcome).not.toBe(verdictFor('0').outcome);
  });

  it('the ambiguous phrasing is gone from the script', () => {
    expect(readFileSync(ORCH, 'utf8'),
      'the run can still log "found nothing to do or failed", which is two outcomes in one line')
      .not.toContain('found nothing to do or failed');
  });
});
