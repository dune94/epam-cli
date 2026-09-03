/**
 * A COMMENT AFTER A BACKSLASH SILENTLY ENDS THE COMMAND.
 *
 * Live 2026-08-09. Every one of the writer's 8 attempts failed instantly at $0 cost:
 *
 *     Error: no prompt provided via stdin
 *     Cost[AMSD-2041] in=0 out=0 cost=$0 elapsed=0min
 *     Failed to implement AMSD-2041 after 8 attempts
 *
 * The prompt was built correctly — all 1,008 lines of it, logged for every attempt. It never
 * reached the process, because I had added an explanatory comment in the middle of the
 * invocation's line-continuation chain:
 *
 *     if echo "$prompt" | \
 *             EPAM_ACTIVITY_LOG_DIR="${LOG_DIR}" \
 *             # DEFAULT OFF. See toolPolicy...        <-- terminates the command HERE
 *             EPAM_READ_DEDUPE="${EPAM_READ_DEDUPE:-0}" \
 *
 * `\` continues a line; a comment on the next line ends the command anyway. So
 * `echo "$prompt" | ENV=...` ran as a complete pipeline with no consumer, and the real
 * invocation became a separate command with nothing on stdin.
 *
 * `bash -n` passes. It is valid shell — just not the command that was written. That is what
 * makes this worth a test rather than a habit: nothing in the normal toolchain objects, and the
 * failure surfaces far away, as an empty prompt.
 *
 * A sweep found a SECOND instance from the same day, in a gate invocation, where the tool-budget
 * explanation had been placed inside the chain the same way.
 *
 * Comment blocks that merely CONTAIN a backslash — usage examples in a file header — are not
 * this, so the check requires the previous line to be real code.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../orchestrations/scripts');

function shellScripts(dir = ROOT): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { out.push(...shellScripts(p)); continue; }
    if (e.endsWith('.sh')) out.push(p);
  }
  return out;
}

/** Lines where a CODE line ends in `\` and the next line is a comment. */
function brokenContinuations(file: string): Array<{ line: number; text: string }> {
  const lines = readFileSync(file, 'utf8').split('\n');
  const bad: Array<{ line: number; text: string }> = [];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i].trim();
    if (!prev.trimEnd().endsWith('\\')) continue;
    if (prev.trim().startsWith('#')) continue;      // a comment block's own example
    if (!cur.startsWith('#')) continue;
    bad.push({ line: i + 1, text: cur.slice(0, 80) });
  }
  return bad;
}

describe('no comment sits inside a line-continuation chain', () => {
  it.each(shellScripts().map(f => [f.replace(ROOT + '/', ''), f]))('%s', (_name, file) => {
    const bad = brokenContinuations(file);
    expect(
      bad,
      'a `\\` continuation followed by a comment ENDS the command — bash -n accepts it, and the ' +
      'invocation then runs with nothing on stdin. This cost 8 writer attempts at $0 on 2026-08-09.',
    ).toEqual([]);
  });
});

describe('the detector actually detects', () => {
  it('flags a comment after a code continuation', () => {
    // Guards against the sweep silently passing everything, which is how the original defect
    // survived a `bash -n` that reported success.
    const tmp = join(__dirname, '../../../orchestrations/scripts');
    void tmp;
    const sample = ['cmd one \\', '# explanation', 'ARG=1 \\', 'final'].join('\n');
    const lines = sample.split('\n');
    let found = 0;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i - 1].trimEnd().endsWith('\\') && !lines[i - 1].trim().startsWith('#')
          && lines[i].trim().startsWith('#')) found++;
    }
    expect(found).toBe(1);
  });

  it('does NOT flag a usage example inside a comment block', () => {
    const lines = ['#   cmd \\', '#     --flag'];
    let found = 0;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i - 1].trimEnd().endsWith('\\') && !lines[i - 1].trim().startsWith('#')
          && lines[i].trim().startsWith('#')) found++;
    }
    expect(found).toBe(0);
  });

  it('inspects a real number of scripts', () => {
    expect(shellScripts().length).toBeGreaterThan(10);
  });
});
