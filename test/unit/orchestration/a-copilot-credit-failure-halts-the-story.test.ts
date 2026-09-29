/**
 * A COPILOT CALL THAT RAN OUT OF CREDIT HALTS THE STORY — IT DOES NOT CLIMB.
 *
 * The credit class (halt, no escalation) fired only when a provider set's BALANCE PROBE read ~0; the
 * copilot set has no balance probe (premium requests are not a dollar balance), so an exhausted account
 * would have been classed like any other failure and the ladder climbed — every rung on the same account,
 * every rung failing the same way (the MiniMax 402s of regintel run 20260926T125158Z burned attempts the
 * same way). The call's own result now says why it failed (plugins/providers/copilot/copilot-result.js: error.class), and the
 * classifier reads that first.
 *
 * Executed: the real classify_failure_class (lib/failure-healing.sh) on the result the real normaliser
 * writes for the Copilot CLI's captured 402 output. The negative: a claude-shaped error result, which
 * carries no error.class, is classified exactly as before.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const HEAL = join(ROOT, 'orchestrations/scripts/lib/failure-healing.sh');
const NORMALISE = join(ROOT, 'orchestrations/plugins/providers/copilot/copilot-result.js');
const F = (n: string) => join(ROOT, 'test/fixtures/copilot', n);

function classify(resultJson: string) {
  const d = mkdtempSync(join(tmpdir(), 'classify-'));
  try {
    const log = join(d, 'attempt.log'); writeFileSync(log, 'attempt output\n');
    const raw = join(d, 'raw.json'); writeFileSync(raw, '{"x":1}');
    const script = [
      'log(){ :; }; warning(){ echo "W: $*" >&2; }; error(){ echo "E: $*" >&2; }; info(){ :; }; success(){ :; }',
      'balance_probe_read(){ return 1; }',
      `. ${JSON.stringify(HEAL)} 2>/dev/null`,
      `classify_failure_class ${JSON.stringify(raw)} ${JSON.stringify(resultJson)} 1 S-1 ${JSON.stringify(log)}`,
      'echo "CLASS=$COORDINATOR_FAILURE_CLASS ESCALATE=$COORDINATOR_ESCALATE"',
    ].join('\n');
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, LOG_DIR: d } });
    return { out: r.stdout.trim(), err: r.stderr };
  } finally { rmSync(d, { recursive: true, force: true }); }
}

describe('a copilot call that ran out of credit', () => {
  it('is class credit and does not escalate', () => {
    const d = mkdtempSync(join(tmpdir(), 'cp402-'));
    try {
      const result = join(d, 'result.json');
      spawnSync(process.execPath, [NORMALISE, F('402.jsonl'), F('empty.stderr'), result]);
      const r = classify(result);
      expect(r.out).toBe('CLASS=credit ESCALATE=no');
      expect(r.err).toMatch(/credit/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('a result that names no class is classified as before', () => {
  it('a claude-shaped error result is not read as credit', () => {
    const d = mkdtempSync(join(tmpdir(), 'claude-err-'));
    try {
      const result = join(d, 'result.json');
      writeFileSync(result, JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', usage: { input_tokens: 10, output_tokens: 0 } }));
      expect(classify(result).out).not.toMatch(/CLASS=credit/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
