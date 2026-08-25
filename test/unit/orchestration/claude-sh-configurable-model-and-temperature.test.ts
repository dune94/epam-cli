/**
 * EFFORT_MODEL_LOW/MEDIUM/HIGH and the ladder's per-rung EPAM_TEMPERATURE
 * values were hardcoded literals in claude.sh with NO project-config
 * override path at all — found live, 2026-08-01: a sandbox invocation with
 * no story.model/aiProvider set fell through to EFFORT_MODEL_HIGH's
 * hardcoded "gpt-5-codex" default and invoked codex via that fallback, 4
 * straight zero-token failures (no OPENAI_API_KEY in the environment) — a
 * provider this project never actually uses. Every one of these is now
 * env-overridable, defaulting to the prior hardcoded value so existing
 * behavior is unchanged unless a project opts in.
 *
 * Real execution: extracts and runs the actual, unmodified lines from
 * claude.sh, not a re-implementation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const CLAUDE_SH = readFileSync(join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');

function extractLine(marker: string): string {
  const start = CLAUDE_SH.indexOf(marker);
  expect(start, `line not found: ${marker}`).toBeGreaterThan(-1);
  const end = CLAUDE_SH.indexOf('\n', start);
  return CLAUDE_SH.slice(start, end);
}

function runLine(line: string, env: NodeJS.ProcessEnv = {}): string {
  const varName = line.replace(/^export\s+/, '').split('=')[0].trim();
  return execFileSync('bash', ['-c', `${line}\necho "$${varName}"`], {
    encoding: 'utf8', env: { ...process.env, ...env },
  }).trim();
}

describe('EFFORT_MODEL_LOW/MEDIUM/HIGH are env-overridable, not hardcoded', () => {
  it('EFFORT_MODEL_LOW resolves from the LADDER when unset — never a literal', () => {
    // THIS CASE USED TO ASSERT `gpt-5-codex`, described as "unchanged behavior".
    //
    // That literal was the defect, not the contract: all three effort tiers defaulted to the SAME
    // model, and one with no entry in any ladder — which is why 205 of 211 archived story records
    // carry an identical assigned model. The ladders now decide every call, with no exceptions.
    //
    // The case's INTENT — these are resolved, not hardcoded — is unchanged and still asserted;
    // only the stale expectation about what they resolve TO has moved. With no ladder exported
    // the answer is EMPTY, because a wrong model costs more than a stopped run and the caller
    // fails rather than substituting something plausible.
    const line = extractLine('EFFORT_MODEL_LOW=');
    const env = { ...process.env };
    delete env.EPAM_EFFORT_MODEL_LOW;
    delete env.EPAM_MODEL_LADDER_TIER_ORDER;
    expect(runLine(line, env), 'a model literal reappeared as the effort default').toBe('');
  });

  it('EFFORT_MODEL_LOW is overridden by EPAM_EFFORT_MODEL_LOW', () => {
    const line = extractLine('EFFORT_MODEL_LOW=');
    expect(runLine(line, { EPAM_EFFORT_MODEL_LOW: 'z-ai/glm-5.1' })).toBe('z-ai/glm-5.1');
  });

  it('EFFORT_MODEL_MEDIUM is overridden by EPAM_EFFORT_MODEL_MEDIUM', () => {
    const line = extractLine('EFFORT_MODEL_MEDIUM=');
    expect(runLine(line, { EPAM_EFFORT_MODEL_MEDIUM: 'z-ai/glm-5.2' })).toBe('z-ai/glm-5.2');
  });

  it('EFFORT_MODEL_HIGH is overridden by EPAM_EFFORT_MODEL_HIGH', () => {
    const line = extractLine('EFFORT_MODEL_HIGH=');
    expect(runLine(line, { EPAM_EFFORT_MODEL_HIGH: 'moonshotai/kimi-k3' })).toBe('moonshotai/kimi-k3');
  });
});

describe('the ladder\'s per-rung EPAM_TEMPERATURE values are env-overridable, not hardcoded', () => {
  it('Rung1 defaults to 0 (unchanged behavior) and is overridden by EPAM_RUNG1_TEMPERATURE', () => {
    const line = extractLine('export EPAM_TEMPERATURE="${EPAM_RUNG1_TEMPERATURE:-0}"');
    const envDefault = { ...process.env };
    delete envDefault.EPAM_RUNG1_TEMPERATURE;
    expect(runLine(line, envDefault)).toBe('0');
    expect(runLine(line, { EPAM_RUNG1_TEMPERATURE: '0.6' })).toBe('0.6');
  });

  it('Rung2 defaults to 0.3 (unchanged behavior) and is overridden by EPAM_RUNG2_TEMPERATURE', () => {
    const line = extractLine('export EPAM_TEMPERATURE="${EPAM_RUNG2_TEMPERATURE:-0.3}"');
    const envDefault = { ...process.env };
    delete envDefault.EPAM_RUNG2_TEMPERATURE;
    expect(runLine(line, envDefault)).toBe('0.3');
    expect(runLine(line, { EPAM_RUNG2_TEMPERATURE: '0.7' })).toBe('0.7');
  });

  it('Rung3 defaults to 0.7 (unchanged behavior) and is overridden by EPAM_RUNG3_TEMPERATURE', () => {
    const line = extractLine('export EPAM_TEMPERATURE="${EPAM_RUNG3_TEMPERATURE:-0.7}"');
    const envDefault = { ...process.env };
    delete envDefault.EPAM_RUNG3_TEMPERATURE;
    expect(runLine(line, envDefault)).toBe('0.7');
    expect(runLine(line, { EPAM_RUNG3_TEMPERATURE: '0.8' })).toBe('0.8');
  });
});
