/**
 * runClaude output salvage — don't discard a complete result when the process
 * exits non-zero/null.
 *
 * Found LIVE (2026-07-23, AMSD-1820 confirmation run): the code-graph-detective
 * emitted its perfect fix-site JSON to stdout, then its runner process exited
 * with code null (killed during teardown — a detached grandchild like the
 * codegraph binary disturbing the process group). runClaude rejected on the
 * non-zero exit and threw the already-captured JSON away, so the implementer got
 * no root cause. The detective's own loud-retry correctly flagged it — but the
 * real finding was right there and lost.
 *
 * Fix: opt-in `salvageOutputOnFailure` — when the caller allows it AND output was
 * captured, resolve with it (the caller's parser validates). Off by default so
 * other callers keep strict reject-on-failure.
 *
 * Real subprocess execution (a stub command that prints then exits non-zero) —
 * not a mock of the exit semantics.
 */
import { describe, it, expect } from 'vitest';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { runClaude } = spec;

// A stub "runner": prints the given text to stdout, then exits with the given code.
const stub = (text: string, code: number) => ({
  cmd: 'bash',
  args: ['-c', `printf '%s' ${JSON.stringify(text)}; exit ${code}`],
});

const FIX_JSON = '[{"file":"src/services/apply-report-discounts.service.ts","helper":"parseDispatchLineItemKey"}]';

describe('runClaude — salvageOutputOnFailure', () => {
  it('resolves with the captured output when the process exits non-zero AND salvage is on', async () => {
    const out = await runClaude(stub(FIX_JSON, 1), 'p', null, {}, { salvageOutputOnFailure: true });
    expect(out).toContain('apply-report-discounts.service.ts');
    expect(out).toContain('parseDispatchLineItemKey');
  });

  it('still REJECTS a non-zero exit when salvage is off (default — strict semantics preserved)', async () => {
    await expect(runClaude(stub(FIX_JSON, 1), 'p', null, {})).rejects.toThrow(/exited with code/);
  });

  it('resolves normally on a clean exit regardless of the salvage flag', async () => {
    const out = await runClaude(stub(FIX_JSON, 0), 'p', null, {}, { salvageOutputOnFailure: true });
    expect(out).toContain('parseDispatchLineItemKey');
  });

  it('does not salvage when there is no output to salvage (empty → still rejects)', async () => {
    await expect(runClaude(stub('', 1), 'p', null, {}, { salvageOutputOnFailure: true }))
      .rejects.toThrow(/exited with code/);
  });
});
