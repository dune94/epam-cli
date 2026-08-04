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

/**
 * DERIVED, NOT RESTATED. The first version of the validator hand-wrote the shapes and was
 * wrong on three of four within the hour — it required `agentRole` where the contract says
 * `agents`, `verdict` where MODEL_REVIEW says `finalModel`, and accepted any object for
 * SPEC_AGENT. It rejected VALID coordinator output on a live run, on every lane, every
 * attempt.
 *
 * So these tests read the SAME tool definitions the validator reads. If a contract
 * changes, both move together; neither can drift into rejecting correct work.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TOOL_DEFINITIONS } = require('../../../orchestrations/scripts/spec-mode-runner.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TAG_TO_TOOL, itemSchemaFor } = require('../../../orchestrations/scripts/lib/agent-output-schema.js');

const TAGS = Object.keys(TAG_TO_TOOL) as string[];

/** Build a minimal VALID item straight from the declared schema. */
function validItem(tag: string): Record<string, unknown> {
  const schema = itemSchemaFor(tag);
  const item: Record<string, unknown> = {};
  for (const key of schema.required || []) {
    const t = ((schema.properties || {})[key] || {}).type;
    item[key] = t === 'array' ? ['x'] : t === 'number' ? 0.5 : t === 'boolean' ? true : 'x';
  }
  return item;
}

const wrap = (tag: string, item: unknown) =>
  TAG_TO_TOOL[tag].itemsKey ? [item] : item;

describe('every tagged contract is enforced from its OWN tool definition', () => {
  it('all four tags resolve to a declared schema (guard against a vacuous pass)', () => {
    expect(TAGS.length).toBeGreaterThan(0);
    for (const tag of TAGS) {
      expect(itemSchemaFor(tag), `${tag} has no declared item schema`).toBeTruthy();
      expect((itemSchemaFor(tag).required || []).length, `${tag} declares no required fields`)
        .toBeGreaterThan(0);
    }
  });

  it.each(TAGS)('%s accepts an item built from its declared schema', (tag) => {
    expect(ok(tag, wrap(tag, validItem(tag))), why(tag, wrap(tag, validItem(tag)))).toBe(true);
  });

  it.each(TAGS)('%s refuses an item missing each declared-required field', (tag) => {
    const schema = itemSchemaFor(tag);
    for (const key of schema.required) {
      const item = validItem(tag);
      delete item[key];
      expect(ok(tag, wrap(tag, item)), `${tag} accepted an item with no "${key}"`).toBe(false);
      expect(why(tag, wrap(tag, item)), 'the reason must name the missing field').toContain(key);
    }
  });

  it.each(TAGS)('%s refuses null — no answer is no answer', (tag) => {
    expect(ok(tag, null)).toBe(false);
    expect(why(tag, null)).toMatch(/no parseable output/i);
  });

  it.each(TAGS.filter((t) => TAG_TO_TOOL[t].itemsKey))('%s refuses an empty array', (tag) => {
    expect(ok(tag, [])).toBe(false);
  });

  /**
   * THE LIVE REGRESSION, named. The hand-written validator demanded `agentRole`; the
   * contract says `agents`. Three lanes of valid coordinator output were rejected.
   */
  it('SPEC_ASSIGNMENTS accepts the DECLARED field name, not the invented one', () => {
    expect(TOOL_DEFINITIONS.TOOL_SPEC_ASSIGNMENTS.parameters.properties.assignments.items.required)
      .toContain('agents');
    expect(ok('SPEC_ASSIGNMENTS', [{ storyId: 'S1', agents: ['typescript-engineer'] }])).toBe(true);
    expect(
      ok('SPEC_ASSIGNMENTS', [{ storyId: 'S1', agentRole: 'typescript-engineer' }]),
      'agentRole is not the contract — a validator that demands it fails valid work',
    ).toBe(false);
  });

  it('MODEL_REVIEW requires finalModel, not verdict', () => {
    expect(ok('MODEL_REVIEW', [{ storyId: 'S1', finalModel: 'some-model' }])).toBe(true);
    expect(ok('MODEL_REVIEW', [{ storyId: 'S1', verdict: 'approved' }])).toBe(false);
  });

  it('an optional field absent is still valid', () => {
    // qualityScore is optional on SPEC_REVIEW; its absence must not fail a real review.
    expect(ok('SPEC_REVIEW', [{ storyId: 'S1', verdict: 'approved' }])).toBe(true);
  });

  it('a declared type mismatch is refused', () => {
    expect(ok('SPEC_ASSIGNMENTS', [{ storyId: 'S1', agents: 'not-an-array' }])).toBe(false);
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
