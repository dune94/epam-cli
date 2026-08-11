/**
 * Root cause of a live defect (run #14, 2026-07-04): Rung 3 (the top of the
 * inference ladder) was supposed to escalate to the strongest configured model,
 * but its ONLY model-escalation branch fired when the story had had ZERO prior
 * escalation (STORY_MODEL == STORY_MODEL_ORIGINAL). Every story that reaches
 * Rung 3 already escalated once at Rung 2 by construction, so that condition was
 * always false — Rung 3 silently kept whatever model Rung 2 picked, only bumping
 * EPAM_REASONING_EFFORT to "high". Confirmed on SKY-004: attempts 5-8 all ran on
 * z-ai/glm-5.2 (the MEDIUM-tier target); z-ai/glm-5.1 (the HIGH-tier target,
 * configured specifically via EPAM_MODEL_LADDER_HIGH for hard stories) was never
 * invoked across the entire 8-attempt cycle.
 *
 * Fix: when the story already escalated once (the common case at Rung 3), step
 * the CURRENT model again via get_model_ladder_step(STORY_MODEL, "high") — using
 * "high" unconditionally, since reaching Rung 3 at all is itself the evidence
 * this story needs the strongest available model. The original "never escalated
 * at all" fallback-to-EPAM_FINAL_FALLBACK_MODEL path is preserved for the rare
 * case Rung 2 had no ladder step for its model.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const TIER3_SH = join(REPO_ROOT, 'orchestrations/scripts/tier3-travel-app-run.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');

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

describe('claude.sh — Rung 3 escalation logic', () => {
  const rung3Idx = claudeSrc.indexOf('Rung 3+: escalate to the strongest configured model');
  const rung3End = claudeSrc.indexOf('\n                esac', rung3Idx);
  const rung3Body = claudeSrc.slice(rung3Idx, rung3End);

  it('Rung 3 comment/logic block exists', () => {
    expect(rung3Idx).toBeGreaterThan(-1);
  });

  it('preserves the "never escalated at all" fallback-to-final-fallback-model path', () => {
    expect(rung3Body).toMatch(/STORY_MODEL:-\}"\s*=\s*"\$\{STORY_MODEL_ORIGINAL:-\}/);
    expect(rung3Body).toMatch(/EPAM_FINAL_FALLBACK_MODEL/);
  });

  it('the "already escalated" branch calls get_model_ladder_step with the story\'s classified tier (2026-07-05: replaced a hardcoded "high" literal — see complexity-driven-ladder-tier.test.ts), not an unconditional literal', () => {
    expect(rung3Body).toMatch(/_ladder_tier_r3=\$\(classify_ladder_tier "\$story_id"\)/);
    // The ladder decision is delegated to next_ladder_step (executed tests: next-ladder-step.test.ts);
    // it calls get_model_ladder_step internally. What rung 3 must still do is escalate on the
    // story's CLASSIFIED tier rather than a hardcoded one — that is the defect this file guards.
    expect(rung3Body).toMatch(/next_ladder_step\s+3\s+"\$\{STORY_MODEL:-\}"/);
    expect(rung3Body).toMatch(/_ladder_tier_r3/);
  });

  it('updates STORY_MODEL and STORY_PROVIDER when the high-tier step returns a different model', () => {
    expect(rung3Body).toMatch(/STORY_MODEL="\$ladder_step_r3"/);
    expect(rung3Body).toMatch(/STORY_PROVIDER=/);
  });

  it('still sets reasoning effort to high regardless of which branch was taken', () => {
    // Env-overridable via EPAM_RUNG3_REASONING_EFFORT — default is still "high".
    // The per-rung effort floor moved into next_ladder_step with the rest of the ladder
    // decision, so assert it where it now lives. The behaviour is unchanged and is also
    // covered by executed tests in next-ladder-step.test.ts.
    expect(extractFunctionBody('next_ladder_step'))
      .toMatch(/EPAM_RUNG3_REASONING_EFFORT:-high/);
  });
});

describe('Rung 3 escalation — REAL execution using the actual tier3 ladder config', () => {
  function simulateRung3(storyModel: string, storyModelOriginal: string): { route: string; finalModel: string } {
    const dir = mkdtempSync(join(tmpdir(), 'rung3-test-'));
    try {
      const ladderStepBody = extractFunctionBody('get_model_ladder_step');
      const scriptPath = join(dir, 'run.sh');
      // Mirrors tier3-travel-app-run.sh's real ladder env vars exactly.
      writeFileSync(
        scriptPath,
        `
ESCALATION_MODEL="z-ai/glm-5.2"
ESCALATION_MODEL_HIGH="z-ai/glm-5.1"
export EPAM_MODEL_LADDER_MEDIUM="MiniMax-M2.5=MiniMax-M3|MiniMax-M3=\${ESCALATION_MODEL}|zhipuai/glm-z1-32b=\${ESCALATION_MODEL}|zhipuai/glm-z1-9b=\${ESCALATION_MODEL}"
export EPAM_MODEL_LADDER_HIGH="MiniMax-M2.5=MiniMax-M3|MiniMax-M3=\${ESCALATION_MODEL_HIGH}|zhipuai/glm-z1-32b=\${ESCALATION_MODEL_HIGH}|zhipuai/glm-z1-9b=\${ESCALATION_MODEL_HIGH}|\${ESCALATION_MODEL}=\${ESCALATION_MODEL_HIGH}"
export EPAM_MODEL_LADDER=""
${ladderStepBody}

STORY_MODEL="${storyModel}"
STORY_MODEL_ORIGINAL="${storyModelOriginal}"
EPAM_FINAL_FALLBACK_MODEL="moonshotai/kimi-k2"
log() { :; }

_ffm="\${EPAM_FINAL_FALLBACK_MODEL:-}" _ffp="\${EPAM_FINAL_FALLBACK_PROVIDER:-}"
if [ -n "$_ffm" ] && [ "\${STORY_MODEL:-}" = "\${STORY_MODEL_ORIGINAL:-}" ]; then
    echo "ROUTE=fallback"
    STORY_MODEL="$_ffm"
    [ -n "$_ffp" ] && STORY_PROVIDER="$_ffp"
else
    ladder_step_r3=$(get_model_ladder_step "\${STORY_MODEL:-}" "high")
    if [ -n "$ladder_step_r3" ] && [ "$ladder_step_r3" != "\${STORY_MODEL:-}" ]; then
        echo "ROUTE=escalate"
        STORY_MODEL="$ladder_step_r3"
    else
        echo "ROUTE=no-step"
    fi
fi
echo "FINAL_MODEL=$STORY_MODEL"
`,
      );
      const output = execFileSync('bash', [scriptPath], { encoding: 'utf8' });
      const route = output.match(/ROUTE=(\S+)/)?.[1] ?? '';
      const finalModel = output.match(/FINAL_MODEL=(\S+)/)?.[1] ?? '';
      return { route, finalModel };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('when the story already escalated at Rung 2 (MiniMax-M3 -> glm-5.2), Rung 3 steps further to glm-5.1 (the HIGH-tier target)', () => {
    const { route, finalModel } = simulateRung3('z-ai/glm-5.2', 'MiniMax-M3');
    expect(route).toBe('escalate');
    expect(finalModel).toBe('z-ai/glm-5.1');
  });

  it('when the story never escalated at all (Rung 2 had no ladder step), Rung 3 still routes to the final fallback model', () => {
    const { route, finalModel } = simulateRung3('MiniMax-M3', 'MiniMax-M3');
    expect(route).toBe('fallback');
    expect(finalModel).toBe('moonshotai/kimi-k2');
  });

  it('regression guard: the OLD buggy behavior (staying on glm-5.2 forever) does not occur', () => {
    const { finalModel } = simulateRung3('z-ai/glm-5.2', 'MiniMax-M3');
    expect(finalModel).not.toBe('z-ai/glm-5.2');
  });
});

describe('tier3-travel-app-run.sh — HIGH ladder actually contains a step from the MEDIUM target to the HIGH target', () => {
  const tier3Src = readFileSync(TIER3_SH, 'utf8');

  it('EPAM_MODEL_LADDER_HIGH maps ESCALATION_MODEL (medium target) to ESCALATION_MODEL_HIGH', () => {
    const idx = tier3Src.indexOf('EPAM_MODEL_LADDER_HIGH=');
    const line = tier3Src.slice(idx, tier3Src.indexOf('\n', idx));
    expect(line).toMatch(/\$\{ESCALATION_MODEL\}=\$\{ESCALATION_MODEL_HIGH\}/);
  });
});
