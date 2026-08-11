/**
 * A KILLED ATTEMPT SPENT REAL MONEY, AND THE BUDGET GUARD COULD NOT SEE A PENNY OF IT.
 *
 * The watchdog SIGKILLs a story attempt at 1800s. The cost record is written by the code that
 * runs AFTER the invocation returns — which, for a killed attempt, never runs. The timeout
 * branch wrote `{phase_id, story_id, status:"timeout"}` and nothing else: no tokens, no cost.
 *
 * Live 2026-08-10: 10 of 23 writer invocations were killed, and they were the longest and most
 * expensive ones (25.4 min, ~2.2M input tokens each). Every one contributed $0 to the story's
 * running total. `storyBudgetHardLimitUsd` ($15) sums task_cost_usd from phase-cost.jsonl, so
 * it was totalling only the cheap attempts that finished — blindest exactly where the money
 * went. The run billed $11.76 on OpenRouter alone while the guard believed $3.80.
 *
 * The fix cannot be "record it at the end", because the end is the case that does not happen.
 * AgentRunner persists usage-so-far after EVERY turn, so the last completed turn's numbers are
 * already durable when the kill lands.
 *
 * These tests actually kill a process. A test that politely lets the writer finish proves
 * nothing about the only scenario this code exists for.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRunner } from '../../../src/agent/AgentRunner';

const ORCH = join(__dirname, '../../../orchestrations/scripts/run-agent-orchestration.sh');
const SRC = readFileSync(ORCH, 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** A provider that reports usage and then blocks forever — a writer the watchdog must kill. */
function hangingProvider(usagePerTurn: { inputTokens: number; outputTokens: number }) {
  let turn = 0;
  // BOTH paths, because AgentRunner streams. A stub that only implements complete() throws
  // "unused" and the test learns nothing — the same mismatch that let cachedInputTokens reach
  // the CLI as undefined while every unit test on either side of the seam passed.
  const respond = () => {
    turn++;
    return {
      content: [{ type: 'text' as const, text: `turn ${turn}` }],
      stopReason: 'end_turn' as const,
      usage: { ...usagePerTurn, cachedInputTokens: 1000 },
    };
  };
  return {
    name: 'stub', defaultModel: 'stub',
    async complete() { return respond(); },
    async stream() { return respond(); },
  };
}

describe('usage is durable BEFORE the kill, not after the run', () => {
  it('the progress file exists after the first turn, not only at the end', async () => {
    const dir = tmp('usageprog-');
    const file = join(dir, 'usage.json');
    process.env.EPAM_USAGE_PROGRESS_FILE = file;
    try {
      const runner = new AgentRunner({
        provider: hangingProvider({ inputTokens: 2200, outputTokens: 40 }) as never,
        model: 'stub', systemPrompt: 's', userMessage: 'u', tools: [], maxIterations: 2,
      } as never);
      await runner.run();
      expect(existsSync(file), 'nothing was persisted — a kill would lose everything').toBe(true);
      const u = JSON.parse(readFileSync(file, 'utf8'));
      expect(u.inputTokens).toBeGreaterThan(0);
      expect(u.outputTokens).toBeGreaterThan(0);
    } finally { delete process.env.EPAM_USAGE_PROGRESS_FILE; }
  });

  it('it reports the running TOTAL, not just the most recent turn', async () => {
    // A single `end_turn` response ends the loop, so this run completes one turn — and the
    // persisted figure must be the accumulator (which a kill mid-run would then expose),
    // not a per-turn snapshot that resets.
    const dir = tmp('usageprog2-');
    const file = join(dir, 'usage.json');
    process.env.EPAM_USAGE_PROGRESS_FILE = file;
    try {
      const res = await new AgentRunner({
        provider: hangingProvider({ inputTokens: 1000, outputTokens: 10 }) as never,
        model: 'stub', systemPrompt: 's', userMessage: 'u', tools: [], maxIterations: 2,
      } as never).run();
      const persisted = JSON.parse(readFileSync(file, 'utf8'));
      expect(
        persisted.inputTokens,
        'the persisted figure disagrees with what the run itself reports',
      ).toBe(res.usage.inputTokens);
      expect(persisted.cachedInputTokens).toBe(res.usage.cachedInputTokens);
    } finally { delete process.env.EPAM_USAGE_PROGRESS_FILE; }
  });

  it('writes nothing when the pipeline did not ask for it', async () => {
    delete process.env.EPAM_USAGE_PROGRESS_FILE;
    const dir = tmp('usageprog3-');
    await new AgentRunner({
      provider: hangingProvider({ inputTokens: 10, outputTokens: 1 }) as never,
      model: 'stub', systemPrompt: 's', userMessage: 'u', tools: [], maxIterations: 1,
    } as never).run();
    expect(existsSync(join(dir, 'usage.json'))).toBe(false);
  });

  it('SURVIVES A REAL KILL — the scenario the whole mechanism exists for', () => {
    // A child that writes progress then hangs, killed with SIGKILL exactly as `timeout` does.
    const dir = tmp('usagekill-');
    const file = join(dir, 'usage.json');
    const script = join(dir, 'child.js');
    writeFileSync(script,
      `require('node:fs').writeFileSync(${JSON.stringify(file)},
         JSON.stringify({inputTokens:2214217,outputTokens:12674,cachedInputTokens:2100000,iterations:47}));
       setInterval(()=>{},1000);`);
    const r = spawnSync('bash', ['-c',
      `timeout -s KILL 2 ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}; echo "rc=$?"`],
      { encoding: 'utf8', timeout: 20000 });
    expect(r.stdout, 'the child was not actually killed — this test proves nothing').toMatch(/rc=137/);
    expect(existsSync(file), 'the kill took the usage with it').toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).inputTokens).toBe(2214217);
  });
});

