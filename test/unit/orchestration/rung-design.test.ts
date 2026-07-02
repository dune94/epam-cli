/**
 * Rung-based InferenceLadder invariants.
 *
 * Design: 4 rungs, 2 attempts each, MAX_RETRIES=7 (8 total attempts).
 *   Rung 0 (attempts 0-1): base model, base effort — initial + 1 retry
 *   Rung 1 (attempts 2-3): same model, effort → medium
 *   Rung 2 (attempts 4-5): escalated model, effort → medium
 *   Rung 3 (attempts 6-7): escalated model, effort → high (maximum)
 *
 * HEALING_BROKEN: when diagnosis repeats ≥2 times, skip the remaining attempt
 * in the current rung and jump directly to the next rung's first attempt.
 * At Rung 3 (already max), abort instead.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE_SH = join(__dirname, '../../../orchestrations/scripts/claude.sh');
const src = readFileSync(CLAUDE_SH, 'utf8');

// ── 1. MAX_RETRIES = 7 (8 total attempts across 4 rungs) ─────────────────────
describe('claude.sh — MAX_RETRIES=7 gives 8 total attempts', () => {
  it('MAX_RETRIES default is 7', () => {
    expect(src).toMatch(/MAX_RETRIES.*EPAM_MAX_RETRIES.*:-7\}|MAX_RETRIES=.*7/);
  });

  it('retry loop condition uses -le MAX_RETRIES (inclusive = 8 iterations)', () => {
    expect(src).toMatch(/retry_count\s*-le\s*\$MAX_RETRIES/);
  });

  it('failure message references MAX_RETRIES+1 total attempts', () => {
    expect(src).toMatch(/MAX_RETRIES\s*\+\s*1.*attempts|attempts.*MAX_RETRIES\s*\+\s*1/is);
  });
});

// ── 2. Rung arithmetic — rung = retry_count / 2 ───────────────────────────────
describe('claude.sh — rung assigned by integer division of retry_count', () => {
  it('_rung is computed as retry_count / 2', () => {
    expect(src).toMatch(/_rung=\$\(\(\s*retry_count\s*\/\s*2\s*\)\)/);
  });

  it('_entering_rung is computed via retry_count % 2 == 0', () => {
    expect(src).toMatch(/_entering_rung=\$\(\(\s*retry_count\s*%\s*2\s*==\s*0\s*\)\)/);
  });

  it('escalation only fires when _entering_rung == 1 (first attempt of rung)', () => {
    expect(src).toMatch(/if\s*\[\s*"\$_entering_rung"\s*-eq\s*1\s*\]/);
  });

  it('second attempt of rung emits "same rung — no escalation" log', () => {
    expect(src).toMatch(/same rung.*no escalation|no escalation.*same rung/i);
  });
});

// ── 3. Rung boundaries and effort assignments ─────────────────────────────────
describe('claude.sh — each rung escalates correctly', () => {
  it('Rung 1 is the "1)" case in the rung switch/case', () => {
    const implStart = src.indexOf('implement_story()');
    const implEnd   = src.indexOf('\nimplement_story()', implStart + 100) > -1
      ? src.indexOf('\n# ──', implStart + 100)
      : src.length;
    const body = src.slice(implStart, implEnd);
    expect(body).toMatch(/case.*\$_rung.*\n.*1\)/is);
  });

  it('Rung 1 sets EPAM_REASONING_EFFORT=medium (no model change)', () => {
    const rung1Start = src.indexOf('# Rung 1:');
    const rung1End   = src.indexOf('# Rung 2:', rung1Start);
    const rung1Block = src.slice(rung1Start, rung1End);
    expect(rung1Block).toMatch(/EPAM_REASONING_EFFORT.*medium/);
    expect(rung1Block).not.toMatch(/get_model_ladder_step/);
  });

  it('Rung 2 calls get_model_ladder_step (model escalation)', () => {
    const rung2Start = src.indexOf('# Rung 2:');
    const rung2End   = src.indexOf('# Rung 3', rung2Start);
    const rung2Block = src.slice(rung2Start, rung2End);
    expect(rung2Block).toMatch(/get_model_ladder_step/);
  });

  it('Rung 3 sets EPAM_REASONING_EFFORT=high', () => {
    const rung3Start = src.indexOf('# Rung 3+:');
    const rung3Block = src.slice(rung3Start, rung3Start + 600);
    expect(rung3Block).toMatch(/EPAM_REASONING_EFFORT.*high/);
  });
});

// ── 4. HEALING_BROKEN — skip to next rung, not abort ─────────────────────────
describe('claude.sh — HEALING_BROKEN skips to next rung (not abort except at Rung 3)', () => {
  it('HEALING_BROKEN is checked after retry_count increment', () => {
    const incIdx   = src.indexOf('retry_count=$((retry_count + 1))');
    const afterInc = src.slice(incIdx, incIdx + 600);
    expect(incIdx).toBeGreaterThan(-1);
    expect(afterInc).toMatch(/HEALING_BROKEN/);
  });

  it('HEALING_BROKEN computes _cur_rung from (retry_count - 1) / 2', () => {
    expect(src).toMatch(/_cur_rung=\$\(\(\s*\(\s*retry_count\s*-\s*1\s*\)\s*\/\s*2\s*\)\)/);
  });

  it('HEALING_BROKEN computes _next_rung_start as (_cur_rung + 1) * 2', () => {
    expect(src).toMatch(/_next_rung_start=\$\(\(\s*\(_cur_rung\s*\+\s*1\s*\)\s*\*\s*2\s*\)\)/);
  });

  it('HEALING_BROKEN resets to 0 after handling (no bleed to next story)', () => {
    const hbCheckIdx = src.indexOf('HEALING_BROKEN:-0}') > -1
      ? src.indexOf('HEALING_BROKEN:-0}')
      : src.indexOf('"${HEALING_BROKEN:-0}"');
    const afterHBCheck = src.slice(hbCheckIdx, hbCheckIdx + 400);
    expect(afterHBCheck).toMatch(/HEALING_BROKEN=0/);
    expect(afterHBCheck).toMatch(/export HEALING_BROKEN/);
  });

  it('HEALING_BROKEN at _cur_rung >= 3 causes abort (not skip)', () => {
    expect(src).toMatch(/_cur_rung.*-ge.*3|HealingBroken.*max rung/is);
  });

  it('HEALING_BROKEN below Rung 3 sets retry_count to _next_rung_start', () => {
    expect(src).toMatch(/retry_count=\$_next_rung_start/);
  });

  it('[HealingBroken] log lines are emitted for both skip and abort cases', () => {
    expect(src).toMatch(/\[HealingBroken\].*Skipping to rung/);
    expect(src).toMatch(/\[HealingBroken\].*max rung|HealingBroken.*aborting/i);
  });
});

// ── 5. HEALING_BROKEN 20-char prefix comparison ───────────────────────────────
describe('claude.sh — HEALING_BROKEN uses 20-char prefix to tolerate analyst rephrasing', () => {
  it('diagnosis is truncated to [:20] before comparison', () => {
    const healingIdx = src.indexOf('check_healing_effectiveness()');
    const healingEnd = src.indexOf('\n}', healingIdx + 100);
    const body       = src.slice(healingIdx, healingEnd);
    expect(body).toMatch(/\[:20\]/g);
  });

  it('both diag AND events entries use the same [:20] truncation', () => {
    const healingIdx = src.indexOf('check_healing_effectiveness()');
    const healingEnd = src.indexOf('\n}', healingIdx + 100);
    const body       = src.slice(healingIdx, healingEnd);
    const matches    = body.match(/\[:20\]/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('no [:50] or [:100] truncation remains (mixed lengths would break comparison)', () => {
    const healingIdx = src.indexOf('check_healing_effectiveness()');
    const healingEnd = src.indexOf('\n}', healingIdx + 100);
    const body       = src.slice(healingIdx, healingEnd);
    expect(body).not.toMatch(/\[:50\]|\[:100\]/);
  });
});

// ── 6. EPAM_REASONING_EFFORT scoping ─────────────────────────────────────────
describe('claude.sh — reasoning effort is scoped per-story (no leakage)', () => {
  it('effort is reset to "low" at the start of each story', () => {
    expect(src).toMatch(/export EPAM_REASONING_EFFORT="low"/);
  });

  it('effort is exported so ai-run.sh subprocess receives it', () => {
    const exportCount = (src.match(/export EPAM_REASONING_EFFORT/g) ?? []).length;
    expect(exportCount).toBeGreaterThanOrEqual(2);
  });
});
