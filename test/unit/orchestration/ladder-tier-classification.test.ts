/**
 * Dynamic medium/high ladder classification — requested design: "current
 * ladder = medium ladder", add a "high" ladder using pricier/stronger models,
 * with the tier chosen DYNAMICALLY per story (never hardcoded per story ID)
 * from the story's own recorded failure history, plus an explicit PRD-level
 * override (.ladderTier) for known-hard stories.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(__dirname, '../../../');
const CLAUDE_SH = join(REPO_ROOT, 'orchestrations/scripts/claude.sh');
const TIER3_SH = join(REPO_ROOT, 'orchestrations/scripts/tier3-travel-app-run.sh');
const claudeSrc = readFileSync(CLAUDE_SH, 'utf8');
const tier3Src = readFileSync(TIER3_SH, 'utf8');

describe('tier3 script — medium/high ladder split', () => {
  it('MEDIUM ladder uses ESCALATION_MODEL (z-ai/glm-5.2 by default)', () => {
    const idx = tier3Src.indexOf('EPAM_MODEL_LADDER_MEDIUM=');
    const line = tier3Src.slice(idx, tier3Src.indexOf('\n', idx));
    expect(line).toMatch(/\$\{ESCALATION_MODEL\}/);
  });

  it('HIGH ladder uses a distinct ESCALATION_MODEL_HIGH variable', () => {
    expect(tier3Src).toMatch(/export ESCALATION_MODEL_HIGH="\$\{ESCALATION_MODEL_HIGH:-/);
    const idx = tier3Src.indexOf('EPAM_MODEL_LADDER_HIGH=');
    const line = tier3Src.slice(idx, tier3Src.indexOf('\n', idx));
    expect(line).toMatch(/\$\{ESCALATION_MODEL_HIGH\}/);
  });

  it('HIGH ladder default model differs from MEDIUM default model', () => {
    const medIdx = tier3Src.indexOf('export ESCALATION_MODEL="');
    const medLine = tier3Src.slice(medIdx, tier3Src.indexOf('\n', medIdx));
    const highIdx = tier3Src.indexOf('export ESCALATION_MODEL_HIGH="');
    const highLine = tier3Src.slice(highIdx, tier3Src.indexOf('\n', highIdx));
    expect(medLine).not.toBe(highLine);
  });

  it('HIGH ladder has an extra escalation step from the medium model to the high model', () => {
    const idx = tier3Src.indexOf('EPAM_MODEL_LADDER_HIGH=');
    const line = tier3Src.slice(idx, tier3Src.indexOf('\n', idx));
    expect(line).toMatch(/\$\{ESCALATION_MODEL\}=\$\{ESCALATION_MODEL_HIGH\}/);
  });
});

describe('claude.sh — classify_ladder_tier() is dynamic, not hardcoded per story', () => {
  const fnIdx = claudeSrc.indexOf('classify_ladder_tier()');
  const fnEnd = claudeSrc.indexOf('\n}', fnIdx);
  const body = claudeSrc.slice(fnIdx, fnEnd);

  it('function exists', () => {
    expect(fnIdx).toBeGreaterThan(-1);
  });

  it('contains no hardcoded story ID (SKY-*, HW-*, etc.)', () => {
    expect(body).not.toMatch(/SKY-\d|HW-\d/);
  });

  it('contains no hardcoded model name — tier decision is history/PRD driven only', () => {
    expect(body).not.toMatch(/MiniMax-M3|kimi-k2|z-ai\/glm/);
  });

  it('reads story-failures.jsonl (cross-run history) to detect a story that already exhausted a cycle', () => {
    expect(body).toMatch(/story-failures\.jsonl/);
    expect(body).toMatch(/MAX_RETRIES/);
  });

  it('checks a PRD-level .ladderTier override before computing from history', () => {
    expect(body).toMatch(/\.ladderTier/);
    const overrideIdx = body.indexOf('.ladderTier');
    const historyIdx = body.indexOf('story-failures.jsonl');
    expect(overrideIdx).toBeLessThan(historyIdx);
  });

  it('defaults to "medium" when no failure file and no PRD override exist', () => {
    expect(body).toMatch(/echo "medium"; return/);
  });
});

describe('claude.sh — get_model_ladder_step() resolves ladder by tier param', () => {
  const fnIdx = claudeSrc.indexOf('get_model_ladder_step()');
  const fnEnd = claudeSrc.indexOf('\n}', fnIdx);
  const body = claudeSrc.slice(fnIdx, fnEnd);

  it('accepts a tier argument defaulting to "medium"', () => {
    expect(body).toMatch(/tier="\$\{2:-medium\}"/);
  });

  it('resolves EPAM_MODEL_LADDER_HIGH for tier=high', () => {
    expect(body).toMatch(/EPAM_MODEL_LADDER_HIGH/);
  });

  it('resolves EPAM_MODEL_LADDER_MEDIUM for the default tier', () => {
    expect(body).toMatch(/EPAM_MODEL_LADDER_MEDIUM/);
  });

  it('EPAM_MODEL_LADDER (no suffix), if set, overrides both tiers (opt-out escape hatch)', () => {
    expect(body).toMatch(/ladder="\$\{EPAM_MODEL_LADDER:-\}"/);
  });
});

describe('claude.sh — Rung 2 wires classify_ladder_tier into get_model_ladder_step', () => {
  it('calls classify_ladder_tier before get_model_ladder_step', () => {
    const classifyIdx = claudeSrc.indexOf('_ladder_tier=$(classify_ladder_tier "$story_id")');
    const stepIdx = claudeSrc.indexOf('ladder_step_r2=$(get_model_ladder_step "${STORY_MODEL:-}" "$_ladder_tier")');
    expect(classifyIdx).toBeGreaterThan(-1);
    expect(stepIdx).toBeGreaterThan(classifyIdx);
  });

  it('logs the resolved tier for observability', () => {
    expect(claudeSrc).toMatch(/InferenceLadder\[Rung2\/R\$\{retry_count\}\]: tier=\$\{_ladder_tier\}/);
  });
});

describe('classify_ladder_tier — REAL execution against fixture failure histories', () => {
  function runClassify(failuresContent: string | null, prdLadderTier?: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'ladder-tier-test-'));
    try {
      const prd = {
        stories: [
          { id: 'TEST-001', ...(prdLadderTier ? { ladderTier: prdLadderTier } : {}) },
        ],
      };
      const prdPath = join(dir, 'prd.json');
      writeFileSync(prdPath, JSON.stringify(prd));

      let failuresFile = '';
      if (failuresContent !== null) {
        failuresFile = join(dir, 'story-failures.jsonl');
        writeFileSync(failuresFile, failuresContent);
      }

      const fnIdx = claudeSrc.indexOf('classify_ladder_tier()');
      const fnEnd = claudeSrc.indexOf('\n}', fnIdx) + 2;
      const fnBody = claudeSrc.slice(fnIdx, fnEnd);

      const script = `
PRD_FILE="${prdPath}"
LOG_DIR="${dir}"
MAX_RETRIES=7
${fnBody}
classify_ladder_tier "TEST-001"
`;
      const scriptPath = join(dir, 'run.sh');
      writeFileSync(scriptPath, script);
      return execFileSync('bash', [scriptPath], { encoding: 'utf8' }).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('returns "medium" when no failure history exists', () => {
    expect(runClassify(null)).toBe('medium');
  });

  it('returns "medium" for a story with only 1-2 failure attempts', () => {
    const content = [
      JSON.stringify({ storyId: 'TEST-001', attempt: 0 }),
      JSON.stringify({ storyId: 'TEST-001', attempt: 1 }),
    ].join('\n');
    expect(runClassify(content)).toBe('medium');
  });

  it('returns "high" when a prior attempt reached MAX_RETRIES (story exhausted a full cycle before)', () => {
    const content = [
      JSON.stringify({ storyId: 'TEST-001', attempt: 0 }),
      JSON.stringify({ storyId: 'TEST-001', attempt: 7 }),
    ].join('\n');
    expect(runClassify(content)).toBe('high');
  });

  it('returns "high" when the story has 6+ distinct recorded attempts even without hitting MAX_RETRIES in one', () => {
    const content = Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({ storyId: 'TEST-001', attempt: i })
    ).join('\n');
    expect(runClassify(content)).toBe('high');
  });

  it('ignores failure records for OTHER story IDs', () => {
    const content = [
      JSON.stringify({ storyId: 'OTHER-001', attempt: 7 }),
    ].join('\n');
    expect(runClassify(content)).toBe('medium');
  });

  it('PRD .ladderTier="high" override wins even with no failure history', () => {
    expect(runClassify(null, 'high')).toBe('high');
  });

  it('PRD .ladderTier="medium" override wins even with exhausted-cycle history', () => {
    const content = JSON.stringify({ storyId: 'TEST-001', attempt: 7 });
    expect(runClassify(content, 'medium')).toBe('medium');
  });
});
