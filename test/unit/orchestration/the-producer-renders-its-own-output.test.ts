/**
 * THE PRODUCER RENDERS ITS OWN OUTPUT. EVERY CONSUMER GETS THE SAME WORDS.
 *
 * WRITTEN BEFORE THE IMPLEMENTATION.
 *
 * The code-graph-detective's answer is turned into prompt text in two places, and the two have
 * drifted in OPPOSITE directions:
 *
 *   claude.sh:2045          renders deliveryRole, runsIn, the UNVERIFIED warning, the UNGROUNDED
 *                           warning, and the "nothing here produces the value" alarm
 *   team-lead-review.sh:410 renders the changeRequired:false marker — which claude.sh does not
 *
 * So the writer is never told which sites are deliberately left alone, and the reviewer is never
 * told that a prescribed helper does not exist or that the quoted broken line is not in the file.
 * Each copy holds a fact the other lost. Nobody decided this; it is what two copies do.
 *
 * The fix is not a better copy. It is ONE renderer, owned by the producer, because the producer is
 * the only actor that knows what its own fields mean. Consumers ask for the kind and receive the
 * words.
 *
 * THIS STEP IS DELIBERATELY CONSERVATIVE. It moves claude.sh's rendering, unchanged, into the
 * producer module — same words, same order, same branches. The captured writer prompts must not
 * move by a single byte. Unifying the reviewer onto it comes next, as its own visible diff, so
 * that "what the writer is told" and "what the reviewer is told" never change silently.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderFixPlan } = require(join(ROOT, 'orchestrations/scripts/lib/producers/fix-plan.js'));

/** One site, in the detective's own output shape. */
const site = (over: Record<string, unknown> = {}) => ({
  file: 'src/service.ts',
  function: 'loadPage',
  reason: 'the response is memoised',
  fix: 'pass a cache-busting parameter',
  ...over,
});

describe('IT RENDERS THE FACTS THE DETECTIVE FOUND', () => {
  it('a site becomes a line naming the file, the function and the cause', () => {
    const out = renderFixPlan([site()]);
    expect(out).toContain('src/service.ts');
    expect(out).toContain('loadPage');
    expect(out).toContain('the response is memoised');
  });

  it('the prescribed fix appears as its own sub-point, not run into the cause', () => {
    // A cause and a remedy read as one sentence is how a writer ends up implementing the symptom.
    expect(renderFixPlan([site()])).toMatch(/Minimal fix:.*cache-busting/);
  });

  it('a site with no function does not render an empty pair of backticks', () => {
    expect(renderFixPlan([site({ function: '' })])).not.toContain('()');
  });

  it('a site with no prescribed fix renders the cause alone', () => {
    const out = renderFixPlan([site({ fix: '' })]);
    expect(out).toContain('the response is memoised');
    expect(out).not.toContain('Minimal fix');
  });

  it('nothing to say renders nothing at all — never a heading with a blank under it', () => {
    expect(renderFixPlan([]).trim()).toBe('');
    expect(renderFixPlan(null).trim()).toBe('');
    expect(renderFixPlan(undefined).trim()).toBe('');
  });
});

describe('THE DELIVERY ROLE SURVIVES, INCLUDING ITS ALARM', () => {
  it('the site that PRODUCES the value is marked as the one that matters', () => {
    expect(renderFixPlan([site({ deliveryRole: 'produces' })]))
      .toMatch(/PRODUCES THE VALUE/);
  });

  it('a carrier and a verifier are marked as what they are', () => {
    expect(renderFixPlan([site({ deliveryRole: 'carries' })])).toMatch(/carries the value/);
    expect(renderFixPlan([site({ deliveryRole: 'verifies' })])).toMatch(/verify only/);
  });

  it('a plan where NOTHING produces the value says so, loudly', () => {
    // The live failure this exists for: every prescribed site only moved a value that never
    // changed, so implementing the plan exactly produced code that ran and did nothing.
    const out = renderFixPlan([site({ deliveryRole: 'carries' }), site({ deliveryRole: 'verifies' })]);
    expect(out).toMatch(/NONE OF THESE PRODUCE THE VALUE/);
  });

  it('but not when a producer IS present', () => {
    const out = renderFixPlan([site({ deliveryRole: 'produces' }), site({ deliveryRole: 'carries' })]);
    expect(out).not.toMatch(/NONE OF THESE PRODUCE THE VALUE/);
  });

  it('and not when the detective never assigned roles at all', () => {
    // Absent is absent. An older detective answer with no roles must not be accused of omitting
    // a producer it was never asked to identify.
    expect(renderFixPlan([site()])).not.toMatch(/NONE OF THESE PRODUCE THE VALUE/);
  });
});

describe('AN UNPROVEN CLAIM IS MARKED AS UNPROVEN', () => {
  it('a helper the detective could not find is flagged as a hypothesis, and named', () => {
    const out = renderFixPlan([site({ fixVerified: false, helper: 'parseCacheKey' })]);
    expect(out).toMatch(/UNVERIFIED/);
    expect(out, 'the writer cannot check a helper it was not told the name of')
      .toContain('parseCacheKey');
  });

  it('a quoted broken line that is not in the file is flagged as ungrounded, and quoted', () => {
    const out = renderFixPlan([site({ evidenceVerified: false, brokenLine: 'return cached(x)' })]);
    expect(out).toMatch(/UNGROUNDED/);
    expect(out).toContain('return cached(x)');
  });

  it('a verified site carries no warning', () => {
    const out = renderFixPlan([site({ fixVerified: true, evidenceVerified: true })]);
    expect(out).not.toMatch(/UNVERIFIED|UNGROUNDED/);
  });

  it('an ABSENT verification flag is not treated as a failed one', () => {
    // false-because-proven and false-because-unknown are different, and confusing them puts a
    // "this is a guess" warning on a finding nobody ever questioned.
    const out = renderFixPlan([site()]);
    expect(out).not.toMatch(/UNVERIFIED|UNGROUNDED/);
  });
});

describe('IT IS THE PRODUCER, NOT A CONSUMER', () => {
  it('it renders the detective FACTS and none of a consumer framing', () => {
    // The authority of an input — "this is the plan of record, apply it" versus "this is what the
    // implementer was working from, judge against it" — is the CONSUMER's business, declared on
    // its archetype. Bake a consumer's framing in here and the module cannot serve the other one.
    const out = renderFixPlan([site({ deliveryRole: 'produces', fixVerified: false })]);
    for (const framing of ['AUTHORITATIVE', 'start here', 'raise a finding', 'reviewer']) {
      expect(out.toLowerCase(), `the producer's rendering carries the consumer framing '${framing}'`)
        .not.toContain(framing.toLowerCase());
    }
  });

  it('it names no project, client or vendor', () => {
    const out = renderFixPlan([site()]);
    expect(out).not.toMatch(/metrolinx|gotransit|upexpress|contentstack/i);
  });
});
