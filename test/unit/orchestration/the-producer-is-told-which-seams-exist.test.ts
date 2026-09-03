/**
 * A CLOSED VOCABULARY ENFORCED AT THE RECEIVER MUST BE GIVEN TO THE PRODUCER.
 *
 * project-roster.js rejects any entry whose `seam` is not one of the 40 names declared in
 * invocation-profiles.json — a hand-authored file. The prompt that ASKS a model for those entries
 * mentions the word "seam" and lists none of the names.
 *
 * So the model supplies the natural English word for what the agent is, and is refused for it. No
 * amount of reasoning reaches a closed list nobody showed it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '../../..');
const TEMPLATE = join(REPO, 'orchestrations/prompts/templates/roster-specialisation.json');

const template = () => JSON.parse(readFileSync(TEMPLATE, 'utf8'));

describe('the producer is told which seams exist', () => {
  it('the contract asks for a seam at all — otherwise this is moot', () => {
    expect(JSON.stringify(template()), 'the specialisation contract no longer mentions a seam')
      .toMatch(/seam/i);
  });

  it('and the prompt carries the declared vocabulary', () => {
    const t = template();
    const declares = (t.placeholders || []).includes('__DECLARED_SEAMS__')
      || /__DECLARED_SEAMS__/.test(JSON.stringify(t));
    expect(declares, 'the prompt asks a model to name a seam and never says which seams exist — '
      + 'the value is judged against a closed list the producer was never shown').toBe(true);
  });
});
