/**
 * THE LADDER WROTE ITS STATE CORRECTLY AND NEVER READ IT BACK.
 *
 * Observed live, run 20260810T092715, after shipping the "persist STORY_MODEL" fix:
 *
 *     story-retry-state/AMSD-2041.model      written, correct contents
 *     "[InferenceLadder] ... resuming on '<model>'"   NEVER logged, not once
 *     InferenceLadder[Rung1/R2]: model='MiniMax-M3' unchanged
 *     Invoking epam (attempt 1/8)  x5     <- the climb restarting every re-invocation
 *
 * Cause: the seed sat BEFORE `resolve_provider_settings`, which re-derives STORY_MODEL from the
 * PRD. The persisted value was assigned and then immediately overwritten. My own comment on that
 * block asserted the resolver "has already re-derived STORY_MODEL by this point" — it had not,
 * and nothing tested the ordering, so a fix that wrote perfect state did nothing at all.
 *
 * The same defect applied to the rung iteration bump, which was never persisted: maxIter went
 * 185 at attempt 3 and back to 120 on the next invocation, discarding every rung's escalation.
 *
 * These tests assert the CONSEQUENCE — which model and which iteration budget a re-entering
 * process ends up with — and the ORDERING that makes it possible, because ordering is the thing
 * that silently broke.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(__dirname, '../../../');
const SRC = readFileSync(join(ROOT, 'orchestrations/scripts/claude.sh'), 'utf8');
const LIB = readFileSync(join(ROOT, 'orchestrations/scripts/lib/story-retry-state.sh'), 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function ws() {
  const d = mkdtempSync(join(tmpdir(), 'ladderstate-')); dirs.push(d);
  mkdirSync(join(d, 'story-retry-state'), { recursive: true });
  return d;
}

/** Runs the real read/write pair from the state library. */
function sh(body: string): string {
  return execFileSync('bash', ['-c', `set -u\n${LIB}\n${body}`], { encoding: 'utf8' }).trim();
}

describe('ORDERING: the seed must run after the PRD re-derives STORY_MODEL', () => {
  it('resolve_provider_settings is called BEFORE the persisted-model seed', () => {
    const resolver = SRC.indexOf('    resolve_provider_settings "$story_id"');
    const seed = SRC.indexOf('_persisted_model="$(read_story_retry_model');
    expect(resolver, 'resolve_provider_settings call not found').toBeGreaterThan(-1);
    expect(seed, 'the persisted-model seed not found').toBeGreaterThan(-1);
    expect(
      seed,
      'the seed runs first, so resolve_provider_settings overwrites the resumed model from the ' +
      'PRD and the ladder restarts its climb — exactly what the live run showed',
    ).toBeGreaterThan(resolver);
  });

  it('no later assignment re-derives STORY_MODEL from the PRD after the seed', () => {
    const seed = SRC.indexOf('_persisted_model="$(read_story_retry_model');
    const after = SRC.slice(seed, seed + 3000);
    // The seed's own assignment is expected; a PRD-sourced one after it would undo the resume.
    expect(after).not.toMatch(/STORY_MODEL="\$\{story_model:-/);
  });
});

describe('THE MODEL survives a re-invocation', () => {
  it('what is written is what is read back', () => {
    const d = ws();
    sh(`write_story_retry_model ${JSON.stringify(d)} S-1 "moonshotai/kimi-k3"`);
    expect(sh(`read_story_retry_model ${JSON.stringify(d)} S-1`)).toBe('moonshotai/kimi-k3');
  });

  it('an absent story reads empty, so a first attempt keeps the PRD model', () => {
    expect(sh(`read_story_retry_model ${JSON.stringify(ws())} S-1`)).toBe('');
  });

  it('an empty model is never persisted — it would read as "no state" and restart the climb', () => {
    const d = ws();
    sh(`write_story_retry_model ${JSON.stringify(d)} S-1 "z-ai/glm-5.2"`);
    sh(`write_story_retry_model ${JSON.stringify(d)} S-1 ""`);
    expect(sh(`read_story_retry_model ${JSON.stringify(d)} S-1`)).toBe('z-ai/glm-5.2');
  });

  it('it is written wherever the count is written — one state dir, never two', () => {
    const d = ws();
    sh(`write_story_retry_count ${JSON.stringify(d)} S-1 4\nwrite_story_retry_model ${JSON.stringify(d)} S-1 "kimi"`);
    expect(existsSync(join(d, 'story-retry-state', 'S-1.count'))).toBe(true);
    expect(existsSync(join(d, 'story-retry-state', 'S-1.model'))).toBe(true);
  });
});

describe('THE ITERATION BUMP survives a re-invocation', () => {
  it('what is written is what is read back', () => {
    const d = ws();
    sh(`write_story_iteration_bump ${JSON.stringify(d)} S-1 65`);
    expect(sh(`read_story_iteration_bump ${JSON.stringify(d)} S-1`)).toBe('65');
  });

  it('absent reads as 0, so a fresh story starts at its base budget', () => {
    expect(sh(`read_story_iteration_bump ${JSON.stringify(ws())} S-1`)).toBe('0');
  });

  it('a non-numeric value is refused rather than persisted', () => {
    const d = ws();
    sh(`write_story_iteration_bump ${JSON.stringify(d)} S-1 30`);
    sh(`write_story_iteration_bump ${JSON.stringify(d)} S-1 "junk"`);
    expect(sh(`read_story_iteration_bump ${JSON.stringify(d)} S-1`)).toBe('30');
  });

  it('claude.sh persists it wherever it persists the model', () => {
    expect(
      SRC,
      'the bump is process-local, so maxIter fell 185 -> 120 on re-invocation',
    ).toContain('write_story_iteration_bump "$LOG_DIR" "$story_id"');
  });

  it('and seeds it on entry', () => {
    expect(SRC).toContain('STORY_ITERATION_BUMP_TOTAL="$(read_story_iteration_bump');
  });
});

describe('the rejection names each file once', () => {
  it('duplicate verified sites collapse to one line', () => {
    // Live: ContentstackContext.tsx appeared twice because two verified fix sites named it, so
    // the count disagreed with the list and the writer was told the same path twice.
    const out = execFileSync('bash', ['-c',
      `set -u\n_unchanged_verified=(a.ts b.ts a.ts c.ts)\n` +
      `while IFS= read -r f; do echo "$f"; done < <(printf '%s\\n' "\${_unchanged_verified[@]}" | sort -u)`],
      { encoding: 'utf8' }).trim().split('\n');
    expect(out).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  // REMOVED 2026-08-12: this asserted the dedup of the VERIFIED-fix-site rejection list.
  // That gate is deleted — it demanded a diff in every prescribed file, which is conformance to
  // a plan that is explicitly guidance. There is no such rejection to dedup any more.
});
