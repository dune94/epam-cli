/**
 * RETEST OF d018fa2 — an unguarded SIGPIPE site in claude.sh.
 *
 * The line was:
 *
 *     _opt=$(printf '%s' "$_line" | grep -oE -m1 -- "--[a-z0-9-]+" | head -1)
 *
 * Under `set -o pipefail`, head closes the pipe, grep dies of SIGPIPE, and the assignment fails on
 * a line that matched perfectly well. The head was redundant too — grep -m1 already stops at the
 * first match.
 *
 * classify_invocation_refusal exists to tell the writer WHY an invocation was refused. Silently
 * losing the flag name turns a precise refusal ("this flag is not supported") into nothing, and
 * the writer retries against a wall it is never told about.
 *
 * Driven under pipefail, because without pipefail the bug cannot appear at all.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../orchestrations/scripts/claude.sh');

/**
 * Run the extraction exactly as the shipped function does, under pipefail — the condition the
 * whole defect depends on.
 */
function extractFlag(line: string) {
  const shipped = spawnSync('bash', ['-c',
    `grep -n 'grep -oE -m1' ${JSON.stringify(CLAUDE_SH)} | head -1`,
  ], { encoding: 'utf8', timeout: 30000 }).stdout || '';

  const r = spawnSync('bash', ['-c', `
    set -o pipefail
    _line=${JSON.stringify(line)}
    # The shipped extraction, taken from claude.sh rather than retyped.
    ${shipped.replace(/^\s*\d+:\s*/, '').trim() || 'false'}
    echo "RC=$?"
    echo "OPT=\${_opt:-<empty>}"
  `], { encoding: 'utf8', timeout: 30000 });
  const out = `${r.stdout || ''}`;
  return {
    rc: /RC=(\d+)/.exec(out)?.[1] ?? '',
    opt: (/OPT=(.*)/.exec(out)?.[1] ?? '').trim(),
    shippedLine: shipped.trim(),
  };
}

describe('a pipeline does not die of sigpipe', () => {
  it('the shipped line is the one under test — not a retyped copy', () => {
    const got = extractFlag('unknown option --autocompact');
    expect(got.shippedLine, 'the extraction line was not found in claude.sh').not.toBe('');
  }, 60_000);

  it('extracts the flag from a refusal line under pipefail', () => {
    const got = extractFlag('error: unknown option --autocompact provided');
    expect(got.rc, 'the assignment failed under pipefail — SIGPIPE, on a line that matched').toBe('0');
    expect(got.opt, 'the flag name was lost, so the refusal reason is empty')
      .toBe('--autocompact');
  }, 60_000);

  it('takes the FIRST flag when a line names several', () => {
    const got = extractFlag('unknown option --autocompact (did you mean --auto-compact?)');
    expect(got.opt).toBe('--autocompact');
  }, 60_000);

  it('does not fail the caller when the line names no flag at all', () => {
    // A refusal with no flag is ordinary; it must not take the surrounding function down with it.
    const got = extractFlag('the model refused for reasons of its own');
    expect(got.rc, 'a line with no flag killed the assignment').toBe('0');
  }, 60_000);
});
