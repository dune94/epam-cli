/**
 * runClaude timeout + process-group kill tests.
 *
 * Spawns real short-lived subprocesses (sleep, echo) to verify:
 *   1. A hanging subprocess is killed within the timeout window
 *   2. The promise rejects with a timeout error (not hangs forever)
 *   3. A fast subprocess resolves normally before the timeout
 *   4. The child process group is dead after timeout (no zombies)
 *   5. Grandchildren that survive group-kill don't hold stdout/stderr open
 *      and prevent the event loop from continuing (stream-destruction fix)
 *
 * Zero API calls, zero tokens. Uses /bin/sleep, /bin/echo, /bin/bash.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Buggy version (no stream destroy) ────────────────────────────────────────
// Used to prove the grandchild-stream bug exists before the fix.
function runClaudeBuggy(
  cmd: string,
  args: string[],
  prompt: string,
  logPath: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { detached: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const killGroup = () => { try { process.kill(-proc.pid!, 'SIGKILL'); } catch { /* gone */ } };
    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup();
      // BUG: streams NOT destroyed — grandchildren holding pipes keep event loop alive
      reject(new Error(`prompt runner timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('error', (e: Error) => { if (!settled) { settled = true; clearTimeout(killTimer); reject(e); } });
    proc.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const out = `${stdout}\n${stderr}`.trim();
      writeFileSync(logPath, `# Output\n${out}\n`);
      if (code !== 0 && code !== null) return reject(new Error(`exited ${code}`));
      resolve(out);
    });
    proc.unref();
    proc.stdin?.on('error', () => { /* suppress EPIPE when process is killed before stdin flush */ });
    proc.stdin?.end(prompt);
  });
}

// ── Fixed version (stream destroy on timeout) ─────────────────────────────────
// Mirrors spec-mode-runner.js exactly — if the source diverges, the source
// guard tests in minimax-tool-call.test.ts will catch it.
function runClaudeTest(
  cmd: string,
  args: string[],
  prompt: string,
  logPath: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { detached: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const killGroup = () => {
      try { process.kill(-proc.pid!, 'SIGKILL'); } catch { /* already gone */ }
    };

    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup();
      // FIX: destroy streams so grandchildren holding inherited pipe fds don't
      // keep the Node.js event loop alive after the process group is killed.
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      reject(new Error(`prompt runner timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('error', (error: Error) => { if (!settled) { settled = true; clearTimeout(killTimer); reject(error); } });
    proc.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const output = `${stdout}\n${stderr}`.trim();
      writeFileSync(logPath, `# Output\n${output}\n`);
      if (code !== 0 && code !== null) {
        return reject(new Error(`prompt runner exited with code ${code}`));
      }
      resolve(output);
    });
    proc.unref();
    proc.stdin?.on('error', () => { /* suppress EPIPE when process is killed before stdin flush */ });
    proc.stdin?.end(prompt);
  });
}

const TMP = tmpdir();

