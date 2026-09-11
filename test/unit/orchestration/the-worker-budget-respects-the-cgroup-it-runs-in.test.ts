/**
 * THE BUDGET IS THE CGROUP'S, NOT THE HOST'S.
 *
 * resolve_test_workers sizes the client test pool from `free -m`'s available column. Under a
 * memory-capped scope — which is how every launch on this host now runs — that is the wrong
 * number: the host may show 8.4GB free while the cgroup the workers will live in allows 5GB.
 *
 * Live 2026-09-11, harness on bugfix/AI-AMSD-1919 inside a 5120MB scope: the resolver read
 * 8467MB, budgeted 60% = 5080MB, allowed 7 workers at 700MB; jest's real workers were ~850MB
 * each, 7 × 850 = 6GB, and the cgroup OOM-killed the suite. Bounded — and still killed, because
 * the bound was computed against a limit the process was not under.
 *
 * This runs the REAL resolver inside a real, small scope and asserts it plans against that.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/bounded-exec.sh');

function workersUnderScope(memoryMaxMb: number | null, env: Record<string, string>): { n: number; out: string } {
  const inner = `. ${JSON.stringify(LIB)}; resolve_test_workers`;
  const argv = memoryMaxMb === null
    ? ['bash', ['-c', inner]] as const
    : ['systemd-run', ['--user', '--scope', '--quiet', '-p', `MemoryMax=${memoryMaxMb}M`, '-p', 'MemorySwapMax=0',
        'bash', '-c', inner]] as const;
  const r = spawnSync(argv[0], argv[1] as string[], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });
  const out = (r.stdout || '') + (r.stderr || '');
  return { n: Number((r.stdout || '').trim().split('\n').pop()), out };
}

const scopesWork = spawnSync('systemd-run', ['--user', '--scope', '--quiet', 'true']).status === 0;

describe('the worker budget respects the cgroup it runs in', () => {
  it('this host can create a capped scope — otherwise the case below proves nothing', () => {
    expect(scopesWork, 'systemd-run --user --scope is unavailable here').toBe(true);
  });

  it('with the host roomy but the scope small, the resolver plans against the scope', () => {
    // No override: the resolver reads the real machine. Baseline = whatever scope this test
    // process already lives in; then a nested 2000MB scope, which must dominate.
    // 60% of 2000 / 700 per worker = 1.
    const unscoped = workersUnderScope(null, {});
    const scoped = workersUnderScope(2000, {});
    expect(unscoped.n, [
      `the ambient scope this test runs in only allows ${unscoped.n} worker(s), so a nested 2000MB`,
      'scope cannot show a difference. Run the suite with at least ~4GB allowed to its scope',
      `(e.g. bounded --want 6144). Resolver said:\n${unscoped.out}`,
    ].join('\n')).toBeGreaterThan(1);
    expect(scoped.n, [
      `inside a 2000MB scope the resolver still allowed ${scoped.n} workers (unscoped: ${unscoped.n}).`,
      'It budgets from host free memory, not from the cgroup limit the workers actually live under —',
      'a bounded pool that is still killed by its own cap.',
      scoped.out,
    ].join('\n')).toBe(1);
  });
});
