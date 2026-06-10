/**
 * Unit tests for orchestrations/scripts/lib/cpa-inference.js
 *
 * Covers the pure functions that caused real production bugs:
 *   - extractJSON  : LLM output → parsed object (plain, fenced, buried, invalid)
 *   - buildPrompt  : structured prompt assembly from story + context
 *   - skippedReview: fallback result shape when inference is unavailable
 */
import { createRequire } from 'module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const { extractJSON, buildPrompt, skippedReview } = require(
  '../../../orchestrations/scripts/lib/cpa-inference.js'
);

// ── extractJSON ────────────────────────────────────────────────────────────

describe('extractJSON', () => {
  it('parses plain JSON string', () => {
    const result = extractJSON('{"confidence":0.8,"complexityAdjustment":1.2}');
    expect(result.confidence).toBe(0.8);
    expect(result.complexityAdjustment).toBe(1.2);
  });

  it('parses JSON wrapped in ```json fences', () => {
    const text = '```json\n{"confidence":0.9,"gate":"go"}\n```';
    const result = extractJSON(text);
    expect(result.confidence).toBe(0.9);
    expect(result.gate).toBe('go');
  });

  it('parses JSON wrapped in plain ``` fences', () => {
    const text = '```\n{"confidence":0.7}\n```';
    const result = extractJSON(text);
    expect(result.confidence).toBe(0.7);
  });

  it('extracts JSON buried in prose (first { to last })', () => {
    const text = 'Here is my analysis:\n\n{"confidence":0.6,"reasoning":"looks ok"}\n\nThat is all.';
    const result = extractJSON(text);
    expect(result.confidence).toBe(0.6);
    expect(result.reasoning).toBe('looks ok');
  });

  it('handles leading/trailing whitespace', () => {
    const result = extractJSON('  \n  {"confidence":0.5}  \n  ');
    expect(result.confidence).toBe(0.5);
  });

  it('throws when no valid JSON is present', () => {
    expect(() => extractJSON('This is just plain text with no JSON at all.')).toThrow(
      'No valid JSON object found in response'
    );
  });

  it('throws on truncated/malformed JSON', () => {
    expect(() => extractJSON('{"confidence":0.8, "reasoning": "incomplete')).toThrow();
  });

  it('parses complex nested JSON from LLM', () => {
    const payload = {
      confidence: 0.85,
      complexityAdjustment: 1.1,
      adjustedEstimate: { aiMinutes: 45, cost: 0.12, tokens: 8000, turns: 6 },
      riskFlags: ['missing-tests'],
      citedSources: ['kb/estimation.md'],
      reasoning: 'Story is well-scoped.',
    };
    const result = extractJSON(JSON.stringify(payload));
    expect(result.adjustedEstimate.aiMinutes).toBe(45);
    expect(result.riskFlags).toEqual(['missing-tests']);
  });
});

// ── skippedReview ──────────────────────────────────────────────────────────

describe('skippedReview', () => {
  const formula = { aiMinutes: 30, cost: 0.08, tokens: 5000, turns: 4 };

  it('returns the formula estimate unchanged as adjustedEstimate', () => {
    const result = skippedReview(formula, 'no API key');
    expect(result.adjustedEstimate).toEqual(formula);
  });

  it('sets confidence to 0.70', () => {
    const result = skippedReview(formula, 'timeout');
    expect(result.confidence).toBe(0.70);
  });

  it('sets complexityAdjustment to 1.0', () => {
    const result = skippedReview(formula, 'timeout');
    expect(result.complexityAdjustment).toBe(1.0);
  });

  it('sets _inferenceSkipped to true', () => {
    const result = skippedReview(formula, 'timeout');
    expect(result._inferenceSkipped).toBe(true);
  });

  it('includes the skip reason in reasoning field', () => {
    const result = skippedReview(formula, 'rate limited');
    expect(result.reasoning).toContain('rate limited');
  });

  it('returns empty arrays for riskFlags, missingKbCoverage, citedSources', () => {
    const result = skippedReview(formula, 'x');
    expect(result.riskFlags).toEqual([]);
    expect(result.missingKbCoverage).toEqual([]);
    expect(result.citedSources).toEqual([]);
  });

  it('includes zero _metrics', () => {
    const result = skippedReview(formula, 'x');
    expect(result._metrics.latencyMs).toBe(0);
    expect(result._metrics.tokensIn).toBe(0);
    expect(result._metrics.tokensOut).toBe(0);
  });
});

// ── buildPrompt ────────────────────────────────────────────────────────────

describe('buildPrompt', () => {
  const minimalInput = {
    story: { id: 'HW-001', title: 'Implement greet()', description: 'Write a greet function.' },
    formulaEstimate: { aiMinutes: 20, cost: 0.05 },
    systemPrompt: 'You are a CPA reviewer.',
  };

  it('includes the story id and title', () => {
    const prompt = buildPrompt(minimalInput);
    expect(prompt).toContain('HW-001');
    expect(prompt).toContain('Implement greet()');
  });

  it('includes the system prompt', () => {
    const prompt = buildPrompt(minimalInput);
    expect(prompt).toContain('You are a CPA reviewer.');
  });

  it('includes formula estimate', () => {
    const prompt = buildPrompt(minimalInput);
    expect(prompt).toContain('Formula Baseline Estimate');
    expect(prompt).toContain('"aiMinutes": 20');
  });

  it('shows no KB sources message when kbChunks is empty', () => {
    const prompt = buildPrompt({ ...minimalInput, kbChunks: [] });
    expect(prompt).toContain('No matching KB sources');
  });

  it('includes KB chunks when provided', () => {
    const input = {
      ...minimalInput,
      kbChunks: [{ source: 'kb/estimation.md', score: 0.82, chunk: 'Estimate small stories at 30min.' }],
    };
    const prompt = buildPrompt(input);
    expect(prompt).toContain('kb/estimation.md');
    expect(prompt).toContain('Estimate small stories at 30min.');
  });

  it('truncates KB chunks to 800 chars', () => {
    const longChunk = 'x'.repeat(2000);
    const input = {
      ...minimalInput,
      kbChunks: [{ source: 'big.md', score: 0.5, chunk: longChunk }],
    };
    const prompt = buildPrompt(input);
    // The chunk is sliced to 800 chars before inclusion
    expect(prompt).toContain('x'.repeat(800));
    expect(prompt).not.toContain('x'.repeat(801));
  });

  it('includes adjacent stories when provided', () => {
    const input = {
      ...minimalInput,
      adjacentStories: [{ id: 'HW-002', title: 'Run tests', effort: 'low', status: 'pending' }],
    };
    const prompt = buildPrompt(input);
    expect(prompt).toContain('HW-002');
    expect(prompt).toContain('Adjacent Stories');
  });

  it('ends with JSON-only instruction', () => {
    const prompt = buildPrompt(minimalInput);
    expect(prompt).toContain('Respond with ONLY the JSON object');
  });

  it('handles missing optional fields gracefully', () => {
    const bareInput = {
      story: { id: 'X-1', title: 'Bare story' },
    };
    expect(() => buildPrompt(bareInput)).not.toThrow();
  });
});