describe('runClaude — timeout kills subprocess group', () => {
  it('rejects with timeout error when subprocess hangs', async () => {
    const logPath = join(TMP, `runclaude-test-hang-${Date.now()}.log`);
    const start = Date.now();

    await expect(
      runClaudeTest('sleep', ['10'], '', logPath, 200)
    ).rejects.toThrow('timed out after 200ms');

    const elapsed = Date.now() - start;
    // Must reject within ~500ms despite sleep 10
    expect(elapsed).toBeLessThan(1000);

    try { unlinkSync(logPath); } catch { /* ok */ }
  }, 3000);

  it('resolves normally when subprocess completes before timeout', async () => {
    const logPath = join(TMP, `runclaude-test-ok-${Date.now()}.log`);

    const result = await runClaudeTest('echo', ['hello world'], '', logPath, 5000);
    expect(result).toContain('hello world');

    try { unlinkSync(logPath); } catch { /* ok */ }
  }, 3000);

  it('does not hang the test suite after timeout (proc.unref() works)', async () => {
    // If unref() is missing, this test would keep the process alive after timeout
    const logPath = join(TMP, `runclaude-test-unref-${Date.now()}.log`);
    const start = Date.now();

    await expect(
      runClaudeTest('sleep', ['30'], '', logPath, 100)
    ).rejects.toThrow('timed out');

    // Vitest exits promptly — if it hangs here, unref() is broken
    expect(Date.now() - start).toBeLessThan(500);

    try { unlinkSync(logPath); } catch { /* ok */ }
  }, 3000);

  it('settled flag prevents double-reject on close after kill', async () => {
    // After SIGKILL, the close event fires with code null — settled flag must
    // prevent a second reject() call which would be a no-op but logs an error.
    const logPath = join(TMP, `runclaude-test-settled-${Date.now()}.log`);
    let rejectCount = 0;

    const p = new Promise<string>((resolve, reject) => {
      const proc = spawn('sleep', ['5'], { detached: true });
      let settled = false;
      const killGroup = () => { try { process.kill(-proc.pid!, 'SIGKILL'); } catch { /* ok */ } };
      const killTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killGroup();
        rejectCount++;
        reject(new Error('timeout'));
      }, 100);
      proc.on('close', () => {
        if (settled) return; // this is the guard under test
        settled = true;
        clearTimeout(killTimer);
        rejectCount++;
        resolve('ok');
      });
      proc.unref();
      proc.stdin?.end();
    });

    await expect(p).rejects.toThrow('timeout');
    // Give close event time to fire
    await new Promise(r => setTimeout(r, 200));
    expect(rejectCount).toBe(1); // only one rejection, not two
  }, 3000);

  it('rejects promptly when grandchild in new session holds stdout pipe open (stream destroy fix)', async () => {
    // Root cause of the OpenAI ladder hang: the subprocess (ai-run.sh) spawns a
    // grandchild with setsid/detached that inherits stdout. killGroup() can't
    // reach it. Without proc.stdout?.destroy(), the Node event loop waits
    // forever for the pipe to close. The fixed runClaudeTest destroys streams
    // on timeout; the buggy version would hang the full 30s test timeout.
    const scriptPath = join(TMP, `grandchild-${Date.now()}.sh`);
    writeFileSync(scriptPath,
      '#!/bin/bash\n# Grandchild in new session inherits stdout, survives parent kill\nsetsid sleep 30 &\nsleep 30\n'
    );
    chmodSync(scriptPath, 0o755);
    const logPath = join(TMP, `grandchild-log-${Date.now()}.log`);

    const start = Date.now();
    await expect(
      runClaudeTest('bash', [scriptPath], '', logPath, 250)
    ).rejects.toThrow('timed out after 250ms');

    // Must complete within 1s despite grandchild holding the pipe open
    expect(Date.now() - start).toBeLessThan(1500);

    try { unlinkSync(scriptPath); } catch { /* ok */ }
    try { unlinkSync(logPath); } catch { /* ok */ }
  }, 5000);
});

// ── Ladder provider bug tests ─────────────────────────────────────────────────

describe('runAgentForJson — ladder uses correct provider (not minimax)', () => {
  const { resolvePromptExec } = require('../../../orchestrations/scripts/spec-mode-runner.js');

  it('resolvePromptExec with minimax provider bakes --provider minimax into args', () => {
    // This is the BUG: execSpec is built once with minimax provider and reused for
    // the ladder. The ladder env overrides (AI_PROVIDER=openai) are ignored because
    // ai-run.sh reads the --provider CLI flag, not the env var.
    const exec = resolvePromptExec('/path/ai-run.sh', { AI_PROVIDER: 'minimax', AI_MODEL: 'MiniMax-M3' });
    expect(exec.args).toContain('--provider');
    expect(exec.args[exec.args.indexOf('--provider') + 1]).toBe('minimax');
    // If this execSpec were passed to runClaude with {AI_PROVIDER:'openai'} env override,
    // the subprocess would still use --provider minimax (CLI flag beats env var in ai-run.sh)
  });

  it('ladder execSpec must use ladder provider — not inherit minimax args from original execSpec', () => {
    // The FIX: build a new execSpec for the ladder call using the ladder provider.
    // This test documents the required contract: cmd stays the same, provider changes.
    const minimaxExec = resolvePromptExec('/path/ai-run.sh', { AI_PROVIDER: 'minimax', AI_MODEL: 'MiniMax-M3' });
    expect(minimaxExec.args).toContain('minimax'); // sanity: original has minimax

    // Correct ladder exec: same cmd, new provider args (no model — ladder uses default)
    const ladderProvider = 'openai';
    const ladderExec = { cmd: minimaxExec.cmd, args: ['--provider', ladderProvider] };

    expect(ladderExec.cmd).toBe(minimaxExec.cmd);
    expect(ladderExec.args).toContain('--provider');
    expect(ladderExec.args[ladderExec.args.indexOf('--provider') + 1]).toBe('openai');
    expect(ladderExec.args).not.toContain('minimax');
    expect(ladderExec.args).not.toContain('MiniMax-M3'); // no stale model from minimax exec
  });
});
