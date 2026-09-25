/**
 * AN EXHAUSTED ATTEMPT IS CLASSED BY HOW THE RUNNER SAYS IT ENDED — NOT BY WHAT THE MODEL LAST SAID.
 *
 * classify_failure_class recognised iteration exhaustion only when the model's final TEXT contained
 * "maximum iterations". Live 2026-09-24 (regintel REGI-009a) an attempt hit its 120-iteration cap
 * and its last words were "No clear ownership markers…", so it was classed `quality` — "the code is
 * wrong" — and got the ordinary retry instead of the exhaustion path (write-first amendment, the
 * iteration-exhaustion ledger). The runner reports stop_reason structurally; the result now carries
 * it (lib/handlers/epam-run-result.py). Driven through the real classify_failure_class.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellFunction } from '../../lib/engine-source';

const HEAL = join(__dirname, '../../../orchestrations/scripts/lib/failure-healing.sh');
const dirs: string[] = []; afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function classify(result: object, exitCode = 1) {
  const d = mkdtempSync(join(tmpdir(), 'cls-')); dirs.push(d);
  writeFileSync(join(d, 'raw.json'), '{"level":30,"msg":"a real attempt wrote this"}\n');
  writeFileSync(join(d, 'result.json'), JSON.stringify(result));
  writeFileSync(join(d, 'out.log'), 'attempt output\n');
  const r = spawnSync('bash', ['-c', `set -u
log(){ echo "LOG $*"; }; warning(){ echo "WARN $*"; }; error(){ echo "ERR $*"; }
balance_probe_read(){ echo ""; }; render_or_keep(){ echo "AMENDMENT $3"; }
LOG_DIR=${JSON.stringify(d)}; EPAM_BROWNFIELD=0
${shellFunction(HEAL, 'classify_failure_class')}
classify_failure_class ${JSON.stringify(join(d, 'raw.json'))} ${JSON.stringify(join(d, 'result.json'))} ${exitCode} S-1 ${JSON.stringify(join(d, 'out.log'))}
echo "CLASS=$COORDINATOR_FAILURE_CLASS"; echo "AMEND=\${COORDINATOR_PROMPT_AMENDMENT:-}"`], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const ledger = existsSync(join(d, 'iteration-exhaustion.jsonl')) ? readFileSync(join(d, 'iteration-exhaustion.jsonl'), 'utf8') : '';
  return { cls: (out.match(/CLASS=(\S+)/) || [])[1], out, ledger };
}
const liveResult = { result: 'No clear ownership markers. The instructions just say "ingest.py" can be modified if needed.',
  usage: { input_tokens: 11391282, output_tokens: 87309 }, iterations: 120 };

describe('an exhausted attempt is classed by how it ended', () => {
  it('REPRODUCES 2026-09-24: stop_reason max_iterations with an ordinary last sentence is capability, not quality', () => {
    const { cls, ledger, out } = classify({ ...liveResult, stop_reason: 'max_iterations' });
    expect(cls, out).toBe('capability');
    expect(ledger, 'the iteration-exhaustion ledger was not written').toContain('"story_id":"S-1"');
    expect(out).toContain('AMENDMENT turns_exhausted_nothing_written');
  });

  it('the same result with no stop_reason is still quality — a finished attempt that was wrong', () => {
    expect(classify(liveResult).cls).toBe('quality');
  });

  it('the older text signal still works for a runner that reports no stop_reason', () => {
    expect(classify({ ...liveResult, result: 'Agent reached maximum iterations (40) without completing.' }).cls).toBe('capability');
  });
});
