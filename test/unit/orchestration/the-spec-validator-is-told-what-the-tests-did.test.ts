/**
 * THE SPEC VALIDATOR IS TOLD WHAT THE TESTS DID.
 *
 * AMSD-2974 run 9, resume 10 (2026-10-13 11:58Z): the cxshared 7.x back-port failed its testing gates on the spec
 * validator. Its test oracle (lib/gates-testing.sh) ran the codeline's own suite — jest, bounded — and saved the plain
 * output, but summarised only a vitest JSON report, so the validator was told "(vitest ran but produced no JSON output
 * — exit code 1)" and scored the story's tests as unverified. jest's own output said: 724 passed; the only failing
 * files were the two the phase baseline already records as failing before any story work.
 *
 * EXECUTED: _oracle_summary_from_plain on plain runner output with the real _parse_failing_test_files
 * (run-agent-orchestration.sh) and a baseline-failures file as the pipeline writes it. NEGATIVE: a failure that is NOT
 * in the baseline is reported as new — the summary must never launder a regression into "pre-existing".
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellFunction } from '../../lib/engine-source';

const S = join(__dirname, '../../../orchestrations/scripts');
const FNS = [
  shellFunction(join(S, 'run-agent-orchestration.sh'), '_parse_failing_test_files'),
  shellFunction(join(S, 'lib/gates-testing.sh'), '_oracle_summary_from_plain'),
].join('\n');

const BASE_A = 'src/components/DatePicker/__tests__/DatePicker.spec.tsx';
const BASE_B = 'src/components/AdvancedDatePicker/__tests__/AdvancedDatePicker.spec.tsx';
const NEW_F = 'src/components/ToastNotification/__tests__/Toast.spec.tsx';

function summary(failing: string[], rc: number) {
  const d = mkdtempSync(join(tmpdir(), 'oracle-'));
  const out = join(d, 'oracle.json.txt');
  writeFileSync(out, [
    ...failing.map((f) => `FAIL ${f} (1.2 s)`),
    'PASS src/components/Button/__tests__/Button.spec.tsx',
    `Test Suites: ${failing.length} failed, 194 passed, ${194 + failing.length} total`,
  ].join('\n'));
  writeFileSync(join(d, 'baseline-failures-test-1209e3e786f3.txt'), `${BASE_A}\n${BASE_B}\n`);
  const r = spawnSync('bash', ['-c', `${FNS}\n_oracle_summary_from_plain ${JSON.stringify(out)} ${rc} ${JSON.stringify(d)}`], { encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
}

describe('the spec validator is told what the tests did', () => {
  it('failures that are all in the phase baseline are reported as pre-existing, with no new failure', () => {
    const s = summary([BASE_A, BASE_B], 1);
    expect(s).not.toMatch(/vitest ran but produced no JSON/);
    expect(s).toMatch(/pre-existing/i);
    expect(s).toContain(BASE_A);
    expect(s).toMatch(/new failing test files: 0/i);
  });

  it('NEGATIVE: a failing file outside the baseline is named as NEW', () => {
    const s = summary([BASE_A, NEW_F], 1);
    expect(s).toMatch(/new failing test files: 1/i);
    expect(s).toContain(NEW_F);
  });

  it('a clean run says so', () => {
    expect(summary([], 0)).toMatch(/no failing test files/i);
  });
});
