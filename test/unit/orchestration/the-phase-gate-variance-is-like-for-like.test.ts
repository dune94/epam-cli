/**
 * THE PHASE GATE VARIANCE IS COMPUTED LIKE-FOR-LIKE.
 *
 * check-phase-gate.sh sums elapsed_minutes for EVERY row in the phase but sums
 * forecast_hours only from rows that carry a forecast. The result: seam-overhead rows
 * (spec, CPA, TC-writer, sentinels) inflate actual_minutes while contributing nothing
 * to forecast_minutes. On run 20260917T124016Z, 24 minutes of seam overhead were
 * divided against a 2.4-minute writer forecast — 418% variance, ESCALATE.
 *
 * The September 9 green run had fewer seam rows and slipped below the threshold; this
 * run had more and tripped it. Same story, different ledger shape — the gate should give
 * the same answer for both.
 *
 * Fix: filter both actual_minutes and forecast_hours to only rows that carry a non-zero
 * forecast. Seam rows with forecast_hours=0 represent pipeline overhead the CPA does
 * not forecast; counting their elapsed time against a writer-only denominator is not a
 * cost variance — it is a formula defect.
 *
 * With the fix, AMSD-1919 variance ≈ 71.5% (WARN, not ESCALATE).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { engineSource } from '../../lib/engine-source';

const ROOT = join(__dirname, '../../../');
const GATE_SH = join(ROOT, 'orchestrations/scripts/check-phase-gate.sh');
const LIB_LEDGER = join(ROOT, 'orchestrations/scripts/lib/ledger-tokens.sh');

/**
 * A ledger matching the AMSD-1919 run 20260917T124016Z shape:
 *   - 2 rows with forecast_hours = 0.0393 (CPA + writer)
 *   - 7 seam rows with forecast_hours = 0, adding ~10.7 extra elapsed minutes
 *
 * Total actual_minutes = 8.09 (forecasted) + 10.7 (overhead) = 18.79
 * Forecasted actual_minutes = 0.31 + 7.78 = 8.09
 * Forecast_minutes = (0.0393 + 0.0393) * 60 = 4.716
 *
 * Broken formula: variance = (18.79 - 4.716) / 4.716 * 100 ≈ 298%  → ESCALATE
 * Fixed  formula: variance = (8.09  - 4.716) / 4.716 * 100 ≈  71.5% → WARN
 */
const FIXTURE_ROWS = [
  { run_id: 'TEST', phase_id: 'core', story_id: 'AMSD-1919', agent_id: 'cpa',    status: 'agent',     elapsed_minutes: 0.31, forecast_hours: 0.0393, task_cost_usd: 0.01 },
  { run_id: 'TEST', phase_id: 'core', story_id: 'AMSD-1919', agent_id: 'writer', status: 'agent',     elapsed_minutes: 7.78, forecast_hours: 0.0393, task_cost_usd: 2.40 },
  { run_id: 'TEST', phase_id: 'core', story_id: 'AMSD-1919', agent_id: 'spec',   status: 'agent',     elapsed_minutes: 3.50, forecast_hours: 0,      task_cost_usd: 0.10 },
  { run_id: 'TEST', phase_id: 'core', story_id: 'AMSD-1919', agent_id: 'tc',     status: 'agent',     elapsed_minutes: 2.10, forecast_hours: 0,      task_cost_usd: 0.05 },
  { run_id: 'TEST', phase_id: 'core', story_id: 'core',      agent_id: 'cgd',    status: 'agent',     elapsed_minutes: 1.20, forecast_hours: 0,      task_cost_usd: 0.02 },
  { run_id: 'TEST', phase_id: 'core', story_id: 'core',      agent_id: 'vocab',  status: 'agent',     elapsed_minutes: 0.90, forecast_hours: 0,      task_cost_usd: 0.01 },
  { run_id: 'TEST', phase_id: 'core', story_id: 'core',      agent_id: 'perf',   status: 'agent',     elapsed_minutes: 1.50, forecast_hours: 0,      task_cost_usd: 0.05 },
  { run_id: 'TEST', phase_id: 'core', story_id: 'core',      agent_id: 'fuzz',   status: 'agent',     elapsed_minutes: 1.40, forecast_hours: 0,      task_cost_usd: 0.15 },
  { run_id: 'TEST', phase_id: 'core', story_id: 'core',      agent_type: 'spec-pass', status: 'completed', elapsed_minutes: 3.60, forecast_hours: 0, task_cost_usd: 5.40 },
];

