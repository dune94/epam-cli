/**
 * Four structured agent contracts had NO schema enforcement.
 *
 * SPEC_AGENT, SPEC_ASSIGNMENTS, SPEC_REVIEW and MODEL_REVIEW all declare a JSON shape in
 * prose and all pass a toolDef to runAgentForJson — so they LOOK bound. But that function
 * has two paths, and the direct-exec path simply tag-parses the model's text. Nothing
 * checked the parsed object had the promised shape.
 *
 * LIVE COST, run 20260804T100335Z. The coordinator reviewer answered in prose:
 *     "I cannot write the final output yet — I must first verify the referenced file
 *      paths against the repository using my read-only tools."
 * emitting an EMPTY <SPEC_REVIEW></SPEC_REVIEW>. extractTaggedJson returned null, the
 * review was discarded, all three retries reproduced the identical prose because nothing
 * told the model it had failed, and the spec-review gate then guarded nothing. The one
 * lane that did answer scored 0.35 and flagged "case_variant_filename_risk" — it had
 * found the real defect.
 *
 * NOT provider-side strict schema. gate_verdict_schema.py records why: strict mode
 * suppresses tool calling, and these reviewers now need tools to check paths. Validate
 * AFTER the call — keeps the tools, refuses a malformed answer, and yields a REASON that
 * can be fed into the retry so attempt 2 is told what was wrong.
 *
 * Generic: the validator knows tag shapes, not projects. Nothing here names a client.
 */
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateTaggedOutput } = require('../../../orchestrations/scripts/lib/agent-output-schema.js');

const ok = (tag: string, obj: unknown) => validateTaggedOutput(tag, obj).ok;
const why = (tag: string, obj: unknown) => validateTaggedOutput(tag, obj).reason || '';

describe('SPEC_REVIEW — the contract that failed live', () => {
  const good = [{ storyId: 'ST-1', verdict: 'approved', qualityScore: 0.9 }];

  it('accepts a well-formed review', () => {
    expect(ok('SPEC_REVIEW', good)).toBe(true);
  });

  it('REPRODUCES THE LIVE FAILURE: null (what an empty tag parses to) is refused', () => {
    expect(
      ok('SPEC_REVIEW', null),
      'an empty <SPEC_REVIEW></SPEC_REVIEW> was silently discarded and the gate guarded nothing',
    ).toBe(false);
    expect(why('SPEC_REVIEW', null)).toMatch(/no .*output|empty|null/i);
  });

  it('refuses an empty array — a review of nothing is not a review', () => {
    expect(ok('SPEC_REVIEW', [])).toBe(false);
  });

  it('refuses an entry with no verdict', () => {
    expect(ok('SPEC_REVIEW', [{ storyId: 'ST-1', qualityScore: 0.9 }])).toBe(false);
    expect(why('SPEC_REVIEW', [{ storyId: 'ST-1' }])).toMatch(/verdict/i);
  });

  it('refuses a verdict outside the allowed set', () => {
    expect(ok('SPEC_REVIEW', [{ storyId: 'ST-1', verdict: 'maybe' }])).toBe(false);
    expect(why('SPEC_REVIEW', [{ storyId: 'ST-1', verdict: 'maybe' }])).toMatch(/maybe/);
  });

  it('refuses a qualityScore outside 0..1', () => {
    expect(ok('SPEC_REVIEW', [{ storyId: 'ST-1', verdict: 'approved', qualityScore: 7 }])).toBe(false);
  });

  it('allows an ABSENT qualityScore — absent is not invalid', () => {
    expect(ok('SPEC_REVIEW', [{ storyId: 'ST-1', verdict: 'approved' }])).toBe(true);
  });

  it('refuses an entry with no storyId — a verdict about nothing cannot be applied', () => {
    expect(ok('SPEC_REVIEW', [{ verdict: 'approved' }])).toBe(false);
  });

  it('the reason NAMES what was wrong, so a retry can be told', () => {
    const r = why('SPEC_REVIEW', [{ storyId: 'ST-1', verdict: 'maybe' }]);
    expect(r.length, 'a refusal with no reason cannot improve attempt 2').toBeGreaterThan(10);
  });
});

