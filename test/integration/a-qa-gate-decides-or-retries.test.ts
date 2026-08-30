/**
 * WHAT A QA GATE'S ANSWER MAKES THE RUN DO.
 *
 * Thirteen of the fourteen verdict seams reach the operator through _run_qa_gate_with_retry: it
 * invokes the gate, climbs the gate's own ladder between attempts, and decides whether an answer
 * counts as a review at all. It lived inside run-agent-orchestration.sh — unsourceable without
 * running the pipeline — so none of that had ever been executed by a test.
 *
 * The failure it exists to prevent is recorded in its own comments: on 2026-07-26 two gates
 * "reviewed" a change while emitting 40 bytes of write-tool echo between them, because the check
 * was a grep for the word "verdict". A gate that accepts noise is worse than no gate — it reports
 * a clearance nobody gave.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPTS = join(__dirname, '../../orchestrations/scripts');
const LIB = join(SCRIPTS, 'lib/gate-verdicts.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const VERDICT = JSON.stringify({
  agent: 'qa-gate:sast', verdict: 'pass', findings: [], summary: 'nothing to report',
});

/**
 * Drive the real function with run_orch_prompt stubbed to emit one reply per attempt, so the
 * retry behaviour is observable rather than inferred.
 */
function runGate(replies: string[], maxRetries = 2) {
  const dir = mkdtempSync(join(tmpdir(), 'qagate-'));
  dirs.push(dir);
  const log = join(dir, 'gate.log');
  const calls = join(dir, 'calls');
  const climbs = join(dir, 'climbs');
  replies.forEach((r, i) => writeFileSync(join(dir, `reply.${i + 1}`), r));

  const script = [
    'set -uo pipefail',
    `SCRIPT_DIR=${JSON.stringify(SCRIPTS)}`,
    `. ${JSON.stringify(LIB)} 2>/dev/null || true`,
    'log() { :; }; error() { :; }; warning() { :; }',
    "seam_model_or_fail() { printf '%s' 'a-model'; }",
    "seam_next_model()    { printf '%s' 'the-next-rung'; }",
    'run_orch_prompt() {',
    `  local n; n=$(cat ${JSON.stringify(calls)} 2>/dev/null || echo 0)`,
    `  n=$(( n + 1 )); printf '%s' "$n" > ${JSON.stringify(calls)}`,
    `  printf 'CLIMB=%s ' "\${ORCH_AGENT_MODEL_CLIMB:-none}" >> ${JSON.stringify(climbs)}`,
    `  cat ${JSON.stringify(dir)}/reply."$n" 2>/dev/null || true`,
    '}',
    // The allowlist every gate invocation is restricted to. The lib does not default it — a
    // default would silently widen the tool grant — so the caller supplies it, as the
    // orchestrator does.
    "ORCH_GATE_ALLOWED_TOOLS='read,search'",
    `QA_GATE_MAX_RETRIES=${maxRetries}`,
    `OUTPUT_DIR=${JSON.stringify(dir)}`,
    `PROJECT_ROOT=${JSON.stringify(dir)}`,
    `_run_qa_gate_with_retry "a prompt" "qa-gate:sast" "core" ${JSON.stringify(log)}`,
    'echo "RC=$?"',
    'echo "CLIMB_AFTER=${ORCH_AGENT_MODEL_CLIMB:-unset}"',
  ].join('\n');

  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60000 });
  const out = `${r.stdout || ''}`;
  return {
    rc: /RC=(\d+)/.exec(out)?.[1],
    climbAfter: /CLIMB_AFTER=(\S+)/.exec(out)?.[1],
    attempts: Number(existsSync(calls) ? readFileSync(calls, 'utf8') : 0),
    climbs: existsSync(climbs) ? readFileSync(climbs, 'utf8') : '',
  };
}

describe('a qa gate decides or retries', () => {
  it('accepts a structured verdict on the first attempt', () => {
    const r = runGate([VERDICT]);
    expect(r.rc, 'a valid verdict was not accepted').toBe('0');
    expect(r.attempts, 'it retried an answer that was already good').toBe(1);
  });

  it('REFUSES 40 bytes of write-tool echo — the 2026-07-26 failure', () => {
    // The exact shape recorded in the function's own comments: output that is not a review.
    const noise = 'The file has been written successfully.';
    const r = runGate([noise, noise]);
    expect(r.rc, 'noise was accepted as a completed review').toBe('1');
  });

  it('retries, and the second attempt climbs the gate ladder', () => {
    const r = runGate(['no structured output here', VERDICT]);
    expect(r.rc, 'a good answer on attempt 2 was not accepted').toBe('0');
    expect(r.attempts).toBe(2);
    // Attempt 1 runs on the gate's own rung; attempt 2 must be told the next one.
    expect(r.climbs).toContain('CLIMB=none');
    expect(r.climbs, 'the retry did not climb the ladder').toContain('CLIMB=the-next-rung');
  });

  it('does not leak the climb to the next gate — on success or on exhaustion', () => {
    // A climb left set makes the NEXT agent start on a rung it never earned.
    expect(runGate([VERDICT]).climbAfter).toBe('unset');
    expect(runGate(['nothing', 'nothing']).climbAfter).toBe('unset');
  });

  it('exhausts exactly the configured number of attempts, not more', () => {
    const r = runGate(['nothing', 'nothing', 'nothing'], 2);
    expect(r.rc).toBe('1');
    expect(r.attempts, 'the retry budget was not honoured').toBe(2);
  });
});