describe('the watchdog turns that file into a cost record the budget guard can sum', () => {
  /** Runs the real timeout-record block from run-agent-orchestration.sh. */
  function record(progress: Record<string, unknown> | null) {
    const dir = tmp('torec-');
    mkdirSync(join(dir, 'logs'), { recursive: true });
    const progressFile = join(dir, 'usage.json');
    if (progress) writeFileSync(progressFile, JSON.stringify(progress));
    const costFile = join(dir, 'logs', 'phase-cost.jsonl');
    const start = SRC.indexOf('            _to_progress=');
    expect(start, 'the timeout-record block moved — re-anchor this test').toBeGreaterThan(-1);
    const end = SRC.indexOf('2>/dev/null || true', start) + '2>/dev/null || true'.length;
    const block = SRC.slice(start, end);
    execFileSync('bash', ['-c',
      `set -u
       story_id=AMSD-2041
       CURRENT_PHASE=core
       LOG_DIR=${JSON.stringify(join(dir, 'logs'))}
       PHASE_COST_FILE=${JSON.stringify(costFile)}
       EPAM_USAGE_PROGRESS_FILE=${JSON.stringify(progressFile)}
${block}`], { encoding: 'utf8' });
    return JSON.parse(readFileSync(costFile, 'utf8').trim());
  }

  it('THE DEFECT: a killed attempt now carries its tokens and cost', () => {
    const r = record({ inputTokens: 2214217, outputTokens: 12674, cachedInputTokens: 2100000, costUsd: 0.682 });
    expect(r.status).toBe('timeout');
    expect(r.task_tokens_in, 'the most expensive attempts reported zero tokens').toBe(2214217);
    expect(r.task_cost_usd, 'the $15 guard could not see a penny of a killed attempt').toBe(0.682);
    expect(r.cache_read_tokens).toBe(2100000);
  });

  it('the record is still written when no progress survived, so the timeout is never lost', () => {
    const r = record(null);
    expect(r.status).toBe('timeout');
    expect(r.task_cost_usd).toBe(0);
  });

  it('the budget guard can sum it — the jq the guard actually uses', () => {
    const r = record({ inputTokens: 100, outputTokens: 2, costUsd: 4.25 });
    const summed = execFileSync('jq', ['-s', '--arg', 'id', 'AMSD-2041',
      '[.[] | select(.story_id == $id) | (.task_cost_usd // 0)] | add // 0'],
      { input: JSON.stringify(r) + '\n', encoding: 'utf8' }).trim();
    expect(Number(summed), 'the guard still cannot see it').toBe(4.25);
  });
});
