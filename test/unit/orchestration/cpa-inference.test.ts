/**
 * Unit tests for orchestrations/scripts/lib/cpa-inference.js
 *
 * Covers the pure functions that caused real production bugs:
 *   - extractJSON  : LLM output → parsed object (plain, fenced, buried, invalid)
 *   - buildPrompt  : structured prompt assembly from story + context
 *   - skippedReview: fallback result shape when inference is unavailable
 */
import { createRequire } from 'module';
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const CPA_INFERENCE_PATH = require.resolve('../../../orchestrations/scripts/lib/cpa-inference.js');
const { extractJSON, buildPrompt, skippedReview, validateInput } = require(CPA_INFERENCE_PATH);

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

  it('passes KB chunks through WHOLE — a silent cut hides the evidence the estimate rests on', () => {
    // Was: sliced to 800 chars. 800 related to nothing — not the model, not a token budget,
    // not the content — and nothing in the prompt said anything had been removed, so the
    // estimate was formed from a partial view that looked complete. The models in play
    // carry 200K-400K context windows. Where a bound is genuinely needed it is the model's
    // own window (derivable), and it must ANNOUNCE itself, as team-lead-review.sh does.
    const longChunk = 'x'.repeat(2000);
    const input = {
      ...minimalInput,
      kbChunks: [{ source: 'big.md', score: 0.5, chunk: longChunk }],
    };
    const prompt = buildPrompt(input);
    expect(prompt, 'the chunk reached the prompt truncated').toContain(longChunk);
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

// ── buildPrompt — verificationCriteria / storyKind / manifest ──────────────
//
// Live AMSD-2041, 2026-07-31: contextualize-stories.sh passes CPA the ENTIRE
// raw story record (verificationCriteria included), but buildPrompt()'s own
// field whitelist silently dropped it before it ever reached the model — so
// even after spec-pass generated 7-8 concrete verification criteria
// describing the exact reactive-preview behaviour required, CPA judged
// complexity from an empty immutable acceptanceCriteria array and a bare
// one-line description, and defaulted the whole story to effort:"low". A
// budget that small could never fit the real multi-layer feature the VCs
// actually described.
describe('buildPrompt — includes verificationCriteria, storyKind, and a project manifest section', () => {
  const baseInput = {
    story: {
      id: 'AMSD-2041',
      title: 'Live Preview of Content in CMS',
      description: 'Live Preview of Content in CMS',
      acceptanceCriteria: [],
      verificationCriteria: [
        'When an editor saves a change in Contentstack, the page updates without a manual reload.',
        'The GO Transit page displays updated content without a manual browser reload.',
      ],
      storyKind: 'novel',
    },
    formulaEstimate: { aiMinutes: 20, cost: 0.05 },
    systemPrompt: 'You are a CPA reviewer.',
  };

  it('includes verificationCriteria content in the prompt', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain('editor saves a change in Contentstack');
    expect(prompt).toContain('GO Transit page displays updated content');
  });

  it('includes storyKind', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).toContain('novel');
  });

  it('still works when verificationCriteria is absent (backward-compatible)', () => {
    const { verificationCriteria, ...story } = baseInput.story;
    expect(() => buildPrompt({ ...baseInput, story })).not.toThrow();
  });

  it('includes a manifest section when manifest is provided', () => {
    const manifest = {
      manifestFile: 'package.json',
      requiredDevDependencies: ['typescript', '@types/node'],
      installCommand: 'npm install --no-save {package}',
    };
    const prompt = buildPrompt({ ...baseInput, manifest });
    expect(prompt).toContain('Project Manifest');
    expect(prompt).toContain('requiredDevDependencies');
    expect(prompt).toContain('@types/node');
  });

  it('omits the manifest section entirely when manifest is not provided (no empty section noise)', () => {
    const prompt = buildPrompt(baseInput);
    expect(prompt).not.toContain('Project Manifest');
  });
});

// ── validateInput — the structural contract CPA's payload must satisfy ─────
describe('validateInput — structural schema for the CPA payload', () => {
  const validInput = {
    story: { id: 'X-1', title: 'A story', acceptanceCriteria: ['does a thing'] },
    formulaEstimate: { aiMinutes: 10 },
    systemPrompt: 'You are a CPA reviewer.',
  };

  it('accepts a well-formed input with no errors', () => {
    const result = validateInput(validInput);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects input missing story entirely', () => {
    const { story, ...rest } = validInput;
    const result = validateInput(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/story/i);
  });

  it('rejects a story missing an id', () => {
    const result = validateInput({ ...validInput, story: { title: 'No id' } });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/id/i);
  });

  it('WARNS (not a hard failure) when both acceptanceCriteria and verificationCriteria are empty — the exact "nothing to size from" case that caused AMSD-2041 to be misjudged effort:low', () => {
    const result = validateInput({
      ...validInput,
      story: { id: 'X-1', title: 'Empty story', acceptanceCriteria: [] },
    });
    expect(result.valid, 'this must not be a hard failure — the pipeline must still proceed').toBe(true);
    expect(result.warnings.join(' '), 'no warning surfaced for a story CPA has nothing concrete to size from')
      .toMatch(/acceptanceCriteria|verificationCriteria/i);
  });

  it('does NOT warn when verificationCriteria is populated even though acceptanceCriteria is empty (the immutable-ACs brownfield case)', () => {
    const result = validateInput({
      ...validInput,
      story: {
        id: 'X-1', title: 'Brownfield defect', acceptanceCriteria: [],
        verificationCriteria: ['the page shows the fixed value'],
      },
    });
    expect(result.warnings.join(' ')).not.toMatch(/nothing concrete|both.*empty/i);
  });
});

