/**
 * Three compounding self-heal failures diagnosed 2026-07-20 (SKY-003-test):
 *
 * Bug 1 — PRD-Reviewer emits fail with empty issues array ("no details")
 *   Root: reviewer profile had no constraint requiring non-empty issues on fail.
 *   Fix: prd-change-reviewer profile now requires ≥1 specific issue string when verdict=fail.
 *
 * Bug 2 — DeterministicCheck bypasses failure-analyst but stops re-injecting prior diagnosis
 *   Root: on retries 2+ the deterministic check skips the analyst (correct) but only injects
 *   VERIFICATION_FAILURE — the actionable failure-analyst guidance from healing-events.jsonl
 *   was never re-read, so the agent lost it.
 *   Fix: DeterministicCheck block now reads the last stored diagnosis from healing-events.jsonl
 *   and appends it to COORDINATOR_PROMPT_AMENDMENT.
 *
 * Bug 3 — skipLadder=true traps story at ceiling under confirmed HealingBroken
 *   Root: skipLadder is downgrade-prevention only, but when the medium-tier ceiling is already
 *   assigned and self-healing is confirmed broken, no model diversity is possible.
 *   Fix: Rung 2 and Rung 3 now check healing-events.jsonl; if ≥1 event exists for the story
 *   and the ladder returned no step, they force HIGH-tier escalation instead.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const PROFILES  = join(REPO_ROOT, 'orchestrations/agents/profiles.json');
const PROFILES_ORIG = join(REPO_ROOT, 'orchestrations/agents/profiles.json.original');

const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const profiles  = JSON.parse(readFileSync(PROFILES, 'utf8'));
const profilesOrig = JSON.parse(readFileSync(PROFILES_ORIG, 'utf8'));
const reviewer: string = profiles['prd-change-reviewer'];

// ── Bug 1: PRD-Reviewer must emit specific issues on fail ─────────────────────

describe('Bug 1 fix — prd-change-reviewer: non-empty issues required on fail verdict', () => {
  it('reviewer profile documents the non-empty issues constraint', () => {
    expect(reviewer).toMatch(/fail.*verdict.*MUST.*issues|issues.*array.*fail.*invalid/i);
  });

  it('constraint states that empty issues array makes rejection irreversible', () => {
    expect(reviewer).toContain('"verdict":"fail","issues":[]');
    expect(reviewer).toMatch(/empty issues array.*summarizer|issues array.*nothing to fix/i);
  });

  it('constraint gives the correct fallback: output pass if no violation can be articulated', () => {
    expect(reviewer).toMatch(/cannot articulate.*specific.*violation.*output.*pass|cannot articulate.*pass instead/i);
  });

  it('constraint is present in profiles.json.original (canonical floor)', () => {
    const origReviewer: string = profilesOrig['prd-change-reviewer'];
    expect(origReviewer).toMatch(/fail.*verdict.*MUST.*issues|issues.*array.*fail.*invalid/i);
  });
});

// ── Bug 2: DeterministicCheck re-injects prior failure-analyst diagnosis ──────

describe('Bug 2 fix — DeterministicCheck re-injects prior failure-analyst diagnosis', () => {
  it('DeterministicCheck block reads healing-events.jsonl to find last diagnosis', () => {
    const dcIdx = claudeSrc.indexOf('DeterministicCheck] Skipping failure-analyst');
    expect(dcIdx).toBeGreaterThan(-1);
    const block = claudeSrc.slice(dcIdx, dcIdx + 3000);
    expect(block).toContain('healing-events.jsonl');
    expect(block).toContain('_last_fa_diagnosis');
  });

  it('re-injection is keyed by story_id (not a global last diagnosis)', () => {
    const dcIdx = claudeSrc.indexOf('DeterministicCheck] Skipping failure-analyst');
    const block = claudeSrc.slice(dcIdx, dcIdx + 3000);
    // Must filter healing-events by the current story_id
    expect(block).toMatch(/story_id.*story|story.*story_id/);
  });

  it('prior diagnosis is appended to COORDINATOR_PROMPT_AMENDMENT (not replacing it)', () => {
    const dcIdx = claudeSrc.indexOf('DeterministicCheck] Skipping failure-analyst');
    const block = claudeSrc.slice(dcIdx, dcIdx + 3000);
    // The amendment must include BOTH verification failure AND the prior diagnosis
    expect(block).toContain('${VERIFICATION_FAILURE}');
    expect(block).toContain('_last_fa_diagnosis');
    expect(block).toContain('Prior failure-analyst diagnosis');
  });

  it('re-injection is conditional — only appended when a prior diagnosis exists', () => {
    // The ${var:+text} shell expansion only expands when var is non-empty —
    // this is the canonical bash guard for "append only when set".
    expect(claudeSrc).toContain('${_last_fa_diagnosis:+');
  });

  it('re-injection skips target=none (HEALING_BROKEN marker events)', () => {
    const dcIdx = claudeSrc.indexOf('DeterministicCheck] Skipping failure-analyst');
    const block = claudeSrc.slice(dcIdx, dcIdx + 3000);
    // healing-events reader must exclude target=none (those are HEALING_BROKEN
    // marker rows — not actionable diagnoses).
    expect(block).toMatch(/target.*not in.*none|target.*!=.*none/);
  });
});

// ── Bug 3: skipLadder + HealingBroken → force HIGH-tier escalation ───────────

describe('Bug 3 fix — skipLadder + HealingBroken forces HIGH-tier escalation at Rung 2', () => {
  it('Rung 2 checks healing-events.jsonl to detect confirmed HealingBroken', () => {
    const rung2Idx = claudeSrc.indexOf('InferenceLadder[Rung2/R${retry_count}]: tier=');
    expect(rung2Idx).toBeGreaterThan(-1);
    const block = claudeSrc.slice(rung2Idx, rung2Idx + 3000);
    expect(block).toContain('healing-events.jsonl');
    expect(block).toContain('_healed_count');
  });

  it('Rung 2 forces HIGH-tier get_model_ladder_step when stuck + healed_count >= 1', () => {
    const rung2Idx = claudeSrc.indexOf('InferenceLadder[Rung2/R${retry_count}]: tier=');
    const block = claudeSrc.slice(rung2Idx, rung2Idx + 3000);
    expect(block).toContain('HealingBroken+skipLadder');
    expect(block).toContain('get_model_ladder_step "${STORY_MODEL:-}" "high"');
  });

  it('Rung 2 HIGH-tier override is keyed by story_id (not global healing count)', () => {
    const rung2Idx = claudeSrc.indexOf('InferenceLadder[Rung2/R${retry_count}]: tier=');
    const block = claudeSrc.slice(rung2Idx, rung2Idx + 3000);
    expect(block).toMatch(/story_id.*story|story.*story_id/);
  });

  it('Rung 3 applies the same HealingBroken+skipLadder HIGH-tier override', () => {
    const rung3Idx = claudeSrc.indexOf('InferenceLadder[Rung3/R${retry_count}]: tier=');
    expect(rung3Idx).toBeGreaterThan(-1);
    const block = claudeSrc.slice(rung3Idx, rung3Idx + 3500);
    expect(block).toContain('HealingBroken+skipLadder');
    expect(block).toContain('get_model_ladder_step "${STORY_MODEL:-}" "high"');
    expect(block).toContain('_healed_count_r3');
  });

  it('override only fires when skipLadder=true (not for normal stories with no ceiling)', () => {
    const rung2Idx = claudeSrc.indexOf('InferenceLadder[Rung2/R${retry_count}]: tier=');
    const block = claudeSrc.slice(rung2Idx, rung2Idx + 3000);
    // The guard must check _skip_ladder = "true" before forcing HIGH tier
    const overrideIdx = block.indexOf('HealingBroken+skipLadder');
    const preOverride = block.slice(0, overrideIdx);
    expect(preOverride).toContain('_skip_ladder" = "true"');
  });

  it('override does not apply when the HIGH-tier step returns the same model (already at absolute ceiling)', () => {
    const rung2Idx = claudeSrc.indexOf('InferenceLadder[Rung2/R${retry_count}]: tier=');
    const block = claudeSrc.slice(rung2Idx, rung2Idx + 3000);
    // Must check that _high_step != STORY_MODEL before applying
    expect(block).toMatch(/_high_step.*STORY_MODEL|STORY_MODEL.*_high_step/);
  });
});
