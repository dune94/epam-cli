/**
 * The code-graph-detective must be COHESIVE with the rest of the pipeline's
 * model ladder, not hard-pinned to one model.
 *
 * Found live 2026-07-23: the detective ran fine in isolation (glm-5.1, ~2 min)
 * but in-pipeline its glm-5.1 call stalled and hit the 6-min timeout with EMPTY
 * output — and the old retry re-ran the SAME stuck model, dead-ending. openspec
 * and speckit already escalate to their HIGH model on retry; the detective was
 * the only spec agent that didn't. Now it ladders glm-5.1 → kimi-k3 (per
 * EPAM_MODEL_LADDER_HIGH) on retry, resolving the escalated model's provider
 * from EPAM_MODEL_PROVIDER_MAP — so a stuck/slow base endpoint gets a real
 * second chance on a stronger model / different infra.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const spec = require('../../../orchestrations/scripts/spec-mode-runner.js');
const { ladderNextModel, resolveModelProvider } = spec;
const specSrc = readFileSync(
  join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

const LADDER = 'MiniMax-M3=z-ai/glm-5.1|z-ai/glm-5.1=moonshotai/kimi-k3';
const PROV = 'moonshotai/*=qwen|z-ai/*=qwen|MiniMax-*=minimax';

describe('ladderNextModel', () => {
  it('resolves the HIGH-ladder successor of glm-5.1 to kimi-k3', () => {
    expect(ladderNextModel('z-ai/glm-5.1', { EPAM_MODEL_LADDER_HIGH: LADDER })).toBe('moonshotai/kimi-k3');
  });
  it('returns null for a model not in the ladder', () => {
    expect(ladderNextModel('some/model', { EPAM_MODEL_LADDER_HIGH: LADDER })).toBeNull();
  });
  it('returns null when no ladder is configured', () => {
    expect(ladderNextModel('z-ai/glm-5.1', {})).toBeNull();
  });
  it('the escalated model resolves to a real provider via the provider map', () => {
    const next = ladderNextModel('z-ai/glm-5.1', { EPAM_MODEL_LADDER_HIGH: LADDER });
    expect(resolveModelProvider(next, { EPAM_MODEL_PROVIDER_MAP: PROV })).toBe('qwen');
  });
});

describe('detective wiring — ladder escalation on retry', () => {
  it('builds a per-attempt exec: base model on attempt 1, ladder successor on attempt 2+', () => {
    expect(specSrc).toMatch(/const escalatedModel = ladderNextModel\(baseModel, process\.env\)/);
    expect(specSrc).toMatch(/const useEscalated = attempt >= 2 && escalatedModel/);
    expect(specSrc).toMatch(/execFor\(attempt\)/);
  });
  it('logs the ladder escalation (visible, like openspec/speckit)', () => {
    expect(specSrc).toMatch(/code-graph-detective ladder escalation for .* model .* → /);
  });
  it('defaults to 3 attempts so an escalated retry actually gets to run', () => {
    expect(specSrc).toMatch(/CODEGRAPH_DETECTIVE_MAX_ATTEMPTS \|\| '3'/);
  });
});
