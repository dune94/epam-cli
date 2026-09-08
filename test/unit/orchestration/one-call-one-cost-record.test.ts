/**
 * ONE CALL, ONE COST RECORD.
 *
 * THE LIVE DEFECT (2026-09-08, AMSD-1919 on codemie). Every spec-mode call was recorded TWICE and
 * the ledger reported double the money:
 *
 *   spec-coordinator  $0.2680658  started 00:44:05+00:00  ended 00:44:26.638Z  attempt=None
 *   spec-coordinator  $0.2680658  started 00:43:32.632Z   ended 00:44:26.785Z  attempt=0
 *
 * Identical cost to seven decimals, ended_at 150ms apart — one call, two emitters:
 *   - llm-handler.sh:877 runs lib/handlers/emit-cost.js after every call (the hub), and
 *   - the caller emits too (spec-mode-runner.js:9334, ac-gate.js:77, cpa-inference.js:363),
 *     because only the caller holds the PROMPT the hub never sees.
 *
 * Both read the same ORCH_JSON_RESULT file, so both describe the SAME call. Run total read
 * $14.5179 against ~$7.26 of real spend, and Langfuse got duplicate generations to match.
 *
 * Neither call site can simply be deleted — the caller has the input, the hub has the coverage.
 * So emission is made IDEMPOTENT per call: whoever writes first wins, the second is a no-op, and
 * a genuinely new call through the same path still records because the result content differs.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { emitCostSnapshot } = require(join(process.cwd(), 'orchestrations/scripts/lib/cost-emitter.js'));
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

/** A runner result in the shape the emitter parses. */
const result = (cost: number, out: number) => JSON.stringify({
  type: 'result', subtype: 'success', total_cost_usd: cost, result: 'ok',
  usage: { input_tokens: 100, output_tokens: out, cache_read_input_tokens: 5000 },
});

function setup(cost = 0.25, out = 40) {
  const d = tmp('cost-');
  const resultFile = join(d, 'result.json');
  const ledger = join(d, 'phase-cost.jsonl');
  const activity = join(d, 'agent-activity.jsonl');
  writeFileSync(resultFile, result(cost, out));
  return { d, resultFile, ledger, activity };
}
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);

describe('cost emission', () => {
  it('THE DEFECT: the same call emitted twice writes ONE ledger record, not two', () => {
    const { d, resultFile, ledger, activity } = setup();
    const args = { resultFile, activityFile: activity, ledgerFile: ledger, logDir: d,
                   agent: 'spec-coordinator', model: 'claude-sonnet-5', phase: 'core' };
    emitCostSnapshot({ ...args, startedAt: '2026-09-08T00:43:32.632Z' });   // the caller
    emitCostSnapshot({ ...args, startedAt: '2026-09-08T00:44:05+00:00' });  // the hub

    expect(lines(ledger).length, 'the ledger counted one call twice — the run reported $14.52 '
      + 'against ~$7.26 of real spend').toBe(1);
  });

  it('and ONE activity event, so Langfuse does not receive a duplicate generation', () => {
    const { d, resultFile, ledger, activity } = setup();
    const args = { resultFile, activityFile: activity, ledgerFile: ledger, logDir: d,
                   agent: 'ticket-links', model: 'claude-sonnet-5' };
    emitCostSnapshot({ ...args, startedAt: 'a' });
    emitCostSnapshot({ ...args, startedAt: 'b' });
    expect(lines(activity).filter((l) => l.includes('cost_snapshot')).length).toBe(1);
  });

  it('THE INPUT SURVIVES: the emitter that has the prompt is not the one discarded', () => {
    // The caller emits with the prompt; the hub cannot see it. Whichever runs first, the record
    // that lands must keep the richer input rather than an empty one.
    const { d, resultFile, ledger, activity } = setup();
    const args = { resultFile, activityFile: activity, ledgerFile: ledger, logDir: d,
                   agent: 'spec-agent', model: 'claude-sonnet-5' };
    // The prompt does not live in the activity event — buildCostSnapshot never carries it; it
    // reaches Langfuse as the generation's input. What must hold here is that the emit WITH the
    // prompt is not silently dropped: it supersedes the input-less one (returns a record) while
    // the ledger still holds exactly one row for the call.
    const first = emitCostSnapshot({ ...args, input: '', startedAt: 'hub-first' });
    const second = emitCostSnapshot({ ...args, input: 'THE REAL PROMPT', startedAt: 'caller-second' });
    expect(first, 'the first emit recorded nothing').toBeTruthy();
    expect(second, 'the emit carrying the prompt was discarded as a duplicate, so Langfuse gets '
      + 'a generation with no input — the very gap this pipeline was fixed for once').toBeTruthy();
    expect(lines(ledger).length, 'superseding wrote a second row instead of replacing').toBe(1);
    expect(lines(activity).filter((l) => l.includes('cost_snapshot')).length,
      'superseding left two activity events').toBe(1);
  });

  it('a DIFFERENT call through the same path still records', () => {
    const { d, resultFile, ledger, activity } = setup(0.25, 40);
    const args = { resultFile, activityFile: activity, ledgerFile: ledger, logDir: d,
                   agent: 'spec-agent', model: 'claude-sonnet-5' };
    emitCostSnapshot({ ...args, startedAt: 'first' });
    writeFileSync(resultFile, result(0.99, 900));          // the next call reuses the same path
    emitCostSnapshot({ ...args, startedAt: 'second' });
    expect(lines(ledger).length, 'a genuinely new call was swallowed as a duplicate').toBe(2);
  });

  it('two DIFFERENT agents on one result file are both recorded', () => {
    const { d, resultFile, ledger, activity } = setup();
    const args = { resultFile, activityFile: activity, ledgerFile: ledger, logDir: d,
                   model: 'claude-sonnet-5' };
    emitCostSnapshot({ ...args, agent: 'spec-agent', startedAt: 'x' });
    emitCostSnapshot({ ...args, agent: 'spec-agent:plan', startedAt: 'y' });
    expect(lines(ledger).length, 'a second agent was mistaken for a duplicate').toBe(2);
  });
});
