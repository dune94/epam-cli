/**
 * A schema that permits saying nothing is not a contract.
 *
 * Live AMSD-2041 2026-07-29, all three lanes: openspec returned
 * `acceptanceCriteria: []`. It did not violate its schema — TOOL_SPEC_AGENT
 * lists acceptanceCriteria as `required`, but `required` only means the KEY must
 * be present. An empty array satisfies it perfectly.
 *
 * A reviewer caught the consequence by accident:
 *
 *   "OpenSpec was supposed to elaborate ACs but produced an empty
 *    acceptanceCriteria array — it failed its primary task."
 *
 * speckit then invented every AC itself, "explicitly noting file contents were
 * not reviewed", and the story went forward with criteria derived from a title.
 * That is the head of the cascade behind the whole run: no ACs -> verification
 * criteria derived from the title alone -> CPA with nothing to size from ->
 * effort:"low", 5.4 estimated minutes for a novel capability across three repos
 * -> the cheapest model on the ladder.
 *
 * The codebase already predicted this failure in the assessment agent's own
 * comment: "a schema over an agent that still exhausts returns a valid EMPTY
 * object, which is a loud failure turned silent."
 *
 * minItems is the difference between "the key exists" and "you answered".
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RUNNER = join(__dirname, '../../../orchestrations/scripts/spec-mode-runner.js');
const SRC = readFileSync(RUNNER, 'utf8');

/** A tool definition's source block, bounded by its own declaration. */
function toolBlock(name: string): string {
  const i = SRC.indexOf(`const ${name}`);
  expect(i, `${name} not found`).toBeGreaterThan(-1);
  const j = SRC.indexOf('\n};', i);
  return SRC.slice(i, j + 3);
}

describe('the spec agent cannot answer with an empty criteria list', () => {
  const blk = () => toolBlock('TOOL_SPEC_AGENT');

  it('constrains acceptanceCriteria to at least one item', () => {
    // `required` alone permitted [] — the exact live failure.
    // Match the whole DECLARATION LINE. `\{[^}]*\}` stops at the inner brace of
    // `items: { type: 'string' }` and never reaches minItems — the first draft
    // of this test failed against correct code for that reason.
    const m = blk().match(/acceptanceCriteria:.*$/m);
    expect(m, 'acceptanceCriteria is not declared').toBeTruthy();
    expect(m![0], 'acceptanceCriteria still accepts an empty array — openspec can ' +
      'again "succeed" while saying nothing, and speckit will silently cover for it')
      .toMatch(/minItems/);
  });

  it('still requires the key itself', () => {
    // minItems replaces nothing: the key must be present AND non-empty.
    expect(blk()).toMatch(/required:\s*\[[^\]]*'acceptanceCriteria'/);
  });
});

describe('the coordinator cannot answer with an empty assignment list', () => {
  it('constrains assignments to at least one item', () => {
    // Same shape, same silent failure: an empty assignments array means no
    // agent is assigned to any story, and the pass reports success.
    const m = toolBlock('TOOL_SPEC_ASSIGNMENTS').match(/assignments:\s*\{[^}]*\}/s);
    expect(m, 'assignments is not declared').toBeTruthy();
    expect(m![0], 'assignments still accepts an empty array').toMatch(/minItems/);
  });
});

describe('the constraint is a real JSON Schema keyword', () => {
  it('uses minItems with a positive value', () => {
    // A typo like `minitems` is silently ignored by the provider, which would
    // look like a fix while changing nothing.
    for (const n of ['TOOL_SPEC_AGENT', 'TOOL_SPEC_ASSIGNMENTS']) {
      const hits = [...toolBlock(n).matchAll(/minItems:\s*(\d+)/g)].map((x) => Number(x[1]));
      expect(hits.length, `${n} declares no minItems`).toBeGreaterThan(0);
      for (const v of hits) expect(v, `${n} has a meaningless minItems`).toBeGreaterThanOrEqual(1);
    }
  });
});
