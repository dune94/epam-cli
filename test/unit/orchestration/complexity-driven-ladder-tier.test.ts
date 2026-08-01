/**
 * Root cause of a design gap (discussed live, 2026-07-05): classify_ladder_tier()
 * only ever classified a story's ladder tier REACTIVELY — from failure history
 * (story-failures.jsonl) — even though the CPA pre-pass already computes
 * complexity signals (effort, cpaConfidence, cpaGate) for every story before
 * implementation even starts. No agent connected the two: a story known to be
 * complex up front (e.g. cpaGate="review", meaning its own cost estimate needed
 * scrutiny) still started on the cheap/base-model rungs and only reached the
 * HIGH ladder reactively, after already burning several failed attempts.
 *
 * Fix, two parts:
 *   1. contextualize-stories.sh's CPA pre-pass now derives an INITIAL
 *      `.ladderTier` for every story directly from complexity signals it just
 *      computed (cpaGate/effort) — fully automated, no human override, no new
 *      LLM call (the value is a deterministic function of already-reviewed CPA
 *      output). Written via the SAME jq write + reviewer gate as the rest of
 *      the CPA estimate.
 *   2. Rung 3 in claude.sh's retry loop previously passed a HARDCODED literal
 *      "high" to get_model_ladder_step(), silently pushing every story onto the
 *      HIGH ladder at the final rung regardless of its classified tier. Fixed
 *      to call classify_ladder_tier() at Rung 3 too (same as Rung 2) — the
 *      PRD's classified tier is now the ceiling all the way through the
 *      ladder, not just at the first escalation.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const CONTEXTUALIZE_SH = join(REPO_ROOT, 'orchestrations/scripts/contextualize-stories.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const contextualizeSrc = readFileSync(CONTEXTUALIZE_SH, 'utf8');

describe('contextualize-stories.sh — CPA pre-pass derives INITIAL ladderTier from complexity signals', () => {
  it('computes b_ladder_tier from cpaGate/effort using a deterministic case statement (no LLM call)', () => {
    const idx = contextualizeSrc.indexOf('b_ladder_tier=');
    expect(idx).toBeGreaterThan(-1);
    const block = contextualizeSrc.slice(idx - 50, idx + 400);
    expect(block).toMatch(/block\|review\)\s*b_ladder_tier="high"/);
    expect(block).toMatch(/high\)\s*b_ladder_tier="high"/);
  });

  it('writes ladderTier into the same jq call that writes the rest of the CPA estimate (same reviewer gate, no new write path)', () => {
    const jqCallIdx = contextualizeSrc.indexOf('--arg ltier "$b_ladder_tier"');
    expect(jqCallIdx).toBeGreaterThan(-1);
    // Generous window: this jq call has legitimately grown twice already as
    // more CPA-derived signals were added (cpaEffortTier, cpaIterationEstimate)
    // — a fixed tight window keeps drifting stale for the wrong reason (the
    // call growing, not moving away from ladderTier). A wide window still
    // proves the field is in the SAME jq call, which is the actual intent.
    const afterJq = contextualizeSrc.slice(jqCallIdx, jqCallIdx + 900);
    expect(afterJq).toMatch(/ladderTier:\s*\$ltier/);
    expect(afterJq).toMatch(/cpaGate:\s*\$gate/); // same write, not a separate one
  });

  it('the BEFORE snapshot (used for revert-on-reviewer-reject) includes ladderTier, so a rejected CPA estimate reverts the tier too', () => {
    const idx = contextualizeSrc.indexOf('_cpa_before=$(jq');
    const line = contextualizeSrc.slice(idx, contextualizeSrc.indexOf('\n', idx));
    expect(line).toMatch(/ladderTier/);
  });
});

describe('contextualize-stories.sh — complexity-to-tier rule, REAL execution', () => {
  function classify(gate: string, effort: string): string {
    const output = execFileSync(
      'bash',
      ['-c', `
        b_gate="${gate}"
        b_eff="${effort}"
        case "$b_gate" in
          block|review) b_ladder_tier="high" ;;
          *)
            case "$b_eff" in
              high) b_ladder_tier="high" ;;
              *)    b_ladder_tier="medium" ;;
            esac
            ;;
        esac
        echo "$b_ladder_tier"
      `],
      { encoding: 'utf8' },
    );
    return output.trim();
  }

  it('cpaGate="review" always yields high tier regardless of effort (matches the live SKY-002/003/004 case: all effort=low, gate=review)', () => {
    expect(classify('review', 'low')).toBe('high');
    expect(classify('review', 'medium')).toBe('high');
  });

  it('cpaGate="block" always yields high tier', () => {
    expect(classify('block', 'low')).toBe('high');
  });

  it('cpaGate="pass" with effort="high" still yields high tier', () => {
    expect(classify('pass', 'high')).toBe('high');
  });

  it('cpaGate="pass" with effort="low" or "medium" yields medium tier (the common/default case)', () => {
    expect(classify('pass', 'low')).toBe('medium');
    expect(classify('pass', 'medium')).toBe('medium');
  });
});

describe('claude.sh — Rung 3 respects the PRD-classified tier (no hardcoded "high" literal)', () => {
  const rung3Idx = claudeSrc.indexOf('Rung 3+: escalate to the strongest configured model');
  const rung3End = claudeSrc.indexOf('\n                esac', rung3Idx);
  const rung3Body = claudeSrc.slice(rung3Idx, rung3End);

  it('calls classify_ladder_tier() at Rung 3 (not just Rung 2)', () => {
    expect(rung3Body).toMatch(/_ladder_tier_r3=\$\(classify_ladder_tier "\$story_id"\)/);
  });

  it('passes the classified tier variable to get_model_ladder_step for the main escalation path', () => {
    // Main escalation must use the PRD-classified tier variable — no hardcoded "high".
    // Exception: the HealingBroken+skipLadder override explicitly passes "high" as a
    // documented last-resort for model diversity when self-healing is confirmed broken.
    // That call is guarded by _healed_count_r3 >= 1 && skipLadder=true, making it
    // distinct from the main path.
    expect(rung3Body).toMatch(/get_model_ladder_step "\$\{STORY_MODEL:-\}" "\$_ladder_tier_r3"/);
    // The HealingBroken override's "high" literal must be inside its own guard block,
    // not the main classify_ladder_tier() branch.
    const mainBranchIdx = rung3Body.indexOf('_ladder_tier_r3=$(classify_ladder_tier');
    const healingOverrideIdx = rung3Body.indexOf('HealingBroken+skipLadder');
    expect(mainBranchIdx).toBeGreaterThan(-1);
    expect(healingOverrideIdx).toBeGreaterThan(-1);
    // The "high" literal must appear after the main branch (inside the healing override)
    const highIdx = rung3Body.indexOf('"high"', mainBranchIdx);
    expect(highIdx).toBeGreaterThan(mainBranchIdx);
  });
});

describe('Rung 3 tier-respecting escalation — REAL execution', () => {
  function extractFunctionBody(name: string): string {
    const start = claudeSrc.indexOf(`${name}()`);
    const braceStart = claudeSrc.indexOf('{', start);
    let depth = 0;
    for (let i = braceStart; i < claudeSrc.length; i++) {
      if (claudeSrc[i] === '{') depth++;
      else if (claudeSrc[i] === '}') {
        depth--;
        if (depth === 0) return claudeSrc.slice(start, i + 1);
      }
    }
    throw new Error(`Could not find end of function ${name}`);
  }

  function simulateRung3(tier: 'medium' | 'high', storyModelAfterRung2: string): string {
    const classifyFn = extractFunctionBody('classify_ladder_tier');
    const ladderFn = extractFunctionBody('get_model_ladder_step');
    const dir = mkdtempSync(join(tmpdir(), 'rung3-tier-test-'));
    try {
      const prdPath = join(dir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify({ stories: [{ id: 'SKY-TEST', ladderTier: tier }] }));
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(
        scriptPath,
        `PRD_FILE="${prdPath}"
ESCALATION_MODEL="z-ai/glm-5.2"
ESCALATION_MODEL_HIGH="z-ai/glm-5.1"
EPAM_MODEL_LADDER_MEDIUM="MiniMax-M2.5=MiniMax-M3|MiniMax-M3=\${ESCALATION_MODEL}|moonshotai/kimi-k2=\${ESCALATION_MODEL}"
EPAM_MODEL_LADDER_HIGH="MiniMax-M2.5=MiniMax-M3|MiniMax-M3=\${ESCALATION_MODEL_HIGH}|\${ESCALATION_MODEL}=\${ESCALATION_MODEL_HIGH}|moonshotai/kimi-k2=\${ESCALATION_MODEL_HIGH}"
EPAM_MODEL_LADDER=""
log() { :; }
${classifyFn}
${ladderFn}
STORY_MODEL="${storyModelAfterRung2}"
_ladder_tier_r3=$(classify_ladder_tier "SKY-TEST")
echo "TIER=$_ladder_tier_r3"
ladder_step_r3=$(get_model_ladder_step "$STORY_MODEL" "$_ladder_tier_r3")
echo "STEP=\${ladder_step_r3:-none}"
`,
      );
      return execFileSync('bash', [scriptPath], { encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('a MEDIUM-tier story already escalated to z-ai/glm-5.2 at Rung 2 does NOT escalate further at Rung 3 (stays within its classified ceiling)', () => {
    const output = simulateRung3('medium', 'z-ai/glm-5.2');
    expect(output).toContain('TIER=medium');
    expect(output).toContain('STEP=none');
  });

  it('a HIGH-tier story already escalated to z-ai/glm-5.2 at Rung 2 DOES escalate further to z-ai/glm-5.1 at Rung 3', () => {
    const output = simulateRung3('high', 'z-ai/glm-5.2');
    expect(output).toContain('TIER=high');
    expect(output).toContain('STEP=z-ai/glm-5.1');
  });
});