// ── main() end-to-end — the REAL prompt actually sent, not a re-implementation ─
//
// Real execution (spawns the actual node process, real stdin/stdout), not a
// static check — the exact class of gap that let the whitelist bug ship
// silently for weeks (see feedback_test_fixture_fidelity_not_just_real_execution).
describe('main() — real process execution, captures the ACTUAL prompt sent to the AI runner', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function runMainCaptureStdin(input: unknown): { capturedPrompt: string; stdout: string } {
    const dir = mkdtempSync(join(tmpdir(), 'cpa-main-'));
    dirs.push(dir);
    const capturePath = join(dir, 'captured-stdin.txt');
    const fakeRunner = join(dir, 'fake-ai-run.sh');
    writeFileSync(fakeRunner, [
      '#!/usr/bin/env bash',
      `cat > ${JSON.stringify(capturePath)}`,
      'echo \'{"confidence":0.8,"complexityAdjustment":1.0,"adjustedEstimate":{"aiMinutes":10,"cost":0.02,"tokens":1000,"turns":2},"riskFlags":[],"citedSources":[],"reasoning":"ok"}\'',
    ].join('\n'));
    chmodSync(fakeRunner, 0o755);

    const r = spawnSync(process.execPath, [CPA_INFERENCE_PATH], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, AI_RUNNER_CMD: fakeRunner },
    });
    const capturedPrompt = readFileSync(capturePath, 'utf8');
    return { capturedPrompt, stdout: r.stdout || '' };
  }

  it('the real prompt sent to the AI runner contains the verificationCriteria text', () => {
    const input = {
      story: {
        id: 'AMSD-2041', title: 'Live Preview of Content in CMS',
        acceptanceCriteria: [],
        verificationCriteria: ['A tester observes the updated content without reloading the page.'],
      },
      formulaEstimate: { aiMinutes: 20, cost: 0.05, tokens: 3000, turns: 3 },
      systemPrompt: 'You are a CPA reviewer.',
    };
    const { capturedPrompt } = runMainCaptureStdin(input);
    expect(capturedPrompt, 'the real prompt sent to the model never contained the VC text')
      .toContain('A tester observes the updated content without reloading the page.');
  });

  it('the real prompt contains the manifest facts when a manifest is provided', () => {
    const input = {
      story: { id: 'AMSD-2041', title: 'x', acceptanceCriteria: [] },
      formulaEstimate: { aiMinutes: 20 },
      systemPrompt: 'You are a CPA reviewer.',
      manifest: { requiredDevDependencies: ['@contentstack/live-preview-utils'] },
    };
    const { capturedPrompt } = runMainCaptureStdin(input);
    expect(capturedPrompt).toContain('@contentstack/live-preview-utils');
  });

  it('produces a real, valid review JSON on stdout', () => {
    const input = {
      story: { id: 'X-1', title: 'x', acceptanceCriteria: ['a'] },
      formulaEstimate: { aiMinutes: 5 },
      systemPrompt: 'p',
    };
    const { stdout } = runMainCaptureStdin(input);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.confidence).toBe(0.8);
  });
});

