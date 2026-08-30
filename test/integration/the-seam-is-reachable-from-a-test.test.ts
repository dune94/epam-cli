/**
 * THE SEAM EVERY AGENT ENTERS THROUGH, DRIVEN BY A TEST.
 *
 * All 40 declared seams reach the model through run_orch_prompt. It lived inside
 * run-agent-orchestration.sh — 11,213 lines, 2,625 top-level statements, no main() — so sourcing
 * that file to reach the function ran the entire pipeline. No test could call it. That, not the
 * difficulty of writing tests, is why 33 of 40 seams had no integration coverage.
 *
 * Every defect worth catching here has been at a join, with unit tests green throughout:
 * a gate resolving to no seam; a shell notice printed onto a captured stdout, eating an agent's
 * reply and killing metrolinx three attempts running; a prompt that never reached the trace.
 *
 * The function is now in lib/orch-prompt.sh. These drive it with a stubbed runner: real code
 * path, no provider, no cost, every commit.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../orchestrations/scripts/lib/orch-prompt.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A stand-in for the vendor runner: prints what we tell it, and writes the result file. */
function stubRunner(stdout: string) {
  const dir = mkdtempSync(join(tmpdir(), 'seam-runner-')); dirs.push(dir);
  const sh = join(dir, 'ai-run.sh');
  writeFileSync(sh, [
    '#!/usr/bin/env bash',
    '[ -n "${ORCH_JSON_RESULT:-}" ] && printf \'%s\' \'{"cost_usd":0,"usage":{"inputTokens":1,"outputTokens":1}}\' > "$ORCH_JSON_RESULT"',
    `cat <<'ANSWER_EOF'`,
    stdout,
    'ANSWER_EOF',
  ].join('\n'));
  chmodSync(sh, 0o755);
  return sh;
}

function driveSeam(runnerStdout: string) {
  const runner = stubRunner(runnerStdout);
  // The helpers run_orch_prompt expects its caller to have defined. Declared AFTER the source so
  // they win, exactly as the orchestrator's own definitions would.
  const script = `
    set -uo pipefail
    . ${JSON.stringify(LIB)} 2>/dev/null || true
    log()     { :; }
    error()   { :; }
    warning() { :; }
    resolve_prompt_provider() { printf '%s' 'claude'; }
    seam_ladder_export()      { :; }
    seam_model_or_fail()      { printf '%s' 'a-model'; }
    seam_next_model()         { printf '%s' ''; }
    AI_RUNNER_CMD=${JSON.stringify(runner)}
    CLAUDE_CMD=${JSON.stringify(runner)}
    run_orch_prompt "a prompt" "some-agent" "a-story"
  `;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60000 });
  return { out: r.stdout || '', err: r.stderr || '', code: r.status };
}

const ANSWER = '<ROLE_ASSIGNMENTS>{"assignments":[]}</ROLE_ASSIGNMENTS>';
/** The notice that actually corrupted metrolinx, in shape. */
const NOTICE = "  [provider] 'qwen' is not routable by the 'claude' set — using 'claude'.";

describe('the seam is reachable from a test', () => {
  it('run_orch_prompt can be called without running the pipeline', () => {
    // The property that did not hold before the extraction. If this fails, nothing below means
    // anything — and 33 seams stay untestable.
    const { out } = driveSeam(ANSWER);
    expect(out, 'the seam returned nothing — it was not reached').toContain('ROLE_ASSIGNMENTS');
  }, 90_000);

  it('a diagnostic sharing the runner stdout does not eat the answer', () => {
    const { out } = driveSeam(`${ANSWER}\n${NOTICE}`);
    expect(out).toContain('ROLE_ASSIGNMENTS');
    expect(out).toContain('assignments');
  }, 90_000);
});
