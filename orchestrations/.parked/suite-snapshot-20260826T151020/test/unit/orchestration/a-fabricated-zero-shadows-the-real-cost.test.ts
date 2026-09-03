/**
 * A FABRICATED total_cost_usd: 0 SHADOWS THE REAL cost_usd ONE FIELD ALONG.
 *
 * parseCostRecord picks the cost from the first alias a producer supplies:
 *
 *     const costUsd = num(j.total_cost_usd ?? j.cost_usd ?? j.cost ?? (j.part && j.part.cost));
 *
 * `??` falls through on null and undefined ONLY. A total_cost_usd that is PRESENT and ZERO
 * therefore wins, and the real figure sitting in cost_usd is never read.
 *
 * The zero is not the provider's. ai-run.sh fabricates it in the plan/execute merge:
 *
 *     | .total_cost_usd = (($exec.total_cost_usd // 0) + ($plan.total_cost_usd // 0))
 *
 * On the path where neither input carries the field, `// 0` writes a literal 0 rather than
 * leaving the field out — manufacturing the very value that then outranks the truth.
 *
 * Caught by the anomaly dump added after three blind attempts to explain it
 * (evidence-anomaly-agent-mint.json, run 20260817T211517Z):
 *
 *     RAW  cost_usd       = 0.0164     <- the real cost
 *          total_cost_usd = 0          <- fabricated, and it WINS
 *
 * This is the measurement the operator has called priority #1, and it feeds the story budget
 * guard: spend that reads as $0 cannot trip a limit.
 *
 * THE RULE: a zero-valued alias carries no information. Take the first alias that is a positive
 * number; if every alias is zero, the call really was free and $0 is the honest answer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseCostRecord } = require(join(ROOT, 'orchestrations/scripts/lib/cost-emitter.js'));

const parse = (o: Record<string, unknown>) => parseCostRecord(JSON.stringify(o));

/**
 * Pull the plan/execute merge filter out of ai-run.sh and run it under the real jq, so this tests
 * what the script actually executes. A copy of the filter written here could happily agree with a
 * broken script; the script's own text cannot.
 */
function runRealMerge(planFile: string, execFile: string) {
  const sh = readFileSync(join(ROOT, 'orchestrations/scripts/llm-handler.sh'), 'utf8');
  const m = sh.match(/jq -s '([\s\S]*?)'\s*"\$_plan_cost_json"/);
  expect(m, 'the plan/execute merge filter is no longer where this test reads it from').toBeTruthy();
  const filter = m![1];
  expect(filter, 'the extracted filter is empty, so every assertion below would be vacuous')
    .toMatch(/total_cost_usd/);

  const r = spawnSync('jq', ['-s', filter, planFile, execFile], { encoding: 'utf8' });
  expect(r.status, `jq rejected the script's own filter: ${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout);
}

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'zerocost-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

describe('a fabricated zero shadows the real cost', () => {
  it('THE LIVE RECORD — total_cost_usd 0 alongside cost_usd 0.0164 reports 0.0164', () => {
    // Exactly the agent-mint record the anomaly dump captured.
    const r = parse({ total_cost_usd: 0, cost_usd: 0.0164, usage: { input_tokens: 19785, output_tokens: 1200 } });
    expect(r.costUsd, 'the fabricated zero still outranks the real figure').toBeCloseTo(0.0164, 6);
  });

  it('real precedence is preserved — a positive total_cost_usd still wins', () => {
    const r = parse({ total_cost_usd: 0.5, cost_usd: 0.1 });
    expect(r.costUsd).toBe(0.5);
  });

  it('a genuinely free call is still $0, not an invented number', () => {
    const r = parse({ total_cost_usd: 0, cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } });
    expect(r.costUsd).toBe(0);
  });

  it('falls through the whole alias chain, not just the first pair', () => {
    expect(parse({ total_cost_usd: 0, cost_usd: 0, cost: 0.07 }).costUsd).toBeCloseTo(0.07, 6);
    expect(parse({ total_cost_usd: 0, cost_usd: 0, cost: 0, part: { cost: 0.03 } }).costUsd).toBeCloseTo(0.03, 6);
  });

  it('a negative or non-finite alias is never taken as the cost', () => {
    // Guard the "first POSITIVE" rule against reading garbage as spend.
    expect(parse({ total_cost_usd: -1, cost_usd: 0.02 }).costUsd).toBeCloseTo(0.02, 6);
    expect(parse({ total_cost_usd: 0, cost_usd: 0.02 }).costUsd).toBeCloseTo(0.02, 6);
  });

  it('THE MERGE OMITS THE FIELD rather than writing a zero nobody reported', () => {
    // The other half: stop manufacturing the value at source. Run the real jq the script runs.
    const plan = join(work, 'plan.json');
    const exec = join(work, 'exec.json');
    writeFileSync(plan, JSON.stringify({ tokens: 5 }));
    writeFileSync(exec, JSON.stringify({ cost_usd: 0.0164, tokens: 10 }));

    // THE REAL FILTER, EXTRACTED AND EXECUTED — not a hand-copied paraphrase that could agree
    // with a broken script, and not a source-text match that passes on a comment.
    const merged = runRealMerge(plan, exec);
    expect(merged, 'a total_cost_usd nobody reported was written into the record')
      .not.toHaveProperty('total_cost_usd');
    expect(parseCostRecord(JSON.stringify(merged)).costUsd,
      'the merged record still loses the real cost').toBeCloseTo(0.0164, 6);
  });

  it('the merge still SUMS when the field is genuinely reported', () => {
    // The guard must not turn into "never write the field" — a real plan cost still has to land.
    const plan = join(work, 'plan.json');
    const exec = join(work, 'exec.json');
    writeFileSync(plan, JSON.stringify({ total_cost_usd: 0.01, tokens: 5 }));
    writeFileSync(exec, JSON.stringify({ total_cost_usd: 0.02, tokens: 10 }));
    const merged = runRealMerge(plan, exec);
    expect(merged.total_cost_usd, 'the plan and execute costs no longer add up').toBeCloseTo(0.03, 6);
    expect(merged.tokens, 'token merging was collateral damage').toBe(15);
  });
});
