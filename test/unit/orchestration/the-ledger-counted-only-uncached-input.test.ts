/**
 * THE CALIBRATION COUNTED 9 TOKENS WHERE THE CALL USED 31,417.
 *
 * `task_tokens_in` is `.usage.input_tokens` from the provider, and for a CACHED request that is
 * only the UNCACHED remainder — the rest arrives as cache_read_input_tokens and
 * cache_creation_input_tokens. Measured live 2026-09-09 with a ~2,800-word prompt on
 * claude-haiku-4-5:
 *
 *     input_tokens                :      9
 *     cache_creation_input_tokens : 13,857
 *     cache_read_input_tokens     : 17,551
 *     output_tokens               :    531
 *
 * So the ledger's measurement is CORRECT and complete — it records all three input classes. What
 * is wrong is a consumer that reads one of them as if it were the total:
 *
 *     estimate-stories.sh:237
 *       tier_tokens = (.task_tokens_in // 0) + (.task_tokens_out // 0)
 *
 * That feeds TOKENS_PER_MIN_LOW/MED/HIGH, the constants every future story estimate is derived
 * from. On the row above it counts 540 tokens instead of 31,948 — a 98.3% undercount — so the
 * pipeline believes it produces ~60x fewer tokens per minute than it does, and forecasts
 * accordingly. Live ledger for run 20260908T215555Z: 20 completed rows, 26 carrying the
 * forecast_hours/elapsed_minutes this block filters on, so it is calibrating, not dormant.
 *
 * Fixed by summing what the row already records rather than by adding a field: nothing new is
 * measured, nothing is estimated, and the per-class figures stay separate because they are priced
 * differently (cache read ~0.1x, cache write 1.25-2.0x).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const LIB = join(ROOT, 'orchestrations/scripts/lib/ledger-tokens.sh');

/** The exact usage shape the live probe returned, as the ledger writes it. */
const CACHED_ROW = {
  status: 'completed', forecast_hours: 1, elapsed_minutes: 2,
  task_tokens_in: 9, cache_creation_input_tokens: undefined,
  cache_create_tokens: 13857, cache_read_tokens: 17551, task_tokens_out: 531,
};
/** An older row from a writer that records no cache fields at all — 91% coverage in the wild. */
const UNCACHED_ROW = {
  status: 'completed', forecast_hours: 1, elapsed_minutes: 1,
  task_tokens_in: 4000, task_tokens_out: 1000,
};

function run(rows: object[], filter = '.') {
  const d = mkdtempSync(join(tmpdir(), 'ltok-'));
  const f = join(d, 'rows.jsonl');
  writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const script = join(d, 'run.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
source "${LIB}"
cat "${f}" | ledger_total_tokens '${filter}'
`);
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30_000 });
  rmSync(d, { recursive: true, force: true });
  return { out: (r.stdout ?? '').trim(), err: r.stderr ?? '', status: r.status };
}

beforeAll(() => { expect(existsSync(LIB), `${LIB} missing`).toBe(true); });

describe('ledger_total_tokens — every class the row records', () => {
  it('counts cached input, not just the uncached remainder', () => {
    const r = run([CACHED_ROW]);
    expect(r.status, r.err).toBe(0);
    // 9 + 13857 + 17551 + 531
    expect(Number(r.out)).toBe(31948);
    // The bug this replaces, named so a regression is unmistakable.
    expect(Number(r.out), 'still counting only the uncached remainder').not.toBe(540);
  });

  it('still works on rows that carry no cache fields at all', () => {
    const r = run([UNCACHED_ROW]);
    expect(Number(r.out)).toBe(5000);
  });

  it('sums a mixed ledger — the real shape, where only some rows have cache fields', () => {
    const r = run([CACHED_ROW, UNCACHED_ROW]);
    expect(Number(r.out)).toBe(31948 + 5000);
  });

  it('applies the caller\'s tier filter rather than summing everything', () => {
    const low = { ...CACHED_ROW, forecast_hours: 1 };
    const high = { ...UNCACHED_ROW, forecast_hours: 9 };
    const r = run([low, high], 'select((.forecast_hours // 0) <= 2)');
    expect(Number(r.out), 'the filter was ignored').toBe(31948);
  });

  it('returns 0 for no rows rather than erroring or printing nothing', () => {
    const r = run([]);
    expect(r.status, r.err).toBe(0);
    expect(Number(r.out)).toBe(0);
  });
});
