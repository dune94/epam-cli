/**
 * A REVIEWER MUST BE GIVEN THE GROUND TRUTH FOR EVERY CLAIM IT CAN REJECT.
 *
 * prompt-review received the generated prompt, the template, the codelines and the tickets — and NOT
 * the roster. So a prompt that correctly named this project's minted agents was rejected as false,
 * twice, because the reviewer had no list to check against and refuses what it cannot verify.
 *
 * Live 2026-08-27, run 20260827T183645Z: skill-assessment-prephase and prd-model-coordinator were
 * both rejected for naming fare-rules-engineer, mocka-detective, schedule-display-engineer and
 * mockb-detective. Those are exactly this run's roles. Each false rejection forced a regeneration and
 * often a rung escalation, so the missing input was billed again and again.
 *
 * Identical shape to roster-review being asked to falsify a claim about pipeline stages it was never
 * shown. The rule this encodes: whatever a reviewer is empowered to reject, it must be handed the
 * evidence to check.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../../../');
const TEMPLATE = join(REPO_ROOT, 'orchestrations/prompts/templates/prompt-review.json');
const CALLER = join(REPO_ROOT, 'orchestrations/scripts/mint-agents-step.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { placeholdersIn } = require(join(REPO_ROOT, 'orchestrations/scripts/lib/engine-prompt.js'));

const template = JSON.parse(readFileSync(TEMPLATE, 'utf8'));
const body = typeof template.body === 'string'
  ? template.body
  : Object.values(template.bodies || {}).filter((b) => typeof b === 'string').join('\n');
const caller = readFileSync(CALLER, 'utf8');

/** The values object the reviewer is actually constructed with. */
const valuesBlock = (() => {
  const i = caller.indexOf('values: ({ id, template, generated }) => ({');
  return i < 0 ? '' : caller.slice(i, caller.indexOf('}),', i));
})();

describe('the reviewer can verify what it is allowed to reject', () => {
  it('the caller supplies a values object — otherwise nothing below is meaningful', () => {
    expect(valuesBlock.length, 'the reviewer construction moved; this test is looking at nothing')
      .toBeGreaterThan(100);
  });

  it('REPRODUCES the false rejections: the roster is a declared input', () => {
    expect(placeholdersIn(body), 'the reviewer has no roster and will reject true claims about roles')
      .toContain('__ROSTER_BLOCK__');
    expect(template.placeholders).toContain('__ROSTER_BLOCK__');
  });

  it('and the caller actually supplies it — a declared input nobody fills is worse than none', () => {
    expect(valuesBlock, 'the template declares __ROSTER_BLOCK__ and the caller never supplies it, '
      + 'so the render will refuse and every prompt installs UNREVIEWED')
      .toMatch(/__ROSTER_BLOCK__\s*:/);
  });

  it('the roster it supplies comes from the minted agents, not a literal', () => {
    const m = valuesBlock.match(/__ROSTER_BLOCK__[\s\S]{0,300}/);
    expect(m && m[0], 'the roster must be derived from what the mint produced').toMatch(/_mintedDetail/);
  });

  it('every placeholder the template declares is supplied by the caller', () => {
    // The general rule, not just the roster: a reviewer input that is declared and unfilled makes
    // the strict renderer refuse, and reviewPrompt turns that refusal into UNREVIEWED.
    const missing = placeholdersIn(body).filter((ph: string) => !valuesBlock.includes(ph));
    expect(missing, 'the template declares inputs the caller does not supply').toEqual([]);
  });
});
