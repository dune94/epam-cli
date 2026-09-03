/**
 * ABSENCE OF "fail" IS NOT SUCCESS.
 *
 * The e2e route gate read its own log like this:
 *
 *     if   grep -q '"verdict": *"fail"'  -> FAIL
 *     elif grep -q '"verdict": *"warn"'  -> WARN
 *     else                                  success "PASS"
 *
 * so an empty log, a truncated reply, an unparseable answer, or a verdict this gate has never
 * emitted all arrived as a PASS — announced to the operator in the same words as a gate that ran
 * and approved the work. Nobody wrote "pass"; it was inferred from the absence of "fail".
 *
 * qa-gate:e2e was the seam with the fewest tests naming it in the whole registry: zero.
 *
 * These execute the real reader against real files.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(__dirname, '../..');
const LIB = join(REPO, 'orchestrations/scripts/lib/gate-verdicts.sh');
const ORCH = join(REPO, 'orchestrations/scripts/run-agent-orchestration.sh');

/** Run the real reader over a log with the given contents. */
function verdictOf(contents: string | null): string {
  const work = mkdtempSync(join(tmpdir(), 'qa-verdict-'));
  const log = join(work, 'story.log');
  if (contents !== null) writeFileSync(log, contents);
  const r = spawnSync('bash', ['-c', `
    . ${JSON.stringify(LIB)}
    qa_gate_verdict_of ${JSON.stringify(log)}
  `], { encoding: 'utf8', timeout: 60000, cwd: REPO });
  return (r.stdout ?? '').trim();
}

describe('absence of "fail" is not success', () => {
  it('reads the verdicts a gate really emits', () => {
    expect(verdictOf('{"verdict": "fail", "issues": []}')).toBe('fail');
    expect(verdictOf('{"verdict": "warn"}')).toBe('warn');
    expect(verdictOf('{"verdict": "pass"}')).toBe('pass');
  }, 60_000);

  it('an empty log is not a pass', () => {
    expect(verdictOf(''), 'an empty log was read as an approval').toBe('unknown');
  }, 60_000);

  it('a missing log is not a pass', () => {
    // The gate crashed before writing anything. Previously indistinguishable from success.
    expect(verdictOf(null), 'a gate that wrote no log at all was read as an approval')
      .toBe('unknown');
  }, 60_000);

  it('an unparseable reply is not a pass', () => {
    expect(verdictOf('the browser could not start; I was unable to check the route'),
      'prose with no verdict was read as an approval').toBe('unknown');
  }, 60_000);

  it('a verdict this gate has never emitted is not a pass', () => {
    // Fails safe in the direction that matters: a new outcome added upstream must not silently
    // become an approval.
    expect(verdictOf('{"verdict": "error"}')).toBe('unknown');
    expect(verdictOf('{"verdict": "inconclusive"}')).toBe('unknown');
  }, 60_000);

  it('and the call site treats unknown as a failure, not as a pass', () => {
    // The receiver. A correct reader that the caller ignores changes nothing.
    const src = readFileSync(ORCH, 'utf8');
    expect(src, 'the e2e gate no longer consults the reader')
      .toMatch(/case "\$\(qa_gate_verdict_of "\$story_log"\)" in/);
    const block = src.slice(src.indexOf('qa_gate_verdict_of "$story_log"'));
    const arm = block.slice(0, block.indexOf('esac'));
    expect(arm, 'the catch-all arm does not fail the story')
      .toMatch(/\*\)[\s\S]*?failed=1/);
    expect(arm, 'the catch-all arm reports a pass').not.toMatch(/\*\)[\s\S]*?success /);
  });
});
