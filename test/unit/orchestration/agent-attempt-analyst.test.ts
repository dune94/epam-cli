/**
 * agent-attempt-analyst.sh — reusable self-heal for AGENT-EXECUTION failures (2026-07-24).
 *
 * Detective, test-writer, and impl all fail the same way: the agent burns its whole
 * iteration budget and never produces output ("reached maximum iterations (N) without
 * completing"). A canned corrective note is the wrong fix. This analyst (greenfield-safe
 * sibling of run_failure_analyst) diagnoses WHY from the agent's real output + the real task
 * and prescribes a tailored corrective directive for the next attempt. It uses the
 * failure-analyst profile + escalation model, and SKIPS provider/infra failures.
 *
 * Drives the REAL script with a stubbed ai-run.sh.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ANALYST = join(__dirname, '../../../orchestrations/scripts/agent-attempt-analyst.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// Stub ai-run.sh: capture the prompt (stdin) to a file, echo a canned directive.
function stubRunner(dir: string, promptCapture: string): string {
  const stub = join(dir, 'stub-ai-run.sh');
  writeFileSync(stub, `#!/usr/bin/env bash\ncat > ${JSON.stringify(promptCapture)}\nprintf 'COMMIT EARLY: you already located the fix — WRITE the test file now as your next action; stop exploring.'\n`);
  chmodSync(stub, 0o755);
  return stub;
}

function run(failureClass: string, failedOutput: string, context: string): { out: string; prompt: string } {
  const dir = mkdtempSync(join(tmpdir(), 'analyst-'));
  dirs.push(dir);
  const outFile = join(dir, 'failed.txt'); writeFileSync(outFile, failedOutput);
  const ctxFile = join(dir, 'ctx.txt'); writeFileSync(ctxFile, context);
  const promptCapture = join(dir, 'prompt.txt'); writeFileSync(promptCapture, '');
  const out = execFileSync('bash', [ANALYST, failureClass, outFile, ctxFile], {
    encoding: 'utf8',
    env: { ...process.env, AI_RUNNER_CMD: stubRunner(dir, promptCapture) },
  });
  let prompt = ''; try { prompt = execFileSync('cat', [promptCapture], { encoding: 'utf8' }); } catch { /* */ }
  return { out, prompt };
}

describe('agent-attempt-analyst — reusable self-heal for no-output agent failures', () => {
  it('max_iterations → returns a tailored corrective directive from the analyst', () => {
    const { out } = run('max_iterations', 'reached maximum iterations (15) without completing.', 'Write a .spec.ts reproducing test for the parseDispatchLineItemKey fix.');
    expect(out).toMatch(/COMMIT EARLY|WRITE the test/);
  });

  it('the analyst prompt is grounded: it carries the failure class, the agent output, and the real task', () => {
    const { prompt } = run('max_iterations', 'MAX_ITER_MARKER reached maximum iterations', 'TASK_MARKER write the reproducing test');
    expect(prompt).toMatch(/max_iterations/);
    expect(prompt).toContain('MAX_ITER_MARKER');   // the agent's real output
    expect(prompt).toContain('TASK_MARKER');        // the real task (ground truth)
    // and it frames max-iterations as "commit early", not generic advice
    expect(prompt).toMatch(/commit output EARLY|WRITE your file/i);
  });

  it('provider/infra failure → emits NOTHING (no agent behaviour to correct, caller just retries)', () => {
    const { out } = run('provider', 'ai-run failed with no error output', 'anything');
    expect(out.trim()).toBe('');
  });
});
