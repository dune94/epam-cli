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
    const declared = (schema.properties || {})[key] || {};
    const t = declared.type;
    // HONOUR A DECLARED ENUM. This used 'x' for every string, which stopped being a VALID item
    // the moment the validator began enforcing enums (2026-08-24) — a tool declaring
    // `verdict: {enum: [sound, ...]}` rightly refuses 'x'. The fixture, not the assertion, was
    // wrong: "an item built from its declared schema" has to be built from ALL of the schema.
    const firstLegal = Array.isArray(declared.enum) && declared.enum.length
      ? declared.enum[0] : null;
    item[key] = firstLegal !== null ? firstLegal
      : (t === 'array' ? ['x'] : t === 'number' ? 0.5 : t === 'boolean' ? true : 'x');
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

/**
 * A VALIDATOR BUG MUST NEVER HALT A RUN.
 *
 * I put an unproven validator in the fatal path and it killed two live runs in one hour:
 *  - run 20260804T111540Z: demanded `agentRole`; the contract says `agents`. Valid
 *    coordinator output rejected on every lane, every attempt.
 *  - run 20260804T113729Z: demanded SPEC_AGENT.acceptanceCriteria. spec-mode-runner.js
 *    :1574 forces acceptanceCriteria back to the ticket's immutable original "regardless
 *    of what openspec/speckit proposed" — so an omitted array is survivable BY DESIGN.
 *    Two lanes HALTED on a condition the pipeline recovers from.
 *
 * The blast radius of a wrong validator is larger than the defect it guards. So a
 * refusal WARNS and records the reason, and the parsed object still flows: the pipeline's
 * own recovery decides what to do. EPAM_SCHEMA_STRICT=1 opts into hard failure once a
 * contract is proven.
 *
 * This does NOT weaken the review fix: when a reviewer answers in prose, extractTaggedJson
 * already returns null upstream. The validator's job there is to SAY SO — a null answer is
 * still null whether validation is fatal or not.
 */
describe('a schema refusal is diagnostic, not fatal', () => {
  it('a non-conforming object is still RETURNED by default, with the reason surfaced', () => {
    const r = validateTaggedOutput('SPEC_AGENT', { storyId: 'S1', agent: 'x' });
    expect(r.ok, 'the shape genuinely does not conform').toBe(false);
    expect(r.fatal, 'a shape mismatch must not be fatal by default — it halted two live runs')
      .not.toBe(true);
  });

  it('null is ALWAYS fatal — no answer is no answer, strict or not', () => {
    expect(validateTaggedOutput('SPEC_REVIEW', null).fatal).toBe(true);
  });

  it('EPAM_SCHEMA_STRICT=1 opts into hard failure for a proven contract', () => {
    const prev = process.env.EPAM_SCHEMA_STRICT;
    process.env.EPAM_SCHEMA_STRICT = '1';
    try {
      expect(validateTaggedOutput('SPEC_AGENT', { storyId: 'S1', agent: 'x' }).fatal).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EPAM_SCHEMA_STRICT; else process.env.EPAM_SCHEMA_STRICT = prev;
    }
  });

  it('a conforming object is never fatal', () => {
    const good = { storyId: 'S1', agent: 'x', acceptanceCriteria: ['a'] };
    expect(validateTaggedOutput('SPEC_AGENT', good).fatal).not.toBe(true);
  });
});

/**
 * THE WRAPPER BUG, found 2026-08-06 by the ticket-link integration test.
 *
 * A tag with an itemsKey declares its answer as an OBJECT holding an array — TOOL_TICKET_LINKS
 * is `{ required:['links'], properties:{ links:{ type:'array', items:{...} } } }`. A model
 * answering in EXACTLY that declared shape returned the wrapper, and validateTaggedOutput
 * handed the wrapper to checkItem against the ITEM schema: it looked for `url` on
 * `{links:[...]}` and refused with 'missing required field "url"'.
 *
 * It printed on every call and nobody saw it, because a refusal is diagnostic by default and
 * the payload flows anyway. EPAM_SCHEMA_STRICT=1 — the mode this file exists to make
 * reachable — turns the same refusal FATAL, so switching it on would have dropped valid
 * answers on all four wrapper tags at once.
 */
