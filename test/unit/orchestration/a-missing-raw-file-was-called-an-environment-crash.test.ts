/**
 * A RAW FILE THAT WAS NEVER WRITTEN WAS READ AS PROOF OF AN ENVIRONMENT CRASH.
 *
 * classify_failure_class decides why an attempt failed. Its Class A test is "empty output and a
 * non-zero exit = the environment crashed", and it measures emptiness like this:
 *
 *     local raw_size=0
 *     [ -f "$raw_file" ] && raw_size=$(wc -c < "$raw_file")
 *     if [ "$raw_size" -eq 0 ] && [ "$exit_code" -ne 0 ]; then  ... class=env
 *
 * The caller passes "" when it cannot find the file. An ABSENT file and an EMPTY one are then
 * indistinguishable, and both become a confident diagnosis. Live 2026-08-18: no _result_raw.json
 * was ever written for either story, so ten attempts were classified "environment failure", the
 * coordinator verified a healthy binary and a healthy key, and the real cause — a provider that
 * did not follow its model — was never considered.
 *
 * A conclusion drawn from absent evidence is the defect. Missing means UNKNOWN, and unknown must
 * not impersonate a specific diagnosis: the classifier is told the difference, and says so.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const CLAUDE_SH = join(ROOT, 'orchestrations/scripts/claude.sh');

function extractFn(name: string): string {
  const src = readFileSync(CLAUDE_SH, 'utf8');
  const m = src.match(new RegExp(`^${name}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`, 'm'));
  if (!m) throw new Error(`claude.sh has no function ${name}()`);
  return m[0];
}

/** Run classify_failure_class with stub logging, and report the class it chose. */
function classify(rawArg: string, exitCode: number) {
  const fn = extractFn('classify_failure_class');
  const script = [
    'log() { :; }', 'warning() { echo "WARN: $*"; }', 'info() { :; }', 'error() { echo "ERR: $*"; }',
    'command_exists() { return 0; }',
    fn,
    `classify_failure_class "${rawArg}" "" ${exitCode} "T-1"`,
    'echo "CLASS=$COORDINATOR_FAILURE_CLASS"',
  ].join('\n');
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, OPENROUTER_API_KEY: '' } });
}

describe('a missing raw file was called an environment crash', () => {
  it('AN EMPTY FILE IS STILL AN ENVIRONMENT CRASH — the real signal is preserved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'classify-'));
    const empty = join(dir, 'raw.json');
    writeFileSync(empty, '');
    const r = classify(empty, 1);
    expect(r.stdout, `classify failed: ${r.stderr}`).toContain('CLASS=env');
    rmSync(dir, { recursive: true, force: true });
  });

  it('A FILE THAT DOES NOT EXIST IS NOT EVIDENCE OF ANYTHING', () => {
    const r = classify(join(tmpdir(), 'definitely-not-here-12345.json'), 1);
    expect(r.stdout, 'an absent file still produces a confident "environment crash" diagnosis')
      .not.toContain('CLASS=env');
  });

  it('AND NEITHER IS AN EMPTY PATH — what the caller actually passes', () => {
    // The live shape: the caller sets _raw_for_coord="" after its fallbacks miss.
    const r = classify('', 1);
    expect(r.stdout, 'an unknown-output failure is still reported as an environment crash')
      .not.toContain('CLASS=env');
  });

  it('says so out loud, so the next reader is not left guessing either', () => {
    const r = classify('', 1);
    expect(`${r.stdout}${r.stderr}`, 'nothing reports that the output could not be found')
      .toMatch(/no raw output|could not be found|not written|unknown/i);
  });

  it('a zero exit is not a failure at all, whatever the file says', () => {
    const r = classify('', 0);
    expect(r.stdout).not.toContain('CLASS=env');
  });
});