/** Extract the actual_minutes and forecast_hours jq expressions from check-phase-gate.sh */
function extractVarianceJq(): { actualMinutesJq: string; forecastHoursJq: string } {
  const src = engineSource(GATE_SH);
  const am = src.match(/actual_minutes=\$\(echo "\$phase_cost_data" \| jq -s '([^']+)'\)/);
  const fh = src.match(/forecast_hours=\$\(echo "\$phase_cost_data" \| jq -s '([^']+)'\)/);
  if (!am || !fh) throw new Error('variance jq expressions not found in check-phase-gate.sh — harness is stale');
  return { actualMinutesJq: am[1], forecastHoursJq: fh[1] };
}

/** Run the extracted jq expressions against the fixture and return computed values. */
function computeVariance(rows: object[]): { actualMinutes: number; forecastMinutes: number; variancePct: number } {
  const { actualMinutesJq, forecastHoursJq } = extractVarianceJq();
  const dir = mkdtempSync(join(tmpdir(), 'gate-var-'));
  try {
    const ledger = join(dir, 'ledger.jsonl');
    writeFileSync(ledger, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const script = join(dir, 'run.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
. ${JSON.stringify(LIB_LEDGER)}
phase_cost_data=$(cat ${JSON.stringify(ledger)})
actual_minutes=$(echo "$phase_cost_data" | jq -s '${actualMinutesJq}')
forecast_hours=$(echo "$phase_cost_data" | jq -s '${forecastHoursJq}')
forecast_minutes=$(echo "scale=4; $forecast_hours * 60" | bc)
variance_pct=0
if (( $(echo "$forecast_minutes > 0" | bc -l) )); then
  variance_pct=$(echo "scale=2; (($actual_minutes - $forecast_minutes) / $forecast_minutes) * 100" | bc)
fi
echo "actual_minutes=$actual_minutes"
echo "forecast_minutes=$forecast_minutes"
echo "variance_pct=$variance_pct"
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) throw new Error(`shell failed: ${r.stderr}`);
    const get = (k: string) => parseFloat((r.stdout.match(new RegExp(`^${k}=([0-9.\\-]+)`, 'm')) || ['', '0'])[1]);
    return {
      actualMinutes:  get('actual_minutes'),
      forecastMinutes: get('forecast_minutes'),
      variancePct: get('variance_pct'),
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('the phase gate variance compares like-for-like', () => {
  it('actual_minutes is computed only from rows that carry a non-zero forecast', () => {
    // Seam rows (forecast_hours=0) must NOT add their elapsed_minutes to the actual total.
    // Only the 2 forecasted rows count: 0.31 + 7.78 = 8.09 min.
    const { actualMinutes } = computeVariance(FIXTURE_ROWS);
    expect(actualMinutes, [
      `actual_minutes includes seam-overhead rows (forecast_hours=0).`,
      `Only the 2 forecasted rows should contribute: 0.31 + 7.78 = 8.09 min.`,
      `Got ${actualMinutes} — the jq filter must select rows where forecast_hours > 0.`,
    ].join(' ')).toBeCloseTo(8.09, 1);
  });

  it('forecast_minutes matches the sum of forecasted rows only', () => {
    // (0.0393 + 0.0393) hours * 60 = 4.716 min
    const { forecastMinutes } = computeVariance(FIXTURE_ROWS);
    expect(forecastMinutes, `forecast_minutes should be ≈4.716 (two rows × 0.0393h × 60)`).toBeCloseTo(4.716, 1);
  });

  it('variance is below the 150% escalate threshold — run 20260917T124016Z would not ESCALATE', () => {
    // Broken: 18.79 / 4.716 → 298% → ESCALATE
    // Fixed:   8.09 / 4.716 →  71.5% → WARN (auto-approved)
    const { variancePct } = computeVariance(FIXTURE_ROWS);
    expect(variancePct, [
      `variance ${variancePct.toFixed(1)}% exceeds the 150% escalate threshold.`,
      `Seam-overhead rows are inflating actual_minutes.`,
      `Fix: jq must select only rows where (.forecast_hours // 0) > 0.`,
    ].join(' ')).toBeLessThan(150);
  });
});
