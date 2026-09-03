/**
 * A CLI THAT REJECTS ITS OWN FLAGS WILL REJECT THEM IDENTICALLY EVERY TIME.
 *
 * 2026-08-28, writer leg: every attempt died in milliseconds on
 *
 *   error: option '--autocompact <auto|tokens>' argument '80000' is invalid.
 *          It must be 'auto', or between 100k and 1M
 *
 * The coordinator classified all twelve as "unknown", escalated haiku -> sonnet-5, and reset the
 * worktree between each — because the raw output file was absent, and absent was read as "no
 * evidence". The evidence was there the whole time, in the attempt's own output log: the CLI's
 * error text, identical on every attempt, printed before a single token was sent.
 *
 * Retrying is for conditions that might differ next time. An argument the binary refuses to parse
 * is not one of them, and eleven repetitions of it cost a whole writer leg.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function classify(outputText: string, exitCode = 1) {
  const d = mkdtempSync(join(tmpdir(), 'argerr-')); dirs.push(d);
  const out = join(d, 'attempt.log');
  writeFileSync(out, outputText);
  const r = spawnSync('bash', ['-c',
    `warning(){ echo "$*"; }; log(){ :; }; info(){ :; }
     eval "$(sed -n '/^classify_invocation_refusal() {/,/^}/p' ${JSON.stringify(CLAUDE_SH)})"
     if classify_invocation_refusal ${JSON.stringify(out)} ${exitCode}; then echo REFUSED; else echo RETRYABLE; fi`,
  ], { encoding: 'utf8', timeout: 60000 });
  return { verdict: (r.stdout || '').trim().split('\n').pop(), out: r.stdout || '' };
}

const ARG_ERROR = [
  '=== Prompt for MOCK3-1 (attempt 1) ===',
  'Implement user story MOCK3-1 ...',
  '=== claude Output (attempt 1) ===',
  "error: option '--autocompact <auto|tokens>' argument '80000' is invalid. It must be 'auto', or between 100k and 1M",
  '',
  '=== claude exited with code 1 ===',
].join('\n');

describe('AN ARGUMENT THE BINARY REFUSES IS NOT RETRIED', () => {
  it('recognises the CLI refusing its own option', () => {
    expect(classify(ARG_ERROR).verdict,
      'twelve identical attempts against a deterministic argument error').toBe('REFUSED');
  });

  it('names the offending option so the operator can fix it', () => {
    expect(classify(ARG_ERROR).out).toMatch(/--autocompact/);
  });

  it('does NOT refuse a model that simply produced a poor answer', () => {
    // The failure retrying exists for: the call ran, the answer was wrong.
    expect(classify([
      '=== claude Output (attempt 1) ===',
      'I have reviewed the file but could not determine the correct fix.',
      '=== claude exited with code 1 ===',
    ].join('\n')).verdict).toBe('RETRYABLE');
  });

  it('does NOT refuse a timeout or a crash', () => {
    // Environment failures may genuinely differ next time; that is what retries are for.
    expect(classify([
      '=== claude Output (attempt 1) ===',
      'Error: connection reset by peer',
      '=== claude exited with code 1 ===',
    ].join('\n')).verdict).toBe('RETRYABLE');
  });

  it('does not refuse when the attempt succeeded', () => {
    expect(classify(ARG_ERROR, 0).verdict,
      'exit 0 is not a refusal whatever the log contains').toBe('RETRYABLE');
  });
});
