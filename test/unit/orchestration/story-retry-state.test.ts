/**
 * story-retry-state.sh — per-story inference-ladder rung state that survives
 * across SEPARATE claude.sh subprocess invocations for the same story.
 *
 * Root cause this fixes (live, run 20260806T021820Z): retry_count was a
 * `local` inside claude.sh's implement_story(). Step 3.6's review ->
 * re-implement loop re-invokes claude.sh as a brand-new subprocess on every
 * review-rejection cycle, silently resetting retry_count to 0 every time —
 * the ladder never climbed past rung 0 before the fixed review-cycle cap
 * hard-escalated. Standing requirement: "Retries MUST proceed up the rungs —
 * nothing is allowed to intercede."
 *
 * These tests execute the real lib (not a description of it) via bash, and
 * assert on the artifact it produces (the state file's contents / the
 * function's real exit code), per this repo's "test the code and its
 * impact" rule.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const LIB = join(__dirname, '../../../orchestrations/scripts/lib/story-retry-state.sh');

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(script: string): { out: string; status: number | null } {
  const r = spawnSync('bash', ['-c', `source ${JSON.stringify(LIB)}\n${script}`], {
    encoding: 'utf8',
    timeout: 30000,
  });
  return { out: (r.stdout || '') + (r.stderr || ''), status: r.status };
}

function newLogDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'retry-state-'));
  dirs.push(d);
  return d;
}

describe('read_story_retry_count', () => {
  it('returns 0 for a story with no persisted state', () => {
    const d = newLogDir();
    const { out } = run(`read_story_retry_count ${JSON.stringify(d)} S-1`);
    expect(out.trim()).toBe('0');
  });

  it('returns the persisted value after a write', () => {
    const d = newLogDir();
    const { out } = run(`
      write_story_retry_count ${JSON.stringify(d)} S-1 5
      read_story_retry_count ${JSON.stringify(d)} S-1
    `);
    expect(out.trim()).toBe('5');
  });

  it('is scoped per story — writing S-1 does not affect S-2', () => {
    const d = newLogDir();
    const { out } = run(`
      write_story_retry_count ${JSON.stringify(d)} S-1 6
      read_story_retry_count ${JSON.stringify(d)} S-2
    `);
    expect(out.trim()).toBe('0');
  });

  it('is resilient to a corrupt/non-numeric state file (falls back to 0, does not crash the caller)', () => {
    const d = newLogDir();
    const { out, status } = run(`
      mkdir -p ${JSON.stringify(d)}/story-retry-state
      echo "not-a-number" > ${JSON.stringify(d)}/story-retry-state/S-1.count
      read_story_retry_count ${JSON.stringify(d)} S-1
    `);
    expect(status).toBe(0);
    expect(out.trim()).toBe('0');
  });
});

describe('write_story_retry_count — the actual artifact on disk', () => {
  it('creates the state directory and file with the exact count', () => {
    const d = newLogDir();
    run(`write_story_retry_count ${JSON.stringify(d)} S-1 3`);
    const f = join(d, 'story-retry-state', 'S-1.count');
    expect(existsSync(f), 'state file was never written').toBe(true);
    expect(readFileSync(f, 'utf8').trim()).toBe('3');
  });
});

describe('story_ladder_rung / story_max_rung', () => {
  it.each([
    [0, 0], [1, 0], [2, 1], [3, 1], [4, 2], [5, 2], [6, 3], [7, 3],
  ])('retry_count %i -> rung %i (matches claude.sh\'s own _rung formula)', (retryCount, expected) => {
    const { out } = run(`story_ladder_rung ${retryCount}`);
    expect(out.trim()).toBe(String(expected));
  });

  it('max_rung for MAX_RETRIES=7 is rung 3 (the real default ladder depth)', () => {
    const { out } = run(`story_max_rung 7`);
    expect(out.trim()).toBe('3');
  });
});

describe('story_ladder_exhausted — the gate Step 3.6 must consult before escalating', () => {
  it('is NOT exhausted at rung 0 with a 4-rung ladder (max_retries=7)', () => {
    const d = newLogDir();
    const { status } = run(`
      write_story_retry_count ${JSON.stringify(d)} S-1 0
      story_ladder_exhausted ${JSON.stringify(d)} S-1 7
    `);
    expect(status, 'reported exhausted at rung 0 — Step 3.6 could escalate before the ladder ever climbed').not.toBe(0);
  });

  it('is NOT exhausted at rung 1 or rung 2', () => {
    const d = newLogDir();
    for (const rc of [2, 4]) {
      run(`write_story_retry_count ${JSON.stringify(d)} S-1 ${rc}`);
      const { status } = run(`story_ladder_exhausted ${JSON.stringify(d)} S-1 7`);
      expect(status, `rung for retry_count=${rc} reported exhausted too early`).not.toBe(0);
    }
  });

  it('IS exhausted once the persisted rung reaches the top rung (retry_count=6, rung 3)', () => {
    const d = newLogDir();
    run(`write_story_retry_count ${JSON.stringify(d)} S-1 6`);
    const { status } = run(`story_ladder_exhausted ${JSON.stringify(d)} S-1 7`);
    expect(status).toBe(0);
  });

  it('IS exhausted at retry_count=7 (the last valid attempt, still rung 3)', () => {
    const d = newLogDir();
    run(`write_story_retry_count ${JSON.stringify(d)} S-1 7`);
    const { status } = run(`story_ladder_exhausted ${JSON.stringify(d)} S-1 7`);
    expect(status).toBe(0);
  });
});

describe('advance_story_retry_rung — the real fix: a review rejection must climb the ladder', () => {
  it('moves rung 0 (retry_count 0) to the START of rung 1 (retry_count 2)', () => {
    const d = newLogDir();
    run(`
      write_story_retry_count ${JSON.stringify(d)} S-1 0
      advance_story_retry_rung ${JSON.stringify(d)} S-1 7
    `);
    const { out } = run(`read_story_retry_count ${JSON.stringify(d)} S-1`);
    expect(out.trim()).toBe('2');
  });

  it('moves rung 1 (retry_count 2 or 3) to the START of rung 2 (retry_count 4)', () => {
    const d = newLogDir();
    run(`
      write_story_retry_count ${JSON.stringify(d)} S-1 3
      advance_story_retry_rung ${JSON.stringify(d)} S-1 7
    `);
    const { out } = run(`read_story_retry_count ${JSON.stringify(d)} S-1`);
    expect(out.trim()).toBe('4');
  });

  it('two consecutive review-rejection cycles from rung 0 reach rung 2, not rung 1 twice', () => {
    // This is the exact live-run scenario: two review cycles, each a fresh
    // claude.sh subprocess. Before the fix, both logged Rung0/R1. After the
    // fix, cycle 2 must land on rung 1 having already left rung 0.
    const d = newLogDir();
    run(`advance_story_retry_rung ${JSON.stringify(d)} S-1 7`); // cycle 1
    const afterOne = run(`read_story_retry_count ${JSON.stringify(d)} S-1`).out.trim();
    run(`advance_story_retry_rung ${JSON.stringify(d)} S-1 7`); // cycle 2
    const afterTwo = run(`read_story_retry_count ${JSON.stringify(d)} S-1`).out.trim();
    expect(Number(afterTwo), 'the ladder did not progress between review cycles').toBeGreaterThan(Number(afterOne));
    expect(afterOne).toBe('2');
    expect(afterTwo).toBe('4');
  });

  it('clamps to max_retries once already at the top rung — never pushes past the last valid attempt', () => {
    const d = newLogDir();
    run(`
      write_story_retry_count ${JSON.stringify(d)} S-1 6
      advance_story_retry_rung ${JSON.stringify(d)} S-1 7
    `);
    const { out } = run(`read_story_retry_count ${JSON.stringify(d)} S-1`);
    expect(Number(out.trim()), 'advanced past MAX_RETRIES — the next claude.sh invocation would immediately fail with zero attempts at the top rung').toBeLessThanOrEqual(7);
    expect(out.trim()).toBe('7');
  });

  it('MUTATION CHECK: a version that always writes 0 (a no-op bug) is caught by these tests', () => {
    // Guards against a fix that "runs" but never actually changes state —
    // the exact class of bug this repo's testing rules call out explicitly.
    const d = newLogDir();
    const brokenLib = readFileSync(LIB, 'utf8').replace(
      /advance_story_retry_rung\(\) \{[\s\S]*?\n\}/,
      'advance_story_retry_rung() { local log_dir="$1" story_id="$2"; write_story_retry_count "$log_dir" "$story_id" 0; }',
    );
    expect(brokenLib, 'the replace did not match — test would vacuously pass').not.toBe(readFileSync(LIB, 'utf8'));
    const tmp = join(newLogDir(), 'broken.sh');
    require('node:fs').writeFileSync(tmp, brokenLib);
    const r = spawnSync('bash', ['-c', `source ${JSON.stringify(tmp)}\nwrite_story_retry_count ${JSON.stringify(d)} S-1 4\nadvance_story_retry_rung ${JSON.stringify(d)} S-1 7\nread_story_retry_count ${JSON.stringify(d)} S-1`], { encoding: 'utf8' });
    expect(r.stdout.trim(), 'mutant should regress to 0, proving the real function does NOT').toBe('0');
  });
});

describe('read_story_retry_provider_set / write_story_retry_provider_set', () => {
  // WHICH SET produced a persisted ladder rung, so a resume can tell whether that rung still
  // means anything. read_story_retry_model() persists a MODEL NAME with no notion of which
  // provider set chose it — "MiniMax-M3" is meaningless once EPAM_PROVIDER_SET has moved from
  // openrouter to claude between two invocations, but nothing recorded that it moved. Found
  // 2026-09-03 while confirming the hot-swap requirement extends to resume, per
  // change-log/SEAM-CONSISTENCY-ANALYSIS.md.
  it('returns empty for a story with no persisted set', () => {
    const d = newLogDir();
    const { out } = run(`read_story_retry_provider_set ${JSON.stringify(d)} S-1`);
    expect(out.trim()).toBe('');
  });

  it('returns the persisted value after a write', () => {
    const d = newLogDir();
    const { out } = run(`
      write_story_retry_provider_set ${JSON.stringify(d)} S-1 openrouter
      read_story_retry_provider_set ${JSON.stringify(d)} S-1
    `);
    expect(out.trim()).toBe('openrouter');
  });

  it('is scoped per story', () => {
    const d = newLogDir();
    const { out } = run(`
      write_story_retry_provider_set ${JSON.stringify(d)} S-1 openrouter
      read_story_retry_provider_set ${JSON.stringify(d)} S-2
    `);
    expect(out.trim()).toBe('');
  });

  it('never persists an empty set — a run with no declared set leaves no marker to misread later', () => {
    // Checking the READ result alone is vacuous here: an empty file and a missing file both
    // read back as ''. The real assertion is that no file was created at all — caught by
    // mutation testing: removing the empty-string guard left this passing on the read-back
    // check alone, because the write still landed on disk, just empty.
    const d = newLogDir();
    run(`write_story_retry_provider_set ${JSON.stringify(d)} S-1 ""`);
    const f = join(d, 'story-retry-state', 'S-1.provider-set');
    expect(existsSync(f), 'an empty set was persisted as a file, not skipped').toBe(false);
  });

  it('creates the actual artifact on disk with the exact value', () => {
    const d = newLogDir();
    run(`write_story_retry_provider_set ${JSON.stringify(d)} S-1 codemie`);
    const f = join(d, 'story-retry-state', 'S-1.provider-set');
    expect(existsSync(f), 'state file was never written').toBe(true);
    expect(readFileSync(f, 'utf8').trim()).toBe('codemie');
  });
});
