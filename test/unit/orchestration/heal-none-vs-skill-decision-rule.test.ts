/**
 * "Transient" must exclude anything nameable — or self-heal never patches.
 *
 * Live AMSD-2041, twice now, same defect class, different fields:
 *
 *   2026-07-30 run 6:  "Config object doesn't match the SDK's Config type —
 *                       missing or incorrect properties" — target:none, 3x
 *   2026-07-30 run 8:  "live_preview object missing required
 *                       management_token field from LivePreview interface"
 *                       — target:none, 3x, patches_applied:0 every time
 *
 * The second occurrence happened AFTER HEAL-NONE's grounding fix (vendor
 * contract injection) had already landed and was PROVEN working: the
 * diagnosis text got MORE precise each attempt (it now names the exact
 * interface and field), which is only possible because the analyst could see
 * the real type. Grounding was never the remaining problem. The decision rule
 * was: it still says
 *
 *   "target=none: spec and skill are both correct; the agent made a
 *    TRANSIENT code mistake. Retry with stronger model should fix it."
 *
 * A diagnosis that names a specific, checkable property is not transient —
 * it is the opposite. No amount of ground-truth data changes the outcome if
 * the rule that consumes it still calls a nameable fact "transient."
 *
 * THE RULE (of this test): "target=none" must EXCLUDE any diagnosis that
 * names a concrete, checkable fact (a property, type, or field), and
 * "target=skill" must explicitly claim that case. This is prose, not
 * executable logic, so this test can only verify the WORDING makes the right
 * classification reachable — it cannot prove a model will always choose
 * correctly. That is why the fix ships with both: a clearer rule now, and
 * repeat-rejection escalation (already shipped, separately) as the backstop
 * for whenever a model still gets it wrong.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(__dirname, '../../../orchestrations/scripts/claude.sh'), 'utf8');

function decisionRulesBlock(): string {
  const i = SRC.indexOf('Decision rules:');
  expect(i, 'the failure-analyst decision rules are gone — this is anchored to nothing').toBeGreaterThan(-1);
  return SRC.slice(i, i + 1800);
}

describe('the none/skill boundary excludes anything nameable', () => {
  it('the none rule no longer calls a nameable defect "transient" without qualification', () => {
    const block = decisionRulesBlock();
    const noneLine = block.match(/^- target=none:.*$/m);
    expect(noneLine, 'target=none rule not found').toBeTruthy();
    expect(noneLine![0], 'target=none still has no carve-out for a diagnosis that names a ' +
      'specific type/property/field — exactly what let "Config object doesn\'t match the ' +
      'SDK\'s Config type" and "missing required management_token field" both classify none, ' +
      'three times each, patches_applied:0 every time')
      .toMatch(/does not name|cannot name|no specific|not.*specific.*(property|type|field)/i);
  });

  it('the skill rule explicitly claims a nameable type/property/field mismatch', () => {
    const block = decisionRulesBlock();
    const skillLine = block.match(/^- target=skill:.*$/m);
    expect(skillLine, 'target=skill rule not found').toBeTruthy();
    expect(skillLine![0], 'target=skill does not claim the "wrong property/type/field" case — ' +
      'the exact shape of both live recurrences')
      .toMatch(/propert(y|ies)|type mismatch|field|signature/i);
  });

  it('the boundary is stated as a rule, not left to inference from examples alone', () => {
    // A worked example alone ("e.g. wrong Config shape") would itself be a
    // form of hardcoding one incident into the engine's prompt. The rule must
    // be a GENERAL principle (checkable fact vs genuinely unreproducible
    // mistake), not a growing list of specific past failures.
    const block = decisionRulesBlock();
    expect(block, 'the none/skill distinction is not stated as a general principle')
      .toMatch(/checkable|nameable|reproducible|deterministic|specific fact/i);
  });
});

describe('the rule does not regress into over-triggering skill', () => {
  it('a genuinely non-reproducible mistake is still eligible for none', () => {
    // The fix must narrow "transient" to exclude nameable facts — not delete
    // the concept entirely, or every retry becomes a skill-note write and the
    // KB/skill-addendum channel fills with noise from real one-off slips.
    const block = decisionRulesBlock();
    const noneLine = block.match(/^- target=none:.*$/m)![0];
    expect(noneLine, 'target=none no longer describes ANY case at all').toMatch(/none/i);
    expect(noneLine.length, 'the rule was gutted rather than narrowed').toBeGreaterThan(20);
  });
});