describe('SPEC_ASSIGNMENTS', () => {
  it('accepts a well-formed assignment', () => {
    expect(ok('SPEC_ASSIGNMENTS', [{ storyId: 'ST-1', agentRole: 'typescript-engineer' }])).toBe(true);
  });
  it('refuses an entry with no agentRole', () => {
    expect(ok('SPEC_ASSIGNMENTS', [{ storyId: 'ST-1' }])).toBe(false);
  });
  it('refuses null and empty', () => {
    expect(ok('SPEC_ASSIGNMENTS', null)).toBe(false);
    expect(ok('SPEC_ASSIGNMENTS', [])).toBe(false);
  });
});

describe('MODEL_REVIEW', () => {
  it('accepts a verdict', () => {
    expect(ok('MODEL_REVIEW', { verdict: 'approved' })).toBe(true);
  });
  it('refuses a missing verdict', () => {
    expect(ok('MODEL_REVIEW', { note: 'looks fine' })).toBe(false);
  });
  it('refuses null', () => {
    expect(ok('MODEL_REVIEW', null)).toBe(false);
  });
});

describe('SPEC_AGENT', () => {
  it('accepts an elaboration payload', () => {
    expect(ok('SPEC_AGENT', { acceptanceCriteria: ['A'], storyKind: 'defect' })).toBe(true);
  });
  it('refuses null — an empty spec payload silently drops the elaboration', () => {
    expect(ok('SPEC_AGENT', null)).toBe(false);
  });
  it('refuses a non-object', () => {
    expect(ok('SPEC_AGENT', 'I need to read the PRD first')).toBe(false);
  });
});

describe('the validator is safe and generic', () => {
  it('an UNKNOWN tag passes rather than blocking a call it knows nothing about', () => {
    expect(
      ok('SOME_FUTURE_TAG', { anything: true }),
      'refusing unknown tags would break every agent added later',
    ).toBe(true);
  });

  it('an unknown tag still refuses null — no shape is still no answer', () => {
    expect(ok('SOME_FUTURE_TAG', null)).toBe(false);
  });

  it('names no project, codeline or vendor', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '../../../orchestrations/scripts/lib/agent-output-schema.js'), 'utf8');
    expect(src).not.toMatch(/metrolinx|gotransit|upexpress|contentstack/i);
  });
});

/**
 * THE VALIDATOR MUST ACTUALLY BE CALLED. A validator nothing invokes is precisely the
 * defect this whole file exists for — the same shape as the schemas that never ran and
 * the review that could not block.
 */
describe('the validator is wired into the tag-parse seam', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const SRC = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'), 'utf8');

  it('EVERY tag-parse return passes through the validator', () => {
    const raw = (SRC.match(/return extractTaggedJson\(/g) || []).length;
    const wrapped = (SRC.match(/_validatedOrNull\(extractTaggedJson\(/g) || []).length;
    expect(
      raw,
      `${raw} tag-parse return(s) bypass the validator — an unvalidated path is an ` +
        'unvalidated contract',
    ).toBe(0);
    expect(wrapped, 'no wrapped tag-parse returns found at all').toBeGreaterThan(0);
  });

  it('a missing validator is reported, never silently skipped', () => {
    expect(
      SRC,
      'if the validator cannot load, validation must fail LOUD — silently returning the ' +
        'unvalidated object rebuilds the defect',
    ).toMatch(/validator unavailable/);
  });

  it('the refusal reason is surfaced, not swallowed', () => {
    expect(SRC).toMatch(/console\.warn\(`spec-mode: \$\{v\.reason\}`\)/);
  });
});
