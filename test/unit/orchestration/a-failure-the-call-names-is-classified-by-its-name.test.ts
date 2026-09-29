/**
 * A FAILURE THE CALL'S OWN RESULT NAMES IS CLASSIFIED BY THAT NAME.
 *
 * The copilot and codemie-web runners keep no raw stream; their result says why a call failed
 * (error.class). Before 2026-09-28 the classifier read that only for `credit`, then found no raw file
 * and called every other failure UNKNOWN — and a signed-out session climbed the whole ladder, every
 * rung refused the same way.
 *
 * Executed: the real classify_failure_class (lib/failure-healing.sh) on results written by the real
 * codemie-web judge (plugins/providers/codemie-web/result.js) from the errors the CodeMie SDK throws.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const HEAL = join(ROOT, 'orchestrations/scripts/lib/failure-healing.sh');
const JUDGE = join(ROOT, 'orchestrations/plugins/providers/codemie-web/result.js');

/** The result the codemie-web runner writes for a call that threw `err` (an SDK ApiError's shape). */
function judged(dir: string, err: { statusCode?: number; message: string }): string {
  const out = join(dir, 'result.json');
  const r = spawnSync(process.execPath, ['-e', `const {judge}=require(${JSON.stringify(JUDGE)});require('fs').writeFileSync(${JSON.stringify(out)},JSON.stringify(judge({err:${JSON.stringify(err)},model:'claude-sonnet-5'})))`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return out;
}

/** classify_failure_class as the story attempt calls it — with NO raw file, as these runners leave. */
function classify(dir: string, resultJson: string) {
  const log = join(dir, 'attempt.log'); writeFileSync(log, 'attempt output\n');
  const script = [
    'log(){ :; }; warning(){ echo "W: $*" >&2; }; error(){ echo "E: $*" >&2; }; info(){ :; }; success(){ :; }',
    'balance_probe_read(){ return 1; }',
    `. ${JSON.stringify(HEAL)} 2>/dev/null`,
    `classify_failure_class "" ${JSON.stringify(resultJson)} 1 S-1 ${JSON.stringify(log)}`,
    'echo "CLASS=$COORDINATOR_FAILURE_CLASS ESCALATE=$COORDINATOR_ESCALATE"',
  ].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, LOG_DIR: dir } });
  return { out: r.stdout.trim(), err: r.stderr };
}

const inDir = <T>(f: (d: string) => T): T => { const d = mkdtempSync(join(tmpdir(), 'named-class-')); try { return f(d); } finally { rmSync(d, { recursive: true, force: true }); } };

describe('a failure the call names', () => {
  it('a signed-out session (401) is class auth and halts — every rung would be refused the same way', () => inDir((d) => {
    const r = classify(d, judged(d, { statusCode: 401, message: 'Unauthorized' }));
    expect(r.out).toBe('CLASS=auth ESCALATE=no');
    expect(r.err).toMatch(/not authorised/);
  }));

  it('an out-of-credit account (402) still halts as credit', () => inDir((d) => {
    expect(classify(d, judged(d, { statusCode: 402, message: 'budget exceeded' })).out).toBe('CLASS=credit ESCALATE=no');
  }));

  it('a transient failure keeps its name and may climb — it is evidence, not an unknown', () => inDir((d) => {
    expect(classify(d, judged(d, { statusCode: 503, message: 'Service Unavailable' })).out).toBe('CLASS=transient ESCALATE=yes');
  }));

  it('a result that names nothing, with no raw stream, is still UNKNOWN — nothing is invented', () => inDir((d) => {
    const result = join(d, 'result.json');
    writeFileSync(result, JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', usage: { input_tokens: 10, output_tokens: 0 } }));
    expect(classify(d, result).out).toBe('CLASS=unknown ESCALATE=yes');
  }));
});
