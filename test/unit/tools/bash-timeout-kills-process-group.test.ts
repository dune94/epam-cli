/**
 * B18b — the Bash tool's timeout was decorative.
 *
 * execa kills only the bash SHELL. Any grandchild that outlives it keeps the stdout
 * pipe open, and execa then blocks until that orphan finishes on its own — so the
 * command runs for its full natural duration no matter what timeout was set.
 *
 * Live consequence (mock1, 2026-07-24): the pre-phase assessment agent ran
 * `find / -name profiles.json`. The 30s timeout fired, but the orphaned find kept
 * walking the filesystem holding the pipe, stalling the pipeline for 282 SECONDS.
 * That single stall was ~29% of the run, and for hours it read as "slow LLM calls" —
 * direct measurement later showed the models answer a 14K-token prompt in ~2s.
 *
 * This is NOT about `find`: any backgrounded process, npm install, or hung network
 * call has the same effect. Fixed by running bash in its own process group and
 * SIGKILLing the GROUP on timeout.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BashTool } from '../../../src/tools/builtin/Bash.js';

const SRC = readFileSync(join(__dirname, '../../../src/tools/builtin/Bash.ts'), 'utf8');

describe('B18b — bash timeout must bound wall time, not just signal the shell', () => {
  it('a grandchild outliving the shell cannot extend the timeout', async () => {
    const tool = new BashTool();
    const t0 = Date.now();
    // `sleep 6 & wait` — the shell dies on timeout, the sleep does not.
    await tool.execute({ command: 'sleep 6 & wait', timeout: 1500 });
    const elapsed = Date.now() - t0;
    // Without the process-group kill this took the full 6s (measured 8.0s for an
    // 8s sleep at a 2s timeout). Allow generous headroom for CI slowness.
    expect(elapsed, `took ${elapsed}ms — orphan held the pipe`).toBeLessThan(4500);
  }, 20000);

  it('a normal fast command still returns its output correctly', async () => {
    const tool = new BashTool();
    const r = await tool.execute({ command: 'echo hello-from-bash', timeout: 10000 });
    expect(r.content).toContain('hello-from-bash');
    expect(r.isError).toBe(false);
  }, 20000);

  it('runs bash in its own process group and kills the GROUP', () => {
    expect(SRC).toMatch(/detached:\s*true/);
    expect(SRC).toMatch(/process\.kill\(-/);
  });
});
