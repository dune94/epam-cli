/**
 * EVERY AGENT'S REPLY MUST PARSE, IN EVERY SHAPE A PROVIDER CAN RETURN IT.
 *
 * The pipeline accepts a reply as a tagged block: <PROJECT_AGENTS>{...}</PROJECT_AGENTS>. Since
 * --json-schema was wired into the claude arm, a provider may also return the object BARE, and a
 * model may wrap either in a single-element array. v1.5 passed --json-schema zero times; it is
 * passed now, so the contract changed and nothing held the two ends together.
 *
 * metrolinx died three times in the mint on exactly this, and the fix was applied at ONE call
 * site — which is no fix at all, because every seam parses the same way. This asserts the contract
 * for all of them.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
const runner = require_(join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js'));
const { TAG_TO_TOOL } = require_(join(__dirname, '../../../orchestrations/scripts/lib/agent-output-schema.js'));

/** Every tag the pipeline extracts a reply by. */
const TAGS = Object.keys(TAG_TO_TOOL || {});

/** A payload shaped like that seam's answer — the key it is checked on. */
function payloadFor(tag: string) {
  const key = (TAG_TO_TOOL as Record<string, { itemsKey?: string | null }>)[tag]?.itemsKey;
  return key ? { [key]: [{ name: 'x' }] } : { verdict: 'pass' };
}

describe('EVERY DECLARED AGENT CONTRACT PARSES IN EVERY SHAPE', () => {
  it('there are contracts to check — otherwise this passes vacuously', () => {
    expect(TAGS.length).toBeGreaterThan(3);
  });

  for (const tag of TAGS) {
    const obj = () => payloadFor(tag);

    it(`${tag}: a tagged block parses`, () => {
      const out = runner.extractTaggedJson(`<${tag}>${JSON.stringify(obj())}</${tag}>`, tag);
      expect(out, 'the original contract no longer parses').toBeTruthy();
    });

    it(`${tag}: a BARE object parses — that is what --json-schema returns`, () => {
      const out = runner.extractTaggedJson(JSON.stringify(obj()), tag);
      expect(out, 'schema-enforced replies carry no tags, and this seam cannot read them')
        .toBeTruthy();
    });

    it(`${tag}: a single-element ARRAY envelope parses`, () => {
      const out = runner.extractTaggedJson(JSON.stringify([obj()]), tag);
      const key = (TAG_TO_TOOL as Record<string, { itemsKey?: string | null }>)[tag]?.itemsKey;
      expect(out, 'a model wrapping its answer in an array kills this seam, as it killed the mint')
        .toBeTruthy();
      if (key) expect(Array.isArray((out as Record<string, unknown>)[key])).toBe(true);
    });
  }
});
