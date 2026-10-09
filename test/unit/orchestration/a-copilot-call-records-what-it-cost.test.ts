/**
 * A COPILOT CALL RECORDS WHAT IT COST — the billed AI credits Copilot reports, as dollars.
 *
 * Live AMSD-2974 run 2 (2026-10-09): 116 calls, 15.1M input tokens, $0.00 in phase-cost.jsonl. Copilot writes the
 * session's billed usage in its own record (session.shutdown: totalNanoAiu — nano AI credits, 1 credit = $0.01) and
 * copilot-result.js wrote `total_cost_usd: 0` over it. The CPA estimate priced from that ledger came out $0 and its
 * reviewer rightly rejected it.
 *
 * EXECUTED: the real copilot-result.js judgeCall on a real session record (fixture: a 4-request Haiku 4.5 session from
 * this run — 6,006,790,000 nano credits = $0.0601, which is Haiku's published $1/$5 per 1M across its input, cache
 * reads, cache writes and output). The credit rate is read from the copilot set's declaration, never a number in code.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { judgeCall } = require(join(ROOT, 'orchestrations/plugins/providers/copilot/copilot-result.js'));
const FIXTURE = join(ROOT, 'test/fixtures/copilot-session/haiku-4-requests.events.jsonl');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function judged() {
  const home = mkdtempSync(join(tmpdir(), 'copilot-home-')); dirs.push(home);
  const session = join(home, 'session-state', 'sess-1'); mkdirSync(session, { recursive: true });
  copyFileSync(FIXTURE, join(session, 'events.jsonl'));
  const user = readFileSync(FIXTURE, 'utf8').split('\n').find((l) => l.includes('"user.message"'))!;
  // The CLI's own stdout: the user message it echoed and the answer it streamed.
  const stdout = [user, JSON.stringify({ type: 'assistant.message', data: { content: 'ok', outputTokens: 10 } }), JSON.stringify({ type: 'assistant.turn_end' })].join('\n');
  return judgeCall(stdout, '', join(home, 'session-state'));
}

describe('a copilot call records what it cost', () => {
  it('the billed AI credits, as dollars — real, not an estimate', () => {
    const r = judged();
    expect(r.total_cost_usd).toBeCloseTo(0.0600679, 6);
    expect(r.cost_is_estimate).toBe(false);
  });
  it('cache reads and writes are recorded beside input and output (they are billed differently)', () => {
    const r = judged();
    expect(r.usage).toMatchObject({ input_tokens: 69176, output_tokens: 2573, cache_read_input_tokens: 34139, cache_creation_input_tokens: 35008 });
  });
  it('a session with no usage record stays unknown, never a confident $0', () => {
    const r = judgeCall(JSON.stringify({ type: 'assistant.message', data: { content: 'ok', outputTokens: 5 } }), '', '');
    expect(r.total_cost_usd).toBe(0);
    expect(r.cost_is_estimate).not.toBe(false);
  });
});

describe('the cost emitter records it', () => {
  it('parseCostRecord reads the dollars and the cache tokens from the judged result', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { parseCostRecord } = require(join(ROOT, 'orchestrations/scripts/lib/cost-emitter.js'));
    const c = parseCostRecord(JSON.stringify(judged()));
    expect(c.costUsd).toBeCloseTo(0.0600679, 6);
    expect(c.costUnknown).toBe(false);
    expect(c.costIsEstimate).toBe(false);
    expect(c.tokensCached).toBe(34139);
    expect(c.tokensCacheCreate).toBe(35008);
  });
});