describe('the declared wrapper shape is accepted, not refused', () => {
  const { validateTaggedOutput } = require('../../../orchestrations/scripts/lib/agent-output-schema.js');

  /**
   * Built FROM the tool definition, not hand-written. The hand-written version listed
   * url/classification/relevant and broke the moment the contract tightened to also require
   * fetchStatus and quotes — a fixture that restates a contract drifts exactly like a
   * validator that restates one, which is the defect this whole file exists to avoid.
   */
  function minimalTicketLink() {
    const { itemSchemaFor } = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
    const schema = itemSchemaFor('TICKET_LINKS');
    const item: Record<string, unknown> = {};
    for (const k of schema.required || []) {
      const prop = (schema.properties || {})[k] || {};
      item[k] = prop.type === 'boolean' ? true
        : prop.type === 'number' ? 1
        : prop.type === 'array' ? ['evidence']
        : Array.isArray(prop.enum) ? prop.enum[0]
        : k === 'url' ? 'https://x.test/d' : 'x';
    }
    return item;
  }

  it('a correctly-shaped TICKET_LINKS wrapper passes', () => {
    const r = validateTaggedOutput('TICKET_LINKS', { links: [minimalTicketLink()] });
    expect(r.reason, 'the shape the tool definition itself declares was rejected').toBeNull();
    expect(r.ok).toBe(true);
  });

  it('a genuinely bad item inside the wrapper is still caught', () => {
    const bad = minimalTicketLink(); delete bad.url;
    const r = validateTaggedOutput('TICKET_LINKS', { links: [bad] });
    expect(r.ok, 'unwrapping must not become a way to skip validation entirely').toBe(false);
    expect(r.reason).toMatch(/url/);
  });

  it('an empty wrapper array is a report about nothing', () => {
    expect(validateTaggedOutput('TICKET_LINKS', { links: [] }).ok).toBe(false);
  });

  it('the bare array form still works', () => {
    expect(validateTaggedOutput('TICKET_LINKS', [minimalTicketLink()]).ok).toBe(true);
  });

  it('every wrapper tag accepts its own declared shape', () => {
    const { TAG_TO_TOOL, itemSchemaFor } = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
    for (const [tag, map] of Object.entries<any>(TAG_TO_TOOL)) {
      if (!map.itemsKey) continue;
      const schema = itemSchemaFor(tag);
      if (!schema) continue;
      // One minimal item satisfying whatever that tag declares required.
      const item: Record<string, unknown> = {};
      for (const k of schema.required || []) {
        const prop = ((schema.properties || {})[k] || {}) as Record<string, unknown>;
        const t = prop.type;
        // A DECLARED ENUM WINS OVER THE TYPE DEFAULT. 'x' is a string, and it stopped being a
        // valid value the moment the validator began enforcing enums — TICKET_LINKS.classification
        // declares seven and 'x' is none of them. Same lesson as minimalTicketLink above: a
        // fixture that ignores half the contract is not built "from the tool definition".
        const legal = Array.isArray(prop.enum) && (prop.enum as unknown[]).length
          ? (prop.enum as unknown[])[0] : undefined;
        item[k] = legal !== undefined ? legal
          : (t === 'boolean' ? true : t === 'number' ? 1 : t === 'array' ? ['x'] : t === 'object' ? { a: 1 } : 'x');
      }
      const r = validateTaggedOutput(tag, { [map.itemsKey]: [item] });
      expect(r.ok, `${tag} refused its own declared wrapper: ${r.reason}`).toBe(true);
    }
  });
});

/**
 * ACCEPTANCE CRITERIA ARE NOT IN SCOPE IN BROWNFIELD.
 *
 * The AC gate skips acceptance-criteria processing for a brownfield ticket and records
 * "VCs are derived from the description". A brownfield SPEC_AGENT answer therefore has no
 * acceptanceCriteria — legitimately. Demanding it flagged every brownfield answer on every
 * run (`missing required field "acceptanceCriteria"`, live 2026-08-06, all three lanes),
 * and would be FATAL under EPAM_SCHEMA_STRICT=1 — the mode this validator exists to enable.
 */
describe('brownfield answers are not judged against greenfield requirements', () => {
  const { validateTaggedOutput } = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
  const withEnv = (v: string | undefined, fn: () => void) => {
    const prev = process.env.EPAM_BROWNFIELD;
    if (v === undefined) delete process.env.EPAM_BROWNFIELD; else process.env.EPAM_BROWNFIELD = v;
    try { fn(); } finally {
      if (prev === undefined) delete process.env.EPAM_BROWNFIELD; else process.env.EPAM_BROWNFIELD = prev;
    }
  };

  /** A SPEC_AGENT answer carrying everything its tool declares EXCEPT acceptanceCriteria. */
  function specAnswerWithoutAcs() {
    const { itemSchemaFor } = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
    const schema = itemSchemaFor('SPEC_AGENT');
    const item: Record<string, unknown> = {};
    for (const k of schema.required || []) {
      if (k === 'acceptanceCriteria') continue;
      const t = ((schema.properties || {})[k] || {}).type;
      item[k] = t === 'boolean' ? true : t === 'number' ? 1 : t === 'array' ? ['x'] : t === 'object' ? { a: 1 } : 'x';
    }
    return item;
  }

  it('the fixture is meaningful — acceptanceCriteria really is declared required', () => {
    const { itemSchemaFor } = require('../../../orchestrations/scripts/lib/agent-output-schema.js');
    expect(
      (itemSchemaFor('SPEC_AGENT').required || []),
      'if it is no longer required this test proves nothing',
    ).toContain('acceptanceCriteria');
  });

  it('BROWNFIELD: an answer with no ACs is valid', () => {
    withEnv('1', () => {
      const r = validateTaggedOutput('SPEC_AGENT', specAnswerWithoutAcs());
      expect(r.ok, `brownfield answer refused: ${r.reason}`).toBe(true);
    });
  });

  it('GREENFIELD is unchanged — there the ACs are the contract', () => {
    withEnv(undefined, () => {
      const r = validateTaggedOutput('SPEC_AGENT', specAnswerWithoutAcs());
      expect(r.ok, 'greenfield must still require acceptance criteria').toBe(false);
      expect(r.reason).toMatch(/acceptanceCriteria/);
    });
  });

  it('brownfield still enforces every OTHER required field', () => {
    withEnv('1', () => {
      const item = specAnswerWithoutAcs();
      const other = Object.keys(item)[0];
      delete item[other];
      const r = validateTaggedOutput('SPEC_AGENT', item);
      expect(r.ok, `dropping "${other}" must still be refused in brownfield`).toBe(false);
    });
  });
});
