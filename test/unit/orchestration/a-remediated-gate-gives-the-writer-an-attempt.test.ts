/**
 * A REMEDIATED GATE GIVES THE WRITER AN ATTEMPT.
 *
 * AMSD-2974 run 9, resume 13 (2026-10-13 14:14Z): the mutant-hunter gate failed on two surviving mutations; gate
 * self-heal mapped the finding to AMSD-2974, added 2 ACs and returned "remediated, retry". The lane retried — and the
 * writer stopped at once: "resuming at retry_count=12 … Failed to implement AMSD-2974 after 12 attempts", $0, no model
 * call. The story's persisted count was past MAX_RETRIES from earlier in the run, and the writer loops only while
 * retry_count <= MAX_RETRIES (lib/story-attempt.sh). Review remediation already gives an exhausted story one more
 * top-rung attempt when it adds requirements (lib/review-cycle.sh); gate remediation did not.
 *
 * EXECUTED: the real grant_remediated_attempt (lib/story-retry-state.sh) on a real retry-state directory, and the
 * writer's own loop condition read back from the persisted count. NEGATIVE: a story with attempts left is untouched.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S = join(__dirname, '../../../orchestrations/scripts');

function after(start: number, max: number) {
  const d = mkdtempSync(join(tmpdir(), 'gate-grant-'));
  const r = spawnSync('bash', ['-c', [
    'set -uo pipefail', `. "${S}/lib/story-retry-state.sh"`,
    `write_story_retry_count "${d}" S-1 ${start}`,
    `grant_remediated_attempt "${d}" S-1 ${max}`,
    `c=$(read_story_retry_count "${d}" S-1); printf 'COUNT=%s RUNS=%s\\n' "$c" "$([ "$c" -le ${max} ] && echo yes || echo no)"`,
  ].join('\n')], { encoding: 'utf8' });
  const m = `${r.stdout}`.match(/COUNT=(\d+) RUNS=(\w+)/);
  if (!m) throw new Error(`${r.stdout}${r.stderr}`);
  return { count: Number(m[1]), writerRuns: m[2] === 'yes' };
}

describe('a remediated gate gives the writer an attempt', () => {
  it('a story past its last attempt (resume 13: 12 > 11) gets exactly one top-rung attempt', () => {
    const r = after(12, 11);
    expect(r.writerRuns).toBe(true);
    expect(r.count).toBe(11);
  });

  it('NEGATIVE: a story with attempts left keeps its count — no rung is skipped or repeated', () => {
    expect(after(3, 11)).toEqual({ count: 3, writerRuns: true });
  });
});
