/**
 * Regression guard for a live-run defect (tier3 core phase, 2026-07-02):
 * spec-mode-runner.js's LLM model-review pass wrote decision.finalModel
 * straight to story.model with ZERO validation. The reviewer hallucinated
 * "moonshotai/MiniMax-M3" (mixing the moonshotai org prefix with the
 * minimax model name — matches no real model on any provider), and every
 * subsequent API call for that story failed instantly (cost=$0, 0 tokens),
 * burning all 8 retry attempts. The InferenceLadder cannot recover from a
 * malformed model string — escalation only helps when the current model is
 * real but insufficient.
 *
 * This was NOT caught by the earlier self-healing audit because that audit
 * only covered applySpecChanges (the spec_pass AC/description rewrite path)
 * — a SEPARATE code path in the same file (the model-review pass) also
 * writes directly to story.model and was missed.
 *
 * Fix: buildKnownValidModels()/isValidModelString() validate the LLM's
 * finalModel against a known-good allow-list before it's ever assigned to
 * story.model; an unrecognized string falls back to the rule-based
 * recommendation (which is validated by construction — it only ever
 * produces the current model or the configured upgrade/mini model).
 *
 * Both functions are exported specifically so this validation is
 * REAL-EXECUTION tested here, not just grepped for — the point is to catch
 * this bug CLASS (any future unvalidated LLM-written PRD field), not just
 * this one instance.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const SPEC_RUNNER = join(REPO_ROOT, 'orchestrations/scripts/spec-mode-runner.js');
const src = readFileSync(SPEC_RUNNER, 'utf8');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildKnownValidModels, isValidModelString } = require(SPEC_RUNNER);

/**
 * A PROJECT'S DECLARED LADDER, as export_model_ladders puts it in the environment.
 *
 * buildKnownValidModels used to carry nine vendor model names in the engine, so any project
 * running something else had its own valid models rejected as hallucinations, and the list went
 * stale the moment a vendor shipped a version. The set is now the project's own rungs — which
 * means a test wanting a populated set must declare a ladder, exactly as a run does.
 */
