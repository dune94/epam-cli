/**
 * The observed limit must actually REACH the guard.
 *
 * Live metrolinx 2026-07-25: the guard refused the harmful rule with
 *
 *   "cannot verify EPAM_MAX_ITERATIONS=14 ... no observed limit in the episode
 *    and no value in the environment"
 *
 * — the FAIL-CLOSED branch. But the episode plainly carried observed_limit: 15.
 * The outcome was right for the wrong reason, and that matters: with no baseline
 * the guard also refuses legitimate INCREASES, so self-heal could never propose
 * the fix that would actually help.
 *
 * The cause was a one-line JS trap in the plumbing I wrote:
 *
 *   .reduce((a, b) => Math.max(a, b), NaN)
 *
 * Math.max(NaN, 15) is NaN, so the seed poisoned every iteration and the result
 * was always NaN regardless of the episodes. Filtering finite values first is not
 * enough when the SEED is the problem.
 *
 * This test pins the real comparison, not just "it refused".
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function freshStore() {
  const root = mkdtempSync(join(tmpdir(), 'obs-limit-')); dirs.push(root);
  for (const m of ['kb-store.js', 'kb-arbitration.js', 'kb-synthesizer.js']) {
    delete require.cache[require.resolve(join(LIB, m))];
  }
  const store = require(join(LIB, 'kb-store.js'));
  store.configure({ root });
  return { root, store, synth: require(join(LIB, 'kb-synthesizer.js')) };
}

function stubRunner(json: string) {
  const d = mkdtempSync(join(tmpdir(), 'obs-run-')); dirs.push(d);
  const p = join(d, 'runner.sh');
  writeFileSync(p, `#!/usr/bin/env bash\ncat >/dev/null\ncat <<'EOF'\n${json}\nEOF\n`);
  chmodSync(p, 0o755);
  return p;
}

const SIG = 'class:max_iterations';
const ROLE = 'repro-test-writer';

function seed(store: any, limits: number[]) {
  limits.forEach((observed_limit, i) => store.recordEpisode({
    id: `e-${i}`, signature: SIG, agent_role: ROLE, story_id: 'S',
    diagnosis: 'ran out of turns', observed_limit,
  }));
}

const rule = (value: string) => JSON.stringify({
  enforcement: { kind: 'param', name: 'EPAM_MAX_ITERATIONS', value },
  reason: 'agent exhausted its budget',
});

const quarantine = (root: string) => existsSync(join(root, 'unmapped-rules.jsonl'))
  ? readFileSync(join(root, 'unmapped-rules.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  : [];

describe('observed limit reaches the guard', () => {
  it('refuses a DECREASE by real comparison, not by failing closed', async () => {
    const ctx = freshStore();
    seed(ctx.store, [15, 15]);   // threshold is 2
    const prev = process.env.EPAM_MAX_ITERATIONS;
    delete process.env.EPAM_MAX_ITERATIONS;
    try {
      await ctx.synth.maybeSynthesize(ctx.store, {
        agent_role: ROLE, signature: SIG, runner: stubRunner(rule('14')),
      });
      const q = quarantine(ctx.root);
      expect(q.length).toBeGreaterThan(0);
      expect(q[q.length - 1].detail,
        'still failing closed — the observed limit never reached the guard, so ' +
        'legitimate INCREASES would be refused too')
        .toMatch(/may only INCREASE|Observed 15/);
    } finally {
      if (prev !== undefined) process.env.EPAM_MAX_ITERATIONS = prev;
    }
  });

  it('ADMITS an increase above the observed limit', async () => {
    const ctx = freshStore();
    seed(ctx.store, [15, 15]);   // threshold is 2
    const prev = process.env.EPAM_MAX_ITERATIONS;
    delete process.env.EPAM_MAX_ITERATIONS;
    try {
      const r = await ctx.synth.maybeSynthesize(ctx.store, {
        agent_role: ROLE, signature: SIG, runner: stubRunner(rule('40')),
      });
      expect(r, 'the CORRECT fix was refused — self-heal can never help').toBeTruthy();
      expect(ctx.store.readConstraints().length).toBe(1);
    } finally {
      if (prev !== undefined) process.env.EPAM_MAX_ITERATIONS = prev;
    }
  });

  it('uses the HIGHEST observed limit — a fix must clear the worst case', async () => {
    const ctx = freshStore();
    seed(ctx.store, [10, 25, 15]);
    const prev = process.env.EPAM_MAX_ITERATIONS;
    delete process.env.EPAM_MAX_ITERATIONS;
    try {
      // 20 beats the lowest (10) but not the worst case (25) — must be refused.
      await ctx.synth.maybeSynthesize(ctx.store, {
        agent_role: ROLE, signature: SIG, runner: stubRunner(rule('20')),
      });
      expect(ctx.store.readConstraints().length,
        'a rule that does not clear the worst observed case was admitted').toBe(0);
      expect(quarantine(ctx.root).pop().detail).toMatch(/Observed 25/);
    } finally {
      if (prev !== undefined) process.env.EPAM_MAX_ITERATIONS = prev;
    }
  });
});
