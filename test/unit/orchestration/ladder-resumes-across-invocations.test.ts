/**
 * claude.sh's implement_story() must resume the inference ladder from where a
 * PRIOR claude.sh process left off — not restart at rung 0.
 *
 * Root cause (live, run 20260806T021820Z): retry_count was `local retry_count=0`.
 * Step 3.6's review -> re-implement -> re-review loop calls
 * run_story_with_watchdog on every rejection, which spawns a BRAND-NEW claude.sh
 * subprocess — so every review cycle silently reset the ladder to rung 0, and the
 * fixed REVIEW_MAX_CYCLES cap hard-escalated before the ladder was ever tested
 * past rung 0. Standing requirement: "Retries MUST proceed up the rungs —
 * nothing is allowed to intercede."
 *
 * This test executes the REAL seed block sliced verbatim out of claude.sh (same
 * technique test/unit/orchestration/ladder-traversal.test.ts uses for
 * run_story_with_watchdog) — not a re-description of what it should do — and
 * asserts on the real resulting retry_count value.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const STORY_RETRY_LIB = join(__dirname, '../../../orchestrations/scripts/lib/story-retry-state.sh');
const SRC = readFileSync(CLAUDE_SH, 'utf8');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The REAL seed block, sliced verbatim from claude.sh between its two anchors. */
function realSeedBlock(): string {
  const start = SRC.indexOf('implement_story() {');
  if (start === -1) throw new Error('implement_story() not found');
  const anchorEnd = '# Shadows the script-global MAX_RETRIES';
  const end = SRC.indexOf(anchorEnd, start);
  if (end === -1) throw new Error('seed-block end anchor not found — claude.sh structure changed');
  // Slice everything from the function open brace up to (not including) the
  // MAX_RETRIES-shadow comment, then close the brace ourselves.
  const body = SRC.slice(start, end);
  // retry_count is `local` — it must be echoed from INSIDE the function,
  // before the appended closing brace, or the caller sees nothing.
  return `${body}\n    echo "SEEDED=$retry_count"\n}`;
}

function seedRetryCount(logDir: string, storyId: string): number {
  const script = join(logDir, 'seed-test.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
source ${JSON.stringify(STORY_RETRY_LIB)}
LOG_DIR=${JSON.stringify(logDir)}
log(){ echo "LOG: $*" >&2; }
${realSeedBlock()}
implement_story ${JSON.stringify(storyId)}
`);
  const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 15000 });
  const m = (r.stdout || '').match(/SEEDED=(\d+)/);
  if (!m) throw new Error(`no SEEDED= output. stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  return Number(m[1]);
}

describe('implement_story() seeds retry_count from persisted state, not 0', () => {
  it('a story with no prior state seeds at retry_count=0 (unchanged first-run behavior)', () => {
    const d = mkdtempSync(join(tmpdir(), 'seed-'));
    dirs.push(d);
    expect(seedRetryCount(d, 'S-1')).toBe(0);
  });

  it('THE FIX: a story with persisted retry_count=4 (rung 2, from a prior claude.sh process) resumes at 4, not 0', () => {
    const d = mkdtempSync(join(tmpdir(), 'seed-'));
    dirs.push(d);
    spawnSync('bash', ['-c', `source ${JSON.stringify(STORY_RETRY_LIB)}; write_story_retry_count ${JSON.stringify(d)} S-1 4`]);
    expect(
      seedRetryCount(d, 'S-1'),
      'implement_story restarted the ladder at rung 0 despite persisted state — the exact live bug',
    ).toBe(4);
  });

  it('is scoped per story — a sibling story with no state of its own still seeds at 0', () => {
    const d = mkdtempSync(join(tmpdir(), 'seed-'));
    dirs.push(d);
    spawnSync('bash', ['-c', `source ${JSON.stringify(STORY_RETRY_LIB)}; write_story_retry_count ${JSON.stringify(d)} S-1 6`]);
    expect(seedRetryCount(d, 'S-2')).toBe(0);
  });

  it('MUTATION CHECK: reverting the seed line back to hardcoded 0 makes this test fail', () => {
    const mutated = realSeedBlock().replace(
      /retry_count="\$\(read_story_retry_count "\$LOG_DIR" "\$story_id"\)"/,
      'retry_count=0',
    );
    expect(mutated, 'the replace did not match — test would vacuously pass').not.toBe(realSeedBlock());
    const d = mkdtempSync(join(tmpdir(), 'seed-'));
    dirs.push(d);
    spawnSync('bash', ['-c', `source ${JSON.stringify(STORY_RETRY_LIB)}; write_story_retry_count ${JSON.stringify(d)} S-1 4`]);
    const script = join(d, 'mutant.sh');
    writeFileSync(script, `#!/usr/bin/env bash
set -uo pipefail
source ${JSON.stringify(STORY_RETRY_LIB)}
LOG_DIR=${JSON.stringify(d)}
log(){ :; }
${mutated}
implement_story S-1
`);
    const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 15000 });
    const m = (r.stdout || '').match(/SEEDED=(\d+)/);
    expect(Number(m?.[1]), 'the mutant (hardcoded 0) should regress — proving the real code does NOT').toBe(0);
  });
});

describe('claude.sh persists retry_count at both exit paths (structural — the write call sites)', () => {
  // These two sites are exercised end-to-end by story-retry-state.test.ts's
  // coverage of write_story_retry_count itself; here we confirm claude.sh
  // actually calls it at both required points, since a persistence fix that
  // only fires on ONE of the two exit paths (loop-iteration vs success-return)
  // silently reintroduces the bug for whichever path is missed.
  it('persists before the retry sleep, so a killed/timed-out attempt keeps its rung', () => {
    // Two call sites exist (success path + iteration path); this one is the
    // LATER one in the file — see the sibling test for the success-path site.
    const idx = SRC.lastIndexOf('write_story_retry_count "$LOG_DIR" "$story_id" "$retry_count"');
    expect(idx, 'no persistence call found in the retry-iteration path at all').toBeGreaterThan(-1);
    const after = SRC.slice(idx, idx + 800);
    expect(after).toMatch(/if \[ \$retry_count -le \$MAX_RETRIES \]; then/);
  });

  it('persists on the success return, so a review rejection after a first-try success still resumes correctly', () => {
    const successIdx = SRC.indexOf('post_completion_message "$story_id" "completed"');
    expect(successIdx).toBeGreaterThan(-1);
    const before = SRC.slice(Math.max(0, successIdx - 800), successIdx);
    expect(before).toMatch(/write_story_retry_count "\$LOG_DIR" "\$story_id" "\$retry_count"/);
  });
});