function withLadder<T>(fn: () => T): T {
  const saved = { ...process.env };
  process.env.EPAM_MODEL_LADDER_MEDIUM = 'MiniMax-M2.5=MiniMax-M3';
  process.env.EPAM_MODEL_LADDER_HIGH = 'MiniMax-M3=z-ai/glm-5.2';
  process.env.EPAM_MODEL_LADDER_HIGHEST = 'z-ai/glm-5.2=moonshotai/kimi-k3';
  try { return fn(); } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

describe('buildKnownValidModels — the allow-list', () => {
  it('includes every model the PROJECT declares on its ladders', () => {
    // WAS: asserted a roster hardcoded in the engine. That test's only effect was to keep four
    // vendor model names pinned there. The requirement is that a model the project actually uses
    // is recognised — so declare a ladder and check its rungs, both sides of every hop.
    const set = withLadder(() => buildKnownValidModels('', ''));
    for (const m of ['MiniMax-M2.5', 'MiniMax-M3', 'z-ai/glm-5.2', 'moonshotai/kimi-k3']) {
      expect(set.has(m), `the project declares ${m} on its ladder but it is not recognised`).toBe(true);
    }
  });

  it('recognises a model no engine list could have anticipated', () => {
    // The point of the change: a project on a different vendor entirely still works.
    const saved = process.env.EPAM_MODEL_LADDER_MEDIUM;
    process.env.EPAM_MODEL_LADDER_MEDIUM = 'some-vendor/model-a=some-vendor/model-b';
    try {
      const set = buildKnownValidModels('', '');
      expect(set.has('some-vendor/model-a')).toBe(true);
      expect(set.has('some-vendor/model-b')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.EPAM_MODEL_LADDER_MEDIUM;
      else process.env.EPAM_MODEL_LADDER_MEDIUM = saved;
    }
  });

  it('includes the dynamically-configured upgradeModel and miniModel', () => {
    const set = buildKnownValidModels('some-custom-upgrade-model', 'some-custom-mini-model');
    expect(set.has('some-custom-upgrade-model')).toBe(true);
    expect(set.has('some-custom-mini-model')).toBe(true);
  });

  it('does NOT include the hallucinated model string from the live-run defect', () => {
    const set = buildKnownValidModels('MiniMax-M3', 'MiniMax-M2.5');
    expect(set.has('moonshotai/MiniMax-M3')).toBe(false);
  });
});

describe('isValidModelString — real execution against the exact hallucinated defect', () => {
  const knownValidModels = withLadder(() => buildKnownValidModels('MiniMax-M3', 'MiniMax-M2.5'));

  it('REPRODUCES the exact live-run defect: rejects "moonshotai/MiniMax-M3"', () => {
    expect(isValidModelString('moonshotai/MiniMax-M3', 'moonshotai/kimi-k3', knownValidModels)).toBe(false);
  });

  it('accepts a known-valid model string', () => {
    expect(isValidModelString('z-ai/glm-5.2', 'MiniMax-M3', knownValidModels)).toBe(true);
  });

  it('REJECTS the unchanged current model when the ladder is known — being current is not a reason', () => {
    // This used to accept anything equal to currentModel, ahead of consulting the ladder at all, so
    // a story that had somehow acquired a foreign model perpetuated it on every pass. MiniMax-M3
    // rode that rule through a run whose set declares a Claude ladder, and the writer then spent
    // twelve attempts per story on a model the set cannot route.
    //
    // Where the ladder is known, the ladder decides.
    expect(isValidModelString('some-unlisted-model', 'some-unlisted-model', knownValidModels))
      .toBe(false);
  });

  it('but a no-op IS still accepted when no ladder could be resolved at all', () => {
    // The concession survives exactly where it is safe: with an empty permitted set there is nothing
    // to check against, and refusing everything would strand a project whose ladder did not resolve.
    expect(isValidModelString('some-unlisted-model', 'some-unlisted-model', new Set())).toBe(true);
    expect(isValidModelString('a-different-model', 'some-unlisted-model', new Set()),
      'an empty ladder became a licence to propose anything').toBe(false);
  });

  it('rejects non-string values (null, undefined, numbers, objects)', () => {
    expect(isValidModelString(null, 'MiniMax-M3', knownValidModels)).toBe(false);
    expect(isValidModelString(undefined, 'MiniMax-M3', knownValidModels)).toBe(false);
    expect(isValidModelString(42, 'MiniMax-M3', knownValidModels)).toBe(false);
    expect(isValidModelString({ model: 'MiniMax-M3' }, 'MiniMax-M3', knownValidModels)).toBe(false);
  });

  it('rejects other plausible-looking but unlisted org/model combinations', () => {
    // Same failure shape as the live bug: valid-looking org prefix, wrong model
    expect(isValidModelString('openrouter/MiniMax-M3', 'MiniMax-M3', knownValidModels)).toBe(false);
    expect(isValidModelString('moonshotai/glm-5.2', 'MiniMax-M3', knownValidModels)).toBe(false);
  });

  // REPRODUCES the live-run defect (2026-07-13): with ORCH_UPGRADE_MODEL unset,
  // spec-mode-runner.js's own default fallback WAS 'anthropic/claude-sonnet-4-6'
  // — which then got added to knownValidModels via buildKnownValidModels()'s
  // own upgradeModel/miniModel params, so isValidModelString() accepted it as
  // "known valid" by construction. Assigned to SKY-001, failed 8/8 attempts
  // (wrong provider/model pairing), aborted the phase. Anthropic/Claude models
  // are never a valid assignment in this pipeline (openrouter/minimax-routed by
  // design) — checked independently of currentModel/knownValidModels so this
  // holds even if a story's current model was already corrupted.
  it('rejects any anthropic/* model even when it is the (unset-default-corrupted) upgradeModel', () => {
    const corruptedKnownValidModels = buildKnownValidModels('anthropic/claude-sonnet-4-6', 'MiniMax-M2.5');
    expect(isValidModelString('anthropic/claude-sonnet-4-6', 'MiniMax-M3', corruptedKnownValidModels)).toBe(false);
  });

  it('rejects any anthropic/* or claude-named model regardless of allow-list contents', () => {
    expect(isValidModelString('anthropic/claude-sonnet-4-6', 'MiniMax-M3', knownValidModels)).toBe(false);
    expect(isValidModelString('anthropic/claude-3-5-sonnet', 'MiniMax-M3', knownValidModels)).toBe(false);
    expect(isValidModelString('claude-sonnet-4-6', 'MiniMax-M3', knownValidModels)).toBe(false);
  });

  it('rejects an anthropic model even as a no-op (currentModel already corrupted to anthropic)', () => {
    // Defense in depth: even if story.model was somehow already an Anthropic
    // model before this check runs, isValidModelString must not treat
    // "unchanged" as automatically safe for this specific disallowed family.
    expect(isValidModelString('anthropic/claude-sonnet-4-6', 'anthropic/claude-sonnet-4-6', knownValidModels)).toBe(false);
  });

  it('does not falsely reject legitimate models that merely contain similar substrings', () => {
    expect(isValidModelString('MiniMax-M3', 'MiniMax-M3', knownValidModels)).toBe(true);
    expect(isValidModelString('moonshotai/kimi-k3', 'MiniMax-M3', knownValidModels)).toBe(true);
  });
});

describe('upgradeModel default — must never fall back to an Anthropic model', () => {
  it('spec-mode-runner.js\'s hardcoded default for upgradeModel is not an anthropic/claude model', () => {
    const idx = src.indexOf("const upgradeModel = process.env.ORCH_UPGRADE_MODEL ||");
    expect(idx).toBeGreaterThan(-1);
    const line = src.slice(idx, src.indexOf('\n', idx));
    expect(line).not.toMatch(/anthropic|claude/i);
  });
});

describe('spec-mode-runner.js — model-review pass wired to validate before assignment', () => {
  it('calls buildKnownValidModels before deciding finalModel', () => {
    const idx = src.indexOf('const knownValidModels = buildKnownValidModels(');
    expect(idx).toBeGreaterThan(-1);
  });

  it('isValidModel wraps isValidModelString with the built allow-list', () => {
    expect(src).toMatch(/isValidModel = \(m, currentModel\) => isValidModelString\(m, currentModel, knownValidModels\)/);
  });

  it('rejects an invalid llmModel and falls back to fa.ruleRecommendation (not silently kept)', () => {
    const idx = src.indexOf('if (!isValidModel(llmModel, fa.currentModel)) {');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 400);
    expect(block).toMatch(/llmModel = fa\.ruleRecommendation/);
    expect(block).toMatch(/console\.warn/);
  });

  it('marks llmOverride false when the invalid model was rejected (audit trail reflects reality)', () => {
    const idx = src.indexOf('if (!isValidModel(llmModel, fa.currentModel)) {');
    const block = src.slice(idx, idx + 700);
    expect(block).toMatch(/rejectedInvalidModel = true/);
    expect(block).toMatch(/llmOverride: decision\.override === true && !rejectedInvalidModel/);
  });

  it('exports buildKnownValidModels and isValidModelString for direct testability', () => {
    expect(src).toMatch(/buildKnownValidModels,/);
    expect(src).toMatch(/isValidModelString,/);
  });
});

// ── Structural class-of-bug guard ────────────────────────────────────────────
// The specific defect was one unvalidated write site. The broader lesson: ANY
// direct `story.model = <llm-provided value>` assignment must pass through
// validation first. This test enumerates every such assignment in the file
// and confirms it's downstream of a validated variable, not a raw decision
// field.

describe('structural guard — no unvalidated story.model assignment exists', () => {
  it('the only story.model assignment site uses fa.finalModel (already validated upstream)', () => {
    const assignments = [...src.matchAll(/\bstory\.model\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(assignments.length).toBeGreaterThan(0);
    for (const rhs of assignments) {
      // Must not assign a raw decision/LLM field directly
      expect(rhs, `Unvalidated assignment: story.model = ${rhs}`).not.toMatch(/decision\.finalModel/);
      expect(rhs, `Unvalidated assignment: story.model = ${rhs}`).not.toMatch(/^rawModel$/);
    }
  });
});