// ── buildPrompt — fixSiteAnalysis / Root Cause Analysis section ────────────
//
// Feeds CPA's brownfield-only iterationEstimate judgment (cpa-system.md).
// Without this, CPA never sees the detective's prescribed fix sites or the
// deterministic coverage verdict at all — it could not judge turn-count
// complexity from a signal it never received.
describe('buildPrompt — includes the detective\'s fixSiteAnalysis and coverage verdict', () => {
  it('includes fixSiteAnalysis content under a Root Cause Analysis heading', () => {
    const prompt = buildPrompt({
      story: {
        id: 'AMSD-2041', title: 'x', acceptanceCriteria: [],
        fixSiteAnalysis: [{
          file: 'src/services/contentstack.ts', function: 'Stack',
          reason: 'initializes the SDK', fix: 'add live_preview config', helper: '',
        }],
      },
      formulaEstimate: { aiMinutes: 5 }, systemPrompt: 'p',
    });
    expect(prompt).toContain('Root Cause Analysis');
    expect(prompt).toContain('src/services/contentstack.ts');
    expect(prompt).toContain('add live_preview config');
  });

  it('surfaces an incomplete coverage verdict explicitly', () => {
    const prompt = buildPrompt({
      story: {
        id: 'AMSD-2041', title: 'x', acceptanceCriteria: [],
        fixSiteAnalysis: [{ file: 'x.ts', reason: 'r', fix: 'f' }],
        fixSiteAnalysisCoverage: { complete: false, uncoveredVerificationCriteria: ['a', 'b'] },
      },
      formulaEstimate: {}, systemPrompt: 'p',
    });
    expect(prompt).toMatch(/2 verification criterion\/criteria share NO term/);
  });

  it('surfaces a complete coverage verdict explicitly', () => {
    const prompt = buildPrompt({
      story: {
        id: 'AMSD-2041', title: 'x', acceptanceCriteria: [],
        fixSiteAnalysis: [{ file: 'x.ts', reason: 'r', fix: 'f' }],
        fixSiteAnalysisCoverage: { complete: true, uncoveredVerificationCriteria: [] },
      },
      formulaEstimate: {}, systemPrompt: 'p',
    });
    expect(prompt).toMatch(/every verification criterion shares a term/);
  });

  it('omits the Root Cause Analysis section entirely when no fixSiteAnalysis exists (greenfield / no detective run)', () => {
    const prompt = buildPrompt({
      story: { id: 'X-1', title: 'x', acceptanceCriteria: ['a'] },
      formulaEstimate: {}, systemPrompt: 'p',
    });
    expect(prompt).not.toContain('Root Cause Analysis');
  });
});

// ── main() — iterationEstimate clamping ─────────────────────────────────────
//
// Redesigned 2026-08-01 from a 1.0-3.0x multiplier to an ABSOLUTE turn-count
// estimate: a multiplier on an already-scaled base cannot span "5 iterations
// for a bug fix" to "200 for a large multi-layer change" (a ~40x real-world
// range) — the user's own framing, not an invented number.
describe('main() — iterationEstimate is clamped to [1, 500], defaulting to 1', () => {
  const dirs2: string[] = [];
  afterEach(() => { for (const d of dirs2.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function runWithFakeReview(reviewJson: string): any {
    const dir = mkdtempSync(join(tmpdir(), 'cpa-iter-estimate-'));
    dirs2.push(dir);
    const fakeRunner = join(dir, 'fake-ai-run.sh');
    writeFileSync(fakeRunner, `#!/usr/bin/env bash\ncat /dev/null > /dev/null\necho '${reviewJson}'\n`);
    chmodSync(fakeRunner, 0o755);
    const r = spawnSync(process.execPath, [CPA_INFERENCE_PATH], {
      input: JSON.stringify({ story: { id: 'X-1', title: 'x', acceptanceCriteria: ['a'] }, formulaEstimate: { aiMinutes: 5 }, systemPrompt: 'p' }),
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, AI_RUNNER_CMD: fakeRunner },
    });
    return JSON.parse((r.stdout || '').trim());
  }

  it('a within-range small estimate (bug fix) passes through unchanged', () => {
    const out = runWithFakeReview('{"confidence":0.8,"complexityAdjustment":1.0,"iterationEstimate":8,"reasoning":"x"}');
    expect(out.iterationEstimate).toBe(8);
  });

  it('a within-range large estimate (multi-layer feature) passes through unchanged', () => {
    const out = runWithFakeReview('{"confidence":0.8,"complexityAdjustment":1.0,"iterationEstimate":180,"reasoning":"x"}');
    expect(out.iterationEstimate).toBe(180);
  });

  it('a value above 500 (malformed/hallucinated) is clamped down to the sanity ceiling', () => {
    const out = runWithFakeReview('{"confidence":0.8,"complexityAdjustment":1.0,"iterationEstimate":99999,"reasoning":"x"}');
    expect(out.iterationEstimate).toBe(500);
  });

  it('a value below 1 is clamped up to 1 — never silently produces a zero/negative floor', () => {
    const out = runWithFakeReview('{"confidence":0.8,"complexityAdjustment":1.0,"iterationEstimate":-5,"reasoning":"x"}');
    expect(out.iterationEstimate).toBe(1);
  });

  it('a missing field defaults to 1 (a floor that overrides nothing) rather than throwing or leaving it undefined', () => {
    const out = runWithFakeReview('{"confidence":0.8,"complexityAdjustment":1.0,"reasoning":"x"}');
    expect(out.iterationEstimate).toBe(1);
  });

  it('rounds a non-integer estimate to the nearest whole turn', () => {
    const out = runWithFakeReview('{"confidence":0.8,"complexityAdjustment":1.0,"iterationEstimate":42.7,"reasoning":"x"}');
    expect(out.iterationEstimate).toBe(43);
  });
});
